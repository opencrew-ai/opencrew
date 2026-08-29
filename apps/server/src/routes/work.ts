import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import { agents, channels, messages, runs, users } from '../db/schema'
import { authGuard, ok } from './helpers'

/**
 * Work view — every conversation (a human message and everything it caused,
 * including agent-to-agent delegation chains) is one unit of work with a
 * status derived from its runs. No manual labeling anywhere.
 */

const MESSAGE_WINDOW = 3000
const RUN_WINDOW = 3000
const MAX_ITEMS = 500
const EXCERPT_LENGTH = 200
const CHAIN_DEPTH_LIMIT = 20

export type WorkStatus = 'not_started' | 'waiting' | 'in_progress' | 'done' | 'failed'

interface WorkAgent {
  id: string
  name: string
  emoji: string
}

export interface WorkItem {
  rootId: string
  channelId: string
  channelName: string
  excerpt: string
  authorName: string
  status: WorkStatus
  agents: WorkAgent[]
  replyCount: number
  runCount: number
  createdAt: number
  lastActivityAt: number
}

interface MessageLite {
  id: string
  channelId: string
  threadRootId: string | null
  authorType: 'human' | 'agent' | 'system'
  authorId: string | null
  content: string
  runId: string | null
  createdAt: number
}

interface RunLite {
  id: string
  agentId: string
  triggerMessageId: string
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled'
  createdAt: number
}

function deriveStatus(runStatuses: readonly RunLite['status'][]): WorkStatus {
  if (runStatuses.length === 0) return 'not_started'
  if (runStatuses.some((s) => s === 'awaiting_approval')) return 'waiting'
  if (runStatuses.some((s) => s === 'running' || s === 'queued')) return 'in_progress'
  if (runStatuses.some((s) => s === 'failed')) return 'failed'
  return 'done'
}

/**
 * Resolve the message a unit of work hangs off. Thread replies resolve to the
 * thread root; agent messages resolve through the run that produced them to
 * the message that triggered that run — walking delegation chains
 * (human → Captain → Coder) back to the original human message.
 */
function makeRootResolver(
  msgById: ReadonlyMap<string, MessageLite>,
  runById: ReadonlyMap<string, RunLite>
): (msg: MessageLite) => string {
  const memo = new Map<string, string>()

  return function resolve(msg: MessageLite): string {
    const cached = memo.get(msg.id)
    if (cached) return cached

    let current = msg
    const visited = new Set<string>()
    for (let hop = 0; hop < CHAIN_DEPTH_LIMIT; hop += 1) {
      if (visited.has(current.id)) break
      visited.add(current.id)

      if (current.threadRootId) {
        const root = msgById.get(current.threadRootId)
        if (!root) {
          memo.set(msg.id, current.threadRootId)
          return current.threadRootId
        }
        current = root
        continue
      }

      if (current.authorType !== 'human' && current.runId) {
        const run = runById.get(current.runId)
        const trigger = run ? msgById.get(run.triggerMessageId) : undefined
        if (trigger && trigger.id !== current.id) {
          current = trigger
          continue
        }
      }

      break
    }

    memo.set(msg.id, current.id)
    return current.id
  }
}

