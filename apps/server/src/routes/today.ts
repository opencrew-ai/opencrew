import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { workspaceToday } from '../services/today'
import { listTemplates } from '../services/templates'
import { authGuard, ok } from './helpers'

export function registerTodayRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** HQ first, then every project: shipped / in flight / needs you / spend. */
  app.get('/api/today', { preHandler: authGuard(ctx) }, async () => ok(await workspaceToday(ctx)))

  /** Role templates workers are spawned from. */
  app.get('/api/templates', { preHandler: authGuard(ctx) }, async () => ok(await listTemplates(ctx.db)))
}
