import type { FastifyInstance } from 'fastify'
import { desc, ilike, isNull, or } from 'drizzle-orm'
import type { AppContext } from '../context'
import { channels, messages } from '../db/schema'
import { enrichMessage } from '../services/messages'
import { authGuard, ok, fail } from './helpers'

export interface ThreadSearchResult {
  threadRootId: string
  channelId: string
  channelName: string
  triggerContent: string
  triggerAuthorName: string
  triggerCreatedAt: number
  replyCount: number
  snippet: string
}

/**
 * GET /api/search?q=<query>&limit=<n>
 *
 * Full-workspace message search using ILIKE (case-insensitive substring).
 * Returns at most `limit` (default 5, max 20) top-level thread roots that
 * match, ordered by recency. Each result includes enough metadata for agents
 * to reason about relevance without fetching the full thread.
 */
export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/search', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { q, limit: limitStr } = req.query as { q?: string; limit?: string }
    if (!q || q.trim().length < 2) {
      return reply.code(400).send(fail('query must be at least 2 characters'))
    }
    const limit = Math.min(20, Math.max(1, parseInt(limitStr ?? '5', 10) || 5))
    const pattern = `%${q.trim()}%`

    // Find top-level messages (thread roots) that match the query.
    // We search only roots so each result maps to exactly one thread.
    const matchingRoots = await ctx.db
      .select()
      .from(messages)
      .where(or(ilike(messages.content, pattern), isNull(messages.threadRootId)))
      .orderBy(desc(messages.createdAt))
      .limit(limit * 5) // over-fetch then filter

    // Filter to actual content matches (the WHERE above is too broad; we want
    // rows where content matches AND threadRootId is null).
    const roots = matchingRoots
      .filter((m) => m.threadRootId === null && m.content.toLowerCase().includes(q.toLowerCase()))
      .slice(0, limit)

    if (roots.length === 0) {
      return ok<ThreadSearchResult[]>([])
    }

    // Load channel names
    const channelRows = await ctx.db.select().from(channels)
    const channelMap = new Map(channelRows.map((c) => [c.id, c.name]))

    // For each root, count replies
    const results: ThreadSearchResult[] = await Promise.all(
      roots.map(async (root) => {
        const enriched = await enrichMessage(ctx.db, root)
        // Count replies: fetch thread messages
        const replies = await ctx.db
          .select({ id: messages.id })
          .from(messages)
          .where(
            // replies to this root
            or(
              ilike(messages.threadRootId, root.id)
            )
          )

        return {
          threadRootId: root.id,
          channelId: root.channelId,
          channelName: channelMap.get(root.channelId) ?? root.channelId,
          triggerContent: root.content,
          triggerAuthorName: enriched.authorName ?? 'Unknown',
          triggerCreatedAt: root.createdAt,
          replyCount: replies.length,
          snippet: root.content.slice(0, 200)
        }
      })
    )

    return ok(results)
  })

  // GET /api/search/thread?rootId=<id>&channelId=<id>
  // Returns the full thread (root + replies) enriched — used by ThreadRefCard.
  app.get('/api/search/thread', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { rootId, channelId } = req.query as { rootId?: string; channelId?: string }
    if (!rootId || !channelId) {
      return reply.code(400).send(fail('rootId and channelId are required'))
    }

    const rows = (
      await ctx.db
        .select()
        .from(messages)
        .where(
          or(
            ilike(messages.id, rootId),
            ilike(messages.threadRootId, rootId)
          )
        )
        .orderBy(messages.createdAt)
    ).filter((m) => m.channelId === channelId)

    if (rows.length === 0) return reply.code(404).send(fail('thread not found'))

    const enriched = await Promise.all(rows.map((r) => enrichMessage(ctx.db, r)))
    return ok(enriched)
  })
}
