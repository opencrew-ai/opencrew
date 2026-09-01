import { desc, eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import { messages, runs, runSteps } from '../db/schema'
import { getAgent } from '../services/agents'
import { postSystemMessage } from '../services/messages'
import { broadcastPresence } from '../services/presence'
import { requeueRun } from './queue'

/**
 * Run watchdog — answers "is that agent stuck or working?" so a human never
 * has to wonder. Every run step is a heartbeat:
 *
 *  - quiet for STALL_NOTICE_MS → the live activity label flips to
 *    "quiet for Xm — possibly stuck" (strip, thread rows, sidebar dot stay
 *    visible, so the doubt is surfaced exactly where the user is looking)
 *  - quiet for STALL_KILL_MS → the run is failed and aborted with a visible
 *    watchdog notice in its conversation; re-mentioning the agent retries
 *    with full session context
 *
 * Long tool calls (builds, installs) are the main false-positive risk, which
 * is why the kill threshold is generous and the notice comes first.
 */

const SWEEP_MS = 60_000
const STALL_NOTICE_MS = 10 * 60_000
const STALL_KILL_MS = 30 * 60_000

// Runs already flagged as quiet — one label flip per run, not one per sweep.
const flagged = new Set<string>()

export function startRunWatchdog(ctx: AppContext): void {
  const timer = setInterval(() => {
    void sweep(ctx).catch(() => {
      // The watchdog must never take the server down.
    })
  }, SWEEP_MS)
  timer.unref()
}

async function sweep(ctx: AppContext): Promise<void> {
  const live = await ctx.db.select().from(runs).where(eq(runs.status, 'running'))
  const now = Date.now()

  for (const run of live) {
    const [lastStep] = await ctx.db
      .select({ createdAt: runSteps.createdAt })
      .from(runSteps)
      .where(eq(runSteps.runId, run.id))
      .orderBy(desc(runSteps.createdAt))
      .limit(1)
    const lastBeat = lastStep?.createdAt ?? run.startedAt ?? run.createdAt
    const silence = now - lastBeat
    if (silence < STALL_NOTICE_MS) {
      flagged.delete(run.id)
      continue
    }

    const [trigger] = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, run.triggerMessageId))
      .limit(1)
    const channelId = trigger?.channelId
    const threadRootId = trigger ? (trigger.threadRootId ?? trigger.id) : null
    const minutes = Math.round(silence / 60_000)

    if (silence >= STALL_KILL_MS) {
      const agent = await getAgent(ctx.db, run.agentId)
      // Visibility timeout expired: kill this delivery and redeliver — the
      // resumed session continues from its last state. Budget-capped so a
      // poisoned run can't cycle forever.
      const redelivery = await requeueRun(ctx.db, run, `watchdog: no activity for ${minutes}m`)
      ctx.hub.broadcast({ type: 'run_status', runId: run.id, agentId: run.agentId, status: 'failed' })
      ctx.hub.broadcast({
        type: 'agent_activity',
        agentId: run.agentId,
        runId: run.id,
        label: null,
        channelId,
        threadRootId
      })
      ctx.activeRuns.get(run.id)?.abort()
      flagged.delete(run.id)
      broadcastPresence(ctx)
      if (redelivery) {
        ctx.queue.enqueue(redelivery.runId)
        if (channelId) {
          await postSystemMessage(
            ctx,
            channelId,
            `⏱ **${agent?.name ?? 'An agent'}** went quiet for ${minutes} minutes — watchdog ` +
              `restarted it (retry ${redelivery.attempt}/2), resuming from its last state.`,
            { threadRootId, runId: redelivery.runId }
          )
        }
      } else if (channelId) {
        await postSystemMessage(
          ctx,
          channelId,
          `⚠️ Watchdog gave up on **${agent?.name ?? 'an agent'}** — quiet for ${minutes} ` +
            `minutes and out of automatic retries. @mention it to try again manually.`,
          { threadRootId, runId: run.id }
        )
      }
    } else if (!flagged.has(run.id)) {
      flagged.add(run.id)
      // Flip the live label so the strip/thread rows show honest doubt.
      ctx.hub.broadcast({
        type: 'agent_activity',
        agentId: run.agentId,
        runId: run.id,
        label: `quiet for ${minutes}m — possibly stuck`,
        channelId,
        threadRootId
      })
    }
  }
}
