import { asc, eq, inArray, like } from 'drizzle-orm'
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

function parseBlockedBy(json: string | null): string[] | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json) as string[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

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
    blockedBy: parseBlockedBy(row.blockedBy),
    position: row.position,
    updatedAt: row.updatedAt
  }
}

/**
 * A task is blocked while any of its blockers is an OPEN task. Blockers that
 * were deleted or completed no longer block; unknown ids are ignored.
 */
export async function isTaskBlocked(db: DB, row: TaskRow): Promise<boolean> {
  const blockers = parseBlockedBy(row.blockedBy)
  if (!blockers) return false
  const open = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, blockers))
  return open.some((t) => t.status !== 'completed')
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
  /** Task ids that must complete before this one may start. */
  blockedBy?: string[]
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
    blockedBy: input.blockedBy && input.blockedBy.length > 0 ? JSON.stringify(input.blockedBy) : null,
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
  /** Agent claiming/working the task (set by update_task). */
  sourceAgentId?: string
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
  if (patch.status === 'completed') await dispatchUnblockedTasks(ctx, taskId)
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
  // A deleted blocker unblocks its dependents just like a completed one.
  await dispatchUnblockedTasks(ctx, taskId)
  return true
}

/**
 * Start a task as its own ACTION THREAD: posts a channel message for the
 * task (mentioning the given agent, the task's own agent, or none so the
 * front desk picks it up), then re-homes the task to that new conversation.
 * Used by the ▶ button and by the scheduler when a task's time arrives.
 */
/** Who pulled the trigger — rendered in the kickoff so provenance is honest. */
export type StartTaskOrigin = 'manual' | 'auto' | 'scheduled'

const ORIGIN_NOTE: Record<StartTaskOrigin, string> = {
  // The human clicked ▶ themselves — nothing to explain.
  manual: '',
  auto: ' · auto-dispatched: its blockers completed',
  scheduled: ' · scheduled start'
}

export async function startTask(
  ctx: AppContext,
  taskId: string,
  initiatorUserId: string,
  agentId?: string,
  origin: StartTaskOrigin = 'manual'
): Promise<{ channelId: string; rootId: string } | null> {
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task || task.status !== 'pending') return null
  // DAG guard: a blocked task cannot start — its blockers dispatch it later.
  if (await isTaskBlocked(ctx.db, task)) return null

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
  // The kickoff posts under the initiating human's identity because only
  // human-authored mentions trigger runs directly — the origin note keeps
  // the provenance honest ("did I kick this?" must never be ambiguous).
  //
  // refThreadId (WITHOUT refChannelId) is the SUB-THREAD parent link: it
  // points at the conversation the task was dispatched from, so the feed
  // nests this action thread under its plan instead of scattering siblings
  // across the channel. Citations (cite_thread) always set BOTH ref fields —
  // the missing channel id is what distinguishes the two.
  const message = await postMessage(ctx, {
    channelId: task.channelId,
    authorType: 'human',
    authorId: initiatorUserId,
    content: `${mention}📌 ${task.content} _(priority: ${task.priority}${ORIGIN_NOTE[origin]})_`,
    refThreadId: oldRootId
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
 * DAG dispatch: when a task completes (or a blocker disappears), any task it
 * was blocking whose blockers are now ALL resolved starts automatically —
 * an approved plan executes itself stage by stage. Human-assigned tasks are
 * never auto-started; unblocking surfaces them in Needs-You instead.
 */
export async function dispatchUnblockedTasks(
  ctx: AppContext,
  resolvedTaskId: string
): Promise<void> {
  const dependents = await ctx.db
    .select()
    .from(tasks)
    .where(like(tasks.blockedBy, `%"${resolvedTaskId}"%`))
  let humanUnblocked = false
  for (const task of dependents) {
    if (task.status !== 'pending') continue
    if (await isTaskBlocked(ctx.db, task)) continue
    // Scheduled-for-later tasks keep their schedule; the sweep fires them.
    if (task.scheduledFor && task.scheduledFor > Date.now()) continue
    if (task.assigneeType === 'human') {
      humanUnblocked = true
      continue
    }
    await startTask(ctx, task.id, await autopilotUserId(ctx.db), undefined, 'auto')
  }
  if (humanUnblocked) ctx.hub.broadcast({ type: 'attention_changed' })
}

const AUTOPILOT_EMAIL = 'autopilot@opencrew.local'

/**
 * The workspace's automation identity. Auto-dispatched and scheduled task
 * kickoffs post under it, so the feed never attributes an automatic action
 * to a person ("did I kick this?"). It must be a human-TYPE user because
 * only human-authored mentions trigger runs — but its password hash is a
 * sentinel no scheme matches, so nobody can ever log in as it.
 */
export async function autopilotUserId(db: DB): Promise<string> {
  const { users } = await import('../db/schema')
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, AUTOPILOT_EMAIL))
    .limit(1)
  if (existing) return existing.id
  const id = nanoid()
  await db.insert(users).values({
    id,
    name: 'Autopilot',
    email: AUTOPILOT_EMAIL,
    passwordHash: 'disabled$system-identity',
    role: 'admin',
    createdAt: Date.now()
  })
  return id
}

