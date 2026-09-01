import { describe, expect, test } from 'vitest'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { createDb, type DB } from '../db'
import { approvals, runs } from '../db/schema'
import { resolveApproval } from '../services/approvals'
import { makeTestCtx } from './helpers'
import {
  cancelPendingFabricTask,
  claimNextTask,
  completeFabricTask,
  createFabricTask,
  failAttempt,
  getFabricTask,
  parkFabricTask,
  reapExpiredLeases,
  unparkFabricTask,
  type FabricLane
} from '../fabric/store'
import { canonicalJson, consumeGrant, findConsumableGrant } from '../runs/guardrails'

async function makeDb(): Promise<DB> {
  const { db } = await createDb(':memory:')
  return db
}

let seq = 0
async function seedTask(
  db: DB,
  opts: {
    lane?: FabricLane
    sessionKey?: string
    devices?: string[]
    maxAttempts?: number
    notBefore?: number
  } = {}
): Promise<string> {
  const id = `task-${++seq}-${nanoid(6)}`
  await createFabricTask(db, {
    id,
    kind: 'turn',
    lane: opts.lane ?? 'interactive',
    sessionKey: opts.sessionKey ?? `session-${id}`,
    devices: opts.devices ?? [],
    payload: { agentId: 'agent-1' },
    maxAttempts: opts.maxAttempts,
    notBefore: opts.notBefore
  })
  return id
}

const CLAIM = { workerId: 'w1', capacity: 4, interactiveReserve: 1, leaseMs: 60_000 }

describe('fabric scheduler predicate', () => {
  test('claims oldest interactive work before background work', async () => {
    const db = await makeDb()
    const bg = await seedTask(db, { lane: 'background' })
    const fg = await seedTask(db, { lane: 'interactive' })

    const first = await claimNextTask(db, CLAIM)
    expect(first!.id).toBe(fg)
    const second = await claimNextTask(db, CLAIM)
    expect(second!.id).toBe(bg)
  })

  test('one lease per session key — the serialization law', async () => {
    const db = await makeDb()
    const a = await seedTask(db, { sessionKey: 'coder:general:thread-1' })
    await seedTask(db, { sessionKey: 'coder:general:thread-1' })
    const other = await seedTask(db, { sessionKey: 'coder:general:thread-2' })

    const first = await claimNextTask(db, CLAIM)
    expect(first!.id).toBe(a)
    // Same conversation blocked; the SAME agent's other conversation runs.
    const second = await claimNextTask(db, CLAIM)
    expect(second!.id).toBe(other)
    expect(await claimNextTask(db, CLAIM)).toBeNull()

    await completeFabricTask(db, a)
    const third = await claimNextTask(db, CLAIM)
    expect(third).not.toBeNull()
    expect(third!.sessionKey).toBe('coder:general:thread-1')
  })

  test('exclusive devices never run concurrently', async () => {
    const db = await makeDb()
    await seedTask(db, { devices: ['browser:shared'] })
    await seedTask(db, { devices: ['browser:shared'] })

    expect(await claimNextTask(db, CLAIM)).not.toBeNull()
    expect(await claimNextTask(db, CLAIM)).toBeNull()
  })

  test('background lane cannot consume the interactive reserve', async () => {
    const db = await makeDb()
    for (let i = 0; i < 4; i++) await seedTask(db, { lane: 'background' })

    const opts = { ...CLAIM, capacity: 2, interactiveReserve: 1 }
    expect(await claimNextTask(db, opts)).not.toBeNull()
    // Second slot is reserved for interactive work — background waits.
    expect(await claimNextTask(db, opts)).toBeNull()

    const fg = await seedTask(db, { lane: 'interactive' })
    const claimed = await claimNextTask(db, opts)
    expect(claimed!.id).toBe(fg)
  })

  test('capacity is a hard ceiling', async () => {
    const db = await makeDb()
    for (let i = 0; i < 3; i++) await seedTask(db)
    const opts = { ...CLAIM, capacity: 2, interactiveReserve: 0 }
    expect(await claimNextTask(db, opts)).not.toBeNull()
    expect(await claimNextTask(db, opts)).not.toBeNull()
    expect(await claimNextTask(db, opts)).toBeNull()
  })

  test('not_before holds a task until its time arrives', async () => {
    const db = await makeDb()
    await seedTask(db, { notBefore: Date.now() + 60_000 })
    expect(await claimNextTask(db, CLAIM)).toBeNull()
  })
})

