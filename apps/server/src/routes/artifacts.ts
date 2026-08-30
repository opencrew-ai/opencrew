import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context'
import {
  addComment,
  commitPlan,
  discardPlan,
  getArtifact,
  listAllArtifacts,
  listChannelArtifacts,
  listComments,
  requestChanges
} from '../services/artifacts'
import { authGuard, fail, memberGuard, ok } from './helpers'

const commentSchema = z.object({
  body: z.string().min(1).max(2000),
  quote: z.string().min(1).max(1000).optional()
})

const requestChangesSchema = z.object({
  feedback: z.string().min(1).max(4000)
})

export function registerArtifactRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Every artifact in the workspace — powers the Artifacts tab tree. */
  app.get('/api/artifacts', { preHandler: authGuard(ctx) }, async () => {
    return ok(await listAllArtifacts(ctx.db))
  })

  /** All artifacts in a channel (docs render client-side; newest first). */
  app.get(
    '/api/channels/:channelId/artifacts',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { channelId } = req.params as { channelId: string }
      return ok(await listChannelArtifacts(ctx.db, channelId))
    }
  )

  /** Approve a proposed plan: commit it and put its tasks on the board. */
  app.post(
    '/api/artifacts/:artifactId/commit',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { artifactId } = req.params as { artifactId: string }
      const artifact = await commitPlan(ctx, artifactId, req.user!.id)
      if (!artifact) return reply.code(404).send(fail('no proposed artifact with that id'))
      return ok(artifact)
    }
  )

  /** Single artifact by id — used by the Needs-You inbox to open docs in place. */
  app.get(
    '/api/artifacts/:artifactId',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { artifactId } = req.params as { artifactId: string }
      const artifact = await getArtifact(ctx.db, artifactId)
      if (!artifact) return reply.code(404).send(fail('artifact not found'))
      return ok(artifact)
    }
  )

  /** Review comments on an artifact (anchored to text selections). */
  app.get(
    '/api/artifacts/:artifactId/comments',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { artifactId } = req.params as { artifactId: string }
      return ok(await listComments(ctx.db, artifactId))
    }
  )

  app.post(
    '/api/artifacts/:artifactId/comments',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { artifactId } = req.params as { artifactId: string }
      const parsed = commentSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      const comment = await addComment(ctx, {
        artifactId,
        body: parsed.data.body,
        quote: parsed.data.quote,
        userId: req.user!.id
      })
      if (!comment) return reply.code(404).send(fail('artifact not found'))
      return ok(comment)
    }
  )

  /** Ask the authoring agent to revise: feedback lands in the thread. */
  app.post(
    '/api/artifacts/:artifactId/request-changes',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { artifactId } = req.params as { artifactId: string }
      const parsed = requestChangesSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      const result = await requestChanges(ctx, artifactId, req.user!.id, parsed.data.feedback)
      if (!result) return reply.code(404).send(fail('no proposed artifact with that id'))
      return ok(result)
    }
  )

  /** Reject a proposed plan (the agent can revise and re-propose). */
  app.post(
    '/api/artifacts/:artifactId/discard',
    { preHandler: memberGuard(ctx) },
    async (req, reply) => {
      const { artifactId } = req.params as { artifactId: string }
      const artifact = await discardPlan(ctx, artifactId)
      if (!artifact) return reply.code(404).send(fail('no proposed artifact with that id'))
      return ok(artifact)
    }
  )
}
