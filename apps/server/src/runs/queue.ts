import { and, eq, inArray, like } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { DB } from '../db'
import { approvals, runs } from '../db/schema'

const CONCURRENCY = 4

type ExecutorFn = (runId: string) => Promise<void>

/**
 * In-process job queue: FIFO with a small concurrency cap. No Redis by
 * design — state lives in the runs table, this only schedules work.
 */
export class RunQueue {
  private pending: string[] = []
  private active = new Map<string, string>() // runId -> agentId
  private executor: ExecutorFn = async () => {}
  private lookupAgent: (runId: string) => Promise<string | null> = async () => null

  configure(
    executor: ExecutorFn,
    lookupAgent: (runId: string) => Promise<string | null>
  ): void {
    this.executor = executor
    this.lookupAgent = lookupAgent
  }

  enqueue(runId: string): void {
    this.pending.push(runId)
    this.pump()
  }

  activeAgentIds(): Set<string> {
    return new Set(this.active.values())
  }

  /** Returns how many runs are currently in-flight for each agent. */
  activeRunCountByAgent(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const agentId of this.active.values()) {
      counts.set(agentId, (counts.get(agentId) ?? 0) + 1)
    }
    return counts
  }

  /** Pending (queued but not yet started) run count. */
  pendingCount(): number {
    return this.pending.length
  }

  /** Emergency stop: drop everything not yet started; returns the run ids. */
  drainPending(): string[] {
    const drained = [...this.pending]
    this.pending = []
    return drained
  }

  private pump(): void {
    while (this.active.size < CONCURRENCY && this.pending.length > 0) {
      const runId = this.pending.shift()
      if (!runId) break
      this.active.set(runId, '')
      void this.lookupAgent(runId)
        .then((agentId) => {
          if (agentId) this.active.set(runId, agentId)
        })
        .then(() => this.executor(runId))
        .catch((err) => {
          // Executor handles its own failures; this is a last-resort log.
          console.error(`run ${runId} crashed outside executor error handling:`, err)
        })
        .finally(() => {
          this.active.delete(runId)
          this.pump()
        })
    }
  }
}

const REQUEUE_SUFFIX = '— requeued'
/** SQS-style redelivery budget: the original delivery + two automatic retries. */
const MAX_DELIVERIES = 3

type RunRow = typeof runs.$inferSelect

/**
 * Redeliver a dead run: mark it failed with a requeue marker and queue a
 * fresh run for the same trigger. The persistent per-(agent, conversation)
 * session resumes with everything the previous attempt already did — the
 * work continues from where it left off, not from scratch.
 *
 * Delivery counting is inferred from run history (failed runs for the same
 * trigger+agent carrying the requeue marker), so restart recovery and the
 * watchdog share one budget and cannot ping-pong a poisoned run forever.
 * Returns null when the budget is spent — the run fails permanently.
 */
export async function requeueRun(
  db: DB,
  run: RunRow,
  reason: string
): Promise<{ runId: string; attempt: number } | null> {
  const prior = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.triggerMessageId, run.triggerMessageId),
        eq(runs.agentId, run.agentId),
        like(runs.error, `%${REQUEUE_SUFFIX}`)
      )
    )
  if (prior.length >= MAX_DELIVERIES - 1) {
    await db
      .update(runs)
      .set({
        status: 'failed',
        error: `${reason} — retry limit reached, giving up`,
        finishedAt: Date.now()
      })
      .where(eq(runs.id, run.id))
    return null
  }

  await db
    .update(runs)
    .set({ status: 'failed', error: `${reason} ${REQUEUE_SUFFIX}`, finishedAt: Date.now() })
    .where(eq(runs.id, run.id))
  const newId = nanoid()
  await db.insert(runs).values({
    id: newId,
    agentId: run.agentId,
    agentVersionId: run.agentVersionId,
    triggerMessageId: run.triggerMessageId,
    triggerType: run.triggerType,
    status: 'queued',
    depth: run.depth,
    restricted: run.restricted,
    createdAt: Date.now()
  })
  return { runId: newId, attempt: prior.length + 1 }
}

/**
 * Crash recovery: approval waits live in process memory (a blocked Claude
 * Code session), so anything mid-flight when the process died can't simply
 * continue — each interrupted run is redelivered via requeueRun, within the
 * shared delivery budget. Returns the requeued run ids for the caller to
 * enqueue once the queue is configured.
 */
export async function failInterruptedRuns(db: DB): Promise<string[]> {
  const interrupted = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ['queued', 'running', 'awaiting_approval']))
  await db
    .update(approvals)
    .set({ status: 'denied', resolvedBy: 'system:restart', resolvedAt: Date.now() })
    .where(eq(approvals.status, 'pending'))

  const requeued: string[] = []
  for (const run of interrupted) {
    const result = await requeueRun(db, run, 'server restarted mid-run')
    if (result) requeued.push(result.runId)
  }
  return requeued
}

export async function getRunAgentId(db: DB, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: runs.agentId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  return row?.agentId ?? null
}