export function registerWorkRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/work', { preHandler: authGuard(ctx) }, async () => {
    const [messageRows, runRows, channelRows, agentRows, userRows] = await Promise.all([
      ctx.db
        .select({
          id: messages.id,
          channelId: messages.channelId,
          threadRootId: messages.threadRootId,
          authorType: messages.authorType,
          authorId: messages.authorId,
          content: messages.content,
          runId: messages.runId,
          createdAt: messages.createdAt
        })
        .from(messages)
        .orderBy(desc(messages.createdAt))
        .limit(MESSAGE_WINDOW),
      ctx.db
        .select({
          id: runs.id,
          agentId: runs.agentId,
          triggerMessageId: runs.triggerMessageId,
          status: runs.status,
          createdAt: runs.createdAt
        })
        .from(runs)
        .orderBy(desc(runs.createdAt))
        .limit(RUN_WINDOW),
      ctx.db.select({ id: channels.id, name: channels.name }).from(channels),
      ctx.db
        .select({ id: agents.id, name: agents.name, avatarEmoji: agents.avatarEmoji })
        .from(agents),
      ctx.db.select({ id: users.id, name: users.name }).from(users)
    ])

    const msgById = new Map<string, MessageLite>(messageRows.map((m) => [m.id, m]))
    const runById = new Map<string, RunLite>(runRows.map((r) => [r.id, r]))
    const channelNameById = new Map(channelRows.map((c) => [c.id, c.name]))
    const agentById = new Map(agentRows.map((a) => [a.id, a]))
    const userNameById = new Map(userRows.map((u) => [u.id, u.name]))
    const resolveRoot = makeRootResolver(msgById, runById)

    interface Accumulator {
      runStatuses: RunLite['status'][]
      agentIds: Set<string>
      replyCount: number
      lastActivityAt: number
    }
    const byRoot = new Map<string, Accumulator>()
    const accFor = (rootId: string): Accumulator => {
      const existing = byRoot.get(rootId)
      if (existing) return existing
      const fresh: Accumulator = {
        runStatuses: [],
        agentIds: new Set(),
        replyCount: 0,
        lastActivityAt: 0
      }
      byRoot.set(rootId, fresh)
      return fresh
    }

    for (const msg of messageRows) {
      const rootId = resolveRoot(msg)
      const acc = accFor(rootId)
      acc.lastActivityAt = Math.max(acc.lastActivityAt, msg.createdAt)
      if (msg.id !== rootId) acc.replyCount += 1
      if (msg.authorType === 'agent' && msg.authorId) acc.agentIds.add(msg.authorId)
    }

    for (const run of runRows) {
      const trigger = msgById.get(run.triggerMessageId)
      const rootId = trigger ? resolveRoot(trigger) : run.triggerMessageId
      const acc = accFor(rootId)
      acc.runStatuses.push(run.status)
      acc.agentIds.add(run.agentId)
    }

    const items: WorkItem[] = []
    for (const [rootId, acc] of byRoot) {
      const root = msgById.get(rootId)
      if (!root) continue
      // Units of work: human-authored conversations, plus anything with runs
      // (covers threads rooted on an agent message where a human delegated).
      if (root.authorType !== 'human' && acc.runStatuses.length === 0) continue
      if (root.authorType === 'system') continue

      const authorName =
        root.authorType === 'human'
          ? (root.authorId ? userNameById.get(root.authorId) : undefined) ?? 'someone'
          : (root.authorId ? agentById.get(root.authorId)?.name : undefined) ?? 'agent'

      items.push({
        rootId,
        channelId: root.channelId,
        channelName: channelNameById.get(root.channelId) ?? root.channelId,
        excerpt:
          root.content.length > EXCERPT_LENGTH
            ? `${root.content.slice(0, EXCERPT_LENGTH)}…`
            : root.content,
        authorName,
        status: deriveStatus(acc.runStatuses),
        agents: [...acc.agentIds].flatMap((id) => {
          const agent = agentById.get(id)
          return agent ? [{ id: agent.id, name: agent.name, emoji: agent.avatarEmoji }] : []
        }),
        replyCount: acc.replyCount,
        runCount: acc.runStatuses.length,
        createdAt: root.createdAt,
        lastActivityAt: acc.lastActivityAt || root.createdAt
      })
    }

    items.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return ok(items.slice(0, MAX_ITEMS))
  })

  /** Cheap global counter for the sidebar badge. */
  app.get('/api/work/summary', { preHandler: authGuard(ctx) }, async () => {
    const waitingRuns = await ctx.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, 'awaiting_approval'))
    return ok({ waiting: waitingRuns.length })
  })
}
