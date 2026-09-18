import { and, eq, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AppContext } from '../context'
import type { DB } from '../db'
import { agents, channels, memberships } from '../db/schema'
import { enqueueRun } from '../runs/enqueue'
import { createMessage } from './messages'
import { CHIEF_OF_STAFF_SETTING, getProject } from './projects'
import { commitExists, hqRepoDir } from './record'
import { getRawSetting } from './settings'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ask the workspace. A person consults a project's Captain (or HQ's Chief
 * of Staff) on a private line: "what shipped last week and why?", "what is
 * blocked?". The answer comes from the record — docs, decisions, commits —
 * and cites it, so anyone can check it with plain git. Nothing about a
 * consult reaches the rooms: no delegation, no mentions, no docs.
 */

export interface Asker {
  id: string
  name: string
}

/** One private line per (scope, person). Idempotent. */
export async function ensureConsultChannel(
  db: DB,
  projectId: string | null,
  user: Asker
): Promise<typeof channels.$inferSelect> {
  const name = `consult-${user.id}`
  const [existing] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.name, name), projectId ? eq(channels.projectId, projectId) : isNull(channels.projectId)))
    .limit(1)
  if (existing) return existing
  const row = {
    id: nanoid(),
    workspaceSlug: 'default' as const,
    projectId,
    name,
    topic: `Private line: ${user.name} asks, the Captain answers from the record`,
    isPrivate: true,
    kind: 'consult' as const,
    createdAt: Date.now()
  }
  await db.insert(channels).values(row)
  await db.insert(memberships).values({ channelId: row.id, memberType: 'human', memberId: user.id }).catch(() => {})
  return row
}

/** Who answers for a scope: the project's Captain, or HQ's Chief of Staff. */
export async function captainFor(db: DB, projectId: string | null): Promise<string | null> {
  if (projectId === null) return getRawSetting(db, CHIEF_OF_STAFF_SETTING)
  const [captain] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.name, 'Captain'), eq(agents.status, 'active')))
    .limit(1)
  return captain?.id ?? null
}

export interface AskInput {
  projectId: string | null
  user: Asker
  question: string
  /** Continue an earlier consult (same Captain session) instead of starting fresh. */
  threadId?: string
}

export interface AskAdmitted {
  runId: string
  threadId: string
  channelId: string
}

export async function askCaptain(ctx: AppContext, input: AskInput): Promise<AskAdmitted | { error: string }> {
  if (input.projectId && !(await getProject(ctx.db, input.projectId))) return { error: 'project not found' }
  const captainId = await captainFor(ctx.db, input.projectId)
  if (!captainId) return { error: input.projectId ? 'this project has no active Captain' : 'HQ has no Chief of Staff' }
  const line = await ensureConsultChannel(ctx.db, input.projectId, input.user)
  // createMessage, not postMessage: a consult never fans out to watchers or
  // mentioned agents — exactly one run, for exactly one Captain.
  const message = await createMessage(ctx, {
    channelId: line.id,
    threadRootId: input.threadId ?? null,
    authorType: 'human',
    authorId: input.user.id,
    content: input.question
  })
  const runId = await enqueueRun(ctx, captainId, message, 0, 'ask', false)
  if (!runId) return { error: 'the Captain cannot answer right now (paused, rate-limited, or over budget)' }
  return { runId, threadId: message.threadRootId ?? message.id, channelId: line.id }
}

export interface Citation {
  /** As written in the answer, e.g. `.opencrew/plans/launch.md@3f2a1c9` or `3f2a1c9`. */
  ref: string
  kind: 'file' | 'commit'
  path?: string
  sha: string
}

const CITATION = /(?:([\w./-]+\.md)@)?\b([0-9a-f]{7,40})\b/g

/** Citations in an answer that resolve against the repo; the rest are dropped. */
export async function extractCitations(dir: string | null, text: string): Promise<Citation[]> {
  if (!dir) return []
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const match of text.matchAll(CITATION)) {
    const [ref, path, sha] = match
    if (!sha || seen.has(ref)) continue
    seen.add(ref)
    if (!(await commitExists(dir, sha))) continue
    if (path && !existsSync(join(dir, path))) continue
    out.push(path ? { ref, kind: 'file', path, sha } : { ref, kind: 'commit', sha })
  }
  return out
}

/** The repo an answer's citations resolve in. */
export async function recordDirFor(db: DB, projectId: string | null): Promise<string | null> {
  if (projectId === null) return hqRepoDir()
  const project = await getProject(db, projectId)
  return project?.workingDir || null
}
