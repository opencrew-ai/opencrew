import { eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { FabricHooks } from '../fabric/runtime'
import type { FabricTask } from '../fabric/store'
import { runs } from '../db/schema'
import { getAgent } from '../services/agents'
import { denyPendingApprovalsForRun } from '../services/approvals'
import { flipRemainingReviewDocs } from '../services/artifacts'
import { postSystemMessage } from '../services/messages'
import { broadcastPresence } from '../services/presence'

/**
 * Turn-task glue: translates generic fabric lifecycle events into run-row
 * updates and conversation-facing notices. The kernel stays UI-blind; this
 * is the only place fabric state and the runs table meet.
 */

interface TurnPayload {
  agentId?: string
  channelId?: string
  threadRootId?: string | null
  triggerType?: string
}

export function fabricHooksFor(ctx: AppContext): FabricHooks {
  return {
    // Attempt failed within budget: the task is ready again; the resumed
    // session will continue from wherever the failed attempt left off.
    onRedelivered: async (task, reason, nextAttempt) => {
      const p = task.payload as TurnPayload
      const [run] = await ctx.db.select().from(runs).where(eq(runs.id, task.id)).limit(1)
      if (!run) return
      await ctx.db
        .update(runs)
        .set({ status: 'queued', error: `${reason} — retrying` })
        .where(eq(runs.id, task.id))
      ctx.hub.broadcast({ type: 'run_status', runId: task.id, agentId: run.agentId, status: 'queued' })
      ctx.hub.broadcast({
        type: 'agent_activity',
        agentId: run.agentId,
        runId: task.id,
        label: null,
        channelId: p.channelId,
        threadRootId: p.threadRootId ?? null
      })
      broadcastPresence(ctx)
      if (p.channelId) {
        const agent = await getAgent(ctx.db, run.agentId)
        // A refunded restart redelivery is routine, not a strike — no attempt
        // counter to read as the task being in trouble.
        const notice =
          reason === 'server restarted'
            ? `⏱ **${agent?.name ?? 'An agent'}** was interrupted by a server restart — ` +
              `resuming from its last state (retry budget untouched).`
            : `⏱ **${agent?.name ?? 'An agent'}**'s attempt was interrupted (${reason}) — ` +
              `retrying (attempt ${nextAttempt}/${task.maxAttempts}), resuming from its last state.`
        await postSystemMessage(ctx, p.channelId, notice, {
          threadRootId: p.threadRootId ?? null,
          runId: task.id
        })
      }
      ctx.fabric.wake()
    },

    // Budget spent: dead-letter. The human re-mentions to retry fresh.
    onDead: async (task, reason) => {
      const p = task.payload as TurnPayload
      const [run] = await ctx.db.select().from(runs).where(eq(runs.id, task.id)).limit(1)
      if (!run) return
      await ctx.db
        .update(runs)
        .set({
          status: 'failed',
          error: `${reason} — retry limit reached, giving up`,
          finishedAt: Date.now()
        })
        .where(eq(runs.id, task.id))
      ctx.hub.broadcast({ type: 'run_status', runId: task.id, agentId: run.agentId, status: 'failed' })
      ctx.hub.broadcast({
        type: 'agent_activity',
        agentId: run.agentId,
        runId: task.id,
        label: null,
        channelId: p.channelId,
        threadRootId: p.threadRootId ?? null
      })
      broadcastPresence(ctx)
      await denyPendingApprovalsForRun(ctx, task.id, 'system:run-ended')
      if (p.triggerType === 'review' && p.threadRootId) {
        await flipRemainingReviewDocs(ctx, p.threadRootId)
      }
      if (p.channelId) {
        const agent = await getAgent(ctx.db, run.agentId)
        await postSystemMessage(
          ctx,
          p.channelId,
          `⚠️ Gave up on **${agent?.name ?? 'an agent'}** — ${reason}, out of automatic ` +
            `retries. @mention it to try again manually.`,
          { threadRootId: p.threadRootId ?? null, runId: task.id }
        )
      }
    },

    // Honest doubt, surfaced where the user is looking (strip, thread, dot).
    onStallNotice: async (task: FabricTask, minutes: number) => {
      const p = task.payload as TurnPayload
      if (!p.agentId) return
      ctx.hub.broadcast({
        type: 'agent_activity',
        agentId: p.agentId,
        runId: task.id,
        label: `quiet for ${minutes}m — possibly stuck`,
        channelId: p.channelId,
        threadRootId: p.threadRootId ?? null
      })
    }
  }
}