describe('fabric failure handling', () => {
  test('a failed attempt redelivers within budget, then dead-letters', async () => {
    const db = await makeDb()
    const id = await seedTask(db, { maxAttempts: 2 })

    expect((await claimNextTask(db, CLAIM))!.id).toBe(id)
    expect(await failAttempt(db, id)).toBe('retry')
    expect((await getFabricTask(db, id))!.state).toBe('ready')

    expect((await claimNextTask(db, CLAIM))!.id).toBe(id)
    expect(await failAttempt(db, id)).toBe('dead')
    expect((await getFabricTask(db, id))!.state).toBe('failed')
  })

  test('reaper redelivers expired leases — restart recovery is this loop', async () => {
    const db = await makeDb()
    const id = await seedTask(db)
    await claimNextTask(db, { ...CLAIM, leaseMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const reaped = await reapExpiredLeases(db, new Set())
    expect(reaped).toHaveLength(1)
    expect(reaped[0]!.task.id).toBe(id)
    expect(reaped[0]!.disposition).toBe('retry')
    expect((await getFabricTask(db, id))!.state).toBe('ready')
  })

  test('reaper skips attempts this process is actively executing', async () => {
    const db = await makeDb()
    const id = await seedTask(db)
    await claimNextTask(db, { ...CLAIM, leaseMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const reaped = await reapExpiredLeases(db, new Set([id]))
    expect(reaped).toHaveLength(0)
    expect((await getFabricTask(db, id))!.state).toBe('leased')
  })

  test('boot reap: another worker\'s leases reclaim instantly, own leases survive', async () => {
    const db = await makeDb()
    const foreign = await seedTask(db)
    const mine = await seedTask(db)
    await claimNextTask(db, { ...CLAIM, workerId: 'old-pid' })
    await claimNextTask(db, { ...CLAIM, workerId: 'new-pid' })

    const { reapForeignLeases } = await import('../fabric/store')
    const reaped = await reapForeignLeases(db, 'new-pid')
    expect(reaped.map((r) => r.task.id)).toEqual([foreign])
    expect(reaped[0]!.disposition).toBe('retry')
    // No waiting out the lease TTL — the foreign lease is ready right now.
    expect((await getFabricTask(db, foreign))!.state).toBe('ready')
    expect((await getFabricTask(db, mine))!.state).toBe('leased')
  })

  test('restart refund: a healthy attempt costs nothing; an instant death still burns budget', async () => {
    const db = await makeDb()
    const { reapForeignLeases } = await import('../fabric/store')
    const { fabricTasks } = await import('../db/schema')
    const { eq: eqOp } = await import('drizzle-orm')

    // Attempt ran 30s before the restart → the attempt is refunded.
    const healthy = await seedTask(db)
    await claimNextTask(db, { ...CLAIM, workerId: 'old-pid' })
    await db
      .update(fabricTasks)
      .set({ claimedAt: Date.now() - 30_000 })
      .where(eqOp(fabricTasks.id, healthy))
    const [refunded] = await reapForeignLeases(db, 'new-pid')
    expect(refunded!.disposition).toBe('retry')
    expect((await getFabricTask(db, healthy))!.attempts).toBe(0)

    // Attempt died within seconds of claim → attempt counted (crash-loop guard):
    // deliberate restarts can never dead-letter healthy work, but a task that
    // kills its worker on arrival still marches toward the budget.
    const db2 = await makeDb()
    const poison = await seedTask(db2, { maxAttempts: 1 })
    await claimNextTask(db2, { ...CLAIM, workerId: 'old-pid-2' })
    const reaped = await reapForeignLeases(db2, 'new-pid')
    expect(reaped[0]!.disposition).toBe('dead')
    expect((await getFabricTask(db2, poison))!.state).toBe('failed')
  })

  test('failAttempt on a task no longer leased is a safe no-op', async () => {
    const db = await makeDb()
    const id = await seedTask(db)
    await claimNextTask(db, CLAIM)
    await completeFabricTask(db, id)
    expect(await failAttempt(db, id)).toBe('gone')
    expect((await getFabricTask(db, id))!.state).toBe('done')
  })
})

describe('fabric park / unpark (approvals)', () => {
  test('parking frees the session and survives; unparking carries the decision', async () => {
    const db = await makeDb()
    const id = await seedTask(db, { sessionKey: 's1' })
    const rival = await seedTask(db, { sessionKey: 's1' })

    await claimNextTask(db, CLAIM)
    expect(await parkFabricTask(db, id, { approvalId: 'appr-1' })).toBe(true)
    const parked = await getFabricTask(db, id)
    expect(parked!.state).toBe('needs_human')
    expect(parked!.pause).toEqual({ approvalId: 'appr-1' })

    // Parked ≠ leased: the session key is free for the rival conversation turn.
    expect((await claimNextTask(db, CLAIM))!.id).toBe(rival)

    expect(
      await unparkFabricTask(db, id, { approvalId: 'appr-1', decision: 'approved' })
    ).toBe(true)
    const resumed = await getFabricTask(db, id)
    expect(resumed!.state).toBe('ready')
    expect(resumed!.pause).toBeNull()
    expect(resumed!.payload.resume).toEqual({ approvalId: 'appr-1', decision: 'approved' })
  })

  test('unparking a cancelled task refuses — nothing resumes after a stop', async () => {
    const db = await makeDb()
    const id = await seedTask(db)
    await claimNextTask(db, CLAIM)
    await parkFabricTask(db, id, { approvalId: 'appr-1' })
    expect(await cancelPendingFabricTask(db, id)).toBe(true)

    expect(await unparkFabricTask(db, id, { decision: 'approved' })).toBe(false)
    expect((await getFabricTask(db, id))!.state).toBe('cancelled')
  })

  test('cancel only touches pending work, never a live attempt', async () => {
    const db = await makeDb()
    const id = await seedTask(db)
    await claimNextTask(db, CLAIM)
    expect(await cancelPendingFabricTask(db, id)).toBe(false)
    expect((await getFabricTask(db, id))!.state).toBe('leased')
  })
})

describe('approval resolution end to end', () => {
  async function parkOnApproval(decision: 'approved' | 'denied') {
    const ctx = await makeTestCtx()
    const runId = nanoid()
    const approvalId = nanoid()
    await ctx.db.insert(runs).values({
      id: runId,
      agentId: 'agent-1',
      agentVersionId: 'v-1',
      triggerMessageId: 'msg-1',
      triggerType: 'mention',
      status: 'awaiting_approval',
      depth: 0,
      restricted: false,
      createdAt: Date.now()
    })
    await ctx.db.insert(approvals).values({
      id: approvalId,
      runId,
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'npm test' }),
      status: 'pending',
      createdAt: Date.now()
    })
    await createFabricTask(ctx.db, {
      id: runId,
      kind: 'turn',
      lane: 'interactive',
      sessionKey: 'agent-1:chan:thread',
      devices: [],
      payload: { agentId: 'agent-1', channelId: 'chan' }
    })
    await claimNextTask(ctx.db, CLAIM)
    await parkFabricTask(ctx.db, runId, { approvalId })

    await resolveApproval(ctx, approvalId, decision, 'user-1')
    return { ctx, runId, approvalId }
  }

  test('approving unparks the task with a grant and requeues the run', async () => {
    const { ctx, runId, approvalId } = await parkOnApproval('approved')
    const task = await getFabricTask(ctx.db, runId)
    expect(task!.state).toBe('ready')
    expect(task!.payload.resume).toEqual({
      approvalId,
      decision: 'approved',
      toolName: 'Bash'
    })
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId))
    expect(run!.status).toBe('queued')
    // The approved row IS the one-shot grant for the resumed attempt.
    const grant = await findConsumableGrant(ctx.db, runId, 'Bash', { command: 'npm test' })
    expect(grant!.id).toBe(approvalId)
  })

  test('denying unparks too — the agent adapts instead of dying', async () => {
    const { ctx, runId } = await parkOnApproval('denied')
    const task = await getFabricTask(ctx.db, runId)
    expect(task!.state).toBe('ready')
    expect((task!.payload.resume as { decision: string }).decision).toBe('denied')
    // A denied approval is never a grant.
    expect(await findConsumableGrant(ctx.db, runId, 'Bash', { command: 'npm test' })).toBeNull()
  })

  test('approving a run that already ended is refused honestly', async () => {
    const ctx = await makeTestCtx()
    const runId = nanoid()
    const approvalId = nanoid()
    await ctx.db.insert(runs).values({
      id: runId,
      agentId: 'agent-1',
      agentVersionId: 'v-1',
      triggerMessageId: 'msg-1',
      triggerType: 'mention',
      status: 'cancelled',
      depth: 0,
      restricted: false,
      createdAt: Date.now()
    })
    await ctx.db.insert(approvals).values({
      id: approvalId,
      runId,
      toolName: 'Bash',
      toolInput: '{}',
      status: 'pending',
      createdAt: Date.now()
    })
    await expect(resolveApproval(ctx, approvalId, 'approved', 'user-1')).rejects.toThrow(
      /already ended/
    )
    const [row] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId))
    expect(row!.status).toBe('denied')
  })
})

