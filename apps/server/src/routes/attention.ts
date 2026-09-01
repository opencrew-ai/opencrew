import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context'
import {
  clearAttention,
  dismissAttentionItem,
  listAttention,
  resolveAttentionRequest,
  restoreAttention
} from '../services/attention'
import { authGuard, fail, memberGuard, ok } from './helpers'

const dismissSchema = z.object({
  kind: z.enum(['request', 'task', 'doc_review', 'tool_approval']),
  refId: z.string().min(1)
})

export function registerAttentionRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The Needs-You inbox: everything currently waiting on a human. */
  app.get('/api/attention', { preHandler: authGuard(ctx) }, async (req) => {
    return ok(await listAttention(ctx.db, req.user!.id))
  })

  /** "Not now" — hide one item from MY inbox. The item's real state is
   *  untouched; it still resolves through its own flow. */
  app.post('/api/attention/dismiss', { preHandler: memberGuard(ctx) }, async (req, reply) => {
    const parsed = dismissSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    await dismissAttentionItem(ctx, req.user!.id, parsed.data.kind, parsed.data.refId)
    return ok({ dismissed: true })
  })

  /** Clear my whole inbox (per-user hide). Undo via /restore. */
  app.post('/api/attention/clear', { preHandler: memberGuard(ctx) }, async (req) => {
    const cleared = await clearAttention(ctx, req.user!.id)
    return ok({ cleared })
  })

  /** Undo: bring back everything I dismissed. */
  app.post('/api/attention/restore', { preHandler: memberGuard(ctx) }, async (req) => {
    await restoreAttention(ctx, req.user!.id)
    return ok({ restored: true })
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