export type ShortIdLookup =
  | { kind: 'one'; task: TaskRow }
  | { kind: 'none' }
  | { kind: 'ambiguous' }

/**
 * Resolve the short "#a1b2c3" ids printed in run prompts back to a task in
 * this conversation. Prefix match; ambiguity is an error, never a guess.
 */
export async function findTaskByShortId(
  db: DB,
  conversationRootId: string,
  shortId: string
): Promise<ShortIdLookup> {
  const needle = shortId.replace(/^#/, '').trim()
  if (!needle) return { kind: 'none' }
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.conversationRootId, conversationRootId))
  const matches = rows.filter((row) => row.id.startsWith(needle))
  if (matches.length === 1) return { kind: 'one', task: matches[0]! }
  return matches.length === 0 ? { kind: 'none' } : { kind: 'ambiguous' }
}

/** Short id shown next to each task in prompts — enough to be unique per conversation. */
export function taskShortId(id: string): string {
  return `#${id.slice(0, 6)}`
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
  const newlyCompleted: string[] = []

  for (const item of input.items) {
    const match = byContent.get(item.content.trim())
    if (match) {
      const activeForm = item.status === 'in_progress' ? (item.activeForm ?? null) : null
      if (
        match.status !== item.status ||
        match.activeForm !== activeForm ||
        match.sourceAgentId !== input.agentId
      ) {
        if (item.status === 'completed' && match.status !== 'completed') {
          newlyCompleted.push(match.id)
        }
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
  for (const taskId of newlyCompleted) {
    await dispatchUnblockedTasks(ctx, taskId)
  }
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
  const openIds = new Set(items.filter((t) => t.status !== 'completed').map((t) => t.id))
  const lines = items.map((t) => {
    const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
    const author = t.createdByType === 'human' ? ' (added by a human)' : ''
    const assignee =
      t.assigneeType === 'human' ? ' [ASSIGNED TO A HUMAN — do not work this item]' : ''
    const blocked = t.blockedBy?.some((id) => openIds.has(id))
      ? ' [BLOCKED — waits on earlier tasks, do not start]'
      : ''
    return `${box} ${taskShortId(t.id)} (${t.priority}) ${t.content}${author}${assignee}${blocked}`
  })
  return (
    `\n\nShared task list for this conversation (humans and agents co-edit it):\n` +
    lines.join('\n') +
    `\nWork the highest-priority open items first. STATUS IS PART OF THE WORK: when you ` +
    `start an item, call update_task with its #id and status "in_progress"; the moment its ` +
    `deliverable exists, call update_task with "completed" — completing is what unblocks ` +
    `and auto-starts the tasks depending on it. Use TodoWrite freely for your own ` +
    `finer-grained scratch planning.`
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
