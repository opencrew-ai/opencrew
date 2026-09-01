import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { DB } from '../db'
import { fabricTasks } from '../db/schema'

/**
 * Fabric store — the pure persistence layer of the coordination kernel
 * (see /DESIGN.md). Every state transition happens here, guarded by the
 * task's version counter (optimistic concurrency) or a state predicate, so
 * two controllers can never silently clobber each other. No in-memory state:
 * the table IS the queue, which is what makes the system crash-only.
 */

export type FabricLane = 'interactive' | 'background'
export type FabricState = 'ready' | 'leased' | 'needs_human' | 'done' | 'failed' | 'cancelled'

export interface FabricTaskSpec {
  id: string
  kind: 'turn'
  lane: FabricLane
  sessionKey: string
  devices: string[]
  payload: Record<string, unknown>
  maxAttempts?: number
  notBefore?: number
}

export interface FabricTask {
  id: string
  kind: 'turn'
  lane: FabricLane
  sessionKey: string
  devices: string[]
  payload: Record<string, unknown>
  state: FabricState
  attempts: number
  maxAttempts: number
  pause: Record<string, unknown> | null
  createdAt: number
}

type Row = typeof fabricTasks.$inferSelect

function toTask(row: Row): FabricTask {
  return {
    id: row.id,
    kind: row.kind,
    lane: row.lane,
    sessionKey: row.sessionKey,
    devices: JSON.parse(row.devices) as string[],
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    pause: row.pause ? (JSON.parse(row.pause) as Record<string, unknown>) : null,
    createdAt: row.createdAt
  }
}

export async function createFabricTask(db: DB, spec: FabricTaskSpec): Promise<void> {
  const now = Date.now()
  await db.insert(fabricTasks).values({
    id: spec.id,
    kind: spec.kind,
    lane: spec.lane,
    sessionKey: spec.sessionKey,
    devices: JSON.stringify(spec.devices),
    payload: JSON.stringify(spec.payload),
    state: 'ready',
    maxAttempts: spec.maxAttempts ?? 3,
    notBefore: spec.notBefore ?? null,
    createdAt: now,
    updatedAt: now
  })
}

export async function getFabricTask(db: DB, id: string): Promise<FabricTask | null> {
  const [row] = await db.select().from(fabricTasks).where(eq(fabricTasks.id, id)).limit(1)
  return row ? toTask(row) : null
}

export interface ClaimOptions {
  workerId: string
  /** Max concurrently leased tasks across both lanes. */
  capacity: number
  /** Slots claimable ONLY by the interactive lane. */
  interactiveReserve: number
  leaseMs: number
  now?: number
}

/**
 * Claim the next dispatchable task, or null when nothing is eligible.
 * Eligibility is the whole scheduler: not_before passed, session key free,
 * devices free, lane capacity free — evaluated against currently-leased rows,
 * then committed with a version-guarded UPDATE so a concurrent claimer loses
 * cleanly and the loop moves to the next candidate.
 */
