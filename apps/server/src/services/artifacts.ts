import { and, asc, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Artifact, ArtifactComment, PlanTaskDraft } from '@opencrew/shared'
import { artifactComments, artifacts, users } from '../db/schema'
import type { DB } from '../db'
import type { AppContext } from '../context'
import { postSystemMessage } from './messages'
import { postMessage } from './post'
import { createTask } from './tasks'
import { getAgent } from './agents'

type ArtifactRow = typeof artifacts.$inferSelect

function parseDrafts(json: string): PlanTaskDraft[] {
  try {
    const parsed = JSON.parse(json) as PlanTaskDraft[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    conversationRootId: row.conversationRootId,
    channelId: row.channelId,
    runId: row.runId,
    kind: row.kind,
    folder: row.folder,
    title: row.title,
    content: row.content,
    tasks: parseDrafts(row.tasks),
    status: row.status,
    version: row.version,
    createdByAgentId: row.createdByAgentId,
    committedBy: row.committedBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export async function listChannelArtifacts(db: DB, channelId: string): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.channelId, channelId))
    .orderBy(desc(artifacts.createdAt))
  return rows.map(toArtifact)
}

/** Every artifact in the workspace (the Artifacts tab), newest first. */
export async function listAllArtifacts(db: DB): Promise<Artifact[]> {
  const rows = await db.select().from(artifacts).orderBy(desc(artifacts.createdAt))
  return rows.map(toArtifact)
}

export interface ProposePlanInput {
  conversationRootId: string
  channelId: string
  runId: string
  agentId: string
  title: string
  content: string
  tasks: PlanTaskDraft[]
  folder?: string
}

/** Normalize a folder path: trim slashes/spaces per segment, drop empties. */
export function normalizeFolder(folder: string | undefined, fallback: string): string {
  const segments = (folder ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  return segments.length > 0 ? segments.join('/') : fallback
}

/**
 * Store a plan proposal as a versioned artifact. Re-proposing the same title
 * in the same conversation supersedes the previous version (which is marked
 * discarded so exactly one proposal per title is ever actionable).
 */
export async function proposePlan(ctx: AppContext, input: ProposePlanInput): Promise<Artifact> {
  const prior = await ctx.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, input.conversationRootId),
        eq(artifacts.title, input.title)
      )
    )
  const now = Date.now()
  for (const row of prior) {
    if (row.status === 'proposed') {
      await ctx.db
        .update(artifacts)
        .set({ status: 'discarded', updatedAt: now })
        .where(eq(artifacts.id, row.id))
      ctx.hub.broadcast({
        type: 'artifact_state',
        artifact: { ...toArtifact(row), status: 'discarded', updatedAt: now }
      })
    }
  }
  const row: ArtifactRow = {
    id: nanoid(),
    workspaceSlug: 'default',
    conversationRootId: input.conversationRootId,
    channelId: input.channelId,
    runId: input.runId,
    kind: 'plan',
    folder: normalizeFolder(input.folder, 'plans'),
    title: input.title,
    content: input.content,
    tasks: JSON.stringify(input.tasks),
    status: 'proposed',
    version: prior.reduce((max, r) => Math.max(max, r.version), 0) + 1,
    createdByAgentId: input.agentId,
    committedBy: null,
    createdAt: now,
    updatedAt: now
  }
  await ctx.db.insert(artifacts).values(row)
  const artifact = toArtifact(row)
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  return artifact
}

/**
 * Human approval: mark the plan committed and materialize its task drafts
 * onto the conversation's shared task board.
 */
export async function commitPlan(
  ctx: AppContext,
  artifactId: string,
  userId: string
): Promise<Artifact | null> {
  const [row] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!row || row.status !== 'proposed') return null

  const now = Date.now()
  await ctx.db
    .update(artifacts)
    .set({ status: 'committed', committedBy: userId, updatedAt: now })
    .where(eq(artifacts.id, artifactId))

  for (const draft of parseDrafts(row.tasks)) {
    await createTask(ctx, {
      conversationRootId: row.conversationRootId,
      channelId: row.channelId,
      content: draft.content,
      priority: draft.priority,
      createdByType: 'agent',
      createdById: row.createdByAgentId,
      sourceAgentId: row.createdByAgentId
    })
  }

  const agent = await getAgent(ctx.db, row.createdByAgentId)
  const taskCount = parseDrafts(row.tasks).length
  // The approval IS the go signal: posted as the approving human and
  // @mentioning the authoring agent, so the run pipeline kicks off execution
  // immediately (a system message would trigger nothing).
  await postMessage(ctx, {
    channelId: row.channelId,
    threadRootId: row.conversationRootId,
    authorType: 'human',
    authorId: userId,
    content:
      `${agent ? `@${agent.name} ` : ''}✅ Approved **${row.title}** (v${row.version}) — ` +
      `${taskCount} task${taskCount === 1 ? '' : 's'} are on the board. Start executing: ` +
      `work the board top-down by priority, delegate tasks to the right specialists, and ` +
      `keep the doc updated with update_doc as tasks complete.`
  })

  const artifact: Artifact = {
    ...toArtifact(row),
    status: 'committed',
    committedBy: userId,
    updatedAt: now
  }
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  return artifact
}

