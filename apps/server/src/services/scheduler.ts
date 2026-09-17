import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { tasks } from '../db/schema'
import type { AppContext } from '../context'
import { env } from '../env'
import { autopilotUserId, startTask } from './tasks'
import { retireIdleWorkers } from './workers'
import { postMorningBrief } from './today'

const SWEEP_INTERVAL_MS = 30_000
const WORKER_SWEEP_MS = 5 * 60_000

/**
 * Time-based task dispatch. Every sweep:
 *  - AGENT tasks whose scheduledFor has arrived are started as their own
 *    action thread (same as the ▶ button) — the crew fires on schedule.
 *  - HUMAN tasks that just became due trigger an inbox refresh so they
 *    surface in Needs You the moment their time arrives.
 * In-process by design (single mode); moves into the control-plane
 * scheduler with the M3 worker seam.
 */
export function startTaskScheduler(ctx: AppContext): void {
  let lastSweepAt = Date.now()
  let lastWorkerSweepAt = 0
  let lastBriefDay = ''

  const sweep = async () => {
    const now = Date.now()
    // Workers that finished their task go home; judged groups get judged.
    if (now - lastWorkerSweepAt >= WORKER_SWEEP_MS) {
      lastWorkerSweepAt = now
      await retireIdleWorkers(ctx, now).catch(() => {})
    }
    // One morning brief in #hq per day, at the configured local hour.
    const today = new Date(now).toDateString()
    if (lastBriefDay !== today && new Date(now).getHours() >= env.briefHour) {
      lastBriefDay = today
      await postMorningBrief(ctx).catch(() => {})
    }
    try {
      const due = await ctx.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.status, 'pending'),
            isNotNull(tasks.scheduledFor),
            lte(tasks.scheduledFor, now)
          )
        )
      if (due.length > 0) {
        let humanBecameDue = false
        for (const task of due) {
          if (task.assigneeType === 'agent') {
            // Scheduled kickoffs post as Autopilot — never as a person.
            await startTask(ctx, task.id, await autopilotUserId(ctx.db), undefined, 'scheduled')
          } else if ((task.scheduledFor ?? 0) > lastSweepAt) {
            humanBecameDue = true
          }
        }
        if (humanBecameDue) ctx.hub.broadcast({ type: 'attention_changed' })
      }
    } catch {
      // A failed sweep must never kill the loop — next tick retries.
    }
    lastSweepAt = now
  }

  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS)
  timer.unref()
}
