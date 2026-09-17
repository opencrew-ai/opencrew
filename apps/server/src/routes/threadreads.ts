import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { clearThreadRead, findThreadRoot, markThreadRead } from '../services/threadreads'
import { authGuard, fail, ok } from './helpers'

/**
 * Per-user, server-persisted "I've read this thread" state.
 *
 *   POST   /api/channels/:channelId/threads/:rootId/read  → upsert read_at = now
 *   DELETE /api/channels/:channelId/threads/:rootId/read  → clear (back to unread)
 *
 * Both broadcast `thread_read` so the caller's other tabs/devices reconcile.
 * On load, GET /api/channels/:channelId/messages hydrates `readAt` and
 * `lastActivityAt` on every root, so unread derives client-side:
 *   unread = no readAt, or lastActivityAt > readAt.
 */
export function registerThreadReadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/channels/:channelId/threads/:rootId/read',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { channelId, rootId } = req.params as { channelId: string; rootId: string }
      const root = await findThreadRoot(ctx.db, channelId, rootId)
      if (!root) return reply.code(404).send(fail('thread not found'))

      const readAt = await markThreadRead(ctx, req.user!.id, channelId, rootId)
      return ok({ threadRootId: rootId, channelId, readAt })
    }
  )

  app.delete(
    '/api/channels/:channelId/threads/:rootId/read',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { channelId, rootId } = req.params as { channelId: string; rootId: string }
      const root = await findThreadRoot(ctx.db, channelId, rootId)
      if (!root) return reply.code(404).send(fail('thread not found'))

      await clearThreadRead(ctx, req.user!.id, channelId, rootId)
      return ok({ threadRootId: rootId, channelId, readAt: null })
    }
  )
}
