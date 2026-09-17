import { and, eq, gt, inArray } from 'drizzle-orm'
import type { DB } from '../db'
import { runs, runSteps } from '../db/schema'

/**
 * Budgets — what a project may spend per calendar day. Spend is the sum of
 * the model cost each turn's session reported (the `result` step), read
 * the same way the sidebar's counter and the Today page read it.
 */

export function startOfToday(now: number = Date.now()): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Model spend today for one project (null = HQ), in USD. */
export async function projectSpendToday(db: DB, projectId: string | null): Promise<number> {
  const since = startOfToday()
  const scope = projectId ? eq(runs.projectId, projectId) : eq(runs.projectId, '')
  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(gt(runs.createdAt, since), scope))
  if (runRows.length === 0) return 0
  const steps = await db
    .select({ payload: runSteps.payload })
    .from(runSteps)
    .where(
      and(
        inArray(
          runSteps.runId,
          runRows.map((r) => r.id)
        ),
        eq(runSteps.type, 'llm_call'),
        gt(runSteps.createdAt, since)
      )
    )
  return sumResultCosts(steps.map((s) => s.payload))
}

export function sumResultCosts(payloads: string[]): number {
  let total = 0
  for (const raw of payloads) {
    try {
      const payload = JSON.parse(raw) as { phase?: string; costUsd?: number }
      if (payload.phase === 'result' && typeof payload.costUsd === 'number') total += payload.costUsd
    } catch {
      // malformed step payloads never break accounting
    }
  }
  return total
}

/** True when a project with a cap has spent it today. 0 = unlimited. */
export function isOverBudget(spendUsd: number, dailyBudgetUsd: number): boolean {
  return dailyBudgetUsd > 0 && spendUsd >= dailyBudgetUsd
}
