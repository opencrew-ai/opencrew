import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { tasks } from '../db/schema'
import type { AppContext } from '../context'
import { autopilotUserId, startTask } from './tasks'

const SWEEP_INTERVAL_MS = 30_000

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

  const sweep = async () => {
    const now = Date.now()
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
