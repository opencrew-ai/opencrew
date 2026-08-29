import type { FastifyInstance } from 'fastify'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AppContext } from '../context'
import { approvalRules, approvals, runs, runSteps } from '../db/schema'
import { resolveApproval, toApproval } from '../services/approvals'
import { broadcastPresence } from '../services/presence'
import { adminGuard, authGuard, fail, ok } from './helpers'

const RECENT_RUNS_LIMIT = 50

const resolveSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  always: z.boolean().default(false)
})

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
  // Terminal steps expose the owner's machine (file contents, command
  // output) — admins only, matching the run_step WS gating in the Hub.
  app.get('/api/runs/:runId', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run) return reply.code(404).send(fail('run not found'))
    const steps = (
      await ctx.db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, runId))
        .orderBy(asc(runSteps.seq))
    ).map((s) => ({
      id: s.id,
      runId: s.runId,
      seq: s.seq,
      type: s.type,
      payload: JSON.parse(s.payload),
      createdAt: s.createdAt
    }))
    return ok({ run: toRun(run), steps })
  })

  app.get('/api/agents/:agentId/runs', { preHandler: authGuard(ctx) }, async (req) => {
    const { agentId } = req.params as { agentId: string }
    const rows = await ctx.db
      .select()
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(desc(runs.createdAt))
      .limit(RECENT_RUNS_LIMIT)
    return ok(rows.map(toRun))
  })

  app.post('/api/runs/stop-all', { preHandler: adminGuard(ctx) }, async (req) => {
    // 1. Queued: drop from scheduler, mark cancelled.
    ctx.queue.drainPending()
    const queued = await ctx.db
      .select()
      .from(runs)
      .where(inArray(runs.status, ['queued']))
    for (const run of queued) {
      await ctx.db
        .update(runs)
        .set({ status: 'cancelled', error: 'stopped by admin', finishedAt: Date.now() })
        .where(eq(runs.id, run.id))
      ctx.hub.broadcast({
        type: 'run_status',
        runId: run.id,
        agentId: run.agentId,
        status: 'cancelled'
      })
    }

    // 2. Pending approvals: deny — resolving wakes blocked sessions.
    const pendingApprovals = await ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.status, 'pending'))
    for (const approval of pendingApprovals) {
      try {
        await resolveApproval(ctx, approval.id, 'denied', req.user!.id)
      } catch {
        // Already resolved in a race — fine.
      }
    }

    // 3. Live sessions: pre-mark cancelled, then abort.
    let aborted = 0
    for (const [runId, controller] of ctx.activeRuns) {
      const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
      if (run && ['running', 'awaiting_approval'].includes(run.status)) {
        await ctx.db
          .update(runs)
          .set({ status: 'cancelled', error: 'stopped by admin', finishedAt: Date.now() })
          .where(eq(runs.id, runId))
        ctx.hub.broadcast({
          type: 'run_status',
          runId,
          agentId: run.agentId,
          status: 'cancelled'
        })
        controller.abort()
        aborted++
      }
    }
    broadcastPresence(ctx)

    return ok({
      cancelledQueued: queued.length,
      deniedApprovals: pendingApprovals.length,
      abortedRuns: aborted
    })
  })

  app.get(
    '/api/approvals/:approvalId',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string }
      const [row] = await ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .limit(1)
      if (!row) return reply.code(404).send(fail('approval not found'))
      return ok(toApproval(row))
    }
  )

  app.post(
    '/api/approvals/:approvalId/resolve',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { approvalId } = req.params as { approvalId: string }
      const parsed = resolveSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      try {
        if (parsed.data.decision === 'approved' && parsed.data.always) {
          const [row] = await ctx.db
            .select()
            .from(approvals)
            .where(eq(approvals.id, approvalId))
            .limit(1)
          const [run] = row
            ? await ctx.db.select().from(runs).where(eq(runs.id, row.runId)).limit(1)
            : []
          if (row && run) {
            const existing = (await ctx.db.select().from(approvalRules)).find(
              (r) => r.agentId === run.agentId && r.toolName === row.toolName
            )
            if (!existing) {
              await ctx.db.insert(approvalRules).values({
                id: nanoid(),
                agentId: run.agentId,
                toolName: row.toolName,
                createdBy: req.user!.id,
                createdAt: Date.now()
              })
            }
          }
        }
        return ok(await resolveApproval(ctx, approvalId, parsed.data.decision, req.user!.id))
      } catch (err) {
        return reply
          .code(400)
          .send(fail(err instanceof Error ? err.message : 'resolve failed'))
      }
    }
  )

  app.get(
    '/api/agents/:agentId/approval-rules',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { agentId } = req.params as { agentId: string }
      const rules = await ctx.db
        .select()
        .from(approvalRules)
        .where(eq(approvalRules.agentId, agentId))
      return ok(rules)
    }
  )

  app.delete('/api/approval-rules/:ruleId', { preHandler: adminGuard(ctx) }, async (req) => {
    const { ruleId } = req.params as { ruleId: string }
    await ctx.db.delete(approvalRules).where(eq(approvalRules.id, ruleId))
    return ok(null)
  })
}
