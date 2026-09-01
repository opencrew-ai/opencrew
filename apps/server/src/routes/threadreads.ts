import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { DB } from '../db'
import { messages, threadReads } from '../db/schema'
import { authGuard, fail, ok } from './helpers'

/** Resolve a thread root and confirm it lives in the given channel. */
async function findRoot(db: DB, channelId: string, rootId: string) {
  const [root] = await db
    .select({ id: messages.id, channelId: messages.channelId, threadRootId: messages.threadRootId })
    .from(messages)
    .where(eq(messages.id, rootId))
    .limit(1)
  if (!root || root.channelId !== channelId) return null
  // Only conversation roots carry read state; replies resolve to their root.
  if (root.threadRootId) return null
  return root
}

/**
 * Per-user, server-persisted "I've read this thread" state.
 *
 *   POST   /api/channels/:channelId/threads/:rootId/read  → upsert read_at = now
 *   DELETE /api/channels/:channelId/threads/:rootId/read  → clear (back to unread)
 *
 * Both broadcast `thread_read` so the caller's other tabs/devices reconcile.
 * Unread derivation is client-side: unread = no readAt, or lastReplyAt > readAt.
 */
export function registerThreadReadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/channels/:channelId/threads/:rootId/read',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { channelId, rootId } = req.params as { channelId: string; rootId: string }
      const root = await findRoot(ctx.db, channelId, rootId)
      if (!root) return reply.code(404).send(fail('thread not found'))

      const userId = req.user!.id
      const readAt = Date.now()
      await ctx.db
        .insert(threadReads)
        .values({ userId, threadRootId: rootId, channelId, readAt })
        .onConflictDoUpdate({
          target: [threadReads.userId, threadReads.threadRootId],
          set: { readAt, channelId }
        })

      ctx.hub.broadcast({ type: 'thread_read', userId, threadRootId: rootId, channelId, readAt })
      return ok({ threadRootId: rootId, channelId, readAt })
    }
  )

  app.delete(
    '/api/channels/:channelId/threads/:rootId/read',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { channelId, rootId } = req.params as { channelId: string; rootId: string }
      const root = await findRoot(ctx.db, channelId, rootId)
      if (!root) return reply.code(404).send(fail('thread not found'))

      const userId = req.user!.id
      await ctx.db
        .delete(threadReads)
        .where(and(eq(threadReads.userId, userId), eq(threadReads.threadRootId, rootId)))

      ctx.hub.broadcast({ type: 'thread_read', userId, threadRootId: rootId, channelId, readAt: null })
      return ok({ threadRootId: rootId, channelId, readAt: null })
    }
  )
}