export async function claimNextTask(db: DB, opts: ClaimOptions): Promise<FabricTask | null> {
  const now = opts.now ?? Date.now()
  const leased = await db
    .select()
    .from(fabricTasks)
    .where(eq(fabricTasks.state, 'leased'))
  if (leased.length >= opts.capacity) return null

  const busySessions = new Set(leased.map((r) => r.sessionKey))
  const busyDevices = new Set(leased.flatMap((r) => JSON.parse(r.devices) as string[]))
  const backgroundInFlight = leased.filter((r) => r.lane === 'background').length
  const backgroundCap = Math.max(0, opts.capacity - opts.interactiveReserve)

  const candidates = await db
    .select()
    .from(fabricTasks)
    .where(
      and(
        eq(fabricTasks.state, 'ready'),
        or(isNull(fabricTasks.notBefore), lt(fabricTasks.notBefore, now + 1))
      )
    )
    .orderBy(
      sql`CASE WHEN ${fabricTasks.lane} = 'interactive' THEN 0 ELSE 1 END`,
      asc(fabricTasks.createdAt)
    )
    .limit(50)

  for (const row of candidates) {
    if (busySessions.has(row.sessionKey)) continue
    const devices = JSON.parse(row.devices) as string[]
    if (devices.some((d) => busyDevices.has(d))) continue
    if (row.lane === 'background' && backgroundInFlight >= backgroundCap) continue

    const claimed = await db
      .update(fabricTasks)
      .set({
        state: 'leased',
        attempts: row.attempts + 1,
        leaseOwner: opts.workerId,
        leaseBeatAt: now,
        leaseExpiresAt: now + opts.leaseMs,
        version: row.version + 1,
        updatedAt: now
      })
      .where(
        and(
          eq(fabricTasks.id, row.id),
          eq(fabricTasks.state, 'ready'),
          eq(fabricTasks.version, row.version)
        )
      )
      .returning()
    if (claimed.length > 0) return toTask({ ...row, attempts: row.attempts + 1, state: 'leased' })
  }
  return null
}

/** Extend the process-liveness lease; optionally record session activity. */
export async function renewLease(
  db: DB,
  taskId: string,
  leaseMs: number,
  opts: { beat?: boolean } = {}
): Promise<void> {
  const now = Date.now()
  await db
    .update(fabricTasks)
    .set({
      leaseExpiresAt: now + leaseMs,
      ...(opts.beat ? { leaseBeatAt: now } : {}),
      updatedAt: now
    })
    .where(and(eq(fabricTasks.id, taskId), eq(fabricTasks.state, 'leased')))
}

export async function completeFabricTask(db: DB, taskId: string): Promise<void> {
  await db
    .update(fabricTasks)
    .set(terminalPatch('done'))
    .where(and(eq(fabricTasks.id, taskId), eq(fabricTasks.state, 'leased')))
}

export type FailDisposition = 'retry' | 'dead' | 'gone'

/**
 * An attempt errored. Within budget → back to ready (redelivery); budget
 * spent → failed (dead-letter). 'gone' means the task was concurrently
 * cancelled/completed — the caller should do nothing.
 */
export async function failAttempt(db: DB, taskId: string): Promise<FailDisposition> {
  const [row] = await db
    .select()
    .from(fabricTasks)
    .where(eq(fabricTasks.id, taskId))
    .limit(1)
  if (!row || row.state !== 'leased') return 'gone'

  const dead = row.attempts >= row.maxAttempts
  const updated = await db
    .update(fabricTasks)
    .set(dead ? terminalPatch('failed') : readyPatch())
    .where(
      and(
        eq(fabricTasks.id, taskId),
        eq(fabricTasks.state, 'leased'),
        eq(fabricTasks.version, row.version)
      )
    )
    .returning()
  if (updated.length === 0) return 'gone'
  return dead ? 'dead' : 'retry'
}

/** Gate hit: the attempt is over, the task waits on a human at zero cost. */
export async function parkFabricTask(
  db: DB,
  taskId: string,
  pause: Record<string, unknown>
): Promise<boolean> {
  const updated = await db
    .update(fabricTasks)
    .set({
      state: 'needs_human',
      pause: JSON.stringify(pause),
      leaseOwner: null,
      leaseBeatAt: null,
      leaseExpiresAt: null,
      version: sql`${fabricTasks.version} + 1`,
      updatedAt: Date.now()
    })
    .where(and(eq(fabricTasks.id, taskId), eq(fabricTasks.state, 'leased')))
    .returning()
  return updated.length > 0
}

/**
 * A human decided: back to ready, with the decision merged into the payload
 * as `resume` so the next attempt's prompt carries it. Returns false when the
 * task is no longer parked (cancelled in a race) — the caller must not assume
 * anything resumed.
 */
