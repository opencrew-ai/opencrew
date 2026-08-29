import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { AppContext } from '../context'
import { channels, messages } from '../db/schema'
import { enrichMessage } from '../services/messages'
import { postMessage } from '../services/post'
import { authGuard, fail, ok } from './helpers'

const MESSAGE_PAGE_SIZE = 50

const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers, and dashes only'),
  topic: z.string().max(200).default('')
})

const postMessageSchema = z
  .object({
    content: z.string().max(20_000).optional().default(''),
    images: z.array(z.string()).max(10).optional().default([]),
    threadRootId: z.string().optional()
  })
  .refine((d) => d.content.length > 0 || d.images.length > 0, {
    message: 'message must have content or at least one image'
  })

export function registerChannelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/channels', { preHandler: authGuard(ctx) }, async () => {
    const rows = ctx.db.select().from(channels).all()
    return ok(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        topic: c.topic,
        isPrivate: Boolean(c.isPrivate)
      }))
    )
  })

  app.post('/api/channels', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const parsed = createChannelSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const existing = ctx.db
      .select()
      .from(channels)
      .where(eq(channels.name, parsed.data.name))
      .get()
    if (existing) return reply.code(409).send(fail('channel name already exists'))
    const channel = {
      id: nanoid(),
      name: parsed.data.name,
      topic: parsed.data.topic,
      isPrivate: 0,
      createdAt: Date.now()
    }
    ctx.db.insert(channels).values(channel).run()
    const publicChannel = { ...channel, isPrivate: false }
    ctx.hub.broadcast({ type: 'channel_created', channel: publicChannel })
    return ok(publicChannel)
  })

  app.get(
    '/api/channels/:channelId/messages',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { channelId } = req.params as { channelId: string }
      const { thread } = req.query as { thread?: string }

      const scope = thread
        ? or(eq(messages.id, thread), eq(messages.threadRootId, thread))
        : and(eq(messages.channelId, channelId), isNull(messages.threadRootId))

      const rows = ctx.db
        .select()
        .from(messages)
        .where(scope)
        .orderBy(desc(messages.createdAt))
        .limit(MESSAGE_PAGE_SIZE)
        .all()
        .reverse()

      const replyCounts = ctx.db
        .select({
          rootId: messages.threadRootId,
          count: sql<number>`count(*)`
        })
        .from(messages)
        .where(eq(messages.channelId, channelId))
        .groupBy(messages.threadRootId)
        .all()
      const countByRoot = new Map(replyCounts.map((r) => [r.rootId, r.count]))

      return ok(
        rows.map((row) => ({
          ...enrichMessage(ctx.db, row),
          replyCount: countByRoot.get(row.id) ?? 0
        }))
      )
    }
  )

  app.post(
    '/api/channels/:channelId/messages',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { channelId } = req.params as { channelId: string }
      const parsed = postMessageSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))

      const channel = ctx.db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .get()
      if (!channel) return reply.code(404).send(fail('channel not found'))

      const message = postMessage(ctx, {
        channelId,
        threadRootId: parsed.data.threadRootId ?? null,
        authorType: 'human',
        authorId: req.user!.id,
        content: parsed.data.content,
        images: parsed.data.images?.length ? parsed.data.images : undefined
      })
      return ok(message)
    }
  )
}
