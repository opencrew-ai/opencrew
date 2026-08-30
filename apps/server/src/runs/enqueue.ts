import { and, eq, gt } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { extractMentions, type Message, type RunTriggerType } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, runs, users } from '../db/schema'
import { getAgentWithVersion, toAgent } from '../services/agents'
import { postSystemMessage } from '../services/messages'
import { getMaxAgentFanout, getMaxMentionDepth } from '../services/settings'

const HOUR_MS = 60 * 60 * 1000

/** Thread every notice about a message into that message's conversation. */
function conversationThreadOf(message: Message): string | null {
  if (message.threadRootId) return message.threadRootId
  if (message.conversationRootId) return message.conversationRootId
  return message.authorType === 'human' ? message.id : null
}

async function runsInLastHour(ctx: AppContext, agentId: string): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), gt(runs.createdAt, Date.now() - HOUR_MS)))
  return rows.length
}

/**
 * Trigger runs for a new message:
 *  - every @mentioned agent runs (depth-capped for agent→agent chains)
 *  - agents WATCHING this channel run on new human messages, without a
 *    mention. Watchers never fire on agent/system messages, so a watcher
 *    posting its own confirmation can't re-trigger itself or others.
 */
/**
 * Community mode: is this message allowed to put agents to work with full
 * tool access? Admin-authored → no. Agent-authored → inherits the flag from
 * the run that produced the message (restriction survives delegation
 * chains). Member/guest-authored → yes: agents may respond, chat-only.
 */
async function isRestrictedAuthor(ctx: AppContext, message: Message): Promise<boolean> {
  if (message.authorType === 'agent') {
    if (!message.runId) return true
    const [parentRun] = await ctx.db
      .select({ restricted: runs.restricted })
      .from(runs)
      .where(eq(runs.id, message.runId))
      .limit(1)
    return parentRun?.restricted ?? true
  }
  if (message.authorType === 'human' && message.authorId) {
    const [author] = await ctx.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, message.authorId))
      .limit(1)
    return author?.role !== 'admin'
  }
  return true
}

