import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import {
  getThreadShareState,
  NotCloudLinkedError,
  shareThread,
  unshareThread
} from '../services/threadshare'
import { authGuard, fail, ok } from './helpers'

/**
 * Publish a thread as a public page on opencrew.run — the shareable,
 * OG-tagged artifact for X/LinkedIn. Requires the crew to be cloud-linked
 * (the relay hosts the page); humans only, any member can share.
 */
export function registerThreadShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    '/api/threads/:rootId/share',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { rootId } = req.params as { rootId: string }
      return ok(await getThreadShareState(ctx.db, rootId))
    }
  )

  app.post(
    '/api/threads/:rootId/share',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { rootId } = req.params as { rootId: string }
      try {
        return ok(await shareThread(ctx, rootId, req.user!.id))
      } catch (err) {
        if (err instanceof NotCloudLinkedError) return reply.code(409).send(fail(err.message))
        const message = err instanceof Error ? err.message : 'share failed'
        return reply.code(502).send(fail(message))
      }
    }
  )

  app.delete(
    '/api/threads/:rootId/share',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { rootId } = req.params as { rootId: string }
      try {
        await unshareThread(ctx, rootId)
        return ok(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unshare failed'
        return reply.code(502).send(fail(message))
      }
    }
  )
}