describe('one-shot grants', () => {
  test('canonicalJson is key-order insensitive, value sensitive', () => {
    expect(canonicalJson({ a: 1, b: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ b: [{ c: 3, d: 2 }], a: 1 })
    )
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }))
  })

  test('a grant matches exact input once, then is consumed', async () => {
    const db = await makeDb()
    const runId = nanoid()
    const approvalId = nanoid()
    await db.insert(approvals).values({
      id: approvalId,
      runId,
      toolName: 'Bash',
      toolInput: JSON.stringify({ command: 'npm test', timeout: 5 }),
      status: 'approved',
      resolvedBy: 'user-1',
      resolvedAt: Date.now(),
      createdAt: Date.now()
    })

    // Different input → no grant (no silent consent widening).
    expect(await findConsumableGrant(db, runId, 'Bash', { command: 'rm -rf /' })).toBeNull()
    // Same input, different key order → grant found.
    const grant = await findConsumableGrant(db, runId, 'Bash', {
      timeout: 5,
      command: 'npm test'
    })
    expect(grant!.id).toBe(approvalId)

    await consumeGrant(db, grant!.id)
    expect(
      await findConsumableGrant(db, runId, 'Bash', { command: 'npm test', timeout: 5 })
    ).toBeNull()
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId))
    expect(row!.consumedAt).not.toBeNull()
  })
})
