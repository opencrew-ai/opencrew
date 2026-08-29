import { and, eq, gt } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { extractMentions, type Message, type RunTriggerType } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, runs } from '../db/schema'
import { getAgentWithVersion, toAgent } from '../services/agents'
import { postSystemMessage } from '../services/messages'
import { getMaxMentionDepth } from '../services/settings'

const HOUR_MS = 60 * 60 * 1000

function runsInLastHour(ctx: AppContext, agentId: string): number {
  return ctx.db
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), gt(runs.createdAt, Date.now() - HOUR_MS)))
    .all().length
}

/**
 * Trigger runs for a new message:
 *  - every @mentioned agent runs (depth-capped for agent→agent chains)
 *  - agents WATCHING this channel run on new human messages, without a
 *    mention. Watchers never fire on agent/system messages, so a watcher
 *    posting its own confirmation can't re-trigger itself or others.
 */
export function enqueueMentionRuns(
  ctx: AppContext,
  message: Message,
  depth: number
): void {
  const allAgents = ctx.db.select().from(agents).all().map(toAgent)
  const names = allAgents.map((a) => a.name)
  const mentioned = extractMentions(message.content, names)

  // Agent→agent chains make the crew feel alive; the cap (Workspace
  // settings in the UI) plus maxRunsPerHour keeps loops impossible.
  const maxDepth = getMaxMentionDepth(ctx.db)
  if (mentioned.length > 0 && depth >= maxDepth) {
    postSystemMessage(
      ctx,
      message.channelId,
      `Mention chain depth limit (${maxDepth}) reached — not triggering further agents. Adjust it in Workspace settings.`,
      { threadRootId: message.threadRootId }
    )
  } else {
    for (const name of mentioned) {
      const agent = allAgents.find((a) => a.name === name)
      if (!agent) continue
      // An agent mentioning itself must not re-trigger itself.
      if (message.authorType === 'agent' && message.authorId === agent.id) continue
      enqueueRun(ctx, agent.id, message, depth, 'mention')
    }
  }

  if (message.authorType !== 'human') return
  // A human who @mentions an agent has chosen their recipient — watchers
  // (including the orchestrator) stay out of it.
  if (mentioned.length > 0) return
  for (const agent of allAgents) {
    const full = getAgentWithVersion(ctx.db, agent.id)
    const watched = full?.currentVersion.capabilities.watchesChannels ?? []
    // '*' = watches every channel (orchestrator pattern).
    if (full && (watched.includes('*') || watched.includes(message.channelId))) {
      enqueueRun(ctx, agent.id, message, 0, 'watch')
    }
  }
}

function enqueueRun(
  ctx: AppContext,
  agentId: string,
  triggerMessage: Message,
  depth: number,
  triggerType: RunTriggerType
): void {
  const agent = getAgentWithVersion(ctx.db, agentId)
  if (!agent) return

  if (agent.status === 'paused') {
    if (triggerType === 'mention') {
      postSystemMessage(
        ctx,
        triggerMessage.channelId,
        `${agent.avatarEmoji} **${agent.name}** is paused and won't respond.`,
        { threadRootId: triggerMessage.threadRootId }
      )
    }
    return
  }

  // GUARDRAIL: maxRunsPerHour enforced at enqueue time.
  const limit = agent.currentVersion.capabilities.maxRunsPerHour
  if (runsInLastHour(ctx, agentId) >= limit) {
    postSystemMessage(
      ctx,
      triggerMessage.channelId,
      `⛔ **${agent.name}** hit its rate limit (${limit} runs/hour). Try again later.`,
      { threadRootId: triggerMessage.threadRootId }
    )
    return
  }

  const runId = nanoid()
  // Pin the version now: an in-flight run is unaffected by later config edits.
  ctx.db
    .insert(runs)
    .values({
      id: runId,
      agentId,
      agentVersionId: agent.currentVersionId,
      triggerMessageId: triggerMessage.id,
      triggerType,
      status: 'queued',
      depth,
      createdAt: Date.now()
    })
    .run()
  ctx.hub.broadcast({ type: 'run_status', runId, agentId, status: 'queued' })
  ctx.queue.enqueue(runId)
}
