import { and, eq, inArray } from 'drizzle-orm'
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

const RESTART_REQUEUED_ERROR = 'server restarted mid-run — requeued'

/**
 * Crash recovery: approval waits live in process memory (a blocked Claude
 * Code session), so anything mid-flight when the process died can't simply
 * continue. But the WORK shouldn't die with the process — each interrupted
 * run is marked failed and a fresh run is queued for the same trigger; the
 * persistent per-(agent, conversation) session resumes with full context.
 * One retry only: a run that gets interrupted twice is likely what's killing
 * the server, so it fails permanently instead of looping.
 *
 * Returns the requeued run ids — the caller enqueues them once the queue is
 * configured.
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
    // A prior requeued failure for the same trigger+agent means THIS run was
    // already the retry — give up rather than restart-loop.
    const [prior] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.triggerMessageId, run.triggerMessageId),
          eq(runs.agentId, run.agentId),
          eq(runs.error, RESTART_REQUEUED_ERROR)
        )
      )
      .limit(1)
    if (prior) {
      await db
        .update(runs)
        .set({
          status: 'failed',
          error: 'server restarted mid-run twice — giving up',
          finishedAt: Date.now()
        })
        .where(eq(runs.id, run.id))
      continue
    }

    await db
      .update(runs)
      .set({ status: 'failed', error: RESTART_REQUEUED_ERROR, finishedAt: Date.now() })
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
    requeued.push(newId)
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
