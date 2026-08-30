import { asc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type {
  AgentTaskItem,
  SharedTask,
  TaskPriority,
  TaskStatus
} from '@opencrew/shared'
import { agents, tasks } from '../db/schema'
import type { DB } from '../db'
import type { AppContext } from '../context'
import { postMessage } from './post'

type TaskRow = typeof tasks.$inferSelect

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

function toSharedTask(row: TaskRow): SharedTask {
  return {
    id: row.id,
    conversationRootId: row.conversationRootId,
    channelId: row.channelId,
    content: row.content,
    status: row.status,
    priority: row.priority,
    activeForm: row.activeForm ?? undefined,
    createdByType: row.createdByType,
    createdById: row.createdById,
    sourceAgentId: row.sourceAgentId ?? undefined,
    assigneeType: row.assigneeType,
    scheduledFor: row.scheduledFor ?? undefined,
    position: row.position,
    updatedAt: row.updatedAt
  }
}

function sortTasks(items: SharedTask[]): SharedTask[] {
  return [...items].sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.position - b.position
  )
}

export async function listConversationTasks(
  db: DB,
  conversationRootId: string
): Promise<SharedTask[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.conversationRootId, conversationRootId))
    .orderBy(asc(tasks.position))
  return sortTasks(rows.map(toSharedTask))
}

export async function listChannelTasks(db: DB, channelId: string): Promise<SharedTask[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.channelId, channelId))
    .orderBy(asc(tasks.position))
  return sortTasks(rows.map(toSharedTask))
}

/** Broadcast the full (sorted) list for a conversation to every client. */
export async function broadcastTaskState(
  ctx: AppContext,
  conversationRootId: string,
  channelId: string
): Promise<void> {
  const items = await listConversationTasks(ctx.db, conversationRootId)
  ctx.hub.broadcast({
    type: 'task_state',
    tasks: { conversationRootId, channelId, items }
  })
}

async function nextPosition(db: DB, conversationRootId: string): Promise<number> {
  const rows = await db
    .select({ position: tasks.position })
    .from(tasks)
    .where(eq(tasks.conversationRootId, conversationRootId))
  return rows.reduce((max, r) => Math.max(max, r.position), 0) + 1
}

export interface CreateTaskInput {
  conversationRootId: string
  channelId: string
  content: string
  priority: TaskPriority
  createdByType: 'human' | 'agent'
  createdById: string
  sourceAgentId?: string
  status?: TaskStatus
  activeForm?: string
  assigneeType?: 'agent' | 'human'
  scheduledFor?: number
}

export async function createTask(ctx: AppContext, input: CreateTaskInput): Promise<SharedTask> {
  const now = Date.now()
  const row: TaskRow = {
    id: nanoid(),
    workspaceSlug: 'default',
    conversationRootId: input.conversationRootId,
    channelId: input.channelId,
    content: input.content,
    status: input.status ?? 'pending',
    priority: input.priority,
    activeForm: input.activeForm ?? null,
    createdByType: input.createdByType,
    createdById: input.createdById,
    sourceAgentId: input.sourceAgentId ?? null,
    assigneeType: input.assigneeType ?? 'agent',
    scheduledFor: input.scheduledFor ?? null,
    position: await nextPosition(ctx.db, input.conversationRootId),
    createdAt: now,
    updatedAt: now
  }
  await ctx.db.insert(tasks).values(row)
  await broadcastTaskState(ctx, input.conversationRootId, input.channelId)
  return toSharedTask(row)
}

export interface UpdateTaskPatch {
  status?: TaskStatus
  priority?: TaskPriority
  content?: string
  /** null clears the schedule. */
  scheduledFor?: number | null
}

export async function updateTask(
  ctx: AppContext,
  taskId: string,
  patch: UpdateTaskPatch
): Promise<SharedTask | null> {
  const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!row) return null
  await ctx.db
    .update(tasks)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(tasks.id, taskId))
  await broadcastTaskState(ctx, row.conversationRootId, row.channelId)
  return {
    ...toSharedTask(row),
    ...patch,
    scheduledFor: patch.scheduledFor === null ? undefined : (patch.scheduledFor ?? toSharedTask(row).scheduledFor),
    updatedAt: Date.now()
  }
}

/** Every task in the workspace — powers the Tasks panel and calendar. */
export async function listAllTasks(db: DB): Promise<SharedTask[]> {
  const rows = await db.select().from(tasks).orderBy(asc(tasks.createdAt))
  return rows.map(toSharedTask)
}

export async function deleteTask(ctx: AppContext, taskId: string): Promise<boolean> {
  const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!row) return false
  await ctx.db.delete(tasks).where(eq(tasks.id, taskId))
  await broadcastTaskState(ctx, row.conversationRootId, row.channelId)
  return true
}

/**
 * Start a task as its own ACTION THREAD: posts a channel message for the
 * task (mentioning the given agent, the task's own agent, or none so the
 * front desk picks it up), then re-homes the task to that new conversation.
 * Used by the ▶ button and by the scheduler when a task's time arrives.
 */
