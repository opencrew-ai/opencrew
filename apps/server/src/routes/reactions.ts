import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { REACTION_SET, type ReactionGroup } from '@opencrew/shared'
import type { AppContext } from '../context'
import type { DB } from '../db'
import { messages, reactions } from '../db/schema'
import { authGuard, fail, ok } from './helpers'

/** Aggregate reactions for a set of messages: messageId → one group per emoji. */
export async function reactionsFor(
  db: DB,
  messageIds: string[]
): Promise<Map<string, ReactionGroup[]>> {
  if (messageIds.length === 0) return new Map()
  const rows = await db
    .select({ messageId: reactions.messageId, emoji: reactions.emoji, userId: reactions.userId })
    .from(reactions)
    .where(inArray(reactions.messageId, messageIds))

  const byMessage = new Map<string, ReactionGroup[]>()
  for (const row of rows) {
    const groups = byMessage.get(row.messageId) ?? []
    const group = groups.find((g) => g.emoji === row.emoji)
    if (group) {
      group.userIds.push(row.userId)
    } else {
      groups.push({ emoji: row.emoji, userIds: [row.userId] })
    }
    byMessage.set(row.messageId, groups)
  }
  return byMessage
}

export function registerReactionRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Toggle the caller's reaction on a message. */
  app.post(
    '/api/messages/:messageId/reactions',
    { preHandler: authGuard(ctx) },
    async (req, reply) => {
      const { messageId } = req.params as { messageId: string }
      const parsed = z
        .object({ emoji: z.enum(REACTION_SET) })
        .safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail('unknown emoji'))

      const [message] = await ctx.db
        .select({ id: messages.id, channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      if (!message) return reply.code(404).send(fail('message not found'))

      const userId = req.user!.id
      const emoji = parsed.data.emoji
      const existing = await ctx.db
        .select({ userId: reactions.userId })
        .from(reactions)
        .where(
          and(
            eq(reactions.messageId, messageId),
            eq(reactions.emoji, emoji),
            eq(reactions.userId, userId)
          )
        )
        .limit(1)

      if (existing.length > 0) {
        await ctx.db
          .delete(reactions)
          .where(
            and(
              eq(reactions.messageId, messageId),
              eq(reactions.emoji, emoji),
              eq(reactions.userId, userId)
            )
          )
      } else {
        await ctx.db
          .insert(reactions)
          .values({ messageId, emoji, userId, createdAt: Date.now() })
      }

      const groups = (await reactionsFor(ctx.db, [messageId])).get(messageId) ?? []
      ctx.hub.broadcast({
        type: 'reaction_updated',
        messageId,
        channelId: message.channelId,
        reactions: groups
      })
      return ok({ messageId, reactions: groups })
    }
  )
}
