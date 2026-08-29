import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { extractMentions } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, channels, messages } from '../db/schema'
import { createMessage, enrichMessage, postSystemMessage } from '../services/messages'
import { postMessage } from '../services/post'
import { reactionsFor } from './reactions'
import { authGuard, memberGuard, fail, ok } from './helpers'

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
    const rows = await ctx.db.select().from(channels)
    return ok(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        topic: c.topic,
        isPrivate: Boolean(c.isPrivate)
      }))
    )
  })

  app.post('/api/channels', { preHandler: memberGuard(ctx) }, async (req, reply) => {
    const parsed = createChannelSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const [existing] = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.name, parsed.data.name))
      .limit(1)
    if (existing) return reply.code(409).send(fail('channel name already exists'))
    const channel = {
      id: nanoid(),
      name: parsed.data.name,
      topic: parsed.data.topic,
      isPrivate: false,
      createdAt: Date.now()
    }
    await ctx.db.insert(channels).values(channel)
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

      const rows = (
        await ctx.db
          .select()
          .from(messages)
          .where(scope)
          .orderBy(desc(messages.createdAt))
          .limit(MESSAGE_PAGE_SIZE)
      ).reverse()

      const replyCounts = await ctx.db
        .select({
          rootId: messages.threadRootId,
          count: sql<number>`count(*)`
        })
        .from(messages)
        .where(eq(messages.channelId, channelId))
        .groupBy(messages.threadRootId)
      const countByRoot = new Map(replyCounts.map((r) => [r.rootId, r.count]))

      const reactionsByMessage = await reactionsFor(ctx.db, rows.map((r) => r.id))
      const enriched = await Promise.all(
        rows.map(async (row) => ({
          ...(await enrichMessage(ctx.db, row)),
          replyCount: countByRoot.get(row.id) ?? 0,
          reactions: reactionsByMessage.get(row.id) ?? []
        }))
      )
      return ok(enriched)
    }
  )

  app.post(
    '/api/channels/:channelId/messages',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { channelId } = req.params as { channelId: string }
      const parsed = postMessageSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))

      const [channel] = await ctx.db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      if (!channel) return reply.code(404).send(fail('channel not found'))

      const messageInput = {
        channelId,
        threadRootId: parsed.data.threadRootId ?? null,
        authorType: 'human' as const,
        authorId: req.user!.id,
        content: parsed.data.content,
        images: parsed.data.images?.length ? parsed.data.images : undefined
      }

      // Agents execute on the OWNER's machine with the owner's Claude
      // subscription — only admins may put them to work. Members and guests
      // chat normally (createMessage skips mention + watcher triggers).
      const canRunAgents = req.user!.role === 'admin'
      const message = canRunAgents
        ? await postMessage(ctx, messageInput)
        : await createMessage(ctx, messageInput)

      // A member who @mentions an agent deserves to know why nothing happened.
      if (!canRunAgents && req.user!.role === 'member') {
        const agentRows = await ctx.db.select({ name: agents.name }).from(agents)
        const mentioned = extractMentions(parsed.data.content, agentRows.map((a) => a.name))
        if (mentioned.length > 0) {
          await postSystemMessage(
            ctx,
            channelId,
            `Agents on this crew run on the owner's machine and only respond to admins. ` +
              `Run your own crew free — it's open source: https://github.com/opencrew-ai/opencrew — ` +
              `then link it to your profile at opencrew.run and your agents work for you anywhere.`,
            { threadRootId: parsed.data.threadRootId ?? null }
          )
        }
      }

      return ok(message)
    }
  )
}
