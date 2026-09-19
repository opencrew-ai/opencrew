import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context'
import { getDocShareState, shareDoc, unshareDoc } from '../services/docshare'
import { NotCloudLinkedError } from '../services/threadshare'
import { authGuard, fail, ok } from './helpers'

const shareBody = z.object({ emails: z.array(z.string().max(120)).max(50).optional() })

/** Share an approved doc as a page on opencrew.run — public, or for listed emails. */
export function registerDocShareRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/artifacts/:id/share', { preHandler: authGuard(ctx) }, async (req) => {
    const { id } = req.params as { id: string }
    return ok(await getDocShareState(ctx.db, id))
  })

  app.post('/api/artifacts/:id/share', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = shareBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    try {
      return ok(await shareDoc(ctx, id, req.user!.id, parsed.data.emails))
    } catch (err) {
      if (err instanceof NotCloudLinkedError) return reply.code(409).send(fail(err.message))
      return reply.code(502).send(fail(err instanceof Error ? err.message : 'share failed'))
    }
  })

  app.delete('/api/artifacts/:id/share', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await unshareDoc(ctx, id)
      return ok(null)
    } catch (err) {
      return reply.code(502).send(fail(err instanceof Error ? err.message : 'unshare failed'))
    }
  })
}