/**
 * Agent updates a COMMITTED doc — the living record: tick items, record
 * outcomes, add links. Creates the next version, still committed (the human
 * gate applies to proposals; progress updates must not stall on approval).
 */
export async function updateCommittedDoc(
  ctx: AppContext,
  input: {
    conversationRootId: string
    title: string
    content: string
    agentId: string
    runId: string
  }
): Promise<{ artifact: Artifact } | { error: string }> {
  const rows = await ctx.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, input.conversationRootId),
        eq(artifacts.title, input.title)
      )
    )
    .orderBy(desc(artifacts.version))
  const latest = rows.find((r) => r.status !== 'discarded')
  if (!latest) {
    return { error: `No doc titled "${input.title}" in this conversation — use propose_plan to create one.` }
  }
  if (latest.status === 'proposed') {
    return {
      error:
        `"${input.title}" is still awaiting human approval — you cannot update it. ` +
        `To change it, re-propose with propose_plan (same title).`
    }
  }
  const now = Date.now()
  const row: ArtifactRow = {
    ...latest,
    id: nanoid(),
    runId: input.runId,
    content: input.content,
    version: rows.reduce((max, r) => Math.max(max, r.version), 0) + 1,
    createdByAgentId: input.agentId,
    createdAt: now,
    updatedAt: now
  }
  await ctx.db.insert(artifacts).values(row)
  const artifact = toArtifact(row)
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  return { artifact }
}

/** Human rejection: the proposal is dropped (agent can re-propose a revision). */
export async function discardPlan(ctx: AppContext, artifactId: string): Promise<Artifact | null> {
  const [row] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!row || row.status !== 'proposed') return null
  const now = Date.now()
  await ctx.db
    .update(artifacts)
    .set({ status: 'discarded', updatedAt: now })
    .where(eq(artifacts.id, artifactId))
  const artifact: Artifact = { ...toArtifact(row), status: 'discarded', updatedAt: now }
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  return artifact
}

export async function addComment(
  ctx: AppContext,
  input: { artifactId: string; body: string; quote?: string; userId: string }
): Promise<ArtifactComment | null> {
  const [artifact] = await ctx.db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.id, input.artifactId))
    .limit(1)
  if (!artifact) return null
  const [user] = await ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
  const comment: ArtifactComment = {
    id: nanoid(),
    artifactId: input.artifactId,
    quote: input.quote,
    body: input.body,
    createdByUserId: input.userId,
    authorName: user?.name,
    createdAt: Date.now()
  }
  await ctx.db.insert(artifactComments).values({
    id: comment.id,
    workspaceSlug: 'default',
    artifactId: comment.artifactId,
    quote: comment.quote ?? null,
    body: comment.body,
    createdByUserId: comment.createdByUserId,
    createdAt: comment.createdAt
  })
  ctx.hub.broadcast({ type: 'artifact_comment', comment })
  return comment
}

export async function listComments(db: DB, artifactId: string): Promise<ArtifactComment[]> {
  const rows = await db
    .select({
      id: artifactComments.id,
      artifactId: artifactComments.artifactId,
      quote: artifactComments.quote,
      body: artifactComments.body,
      createdByUserId: artifactComments.createdByUserId,
      createdAt: artifactComments.createdAt,
      authorName: users.name
    })
    .from(artifactComments)
    .leftJoin(users, eq(users.id, artifactComments.createdByUserId))
    .where(eq(artifactComments.artifactId, artifactId))
    .orderBy(asc(artifactComments.createdAt))
  return rows.map((row) => ({
    ...row,
    quote: row.quote ?? undefined,
    authorName: row.authorName ?? undefined
  }))
}