export async function enqueueMentionRuns(
  ctx: AppContext,
  message: Message,
  depth: number
): Promise<void> {
  const agentRows = await ctx.db.select().from(agents)
  const allAgents = agentRows.map(toAgent)
  const names = allAgents.map((a) => a.name)
  const mentioned = extractMentions(message.content, names)
  const restricted = await isRestrictedAuthor(ctx, message)

  // Agent→agent chains make the crew feel alive; the cap (Workspace
  // settings in the UI) plus maxRunsPerHour keeps loops impossible.
  const maxDepth = await getMaxMentionDepth(ctx.db)
  if (mentioned.length > 0 && depth >= maxDepth) {
    await postSystemMessage(
      ctx,
      message.channelId,
      `Mention chain depth limit (${maxDepth}) reached — not triggering further agents. Adjust it in Workspace settings.`,
      { threadRootId: conversationThreadOf(message) }
    )
  } else {
    // Fan-out guard: an AGENT message that name-drops the whole crew (a lane
    // table, a status list) must not spin up every agent it mentions. Humans
    // are never capped — a human's mentions are always deliberate.
    const fanoutCap =
      message.authorType === 'agent' ? await getMaxAgentFanout(ctx.db) : Infinity
    let triggered = 0
    const skipped: string[] = []
    for (const name of mentioned) {
      const agent = allAgents.find((a) => a.name === name)
      if (!agent) continue
      // An agent mentioning itself must not re-trigger itself.
      if (message.authorType === 'agent' && message.authorId === agent.id) continue
      // Community mode: visitors can't direct-task agents — watchers
      // (Captain) will still pick the message up below.
      if (restricted && message.authorType === 'human') continue
      if (triggered >= fanoutCap) {
        skipped.push(agent.name)
        continue
      }
      await enqueueRun(ctx, agent.id, message, depth, 'mention', restricted)
      triggered += 1
    }
    if (skipped.length > 0) {
      await postSystemMessage(
        ctx,
        message.channelId,
        `⚠️ ${skipped.map((n) => `**${n}**`).join(', ')} ${skipped.length === 1 ? 'was' : 'were'} ` +
          `mentioned but not triggered — agent messages may trigger at most ${fanoutCap} ` +
          `agents (Workspace settings → fan-out limit). Delegate in separate messages if they're all needed.`,
        { threadRootId: conversationThreadOf(message) }
      )
    }
  }

  if (message.authorType !== 'human') return
  // A human who @mentions an agent has chosen their recipient — watchers
  // (including the orchestrator) stay out of it. Visitors' mentions never
  // trigger directly, so their messages always reach the watchers.
  if (mentioned.length > 0 && !restricted) return

  const createdAtById = new Map(agentRows.map((row) => [row.id, row.createdAt]))
  const watchers: { agentId: string; watchesAll: boolean; createdAt: number }[] = []
  for (const agent of allAgents) {
    const full = await getAgentWithVersion(ctx.db, agent.id)
    const watched = full?.currentVersion.capabilities.watchesChannels ?? []
    // '*' = watches every channel (orchestrator pattern).
    if (full && (watched.includes('*') || watched.includes(message.channelId))) {
      watchers.push({
        agentId: agent.id,
        watchesAll: watched.includes('*'),
        createdAt: createdAtById.get(agent.id) ?? Number.MAX_SAFE_INTEGER
      })
    }
  }
  // EXACTLY ONE front desk answers an untargeted message — never a pile-on,
  // even when several agents are configured as watchers. Preference: an
  // orchestrator ('*' watcher) over channel-scoped watchers; earliest-created
  // wins ties (the workspace's original orchestrator, e.g. Captain). It
  // delegates by @mentioning specialists.
  const orchestrators = watchers.filter((w) => w.watchesAll)
  const pool = orchestrators.length > 0 ? orchestrators : watchers
  const frontDesk = pool.sort((a, b) => a.createdAt - b.createdAt)[0]
  if (frontDesk) {
    await enqueueRun(ctx, frontDesk.agentId, message, 0, 'watch', restricted)
  }
}

export async function enqueueRun(
  ctx: AppContext,
  agentId: string,
  triggerMessage: Message,
  depth: number,
  triggerType: RunTriggerType,
  restricted: boolean
): Promise<void> {
  const agent = await getAgentWithVersion(ctx.db, agentId)
  if (!agent) return

  if (agent.status === 'paused') {
    if (triggerType === 'mention') {
      await postSystemMessage(
        ctx,
        triggerMessage.channelId,
        `${agent.avatarEmoji} **${agent.name}** is paused and won't respond.`,
        { threadRootId: conversationThreadOf(triggerMessage) }
      )
    }
    return
  }

  // GUARDRAIL: maxRunsPerHour enforced at enqueue time.
  const limit = agent.currentVersion.capabilities.maxRunsPerHour
  if ((await runsInLastHour(ctx, agentId)) >= limit) {
    await postSystemMessage(
      ctx,
      triggerMessage.channelId,
      `⛔ **${agent.name}** hit its rate limit (${limit} runs/hour). Try again later.`,
      { threadRootId: conversationThreadOf(triggerMessage) }
    )
    return
  }

  const runId = nanoid()
  // Pin the version now: an in-flight run is unaffected by later config edits.
  await ctx.db.insert(runs).values({
    id: runId,
    agentId,
    agentVersionId: agent.currentVersionId,
    triggerMessageId: triggerMessage.id,
    triggerType,
    status: 'queued',
    depth,
    restricted,
    createdAt: Date.now()
  })
  ctx.hub.broadcast({ type: 'run_status', runId, agentId, status: 'queued' })
  ctx.queue.enqueue(runId)
}
