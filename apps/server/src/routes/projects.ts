import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../context'
import { channels } from '../db/schema'
import { postMessage } from '../services/post'
import {
  createProject,
  getProject,
  listProjects,
  PROJECT_COLORS,
  updateProject
} from '../services/projects'
import { adminGuard, authGuard, fail, ok } from './helpers'

const workingDirSchema = z
  .string()
  .max(500)
  .refine((p) => p === '' || p.startsWith('/'), 'must be an absolute path')

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #f59e0b')

const createProjectSchema = z.object({
  name: z.string().min(1).max(60),
  workingDir: workingDirSchema.default(''),
  color: colorSchema.optional()
})

const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    workingDir: workingDirSchema.optional(),
    color: colorSchema.optional(),
    /** 0 = unlimited. */
    dailyBudgetUsd: z.number().min(0).max(100_000).optional(),
    maxConcurrent: z.number().int().min(1).max(64).optional()
  })
  .refine((p) => Object.keys(p).length > 0, 'nothing to update')

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects', { preHandler: authGuard(ctx) }, async () => {
    return ok({ projects: await listProjects(ctx.db), colors: PROJECT_COLORS })
  })

  app.post('/api/projects', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const parsed = createProjectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const project = await createProject(ctx, { ...parsed.data, createdBy: req.user!.id })
    return ok(project)
  })

  app.patch('/api/projects/:projectId', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    const parsed = updateProjectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    if (!(await getProject(ctx.db, projectId))) return reply.code(404).send(fail('project not found'))
    return ok(await updateProject(ctx, projectId, parsed.data))
  })

  /**
   * Customer intake: anything a support tool, a form, or a script learns
   * from a customer lands in the project's #customers as a human-authored
   * post, so the Captain picks it up like any other ask. Admin-only, meant
   * for the owner's own integrations (their session cookie or a local
   * script on the same machine).
   */
  app.post('/api/projects/:projectId/intake', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string }
    const parsed = intakeSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const project = await getProject(ctx.db, projectId)
    if (!project) return reply.code(404).send(fail('project not found'))
    const [room] = await ctx.db
      .select()
      .from(channels)
      .where(and(eq(channels.projectId, projectId), eq(channels.name, 'customers')))
      .limit(1)
    if (!room) return reply.code(404).send(fail('project has no #customers room'))
    const { source, customer, content } = parsed.data
    const message = await postMessage(ctx, {
      channelId: room.id,
      authorType: 'human',
      authorId: req.user!.id,
      content: `📨 **${source}**${customer ? ` · ${customer}` : ''}\n${content}`
    })
    return ok({ messageId: message.id, channelId: room.id })
  })
}

const intakeSchema = z.object({
  /** Where it came from: "support@", "Intercom", "App Store review", … */
  source: z.string().min(1).max(80),
  /** Who, if known (a name, an email, an account id). */
  customer: z.string().max(120).optional(),
  content: z.string().min(1).max(8000)
})
