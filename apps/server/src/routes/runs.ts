import type { FastifyInstance } from 'fastify'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../context'
import { approvals, runs, runSteps } from '../db/schema'
import { resolveApproval, toApproval } from '../services/approvals'
import { adminGuard, authGuard, fail, ok } from './helpers'

const RECENT_RUNS_LIMIT = 50

const resolveSchema = z.object({ decision: z.enum(['approved', 'denied']) })

function toRun(row: typeof runs.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersionId: row.agentVersionId,
    triggerMessageId: row.triggerMessageId,
    status: row.status,
    error: row.error,
    depth: row.depth,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  }
}

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/runs/:runId', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const run = ctx.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) return reply.code(404).send(fail('run not found'))
    const steps = ctx.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.seq))
      .all()
      .map((s) => ({
        id: s.id,
        runId: s.runId,
        seq: s.seq,
        type: s.type,
        payload: JSON.parse(s.payload),
        createdAt: s.createdAt
      }))
    return ok({ run: toRun(run), steps })
  })

  app.get(
    '/api/agents/:agentId/runs',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { agentId } = req.params as { agentId: string }
      const rows = ctx.db
        .select()
        .from(runs)
        .where(eq(runs.agentId, agentId))
        .orderBy(desc(runs.createdAt))
        .limit(RECENT_RUNS_LIMIT)
        .all()
      return ok(rows.map(toRun))
    }
  )

  app.get(
    '/api/approvals/:approvalId',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string }
      const row = ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .get()
      if (!row) return reply.code(404).send(fail('approval not found'))
      return ok(toApproval(row))
    }
  )

  // Only admins resolve approvals; enforcement of the result lives in the
  // executor (assertToolInvocationAllowed), not here.
  app.post(
    '/api/approvals/:approvalId/resolve',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string }
      const parsed = resolveSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      try {
        return ok(resolveApproval(ctx, approvalId, parsed.data.decision, req.user!.id))
      } catch (err) {
        return reply
          .code(400)
          .send(fail(err instanceof Error ? err.message : 'resolve failed'))
      }
    }
  )
}
