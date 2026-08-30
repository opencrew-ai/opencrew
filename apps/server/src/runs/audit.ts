import { desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { RunStepType } from '@opencrew/shared'
import type { AppContext } from '../context'
import { runs, runSteps } from '../db/schema'

/**
 * Append a run step and stream it to the live terminal panels in the UI.
 * INVARIANT: every agent action of any kind goes through here — LLM turns,
 * tool calls/results, posts, approvals. No silent actions.
 */
export async function recordStep(
  ctx: AppContext,
  runId: string,
  type: RunStepType,
  payload: Record<string, unknown>
): Promise<void> {
  const [last] = await ctx.db
    .select({ seq: runSteps.seq })
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(desc(runSteps.seq))
    .limit(1)
  const step = {
    id: nanoid(),
    runId,
    seq: (last?.seq ?? 0) + 1,
    type,
    payload: JSON.stringify(payload),
    createdAt: Date.now()
  }
  await ctx.db.insert(runSteps).values(step)

  const [run] = await ctx.db
    .select({ agentId: runs.agentId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  ctx.hub.broadcast({
    type: 'run_step',
    agentId: run?.agentId ?? '',
    step: { ...step, payload }
  })
}
