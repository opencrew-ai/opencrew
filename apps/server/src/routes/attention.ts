import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { listAttention, resolveAttentionRequest } from '../services/attention'
import { authGuard, fail, memberGuard, ok } from './helpers'

export function registerAttentionRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The Needs-You inbox: everything currently waiting on a human. */
  app.get('/api/attention', { preHandler: authGuard(ctx) }, async () => {
    return ok(await listAttention(ctx.db))
  })

  /** Mark an explicit agent request handled (doc reviews and tool approvals
   *  resolve through their own flows). */
  app.post(
    '/api/attention/:requestId/resolve',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { requestId } = req.params as { requestId: string }
      const resolved = await resolveAttentionRequest(ctx, requestId, req.user!.id)
      if (!resolved) return reply.code(404).send(fail('no open request with that id'))
      return ok({ resolved: true })
    }
  )
}
