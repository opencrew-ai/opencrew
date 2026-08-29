import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AuthorType, Message } from '@opencrew/shared'
import { agents, channels, messages, users } from '../db/schema'
import type { DB } from '../db'
import type { AppContext } from '../context'
import { getVersion, getAgent } from './agents'

export interface CreateMessageInput {
  channelId: string
  threadRootId?: string | null
  authorType: AuthorType
  authorId?: string | null
  content: string
  /** Base64 data-URL images attached to this message. */
  images?: string[]
  approvalId?: string | null
  runId?: string | null
  /** For agent authors: the pinned version whose capabilities apply. */
  agentVersionId?: string
}

export class GuardrailViolation extends Error {}

function resolveAuthor(db: DB, authorType: AuthorType, authorId: string | null) {
  if (authorType === 'human' && authorId) {
    const user = db.select().from(users).where(eq(users.id, authorId)).get()
    return { name: user?.name ?? 'Unknown', emoji: '' }
  }
  if (authorType === 'agent' && authorId) {
    const agent = getAgent(db, authorId)
    return { name: agent?.name ?? 'Unknown agent', emoji: agent?.avatarEmoji ?? '🤖' }
  }
  return { name: 'OpenCrew', emoji: '⚙️' }
}

export function enrichMessage(db: DB, row: typeof messages.$inferSelect): Message {
  const author = resolveAuthor(db, row.authorType, row.authorId)
  let images: string[] | undefined
  if (row.images) {
    try { images = JSON.parse(row.images) as string[] } catch { /* ignore */ }
  }
  return {
    id: row.id,
    channelId: row.channelId,
    threadRootId: row.threadRootId,
    authorType: row.authorType,
    authorId: row.authorId,
    content: row.content,
    images: images?.length ? images : undefined,
    createdAt: row.createdAt,
    authorName: author.name,
    authorEmoji: author.emoji,
    approvalId: row.approvalId ?? undefined,
    runId: row.runId ?? undefined
  }
}

/**
 * Single choke point for message creation. GUARDRAIL: an agent-authored
 * message into a channel outside its version's canPostInChannels is rejected
 * here, so no code path can bypass it.
 */
export function createMessage(ctx: AppContext, input: CreateMessageInput): Message {
  const { db } = ctx

  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.id, input.channelId))
    .get()
  if (!channel) throw new Error(`channel not found: ${input.channelId}`)

  if (input.authorType === 'agent') {
    if (!input.authorId || !input.agentVersionId) {
      throw new GuardrailViolation('agent posts must carry an agentVersionId')
    }
    const version = getVersion(db, input.agentVersionId)
    if (!version) throw new GuardrailViolation('unknown agent version')
    // '*' = explicitly granted all channels (e.g. an orchestrator agent).
    const allowed = version.capabilities.canPostInChannels
    if (!allowed.includes('*') && !allowed.includes(input.channelId)) {
      throw new GuardrailViolation(
        `agent is not allowed to post in #${channel.name}`
      )
    }
  }

  const row = {
    id: nanoid(),
    channelId: input.channelId,
    threadRootId: input.threadRootId ?? null,
    authorType: input.authorType,
    authorId: input.authorId ?? null,
    content: input.content,
    images: input.images?.length ? JSON.stringify(input.images) : null,
    approvalId: input.approvalId ?? null,
    runId: input.runId ?? null,
    createdAt: Date.now()
  }
  db.insert(messages).values(row).run()
  const message = enrichMessage(db, row)
  ctx.hub.broadcast({ type: 'message_created', message })
  return message
}

/** Replace a streaming placeholder's content and notify clients. */
export function updateMessageContent(
  ctx: AppContext,
  messageId: string,
  content: string
): void {
  ctx.db.update(messages).set({ content }).where(eq(messages.id, messageId)).run()
  const row = ctx.db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (row) {
    ctx.hub.broadcast({ type: 'message_updated', message: enrichMessage(ctx.db, row) })
  }
}

export function postSystemMessage(
  ctx: AppContext,
  channelId: string,
  content: string,
  extra?: { threadRootId?: string | null; approvalId?: string; runId?: string }
): Message {
  return createMessage(ctx, {
    channelId,
    threadRootId: extra?.threadRootId ?? null,
    authorType: 'system',
    content,
    approvalId: extra?.approvalId,
    runId: extra?.runId
  })
}
