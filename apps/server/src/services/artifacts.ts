import { and, asc, desc, eq, gt, inArray, lt, ne } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Artifact, ArtifactComment, PlanTaskDraft } from '@opencrew/shared'
import { artifactComments, artifacts, messages, users } from '../db/schema'
import type { DB } from '../db'
import type { AppContext } from '../context'
import { enrichMessage, postSystemMessage } from './messages'
import { postMessage } from './post'
import { createTask } from './tasks'
import { getAgent } from './agents'
import { getRawSetting, getSettings } from './settings'
import { enqueueRun } from '../runs/enqueue'

export const DOC_REVIEWER_SETTING = 'docReviewerAgentId'
export const CODE_REVIEWER_SETTING = 'codeReviewerAgentId'
const DOC_REVIEWER_NAME = 'Librarian'
const CODE_REVIEWER_NAME = 'CodeReviewer'

/**
 * Built-in doc reviewer, provided like Captain: seeded into fresh workspaces
 * and self-healed at boot for existing ones. One config, used by both paths.
 */
export const DOC_REVIEWER_SEED = {
  name: DOC_REVIEWER_NAME,
  avatarEmoji: '📚',
  version: {
    systemPrompt:
      'You are Librarian, the workspace doc reviewer. Every doc an agent proposes passes ' +
      'through you BEFORE it reaches a human. Your one job: keep the artifact library ' +
      'small, consistent, and trustworthy. For each doc in review, judge: (1) NOISE — does ' +
      'this deserve to be a doc at all? (2) REDUNDANCY — does a committed doc already ' +
      'cover this? (3) CONFLICT — does it contradict committed truth? (4) UPDATE vs ' +
      'CREATE — should this have been an update to an existing doc instead of a new one? ' +
      'Deliver verdicts with review_doc: "clear" only for docs worth the human\'s ' +
      'attention; "revise" otherwise, and @mention the author with precise, actionable ' +
      'guidance (name the existing doc to update when relevant). You never write docs ' +
      'yourself and never do specialist work. Replies: 1-3 sentences, no fluff.',
    model: 'claude-sonnet-4-6',
    skills: ['doc-review', 'curation'],
    tools: [],
    capabilities: {
      canPostInChannels: ['*'],
      maxRunsPerHour: 1000,
      requiresApprovalFor: []
    }
  }
}

/** Built-in code reviewer — gates every proposed change before the human. */
export const CODE_REVIEWER_SEED = {
  name: CODE_REVIEWER_NAME,
  avatarEmoji: '🔍',
  version: {
    systemPrompt:
      'You are CodeReviewer, the workspace code reviewer. Every code change an agent ' +
      'proposes (a captured git diff) passes through you BEFORE it reaches a human, and ' +
      'nothing is committed until the human approves. For each change in review: read it ' +
      'with read_doc and judge — correctness (does the diff do what its title claims, any ' +
      'bugs or missed edge cases?), security (secrets, injection, unsafe input handling), ' +
      'scope (one focused change, no drive-by edits or dead code), and consistency with ' +
      'the codebase. Deliver verdicts with review_doc: "clear" only for changes you would ' +
      'merge; "revise" otherwise, and @mention the author with specific findings (file and ' +
      'hunk, not vague advice). You never write code yourself. Replies: 1-3 sentences.',
    model: 'claude-sonnet-4-6',
    skills: ['code-review', 'security-review'],
    tools: [],
    capabilities: {
      canPostInChannels: ['*'],
      maxRunsPerHour: 1000,
      requiresApprovalFor: []
    }
  }
}

/**
 * Boot-time provisioning: every workspace gets both built-in reviewers.
 * Adopts existing agents by name, otherwise creates them (chat-only — their
 * whole job is read_doc + review_doc, which every agent has anyway).
 */
export async function ensureBuiltinReviewers(ctx: AppContext): Promise<void> {
  await ensureReviewer(ctx, DOC_REVIEWER_SEED, DOC_REVIEWER_SETTING, getDocReviewerId)
  await ensureReviewer(ctx, CODE_REVIEWER_SEED, CODE_REVIEWER_SETTING, getCodeReviewerId)
}