export async function unparkFabricTask(
  db: DB,
  taskId: string,
  resume: Record<string, unknown>
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(fabricTasks)
    .where(eq(fabricTasks.id, taskId))
    .limit(1)
  if (!row || row.state !== 'needs_human') return false
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  const updated = await db
    .update(fabricTasks)
    .set({
      state: 'ready',
      pause: null,
      payload: JSON.stringify({ ...payload, resume }),
      version: row.version + 1,
      updatedAt: Date.now()
    })
    .where(
      and(
        eq(fabricTasks.id, taskId),
        eq(fabricTasks.state, 'needs_human'),
        eq(fabricTasks.version, row.version)
      )
    )
    .returning()
  return updated.length > 0
}

/** Cancel a task that is not currently executing (ready or parked). */
export async function cancelPendingFabricTask(db: DB, taskId: string): Promise<boolean> {
  const updated = await db
    .update(fabricTasks)
    .set(terminalPatch('cancelled'))
    .where(
      and(eq(fabricTasks.id, taskId), inArray(fabricTasks.state, ['ready', 'needs_human']))
    )
    .returning()
  return updated.length > 0
}

/** Fail a leased task terminally, skipping the retry budget (bad config). */
export async function failLeasedFabricTask(db: DB, taskId: string): Promise<boolean> {
  const updated = await db
    .update(fabricTasks)
    .set(terminalPatch('failed'))
    .where(and(eq(fabricTasks.id, taskId), eq(fabricTasks.state, 'leased')))
    .returning()
  return updated.length > 0
}

/** Cancel a leased task whose attempt was aborted on purpose (admin stop). */
export async function cancelLeasedFabricTask(db: DB, taskId: string): Promise<boolean> {
  const updated = await db
    .update(fabricTasks)
    .set(terminalPatch('cancelled'))
    .where(and(eq(fabricTasks.id, taskId), eq(fabricTasks.state, 'leased')))
    .returning()
  return updated.length > 0
}

export interface ReapedTask {
  task: FabricTask
  disposition: 'retry' | 'dead'
}

/**
 * The reaper: leased tasks whose lease expired belong to a dead process.
 * Within budget → ready (redelivery); spent → failed. `skipIds` excludes
 * tasks this process is actively executing (their heartbeats may simply not
 * have landed yet in a slow tick).
 */
export async function reapExpiredLeases(
  db: DB,
  skipIds: Set<string>,
  now = Date.now()
): Promise<ReapedTask[]> {
  const expired = await db
    .select()
    .from(fabricTasks)
    .where(and(eq(fabricTasks.state, 'leased'), lt(fabricTasks.leaseExpiresAt, now)))
  const reaped: ReapedTask[] = []
  for (const row of expired) {
    if (skipIds.has(row.id)) continue
    const dead = row.attempts >= row.maxAttempts
    const updated = await db
      .update(fabricTasks)
      .set(dead ? terminalPatch('failed') : readyPatch())
      .where(
        and(
          eq(fabricTasks.id, row.id),
          eq(fabricTasks.state, 'leased'),
          eq(fabricTasks.version, row.version)
        )
      )
      .returning()
    if (updated.length > 0) {
      reaped.push({ task: toTask(row), disposition: dead ? 'dead' : 'retry' })
    }
  }
  return reaped
}

export async function listFabricTasks(
  db: DB,
  states: FabricState[]
): Promise<FabricTask[]> {
  const rows = await db
    .select()
    .from(fabricTasks)
    .where(inArray(fabricTasks.state, states))
    .orderBy(asc(fabricTasks.createdAt))
  return rows.map(toTask)
}

function readyPatch() {
  return {
    state: 'ready' as const,
    leaseOwner: null,
    leaseBeatAt: null,
    leaseExpiresAt: null,
    version: sql`${fabricTasks.version} + 1`,
    updatedAt: Date.now()
  }
}

function terminalPatch(state: 'done' | 'failed' | 'cancelled') {
  return {
    state,
    leaseOwner: null,
    leaseBeatAt: null,
    leaseExpiresAt: null,
    pause: null,
    version: sql`${fabricTasks.version} + 1`,
    updatedAt: Date.now()
  }
}
