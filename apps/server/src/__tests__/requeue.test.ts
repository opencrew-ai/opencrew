import { describe, expect, test } from 'vitest'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { runs } from '../db/schema'
import { failInterruptedRuns } from '../runs/queue'
import { makeTestCtx } from './helpers'

async function insertRunningRun(db: Awaited<ReturnType<typeof makeTestCtx>>['db']) {
  const id = nanoid()
  await db.insert(runs).values({
    id,
    agentId: 'agent-1',
    agentVersionId: 'v-1',
    triggerMessageId: 'msg-1',
    triggerType: 'mention',
    status: 'running',
    depth: 0,
    restricted: false,
    createdAt: Date.now(),
    startedAt: Date.now()
  })
  return id
}

describe('restart recovery', () => {
  test('an interrupted run is requeued as a fresh run', async () => {
    const ctx = await makeTestCtx()
    const originalId = await insertRunningRun(ctx.db)

    const requeued = await failInterruptedRuns(ctx.db)
    expect(requeued).toHaveLength(1)

    const [original] = await ctx.db.select().from(runs).where(eq(runs.id, originalId))
    expect(original!.status).toBe('failed')
    expect(original!.error).toContain('requeued')

    const [fresh] = await ctx.db.select().from(runs).where(eq(runs.id, requeued[0]!))
    expect(fresh!.status).toBe('queued')
    expect(fresh!.triggerMessageId).toBe('msg-1')
    expect(fresh!.agentId).toBe('agent-1')
  })

  test('a second interruption gives up instead of looping', async () => {
    const ctx = await makeTestCtx()
    await insertRunningRun(ctx.db)

    const first = await failInterruptedRuns(ctx.db)
    expect(first).toHaveLength(1)

    // The requeued run starts running, then the server dies again.
    await ctx.db.update(runs).set({ status: 'running' }).where(eq(runs.id, first[0]!))
    const second = await failInterruptedRuns(ctx.db)
    expect(second).toHaveLength(0)

    const [givenUp] = await ctx.db.select().from(runs).where(eq(runs.id, first[0]!))
    expect(givenUp!.status).toBe('failed')
    expect(givenUp!.error).toContain('giving up')
  })
})
