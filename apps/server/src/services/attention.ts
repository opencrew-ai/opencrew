import { desc, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AttentionItem } from '@opencrew/shared'
import {
  agents,
  approvals,
  artifacts,
  attentionRequests,
  messages,
  runs,
  tasks
} from '../db/schema'
import type { DB } from '../db'
import type { AppContext } from '../context'


export async function createAttentionRequest(
  ctx: AppContext,
  input: {
    conversationRootId: string
    channelId: string
    agentId: string
    runId: string
    request: string
  }
): Promise<string> {
  const id = nanoid()
  await ctx.db.insert(attentionRequests).values({
    id,
    workspaceSlug: 'default',
    conversationRootId: input.conversationRootId,
    channelId: input.channelId,
    agentId: input.agentId,
    runId: input.runId,
    request: input.request,
    status: 'open',
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null
  })
  ctx.hub.broadcast({ type: 'attention_changed' })
  return id
}

export async function resolveAttentionRequest(
  ctx: AppContext,
  requestId: string,
  userId: string
): Promise<boolean> {
  const [row] = await ctx.db
    .select()
    .from(attentionRequests)
    .where(eq(attentionRequests.id, requestId))
    .limit(1)
  if (!row || row.status !== 'open') return false
  await ctx.db
    .update(attentionRequests)
    .set({ status: 'resolved', resolvedAt: Date.now(), resolvedBy: userId })
    .where(eq(attentionRequests.id, requestId))
  ctx.hub.broadcast({ type: 'attention_changed' })
  return true
}

/**
 * Everything currently waiting on a human, unified and newest-first:
 * explicit agent requests, docs awaiting review, pending tool approvals.
 */
export async function listAttention(db: DB): Promise<AttentionItem[]> {
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, emoji: agents.avatarEmoji })
    .from(agents)
  const agentById = new Map(agentRows.map((a) => [a.id, a]))
  const withAgent = (agentId: string | null | undefined) => {
    const agent = agentId ? agentById.get(agentId) : undefined
    return agent
      ? { agentId: agent.id, agentName: agent.name, agentEmoji: agent.emoji }
      : {}
  }
  const items: AttentionItem[] = []

  // 1. Explicit agent requests.
  const requestRows = await db
    .select()
    .from(attentionRequests)
    .where(eq(attentionRequests.status, 'open'))
    .orderBy(desc(attentionRequests.createdAt))
  for (const row of requestRows) {
    items.push({
      kind: 'request',
      refId: row.id,
      // Full text — the sidebar truncates visually; the modal needs it all.
      title: row.request,
      channelId: row.channelId,
      conversationRootId: row.conversationRootId,
      ...withAgent(row.agentId),
      createdAt: row.createdAt
    })
  }

  // 2. Open tasks assigned to a HUMAN (manual steps from committed plans).
  const humanTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.assigneeType, 'human'))
    .orderBy(desc(tasks.createdAt))
  const now = Date.now()
  for (const task of humanTasks) {
    // Only PENDING tasks need you — in_progress means the crew took it over.
    if (task.status !== 'pending') continue
    // Scheduled-for-later tasks live on the calendar, not in today's inbox.
    if (task.scheduledFor !== null && task.scheduledFor > now) continue
    items.push({
      kind: 'task',
      refId: task.id,
      title: task.content,
      channelId: task.channelId,
      conversationRootId: task.conversationRootId,
      ...withAgent(task.createdByType === 'agent' ? task.createdById : undefined),
      priority: task.priority,
      position: task.position,
      createdAt: task.createdAt
    })
  }

  // 3. Docs awaiting review.
  const proposedDocs = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.status, 'proposed'))
    .orderBy(desc(artifacts.createdAt))
  for (const doc of proposedDocs) {
    items.push({
      kind: 'doc_review',
      refId: doc.id,
      title: `Review doc: ${doc.title} (v${doc.version})`,
      channelId: doc.channelId,
      conversationRootId: doc.conversationRootId,
      ...withAgent(doc.createdByAgentId),
      createdAt: doc.createdAt
    })
  }

  // 4. Pending tool approvals — located via the approval card message, which
  // carries the thread the run posts into.
  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .orderBy(desc(approvals.createdAt))
  if (pendingApprovals.length > 0) {
    const approvalIds = pendingApprovals.map((a) => a.id)
    const cards = await db
      .select({
        approvalId: messages.approvalId,
        channelId: messages.channelId,
        threadRootId: messages.threadRootId,
        id: messages.id
      })
      .from(messages)
      .where(inArray(messages.approvalId, approvalIds))
    const cardByApproval = new Map(cards.map((c) => [c.approvalId, c]))
    const runIds = pendingApprovals.map((a) => a.runId)
    const runRows = await db
      .select({ id: runs.id, agentId: runs.agentId })
      .from(runs)
      .where(inArray(runs.id, runIds))
    const runById = new Map(runRows.map((r) => [r.id, r]))
    for (const approval of pendingApprovals) {
      const card = cardByApproval.get(approval.id)
      if (!card) continue
      const run = runById.get(approval.runId)
      items.push({
        kind: 'tool_approval',
        refId: approval.id,
        title: `Approve tool: ${approval.toolName}`,
        channelId: card.channelId,
        conversationRootId: card.threadRootId ?? card.id,
        ...withAgent(run?.agentId),
        createdAt: approval.createdAt
      })
    }
  }

  // Work-queue order, not a news feed: blocked agents first (a paused run is
  // the most expensive kind of waiting), then docs to review, then tasks and
  // requests by priority → plan order → oldest first (do step 1 first).
  const KIND_RANK: Record<AttentionItem['kind'], number> = {
    tool_approval: 0,
    doc_review: 1,
    request: 2,
    task: 2
  }
  const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
  return items.sort((a, b) => {
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (kind !== 0) return kind
    const priority =
      (PRIORITY_RANK[a.priority ?? 'medium'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'medium'] ?? 1)
    if (priority !== 0) return priority
    const position = (a.position ?? 0) - (b.position ?? 0)
    if (position !== 0) return position
    return a.createdAt - b.createdAt
  })
}
