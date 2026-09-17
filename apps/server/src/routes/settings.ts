import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context'
import { getSettings, setSetting } from '../services/settings'
import { updateStatus } from '../services/telemetry'
import { env } from '../env'
import { adminGuard, authGuard, fail, ok } from './helpers'

const updateSchema = z.object({
  maxMentionDepth: z.number().int().min(1).optional(),
  maxAgentFanout: z.number().int().min(1).optional(),
  badgeEnabled: z.boolean().optional(),
  telemetryEnabled: z.boolean().optional()
})

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', { preHandler: authGuard(ctx) }, async () => {
    return ok(await getSettings(ctx.db))
  })

  /** Running version, the latest released one (from the heartbeat reply), and whether telemetry can run at all. */
  app.get('/api/version', { preHandler: authGuard(ctx) }, async () => {
    return ok({ ...updateStatus(), telemetryAllowed: env.telemetry })
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
    if (parsed.data.telemetryEnabled !== undefined) {
      await setSetting(ctx.db, 'telemetryEnabled', parsed.data.telemetryEnabled)
    }
    return ok(await getSettings(ctx.db))
  })
}