export async function startTask(
  ctx: AppContext,
  taskId: string,
  initiatorUserId: string,
  agentId?: string
): Promise<{ channelId: string; rootId: string } | null> {
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task || task.status !== 'pending') return null

  const targetAgentId = agentId ?? task.sourceAgentId ?? undefined
  let mention = ''
  if (targetAgentId) {
    const [agent] = await ctx.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, targetAgentId))
      .limit(1)
    if (agent) mention = `@${agent.name} `
  }

  const oldRootId = task.conversationRootId
  const message = await postMessage(ctx, {
    channelId: task.channelId,
    authorType: 'human',
    authorId: initiatorUserId,
    content: `${mention}📌 ${task.content} _(priority: ${task.priority})_`
  })
  await ctx.db
    .update(tasks)
    .set({ conversationRootId: message.id, status: 'in_progress', updatedAt: Date.now() })
    .where(eq(tasks.id, taskId))
  await broadcastTaskState(ctx, oldRootId, task.channelId)
  await broadcastTaskState(ctx, message.id, task.channelId)
  return { channelId: task.channelId, rootId: message.id }
}

/**
 * Merge an agent's TodoWrite snapshot into the SHARED list. Items are
 * matched by exact (trimmed) content — the agent is instructed to echo item
 * text verbatim — so human-created items the agent picked up get their
 * status synced, agent-new items are inserted, and rows the snapshot does
 * not mention (e.g. human items the agent hasn't started) are left alone.
 */
export async function reconcileTodoSnapshot(
  ctx: AppContext,
  input: {
    conversationRootId: string
    channelId: string
    agentId: string
    items: AgentTaskItem[]
  }
): Promise<void> {
  const existing = await ctx.db
    .select()
    .from(tasks)
    .where(eq(tasks.conversationRootId, input.conversationRootId))
  const byContent = new Map(existing.map((row) => [row.content.trim(), row]))
  const now = Date.now()
  let position = existing.reduce((max, r) => Math.max(max, r.position), 0)

  for (const item of input.items) {
    const match = byContent.get(item.content.trim())
    if (match) {
      const activeForm = item.status === 'in_progress' ? (item.activeForm ?? null) : null
      if (
        match.status !== item.status ||
        match.activeForm !== activeForm ||
        match.sourceAgentId !== input.agentId
      ) {
        await ctx.db
          .update(tasks)
          .set({
            status: item.status,
            activeForm,
            sourceAgentId: input.agentId,
            updatedAt: now
          })
          .where(eq(tasks.id, match.id))
      }
    } else {
      position += 1
      await ctx.db.insert(tasks).values({
        id: nanoid(),
        workspaceSlug: 'default',
        conversationRootId: input.conversationRootId,
        channelId: input.channelId,
        content: item.content,
        status: item.status,
        priority: 'medium',
        activeForm: item.status === 'in_progress' ? (item.activeForm ?? null) : null,
        createdByType: 'agent',
        createdById: input.agentId,
        sourceAgentId: input.agentId,
        assigneeType: 'agent',
        position,
        createdAt: now,
        updatedAt: now
      })
    }
  }
  await broadcastTaskState(ctx, input.conversationRootId, input.channelId)
}

/**
 * Render the shared list for the agent's run prompt so human-added tasks
 * and priorities steer the work. Empty string when there are no tasks.
 */
export async function buildTaskPromptSection(
  db: DB,
  conversationRootId: string
): Promise<string> {
  const items = await listConversationTasks(db, conversationRootId)
  if (items.length === 0) return ''
  const lines = items.map((t) => {
    const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
    const author = t.createdByType === 'human' ? ' (added by a human)' : ''
    const assignee =
      t.assigneeType === 'human' ? ' [ASSIGNED TO A HUMAN — do not work this item]' : ''
    return `${box} (${t.priority}) ${t.content}${author}${assignee}`
  })
  return (
    `\n\nShared task list for this conversation (humans and agents co-edit it):\n` +
    lines.join('\n') +
    `\nWork the highest-priority open items first. Keep the list current with TodoWrite, ` +
    `echoing existing item text VERBATIM so status updates match up; add new items as you ` +
    `discover work.`
  )
}

/** Parse a TodoWrite tool input into task items; null when the shape is off. */
export function parseTodoWriteInput(input: unknown): AgentTaskItem[] | null {
  if (typeof input !== 'object' || input === null) return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  const items: AgentTaskItem[] = []
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) return null
    const { content, status, activeForm } = todo as {
      content?: unknown
      status?: unknown
      activeForm?: unknown
    }
    if (typeof content !== 'string') return null
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    items.push({
      content,
      status,
      activeForm: typeof activeForm === 'string' ? activeForm : undefined
    })
  }
  return items
}

/**
 * Coarse, member-safe "now doing" label for a tool call. Deliberately never
 * includes tool INPUT (paths, commands, env) — that detail stays in the
 * admin-only terminal.
 */
export function toolActivityLabel(tool: string): string {
  switch (tool) {
    case 'Bash':
      return 'running a command'
    case 'Write':
    case 'Edit':
      return 'editing files'
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'reading the workspace'
    case 'WebFetch':
    case 'WebSearch':
      return 'researching on the web'
    case 'Browser':
      return 'using the browser'
    case 'TodoWrite':
      return 'planning next steps'
    default:
      return `using ${tool}`
  }
}
