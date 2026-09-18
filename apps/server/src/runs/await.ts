import { and, asc, eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import { messages, runs } from '../db/schema'

const POLL_MS = 500
const TERMINAL = new Set(['done', 'failed', 'cancelled'])

export interface RunReply {
  status: 'done' | 'failed' | 'cancelled' | 'running'
  /** The agent's reply text once the run is done; null otherwise. */
  answer: string | null
}

/**
 * Wait for a run to finish and return its reply. Level-triggered on the
 * runs row (the database is the truth, so this survives restarts and never
 * misses an event); a timeout is a status, not an error — the caller polls
 * again with the run id.
 */
export async function awaitRunReply(ctx: AppContext, runId: string, timeoutMs: number): Promise<RunReply> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const [run] = await ctx.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run) return { status: 'failed', answer: null }
    if (TERMINAL.has(run.status)) {
      const [reply] = await ctx.db
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.runId, runId), eq(messages.authorType, 'agent')))
        .orderBy(asc(messages.createdAt))
        .limit(1)
      return { status: run.status as RunReply['status'], answer: reply?.content ?? null }
    }
    if (Date.now() >= deadline) return { status: 'running', answer: null }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