async function ensureReviewer(
  ctx: AppContext,
  seed: typeof DOC_REVIEWER_SEED,
  settingKey: string,
  getConfigured: (db: DB) => Promise<string | null>
): Promise<void> {
  if (await getConfigured(ctx.db)) return
  const { agents: agentsTable, users: usersTable } = await import('../db/schema')
  const { createVersion } = await import('./agents')
  const { setRawSetting } = await import('./settings')
  const { nanoid: makeId } = await import('nanoid')

  const existing = await ctx.db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.name, seed.name))
    .limit(1)
  if (existing[0]) {
    await setRawSetting(ctx.db, settingKey, existing[0].id)
    return
  }

  const [admin] = await ctx.db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, 'admin'))
    .limit(1)
  if (!admin) return

  const agentId = makeId()
  await ctx.db.insert(agentsTable).values({
    id: agentId,
    name: seed.name,
    avatarEmoji: seed.avatarEmoji,
    currentVersionId: 'pending',
    createdBy: admin.id,
    status: 'active',
    createdAt: Date.now()
  })
  await createVersion(
    ctx.db,
    agentId,
    {
      ...seed.version,
      skills: [...seed.version.skills],
      tools: [...seed.version.tools],
      capabilities: { ...seed.version.capabilities }
    },
    admin.id,
    'initial version (auto-provisioned reviewer)'
  )
  await setRawSetting(ctx.db, settingKey, agentId)
}

async function getReviewerId(db: DB, settingKey: string): Promise<string | null> {
  const id = await getRawSetting(db, settingKey)
  if (!id) return null
  const agent = await getAgent(db, id)
  return agent && agent.status === 'active' ? agent.id : null
}

/** The configured doc-reviewer agent, or null when none exists. */
export async function getDocReviewerId(db: DB): Promise<string | null> {
  return getReviewerId(db, DOC_REVIEWER_SETTING)
}

/** The configured code-reviewer agent, or null when none exists. */
export async function getCodeReviewerId(db: DB): Promise<string | null> {
  return getReviewerId(db, CODE_REVIEWER_SETTING)
}

export type ArtifactKind = 'plan' | 'doc' | 'change'

/** Which artifact kinds this agent reviews ([] = not a reviewer). */
export async function reviewKindsForAgent(db: DB, agentId: string): Promise<ArtifactKind[]> {
  const kinds: ArtifactKind[] = []
  if ((await getDocReviewerId(db)) === agentId) kinds.push('plan', 'doc')
  if ((await getCodeReviewerId(db)) === agentId) kinds.push('change')
  return kinds
}

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

export async function getArtifact(db: DB, artifactId: string): Promise<Artifact | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  return row ? toArtifact(row) : null
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
  kind?: ArtifactKind
  /** kind 'change' only: working dir whose staged diff this proposes. */
  sourceDir?: string
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
    // 'review' priors too: an old version parked with a reviewer must not
    // resurface later as a stale duplicate next to the new proposal.
    if (row.status === 'proposed' || row.status === 'review') {
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
  // Reviewer gate: proposals pass their kind's reviewer BEFORE reaching a
  // human — Librarian for docs/plans, CodeReviewer for changes. A reviewer's
  // own proposals skip the gate — no self-review loops.
  const kind = input.kind ?? 'plan'
  const reviewerId =
    kind === 'change' ? await getCodeReviewerId(ctx.db) : await getDocReviewerId(ctx.db)
  const needsReview = reviewerId !== null && reviewerId !== input.agentId
  const row: ArtifactRow = {
    id: nanoid(),
    workspaceSlug: 'default',
    conversationRootId: input.conversationRootId,
    channelId: input.channelId,
    runId: input.runId,
    kind,
    folder: normalizeFolder(input.folder, kind === 'change' ? 'changes' : 'plans'),
    title: input.title,
    content: input.content,
    tasks: JSON.stringify(input.tasks),
    status: needsReview ? 'review' : 'proposed',
    version: prior.reduce((max, r) => Math.max(max, r.version), 0) + 1,
    createdByAgentId: input.agentId,
    committedBy: null,
    sourceDir: input.sourceDir ?? null,
    createdAt: now,
    updatedAt: now
  }
  await ctx.db.insert(artifacts).values(row)
  const artifact = toArtifact(row)
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  if (needsReview && reviewerId) {
    await dispatchDocReview(ctx, artifact.conversationRootId, reviewerId)
  }
  return artifact
}

/** Trigger the reviewer agent's run on the conversation root. */
async function dispatchDocReview(
  ctx: AppContext,
  conversationRootId: string,
  reviewerId: string
): Promise<void> {
  const [root] = await ctx.db
    .select()
    .from(messages)
    .where(eq(messages.id, conversationRootId))
    .limit(1)
  if (!root) return
  await enqueueRun(ctx, reviewerId, await enrichMessage(ctx.db, root), 0, 'review', false)
}

