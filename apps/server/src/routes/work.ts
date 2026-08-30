import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import { agents, channels, messages, runs, tasks, users } from '../db/schema'
import {
  broadcastTaskState,
  createTask,
  deleteTask,
  listChannelTasks,
  updateTask
} from '../services/tasks'
import { postMessage } from '../services/post'
import { z } from 'zod'
import { authGuard, fail, memberGuard, ok } from './helpers'

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
  /** Aggregated checklist progress across all agents on this conversation. */
  tasks?: { done: number; total: number }
  /** Present-continuous label of the item currently in progress, if any. */
  currentActivity?: string
}

interface MessageLite {
  id: string
  channelId: string
  threadRootId: string | null
  authorType: 'human' | 'agent' | 'system'
  authorId: string | null
  content: string
  runId: string | null
  manualStatus: string | null
  createdAt: number
}

/** Active run states always win; otherwise a human's manual 'done' closes it. */
function finalStatus(derived: WorkStatus, manualStatus: string | null): WorkStatus {
  if (derived === 'waiting' || derived === 'in_progress') return derived
  if (manualStatus === 'done') return 'done'
  return derived
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

/** Per-conversation checklist rollup: counts + the active item's label. */
function taskRollup(
  rows: {
    conversationRootId: string
    status: string
    activeForm: string | null
    content: string
  }[]
): Map<string, { done: number; total: number; current?: string }> {
  const byRoot = new Map<string, { done: number; total: number; current?: string }>()
  for (const row of rows) {
    const acc = byRoot.get(row.conversationRootId) ?? { done: 0, total: 0 }
    acc.total += 1
    if (row.status === 'completed') acc.done += 1
    if (row.status === 'in_progress' && !acc.current) {
      acc.current = row.activeForm ?? row.content
    }
    byRoot.set(row.conversationRootId, acc)
  }
  return byRoot
}

const createTaskSchema = z.object({
  content: z.string().min(1).max(500),
  priority: z.enum(['high', 'medium', 'low']).default('medium')
})

const updateTaskSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  content: z.string().min(1).max(500).optional()
})

export function registerWorkRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Shared task lists for every conversation in a channel. */
  app.get(
    '/api/channels/:channelId/tasks',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { channelId } = req.params as { channelId: string }
      return ok(await listChannelTasks(ctx.db, channelId))
    }
  )

  /** Human adds a task (with priority) to a conversation's shared list. */
  app.post(
    '/api/conversations/:rootId/tasks',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { rootId } = req.params as { rootId: string }
      const parsed = createTaskSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      const [root] = await ctx.db
        .select({ id: messages.id, channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, rootId))
        .limit(1)
      if (!root) return reply.code(404).send(fail('conversation not found'))
      const task = await createTask(ctx, {
        conversationRootId: root.id,
        channelId: root.channelId,
        content: parsed.data.content,
        priority: parsed.data.priority,
        createdByType: 'human',
        createdById: req.user!.id
      })
      return ok(task)
    }
  )

  app.patch('/api/tasks/:taskId', { preHandler: memberGuard(ctx) }, async (req, reply) => {
    const { taskId } = req.params as { taskId: string }
    const parsed = updateTaskSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const task = await updateTask(ctx, taskId, parsed.data)
    if (!task) return reply.code(404).send(fail('task not found'))
    return ok(task)
  })

  app.delete('/api/tasks/:taskId', { preHandler: memberGuard(ctx) }, async (req, reply) => {
    const { taskId } = req.params as { taskId: string }
    const deleted = await deleteTask(ctx, taskId)
    if (!deleted) return reply.code(404).send(fail('task not found'))
    return ok({ deleted: true })
  })

  /**
   * Start a task as its own ACTION THREAD: posts a channel message for the
   * task (mentioning the chosen agent, or none so the front desk picks it
   * up), then re-homes the task to that new conversation. Every thread is an
   * action; the thread is where the work happens.
   */
  app.post(
    '/api/tasks/:taskId/start',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { taskId } = req.params as { taskId: string }
      const parsed = z
        .object({ agentId: z.string().optional() })
        .safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))

      const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
      if (!task) return reply.code(404).send(fail('task not found'))

      let mention = ''
      if (parsed.data.agentId) {
        const [agent] = await ctx.db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, parsed.data.agentId))
          .limit(1)
        if (!agent) return reply.code(404).send(fail('agent not found'))
        mention = `@${agent.name} `
      }

      const oldRootId = task.conversationRootId
      const message = await postMessage(ctx, {
        channelId: task.channelId,
        authorType: 'human',
        authorId: req.user!.id,
        content: `${mention}📌 ${task.content} _(priority: ${task.priority})_`
      })
      await ctx.db
        .update(tasks)
        .set({ conversationRootId: message.id, status: 'in_progress', updatedAt: Date.now() })
        .where(eq(tasks.id, taskId))
      await broadcastTaskState(ctx, oldRootId, task.channelId)
      await broadcastTaskState(ctx, message.id, task.channelId)
      return ok({ channelId: task.channelId, rootId: message.id })
    }
  )

  app.get('/api/work', { preHandler: authGuard(ctx) }, async () => {
    const [messageRows, runRows, channelRows, taskRows, agentRows, userRows] = await Promise.all([
      ctx.db
        .select({
          id: messages.id,
          channelId: messages.channelId,
          threadRootId: messages.threadRootId,
          authorType: messages.authorType,
          authorId: messages.authorId,
          content: messages.content,
          runId: messages.runId,
          manualStatus: messages.manualStatus,
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
        .select({
          conversationRootId: tasks.conversationRootId,
          status: tasks.status,
          activeForm: tasks.activeForm,
          content: tasks.content
        })
        .from(tasks),
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
    const tasksByRoot = taskRollup(taskRows)

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
        status: finalStatus(deriveStatus(acc.runStatuses), root.manualStatus),
        agents: [...acc.agentIds].flatMap((id) => {
          const agent = agentById.get(id)
          return agent ? [{ id: agent.id, name: agent.name, emoji: agent.avatarEmoji }] : []
        }),
        replyCount: acc.replyCount,
        runCount: acc.runStatuses.length,
        createdAt: root.createdAt,
        lastActivityAt: acc.lastActivityAt || root.createdAt,
        tasks: tasksByRoot.has(rootId)
          ? {
              done: tasksByRoot.get(rootId)!.done,
              total: tasksByRoot.get(rootId)!.total
            }
          : undefined,
        currentActivity: tasksByRoot.get(rootId)?.current
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

  /** Human override: mark a conversation root done, or reopen it. */
  app.post(
    '/api/messages/:messageId/status',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { messageId } = req.params as { messageId: string }
      const parsed = z.object({ done: z.boolean() }).safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))

      const [root] = await ctx.db
        .select({ id: messages.id, channelId: messages.channelId, threadRootId: messages.threadRootId })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      if (!root) return reply.code(404).send(fail('message not found'))
      if (root.threadRootId) return reply.code(400).send(fail('status lives on the conversation root'))

      const manualStatus = parsed.data.done ? 'done' : null
      await ctx.db.update(messages).set({ manualStatus }).where(eq(messages.id, messageId))
      ctx.hub.broadcast({
        type: 'thread_status',
        rootId: messageId,
        channelId: root.channelId,
        manualStatus
      })
      return ok({ rootId: messageId, manualStatus })
    }
  )
}
