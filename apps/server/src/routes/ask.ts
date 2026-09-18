import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../context'
import { runs } from '../db/schema'
import { awaitRunReply } from '../runs/await'
import { askCaptain, extractCitations, recordDirFor, type Citation } from '../services/ask'
import { fail, memberGuard, ok } from './helpers'

const DEFAULT_WAIT_MS = 60_000
const MAX_WAIT_MS = 240_000

const askSchema = z.object({
  question: z.string().min(1).max(4000),
  threadId: z.string().optional(),
  /** How long to wait for the answer before returning 202 (poll GET /api/ask/:runId). */
  wait: z.number().int().min(0).max(MAX_WAIT_MS).optional()
})

export interface AskResponse {
  runId: string
  threadId: string
  channelId: string
  status: 'done' | 'failed' | 'cancelled' | 'running'
  answer: string | null
  citations: Citation[]
}

/**
 * Ask the workspace: POST a question, get the Captain's answer with
 * citations into the record. Works the same through Cloud Link, which is
 * how a teammate asks from the portal.
 */
export function registerAskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const handle = async (projectId: string | null, body: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, user: { id: string; name: string }) => {
    const parsed = askSchema.safeParse(body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const admitted = await askCaptain(ctx, {
      projectId,
      user,
      question: parsed.data.question,
      threadId: parsed.data.threadId
    })
    if ('error' in admitted) return reply.code(409).send(fail(admitted.error))
    const result = await awaitRunReply(ctx, admitted.runId, parsed.data.wait ?? DEFAULT_WAIT_MS)
    const citations = result.answer ? await extractCitations(await recordDirFor(ctx.db, projectId), result.answer) : []
    const response: AskResponse = { ...admitted, status: result.status, answer: result.answer, citations }
    return result.status === 'running' ? reply.code(202).send(ok(response)) : ok(response)
  }

  app.post('/api/projects/:projectId/ask', { preHandler: memberGuard(ctx) }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    return handle(projectId, req.body, reply, req.user!)
  })

  app.post('/api/ask', { preHandler: memberGuard(ctx) }, async (req, reply) => handle(null, req.body, reply, req.user!))

  /** Poll an answer that took longer than the wait. */
  app.get('/api/ask/:runId', { preHandler: memberGuard(ctx) }, async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || run.triggerType !== 'ask') return reply.code(404).send(fail('no consult with that id'))
    const result = await awaitRunReply(ctx, runId, 0)
    const citations = result.answer ? await extractCitations(await recordDirFor(ctx.db, run.projectId ?? null), result.answer) : []
    return ok({ runId, status: result.status, answer: result.answer, citations })
  })
}
