import { asc, eq, or } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { DB } from '../db'
import { channels, messages, threadShares } from '../db/schema'
import { getRawSetting } from './settings'
import { resolveAuthor } from './messages'

/**
 * Public thread sharing — pushes a frozen, sanitized snapshot of a thread to
 * the relay, which hosts it at opencrew.run/t/:token. The snapshot is what
 * the sharer saw at share time: later replies never leak, and the page stays
 * up when this machine is offline. Re-sharing refreshes the same URL.
 */

const SNAPSHOT_MESSAGE_CAP = 300
const SNAPSHOT_CONTENT_CAP = 6000
const TITLE_CAP = 100

export class NotCloudLinkedError extends Error {
  constructor() {
    super('This crew is not linked to opencrew.run — link it in Settings first.')
  }
}

interface SnapshotMessage {
  author: string
  emoji: string | null
  type: 'human' | 'agent'
  content: string
  createdAt: number
}

export interface ThreadShareState {
  url: string
  updatedAt: number
}

async function relayCredentials(db: DB) {
  const [relayUrl, workspaceId, secret] = await Promise.all([
    getRawSetting(db, 'cloudRelayUrl'),
    getRawSetting(db, 'cloudWorkspaceId'),
    getRawSetting(db, 'cloudLinkSecret')
  ])
  if (!relayUrl || !workspaceId || !secret) throw new NotCloudLinkedError()
  return { relayUrl, workspaceId, secret }
}

function deriveTitle(rootContent: string): string {
  const firstLine = rootContent
    .split('\n')
    .map((line) => line.replace(/[#*>`]/g, '').trim())
    .find((line) => line.length > 0)
  if (!firstLine) return 'A crew conversation'
  return firstLine.length > TITLE_CAP ? `${firstLine.slice(0, TITLE_CAP).trimEnd()}…` : firstLine
}

async function buildSnapshot(db: DB, rootId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(or(eq(messages.id, rootId), eq(messages.threadRootId, rootId)))
    .orderBy(asc(messages.createdAt))
    .limit(SNAPSHOT_MESSAGE_CAP)

  const root = rows.find((r) => r.id === rootId)
  if (!root) throw new Error('thread not found')

  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, root.channelId))
    .limit(1)

  const snapshotMessages: SnapshotMessage[] = []
  for (const row of rows) {
    // Workspace plumbing (run notices, guardrail messages) stays private.
    if (row.authorType === 'system') continue
    const hasImages = Boolean(row.images)
    const content = row.content.trim()
    if (!content && !hasImages) continue
    const author = await resolveAuthor(db, row.authorType, row.authorId)
    const clipped =
      content.length > SNAPSHOT_CONTENT_CAP
        ? `${content.slice(0, SNAPSHOT_CONTENT_CAP).trimEnd()}…`
        : content
    snapshotMessages.push({
      author: author.name,
      emoji: author.emoji || null,
      type: row.authorType,
      // Images are stripped — base64 payloads don't belong in a public snapshot.
      content: hasImages ? `${clipped}${clipped ? '\n' : ''}[image attached]` : clipped,
      createdAt: row.createdAt
    })
  }
  if (snapshotMessages.length === 0) throw new Error('thread has no shareable messages')

  return {
    title: deriveTitle(root.content),
    channelId: root.channelId,
    snapshot: {
      // The relay overwrites crewName with the linked workspace's name.
      crewName: channel?.name ?? 'crew',
      messages: snapshotMessages
    }
  }
}

export async function getThreadShareState(
  db: DB,
  rootId: string
): Promise<ThreadShareState | null> {
  const [row] = await db
    .select()
    .from(threadShares)
    .where(eq(threadShares.threadRootId, rootId))
    .limit(1)
  return row ? { url: row.url, updatedAt: row.updatedAt } : null
}

export async function shareThread(
  ctx: AppContext,
  rootId: string,
  userId: string
): Promise<ThreadShareState> {
  const { relayUrl, workspaceId, secret } = await relayCredentials(ctx.db)
  const { title, channelId, snapshot } = await buildSnapshot(ctx.db, rootId)

  const [existing] = await ctx.db
    .select()
    .from(threadShares)
    .where(eq(threadShares.threadRootId, rootId))
    .limit(1)

  const res = await fetch(`${relayUrl}/connector-api/thread-shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      secret,
      token: existing?.token,
      title,
      snapshot
    })
  })
  if (!res.ok) throw new Error(`relay rejected the share (${res.status})`)
  const { token, url } = (await res.json()) as { token: string; url: string }

  const now = Date.now()
  if (existing) {
    await ctx.db
      .update(threadShares)
      .set({ token, url, updatedAt: now })
      .where(eq(threadShares.threadRootId, rootId))
  } else {
    await ctx.db.insert(threadShares).values({
      threadRootId: rootId,
      workspaceSlug: 'default',
      channelId,
      token,
      url,
      sharedBy: userId,
      createdAt: now,
      updatedAt: now
    })
  }
  return { url, updatedAt: now }
}

export async function unshareThread(ctx: AppContext, rootId: string): Promise<void> {
  const [existing] = await ctx.db
    .select()
    .from(threadShares)
    .where(eq(threadShares.threadRootId, rootId))
    .limit(1)
  if (!existing) return

  try {
    const { relayUrl, workspaceId, secret } = await relayCredentials(ctx.db)
    const res = await fetch(`${relayUrl}/connector-api/thread-shares/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, secret, token: existing.token })
    })
    if (!res.ok) throw new Error(`relay refused to revoke (${res.status})`)
  } catch (err) {
    // The public page MUST come down when the user asks — if the relay is
    // unreachable we keep the local record so they can retry, not silently
    // leave the page up while showing "not shared".
    throw err instanceof Error ? err : new Error('relay unreachable')
  }
  await ctx.db.delete(threadShares).where(eq(threadShares.threadRootId, rootId))
}