/** Docs currently in review for a conversation, with their author names. */
/** True when a newer, non-discarded version of the same doc exists. */
async function supersededByNewer(db: DB, row: ArtifactRow): Promise<boolean> {
  const newer = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, row.conversationRootId),
        eq(artifacts.title, row.title),
        gt(artifacts.version, row.version),
        ne(artifacts.status, 'discarded')
      )
    )
    .limit(1)
  return newer.length > 0
}

/**
 * Committing one version retires any OLDER sibling still awaiting action —
 * exactly one version of a doc may ever sit in the Needs-You inbox.
 */
async function discardStaleSiblings(ctx: AppContext, row: ArtifactRow): Promise<void> {
  const stale = await ctx.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, row.conversationRootId),
        eq(artifacts.title, row.title),
        lt(artifacts.version, row.version),
        inArray(artifacts.status, ['review', 'proposed'])
      )
    )
  const now = Date.now()
  for (const sibling of stale) {
    await ctx.db
      .update(artifacts)
      .set({ status: 'discarded', updatedAt: now })
      .where(eq(artifacts.id, sibling.id))
    ctx.hub.broadcast({
      type: 'artifact_state',
      artifact: { ...toArtifact(sibling), status: 'discarded', updatedAt: now }
    })
  }
}

/**
 * Boot reconcile: retire any proposal a newer version has superseded. The
 * write paths keep this invariant going forward; the sweep heals rows from
 * before the invariant existed (and any edge that slips past it).
 */
export async function retireSupersededProposals(ctx: AppContext): Promise<number> {
  const actionable = await ctx.db
    .select()
    .from(artifacts)
    .where(inArray(artifacts.status, ['review', 'proposed']))
  let retired = 0
  for (const row of actionable) {
    if (await supersededByNewer(ctx.db, row)) {
      await ctx.db
        .update(artifacts)
        .set({ status: 'discarded', updatedAt: Date.now() })
        .where(eq(artifacts.id, row.id))
      retired++
    }
  }
  return retired
}

export async function listDocsInReview(
  db: DB,
  conversationRootId: string,
  kinds?: ArtifactKind[]
): Promise<{ title: string; kind: ArtifactKind; authorName: string }[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(eq(artifacts.conversationRootId, conversationRootId), eq(artifacts.status, 'review'))
    )
  const out: { title: string; kind: ArtifactKind; authorName: string }[] = []
  for (const row of rows) {
    if (kinds && !kinds.includes(row.kind)) continue
    const agent = await getAgent(db, row.createdByAgentId)
    out.push({ title: row.title, kind: row.kind, authorName: agent?.name ?? 'unknown' })
  }
  return out
}

/**
 * Reviewer verdict. 'clear' promotes review → proposed (now visible in the
 * human's Needs-You inbox); 'revise' discards it — the reviewer's chat reply
 * carries the feedback and @mentions the author to re-propose.
 */
export async function applyReviewVerdict(
  ctx: AppContext,
  input: {
    conversationRootId: string
    title: string
    verdict: 'clear' | 'revise'
    /** Kinds the calling reviewer owns — verdicts outside them are refused. */
    kinds: ArtifactKind[]
  }
): Promise<Artifact | null> {
  const rows = await ctx.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, input.conversationRootId),
        eq(artifacts.title, input.title),
        eq(artifacts.status, 'review')
      )
    )
    .orderBy(desc(artifacts.version))
  const row = rows.find((r) => input.kinds.includes(r.kind))
  if (!row) return null
  const now = Date.now()
  // A slow "clear" verdict on a version the author has already re-proposed
  // must not resurrect a stale duplicate into the human's inbox.
  const superseded = input.verdict === 'clear' && (await supersededByNewer(ctx.db, row))
  const status =
    input.verdict === 'clear' && !superseded ? ('proposed' as const) : ('discarded' as const)
  await ctx.db.update(artifacts).set({ status, updatedAt: now }).where(eq(artifacts.id, row.id))
  const artifact: Artifact = { ...toArtifact(row), status, updatedAt: now }
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  if (input.verdict === 'clear' && !superseded) {
    // refArtifactId anchors the doc card to this notice — the card must be
    // reachable even when the proposing run failed to post its reply.
    await postSystemMessage(
      ctx,
      row.channelId,
      `📄 **${row.title}** (v${row.version}) passed review — awaiting your approval.`,
      { threadRootId: row.conversationRootId, refArtifactId: row.id }
    )
  }
  return artifact
}

