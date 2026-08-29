import { and, eq, gt } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { extractMentions, type Message } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, runs } from '../db/schema'
import { getAgentWithVersion, toAgent } from '../services/agents'
import { postSystemMessage } from '../services/messages'

// Agent→agent chains make the crew feel alive; the cap plus maxRunsPerHour
// keeps them from spiraling into infinite loops.
const MAX_MENTION_DEPTH = 4

const HOUR_MS = 60 * 60 * 1000

function runsInLastHour(ctx: AppContext, agentId: string): number {
  return ctx.db
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), gt(runs.createdAt, Date.now() - HOUR_MS)))
    .all().length
}

/**
 * Scan a new message for @agent mentions and enqueue a run per mentioned
 * agent. Depth caps agent→agent chains at MAX_MENTION_DEPTH to prevent loops.
 */
export function enqueueMentionRuns(
  ctx: AppContext,
  message: Message,
  depth: number
): void {
  const allAgents = ctx.db.select().from(agents).all().map(toAgent)
  const names = allAgents.map((a) => a.name)
  const mentioned = extractMentions(message.content, names)
  if (mentioned.length === 0) return

  if (depth >= MAX_MENTION_DEPTH) {
    postSystemMessage(
      ctx,
      message.channelId,
      `Mention chain depth limit (${MAX_MENTION_DEPTH}) reached — not triggering further agents.`,
      { threadRootId: message.threadRootId }
    )
    return
  }

  for (const name of mentioned) {
    const agent = allAgents.find((a) => a.name === name)
    if (!agent) continue
    // An agent mentioning itself must not re-trigger itself.
    if (message.authorType === 'agent' && message.authorId === agent.id) continue
    enqueueRun(ctx, agent.id, message, depth)
  }
}

function enqueueRun(
  ctx: AppContext,
  agentId: string,
  triggerMessage: Message,
  depth: number
): void {
  const agent = getAgentWithVersion(ctx.db, agentId)
  if (!agent) return

  if (agent.status === 'paused') {
    postSystemMessage(
      ctx,
      triggerMessage.channelId,
      `${agent.avatarEmoji} **${agent.name}** is paused and won't respond.`,
      { threadRootId: triggerMessage.threadRootId }
    )
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
      status: 'queued',
      depth,
      createdAt: Date.now()
    })
    .run()
  ctx.hub.broadcast({ type: 'run_status', runId, agentId, status: 'queued' })
  ctx.queue.enqueue(runId)
}
