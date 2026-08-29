import { eq, inArray } from 'drizzle-orm'
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
  private lookupAgent: (runId: string) => string | null = () => null

  configure(executor: ExecutorFn, lookupAgent: (runId: string) => string | null): void {
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
      this.active.set(runId, this.lookupAgent(runId) ?? '')
      void this.executor(runId)
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

/**
 * Crash recovery: approval waits live in process memory (a blocked Claude
 * Code session), so anything mid-flight when the process died is failed and
 * its pending approvals are auto-denied.
 */
export function failInterruptedRuns(db: DB): void {
  db.update(runs)
    .set({ status: 'failed', error: 'server restarted mid-run', finishedAt: Date.now() })
    .where(inArray(runs.status, ['queued', 'running', 'awaiting_approval']))
    .run()
  db.update(approvals)
    .set({ status: 'denied', resolvedBy: 'system:restart', resolvedAt: Date.now() })
    .where(eq(approvals.status, 'pending'))
    .run()
}

export function getRunAgentId(db: DB, runId: string): string | null {
  const row = db
    .select({ agentId: runs.agentId })
    .from(runs)
    .where(eq(runs.id, runId))
    .get()
  return row?.agentId ?? null
}
