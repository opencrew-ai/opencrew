import type { FastifyInstance } from 'fastify'
import { gt, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { agents, messages, runs } from '../db/schema'
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

    return ok({
      agents: Number(agentCount?.n ?? 0),
      messages: Number(messageCount?.n ?? 0),
      runs: Number(runCount?.n ?? 0),
      series
    })
  })
}
