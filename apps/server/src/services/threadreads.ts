import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { DB } from '../db'
import { messages, threadReads } from '../db/schema'

/**
 * Per-user, server-persisted "I've read this thread" state.
 *
 * Only conversation roots carry read state. Unread is derived — never stored:
 *   unread ⇔ readAt is absent OR readAt < lastActivityAt
 * so a new reply automatically resurfaces a read thread without a write.
 */

export interface ThreadReadState {
  /** unix-ms of the newest message in the thread (root included). */
  lastActivityAt: number
  /** When the user last marked the thread read. Absent = never. */
  readAt?: number
}

/** Resolve a thread root and confirm it lives in the given channel. */
export async function findThreadRoot(db: DB, channelId: string, rootId: string) {
  const [root] = await db
    .select({ id: messages.id, channelId: messages.channelId, threadRootId: messages.threadRootId })
    .from(messages)
    .where(eq(messages.id, rootId))
    .limit(1)
  if (!root || root.channelId !== channelId) return null
  // Replies never carry read state; callers must address the root.
  if (root.threadRootId) return null
  return root
}

/** Upsert read_at = now for (user, root) and notify the user's other tabs. */
export async function markThreadRead(
  ctx: AppContext,
  userId: string,
  channelId: string,
  rootId: string
): Promise<number> {
  const readAt = Date.now()
  await ctx.db
    .insert(threadReads)
    .values({ userId, threadRootId: rootId, channelId, readAt })
    .onConflictDoUpdate({
      target: [threadReads.userId, threadReads.threadRootId],
      set: { readAt, channelId }
    })
  ctx.hub.broadcast({ type: 'thread_read', userId, threadRootId: rootId, channelId, readAt })
  return readAt
}

/** Clear read state for (user, root) — thread goes back to unread. */
export async function clearThreadRead(
  ctx: AppContext,
  userId: string,
  channelId: string,
  rootId: string
): Promise<void> {
  await ctx.db
    .delete(threadReads)
    .where(and(eq(threadReads.userId, userId), eq(threadReads.threadRootId, rootId)))
  ctx.hub.broadcast({ type: 'thread_read', userId, threadRootId: rootId, channelId, readAt: null })
}

/**
 * Read state for a page of conversation roots, as seen by `userId`.
 * Two queries regardless of page size; keyed by root id.
 */
export async function threadReadStateFor(
  db: DB,
  userId: string,
  channelId: string,
  rootIds: string[]
): Promise<Map<string, ThreadReadState>> {
  const out = new Map<string, ThreadReadState>()
  if (rootIds.length === 0) return out

  const rootExpr = sql<string>`coalesce(${messages.threadRootId}, ${messages.id})`
  const activity = await db
    .select({ rootId: rootExpr, lastActivityAt: sql<number>`max(${messages.createdAt})` })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        or(inArray(messages.id, rootIds), inArray(messages.threadRootId, rootIds))
      )
    )
    .groupBy(rootExpr)
  for (const row of activity) {
    out.set(row.rootId, { lastActivityAt: Number(row.lastActivityAt) })
  }

  const reads = await db
    .select({ rootId: threadReads.threadRootId, readAt: threadReads.readAt })
    .from(threadReads)
    .where(and(eq(threadReads.userId, userId), inArray(threadReads.threadRootId, rootIds)))
  for (const row of reads) {
    const state = out.get(row.rootId)
    if (state) state.readAt = Number(row.readAt)
  }
  return out
}
