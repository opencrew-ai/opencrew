import type { FastifyInstance } from 'fastify'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { agents, messages, runs, runSteps } from '../db/schema'
import { authGuard, ok } from './helpers'

/** Workspace-level counters + a daily interaction series for the last two weeks. */

const SERIES_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/stats', { preHandler: authGuard(ctx) }, async () => {
    const [agentCount] = await ctx.db.select({ n: sql<number>`count(*)` }).from(agents)
    const [messageCount] = await ctx.db.select({ n: sql<number>`count(*)` }).from(messages)
    const [runCount] = await ctx.db.select({ n: sql<number>`count(*)` }).from(runs)

    const since = Date.now() - SERIES_DAYS * DAY_MS
    const recent = await ctx.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(gt(messages.createdAt, since))

    const dayStart = (ts: number) => {
      const d = new Date(ts)
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    }
    const today = dayStart(Date.now())
    const series: { day: number; count: number }[] = []
    for (let i = SERIES_DAYS - 1; i >= 0; i -= 1) {
      series.push({ day: today - i * DAY_MS, count: 0 })
    }
    const byDay = new Map(series.map((s) => [s.day, s]))
    for (const row of recent) {
      const bucket = byDay.get(dayStart(row.createdAt))
      if (bucket) bucket.count += 1
    }

    // Today's crew economics: run count + real model spend, summed from the
    // per-run session results. Cumulative session costs on resumed runs can
    // overlap slightly, so this reads as an honest approximation (≈).
    const [todayRuns] = await ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(gt(runs.createdAt, today))
    const costRows = await ctx.db
      .select({ payload: runSteps.payload })
      .from(runSteps)
      .where(and(eq(runSteps.type, 'llm_call'), gt(runSteps.createdAt, today)))
    let todayCostUsd = 0
    for (const row of costRows) {
      try {
        const payload = JSON.parse(row.payload) as { phase?: string; costUsd?: number }
        if (payload.phase === 'result' && typeof payload.costUsd === 'number') {
          todayCostUsd += payload.costUsd
        }
      } catch {
        // malformed step payloads never break stats
      }
    }

    return ok({
      agents: Number(agentCount?.n ?? 0),
      messages: Number(messageCount?.n ?? 0),
      runs: Number(runCount?.n ?? 0),
      today: { runs: Number(todayRuns?.n ?? 0), costUsd: todayCostUsd },
      series
    })
  })
}
