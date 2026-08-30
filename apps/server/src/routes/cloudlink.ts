import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context'
import { cloudStatus, startLinking, unlink } from '../services/cloudlink'
import { adminGuard, authGuard, fail, ok } from './helpers'

const startSchema = z.object({ instanceName: z.string().min(1).max(60).default('OpenCrew HQ') })

export function registerCloudLinkRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/cloudlink/status', { preHandler: authGuard(ctx) }, async () => {
    return ok(await cloudStatus(ctx))
  })

  app.post('/api/cloudlink/start', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const parsed = startSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    try {
      return ok(await startLinking(ctx, parsed.data.instanceName))
    } catch (err) {
      return reply
        .code(502)
        .send(fail(err instanceof Error ? err.message : 'could not reach the relay'))
    }
  })

  app.post('/api/cloudlink/unlink', { preHandler: adminGuard(ctx) }, async () => {
    await unlink(ctx)
    return ok(null)
  })
}
