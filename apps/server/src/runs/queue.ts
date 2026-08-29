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

/**
 * Crash recovery: approval waits live in process memory (a blocked Claude
 * Code session), so anything mid-flight when the process died is failed and
 * its pending approvals are auto-denied.
 */
export async function failInterruptedRuns(db: DB): Promise<void> {
  await db
    .update(runs)
    .set({ status: 'failed', error: 'server restarted mid-run', finishedAt: Date.now() })
    .where(inArray(runs.status, ['queued', 'running', 'awaiting_approval']))
  await db
    .update(approvals)
    .set({ status: 'denied', resolvedBy: 'system:restart', resolvedAt: Date.now() })
    .where(eq(approvals.status, 'pending'))
}

export async function getRunAgentId(db: DB, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: runs.agentId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  return row?.agentId ?? null
}