/** Safety net: a review run that ends without verdicts must not strand docs. */
export async function flipRemainingReviewDocs(
  ctx: AppContext,
  conversationRootId: string
): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(artifacts)
    .where(
      and(eq(artifacts.conversationRootId, conversationRootId), eq(artifacts.status, 'review'))
    )
  const now = Date.now()
  for (const row of rows) {
    // Superseded versions retire quietly instead of joining the inbox.
    const status = (await supersededByNewer(ctx.db, row)) ? 'discarded' : 'proposed'
    await ctx.db
      .update(artifacts)
      .set({ status, updatedAt: now })
      .where(eq(artifacts.id, row.id))
    ctx.hub.broadcast({
      type: 'artifact_state',
      artifact: { ...toArtifact(row), status, updatedAt: now }
    })
    if (status === 'proposed') {
      await postSystemMessage(
        ctx,
        row.channelId,
        `📄 **${row.title}** (v${row.version}) is ready for your review.`,
        { threadRootId: row.conversationRootId, refArtifactId: row.id }
      )
    }
  }
  return rows.length
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
  await discardStaleSiblings(ctx, row)

  // Materialize the drafts in order, wiring dependsOn (1-based indexes of
  // EARLIER drafts — later/self references are ignored, so the resulting
  // graph is acyclic by construction) into blockedBy task ids.
  const drafts = parseDrafts(row.tasks)
  const createdIds: string[] = []
  for (const [index, draft] of drafts.entries()) {
    const scheduledMs = draft.scheduledFor ? Date.parse(draft.scheduledFor) : NaN
    const blockedBy = (draft.dependsOn ?? [])
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= index)
      .map((n) => createdIds[n - 1]!)
    const task = await createTask(ctx, {
      conversationRootId: row.conversationRootId,
      channelId: row.channelId,
      content: draft.content,
      priority: draft.priority,
      createdByType: 'agent',
      createdById: row.createdByAgentId,
      sourceAgentId: draft.assignee === 'human' ? undefined : row.createdByAgentId,
      assigneeType: draft.assignee ?? 'agent',
      scheduledFor: Number.isFinite(scheduledMs) ? scheduledMs : undefined,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined
    })
    createdIds.push(task.id)
  }

  const agent = await getAgent(ctx.db, row.createdByAgentId)

  // kind 'change': approval IS the git commit — the codebase artifact stays
  // local; only the reviewed diff and the resulting sha live in the workspace.
  if (row.kind === 'change') {
    if (!row.sourceDir) {
      return null
    }
    const { commitStaged } = await import('./changes')
    const result = await commitStaged(row.sourceDir, row.title, agent?.name ?? 'OpenCrew agent')
    if ('error' in result) {
      // Roll the status back so Approve can be retried after the fix.
      await ctx.db
        .update(artifacts)
        .set({ status: 'proposed', committedBy: null })
        .where(eq(artifacts.id, artifactId))
      await postSystemMessage(
        ctx,
        row.channelId,
        `⚠️ Commit of **${row.title}** failed: ${result.error}`,
        { threadRootId: row.conversationRootId }
      )
      const artifact = toArtifact(row)
      ctx.hub.broadcast({ type: 'artifact_state', artifact })
      return artifact
    }
    await postMessage(ctx, {
      channelId: row.channelId,
      threadRootId: row.conversationRootId,
      authorType: 'human',
      authorId: userId,
      refArtifactId: row.id,
      content:
        `${agent ? `@${agent.name} ` : ''}✅ Approved & committed **${row.title}** ` +
        `(\`${result.sha}\`).`
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

  const taskCount = parseDrafts(row.tasks).length
  // The approval IS the go signal: posted as the approving human and
  // @mentioning the authoring agent, so the run pipeline kicks off execution
  // immediately (a system message would trigger nothing). Kept to one line —
  // the standing system prompt already tells agents how to execute a board;
  // refArtifactId lets the feed render this as a compact approval row.
  await postMessage(ctx, {
    channelId: row.channelId,
    threadRootId: row.conversationRootId,
    authorType: 'human',
    authorId: userId,
    refArtifactId: row.id,
    content:
      taskCount > 0
        ? `${agent ? `@${agent.name} ` : ''}✅ Approved **${row.title}** — ` +
          `${taskCount} task${taskCount === 1 ? '' : 's'} on the board, work it top-down.`
        : `${agent ? `@${agent.name} ` : ''}✅ Approved **${row.title}** — carry on.`
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

/**
 * A human edits the doc text directly — the in-place alternative to the
 * comment → request-changes → agent-revision loop. Same versioning as agent
 * revisions (new row, v+1, same title/status/tasks); authorship stays with
 * the agent, the edit is the human exercising their final say.
 */
export async function humanEditDoc(
  ctx: AppContext,
  artifactId: string,
  content: string
): Promise<Artifact | null> {
  const [current] = await ctx.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1)
  if (!current || current.status === 'discarded') return null

  const siblings = await ctx.db
    .select({ version: artifacts.version })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, current.conversationRootId),
        eq(artifacts.title, current.title)
      )
    )
  const now = Date.now()
  const row: ArtifactRow = {
    ...current,
    id: nanoid(),
    content,
    version: siblings.reduce((max, r) => Math.max(max, r.version), 0) + 1,
    createdAt: now,
    updatedAt: now
  }
  await ctx.db.insert(artifacts).values(row)
  const artifact = toArtifact(row)
  ctx.hub.broadcast({ type: 'artifact_state', artifact })
  return artifact
}

const ARCHIVE_LEAD_LIMIT = 240
const ARCHIVE_TITLE_LIMIT = 80

/** First markdown heading, else the first non-empty line, cleaned + clipped. */
function inferDocTitle(text: string): string {
  const heading = text.match(/^#{1,3}\s+(.+)$/m)
  const raw = heading?.[1] ?? text.split('\n').find((line) => line.trim()) ?? 'Untitled'
  return raw
    .replace(/[*_`#>[\]]/g, '')
    .trim()
    .slice(0, ARCHIVE_TITLE_LIMIT)
}

/**
 * Enforcement for "artifacts never live in chat": a run's over-long reply is
 * moved into a committed 'doc' artifact (folder notes/, versioned per title)
 * and the chat message becomes a short lead + pointer; the doc card renders
 * inline under the reply. Prompt rules ask nicely — this makes it physics.
 */
export async function archiveReplyToDoc(
  ctx: AppContext,
  input: {
    conversationRootId: string
    channelId: string
    runId: string
    agentId: string
    text: string
  }
): Promise<{ artifact: Artifact; pointerText: string }> {
  const title = inferDocTitle(input.text)
  const prior = await ctx.db
    .select({ version: artifacts.version })
    .from(artifacts)
    .where(
      and(eq(artifacts.conversationRootId, input.conversationRootId), eq(artifacts.title, title))
    )
  const now = Date.now()
  const row: ArtifactRow = {
    id: nanoid(),
    workspaceSlug: 'default',
    conversationRootId: input.conversationRootId,
    channelId: input.channelId,
    runId: input.runId,
    kind: 'doc',
    folder: 'notes',
    title,
    content: input.text,
    tasks: '[]',
    status: 'committed',
    version: prior.reduce((max, r) => Math.max(max, r.version), 0) + 1,
    createdByAgentId: input.agentId,
    committedBy: null,
    sourceDir: null,
    createdAt: now,
    updatedAt: now
  }
  await ctx.db.insert(artifacts).values(row)
  const artifact = toArtifact(row)
  ctx.hub.broadcast({ type: 'artifact_state', artifact })

  // Lead paragraph for the chat message: skip the heading, take the first prose.
  const lead =
    input.text
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, ARCHIVE_LEAD_LIMIT) + '…'
  const pointerText =
    `${lead}\n\n📄 _Full content moved to the doc **${title}** (below) — ` +
    `long replies live in docs, not chat._`
  return { artifact, pointerText }
}

/** Human rejection: the proposal is dropped (agent can re-propose a revision). */
export async function discardPlan(ctx: AppContext, artifactId: string): Promise<Artifact | null> {
  const [row] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!row || (row.status !== 'proposed' && row.status !== 'review')) return null
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
  // Sending it back RETIRES this version — the ball is with the author now,
  // so it must leave the human's Needs-You inbox immediately. The revision
  // arrives as the next version and re-enters review.
  const now = Date.now()
  await ctx.db
    .update(artifacts)
    .set({ status: 'discarded', updatedAt: now })
    .where(eq(artifacts.id, artifactId))
  ctx.hub.broadcast({
    type: 'artifact_state',
    artifact: { ...toArtifact(row), status: 'discarded', updatedAt: now }
  })
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
