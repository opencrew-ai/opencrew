import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context'
import { getSettings, setSetting } from '../services/settings'
import { adminGuard, authGuard, fail, ok } from './helpers'

const updateSchema = z.object({
  maxMentionDepth: z.number().int().min(1).optional(),
  maxAgentFanout: z.number().int().min(1).optional(),
  badgeEnabled: z.boolean().optional()
})

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', { preHandler: authGuard(ctx) }, async () => {
    return ok(await getSettings(ctx.db))
  })

  app.post('/api/settings', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    if (parsed.data.maxMentionDepth !== undefined) {
      await setSetting(ctx.db, 'maxMentionDepth', parsed.data.maxMentionDepth)
    }
    if (parsed.data.maxAgentFanout !== undefined) {
      await setSetting(ctx.db, 'maxAgentFanout', parsed.data.maxAgentFanout)
    }
    if (parsed.data.badgeEnabled !== undefined) {
      await setSetting(ctx.db, 'badgeEnabled', parsed.data.badgeEnabled)
    }
    return ok(await getSettings(ctx.db))
  })
}
