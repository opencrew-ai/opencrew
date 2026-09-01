import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { agents, approvals, runs } from '../db/schema'
import { cancelPendingFabricTask } from '../fabric/store'
import { getAgent } from '../services/agents'
import { resolveApproval } from '../services/approvals'
import { postSystemMessage } from '../services/messages'
import { broadcastPresence } from '../services/presence'
import { recordStep } from '../runs/audit'

registerOpenCrewTool({
  name: 'stop_agent',
  description:
    "Emergency brake: stop ALL of one agent's active work — cancel its queued runs, deny " +
    'its pending tool approvals, and abort its live sessions. Use when an agent is stuck, ' +
    'looping, duplicating work, or executing something now obsolete. In-flight work is ' +
    'lost; the agent stays active and can be re-triggered with fresh instructions. ' +
    'You cannot stop yourself.',
  inputShape: {
    name: z.string().min(1).max(40).describe('Exact name of the agent to stop'),
    reason: z
      .string()
      .min(1)
      .max(300)
      .describe('Why — posted to the conversation as the audit trail')
  },
  execute: async (input, ctx) => {
    const [target] = await ctx.app.db
      .select()
      .from(agents)
      .where(eq(agents.name, input.name))
      .limit(1)
    if (!target) throw new Error(`no agent named "${input.name}" — check list_agents`)
    if (target.id === ctx.agentId) {
      throw new Error('you cannot stop yourself — just finish your reply and end the run')
    }

    const stoppedBy = `agent:${ctx.agentId}`

    // 1. Queued runs (fabric: ready or parked tasks): cancel the task first
    // so the scheduler can never claim it, then mark the run row.
    const queued = await ctx.app.db
      .select()
      .from(runs)
      .where(
        and(eq(runs.agentId, target.id), inArray(runs.status, ['queued', 'awaiting_approval']))
      )
    for (const run of queued) {
      await cancelPendingFabricTask(ctx.app.db, run.id)
      await ctx.app.db
        .update(runs)
        .set({ status: 'cancelled', error: `stopped by ${stoppedBy}`, finishedAt: Date.now() })
        .where(eq(runs.id, run.id))
      ctx.app.hub.broadcast({
        type: 'run_status',
        runId: run.id,
        agentId: target.id,
        status: 'cancelled'
      })
    }

    // 2. Pending approvals on the target's runs: deny — resolving wakes
    // blocked sessions so the abort below lands cleanly.
    const targetRunIds = (
      await ctx.app.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.agentId, target.id))
    ).map((r) => r.id)
    let denied = 0
    if (targetRunIds.length > 0) {
      const pending = await ctx.app.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.status, 'pending'), inArray(approvals.runId, targetRunIds)))
      for (const approval of pending) {
        try {
          await resolveApproval(ctx.app, approval.id, 'denied', stoppedBy)
          denied += 1
        } catch {
          // already resolved in a race — fine
        }
      }
    }

    // 3. Live sessions: pre-mark cancelled, then abort — the executor sees
    // the cancelled run row and settles the task as cancelled (no retries).
    let aborted = 0
    for (const runId of ctx.app.fabric.activeTaskIds()) {
      const [run] = await ctx.app.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
      if (run && run.agentId === target.id && run.status === 'running') {
        await ctx.app.db
          .update(runs)
          .set({ status: 'cancelled', error: `stopped by ${stoppedBy}`, finishedAt: Date.now() })
          .where(eq(runs.id, runId))
        ctx.app.hub.broadcast({ type: 'run_status', runId, agentId: target.id, status: 'cancelled' })
        if (ctx.app.fabric.abortTask(runId, `stopped by ${stoppedBy}`)) aborted += 1
      }
    }
    // The aborted sessions never reach their own cleanup — clear the live
    // activity indicator explicitly so the UI doesn't show a ghost worker.
    ctx.app.hub.broadcast({
      type: 'agent_activity',
      agentId: target.id,
      runId: '',
      label: null
    })
    broadcastPresence(ctx.app)

    const total = queued.length + aborted
    const stopper = await getAgent(ctx.app.db, ctx.agentId)
    await postSystemMessage(
      ctx.app,
      ctx.channelId,
      `🛑 **${stopper?.name ?? 'An agent'}** stopped **${target.name}** — ${input.reason} ` +
        `(${aborted} live, ${queued.length} queued, ${denied} approval${denied === 1 ? '' : 's'} denied)`,
      { threadRootId: ctx.threadRootId }
    )
    await recordStep(ctx.app, ctx.runId, 'tool_call', {
      tool: 'stop_agent',
      input: { name: input.name, reason: input.reason, aborted, queued: queued.length, denied }
    })

    if (total === 0 && denied === 0) {
      return `${target.name} had nothing running — no queued runs, live sessions, or pending approvals.`
    }
    return (
      `Stopped ${target.name}: ${aborted} live session${aborted === 1 ? '' : 's'} aborted, ` +
      `${queued.length} queued run${queued.length === 1 ? '' : 's'} cancelled, ${denied} ` +
      `approval${denied === 1 ? '' : 's'} denied. The agent is still active — re-trigger with ` +
      `fresh instructions when ready.`
    )
  }
})