/**
 * Human asks for a revision: posts a message (as that human) into the
 * conversation thread @mentioning the authoring agent with the feedback.
 * The normal run pipeline picks it up; the agent sees the doc's review
 * comments in its prompt and re-proposes the same title as the next version.
 */
export async function requestChanges(
  ctx: AppContext,
  artifactId: string,
  userId: string,
  feedback: string
): Promise<{ ok: true } | null> {
  const [row] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!row || row.status !== 'proposed') return null
  const agent = await getAgent(ctx.db, row.createdByAgentId)
  const mention = agent ? `@${agent.name} ` : ''
  await postMessage(ctx, {
    channelId: row.channelId,
    threadRootId: row.conversationRootId,
    authorType: 'human',
    authorId: userId,
    content:
      `${mention}📝 Requested changes on **${row.title}** (v${row.version}): ${feedback}\n\n` +
      `Please revise and re-propose the doc with the same title (it will become v${row.version + 1}).`
  })
  return { ok: true }
}

const QUOTE_PREVIEW_LIMIT = 100
const WORKSPACE_DOC_LIST_LIMIT = 30

/**
 * Resolve a doc by title for read_doc: this conversation's latest version
 * first (any status), then the workspace's latest COMMITTED doc of that
 * title — committed docs are shared truth, proposals are conversation-local.
 */
export async function findDocByTitle(
  db: DB,
  title: string,
  conversationRootId: string | null
): Promise<Artifact | null> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.title, title))
    .orderBy(desc(artifacts.version), desc(artifacts.updatedAt))
  const live = rows.filter((r) => r.status !== 'discarded')
  const local = conversationRootId
    ? live.find((r) => r.conversationRootId === conversationRootId)
    : undefined
  if (local) return toArtifact(local)
  const committed = live
    .filter((r) => r.status === 'committed')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return committed ? toArtifact(committed) : null
}

/** Latest committed doc per (conversation, title), workspace-wide, newest first. */
async function listCommittedWorkspaceDocs(db: DB): Promise<ArtifactRow[]> {
  const rows = await db.select().from(artifacts).orderBy(desc(artifacts.version))
  const latest = new Map<string, ArtifactRow>()
  for (const row of rows) {
    if (row.status !== 'committed') continue
    const key = `${row.conversationRootId}::${row.title}`
    if (!latest.has(key)) latest.set(key, row)
  }
  return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Prompt section for a run: the conversation's docs (latest non-discarded
 * version per title) plus their review comments, so revisions actually
 * address the feedback. Empty string when the conversation has no docs.
 */
export async function buildDocsPromptSection(
  db: DB,
  conversationRootId: string
): Promise<string> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.conversationRootId, conversationRootId))
    .orderBy(desc(artifacts.version))
  const seen = new Set<string>()
  const lines: string[] = []
  for (const row of rows) {
    if (row.status === 'discarded' || seen.has(row.title)) continue
    seen.add(row.title)
    lines.push(`- "${row.title}" (v${row.version}, ${row.status})`)
    const comments = await listComments(db, row.id)
    for (const comment of comments) {
      const anchor = comment.quote
        ? ` [on: "${comment.quote.slice(0, QUOTE_PREVIEW_LIMIT)}${
            comment.quote.length > QUOTE_PREVIEW_LIMIT ? '…' : ''
          }"]`
        : ''
      lines.push(`  • review comment from ${comment.authorName ?? 'a human'}${anchor}: ${comment.body}`)
    }
  }
  const sections: string[] = []
  if (lines.length > 0) {
    sections.push(
      `Documents in this conversation:\n${lines.join('\n')}\n` +
        `Refer to docs by title instead of restating their content. A doc still "proposed" is ` +
        `awaiting human approval — do not execute it. When revising, address every review ` +
        `comment and re-propose with the SAME title.`
    )
  }

  // Committed docs are workspace truth: every agent sees the index and reads
  // what's relevant, so decisions get made once instead of re-litigated.
  const workspaceDocs = (await listCommittedWorkspaceDocs(db)).filter(
    (row) => row.conversationRootId !== conversationRootId
  )
  if (workspaceDocs.length > 0) {
    const docLines = workspaceDocs
      .slice(0, WORKSPACE_DOC_LIST_LIMIT)
      .map((row) => `- ${row.folder}/"${row.title}" (v${row.version})`)
    sections.push(
      `Committed workspace docs (the source of truth — use the read_doc tool to read any of ` +
        `these BEFORE deciding or answering on their topic, instead of guessing or ` +
        `re-litigating):\n${docLines.join('\n')}`
    )
  }

  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}
