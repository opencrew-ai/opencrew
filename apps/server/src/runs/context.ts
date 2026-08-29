import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { AgentVersion, Channel } from '@opencrew/shared'
import type { DB } from '../db'
import { agents, channels, messages } from '../db/schema'
import { enrichMessage } from '../services/messages'

const CONTEXT_MESSAGE_COUNT = 30

/**
 * Build the conversation context: the last 30 messages of the channel (or
 * thread) as a transcript, ending with the trigger mention.
 */
export function buildContextTranscript(
  db: DB,
  channelId: string,
  threadRootId: string | null,
  triggerMessageId: string
): string {
  const scope = threadRootId
    ? or(eq(messages.id, threadRootId), eq(messages.threadRootId, threadRootId))
    : and(eq(messages.channelId, channelId), isNull(messages.threadRootId))

  const rows = db
    .select()
    .from(messages)
    .where(scope)
    .orderBy(desc(messages.createdAt))
    .limit(CONTEXT_MESSAGE_COUNT)
    .all()
    .reverse()

  const lines = rows.map((row) => {
    const m = enrichMessage(db, row)
    const time = new Date(m.createdAt).toISOString().slice(11, 16)
    const marker = m.id === triggerMessageId ? ' ← you were mentioned here' : ''
    return `[${time}] ${m.authorName} (${m.authorType}): ${m.content}${marker}`
  })
  return lines.join('\n')
}

/** System prompt: the versioned prompt plus identity, crew, and guardrails. */
export function buildSystemPrompt(
  db: DB,
  agentName: string,
  version: AgentVersion,
  channel: Channel
): string {
  const allChannels = db.select().from(channels).all()
  const allowedChannels = allChannels
    .filter((c) => version.capabilities.canPostInChannels.includes(c.id))
    .map((c) => `#${c.name} (id: ${c.id})`)
  const gated = version.capabilities.requiresApprovalFor
  const teammates = db
    .select()
    .from(agents)
    .all()
    .filter((a) => a.name !== agentName && a.status === 'active')
    .map((a) => `@${a.name}`)

  return [
    version.systemPrompt,
    '',
    '---',
    `You are "${agentName}", an AI teammate in the OpenCrew workspace, currently replying in #${channel.name}.`,
    `Your session runs in your own workspace directory; everything you do is streamed live to the crew's terminal panel.`,
    `Your final text IS your chat reply — write conversational markdown, no preamble about being an AI.`,
    version.skills.length > 0 ? `Your skills: ${version.skills.join(', ')}.` : '',
    `Tools you may use: ${version.tools.join(', ') || '(none)'}.`,
    gated.length > 0
      ? `These tools pause for human approval before running: ${gated.join(', ')}. Use them only when needed.`
      : '',
    allowedChannels.length > 0
      ? `Channels you may post into: ${allowedChannels.join(', ')}.`
      : 'You cannot post to other channels.',
    teammates.length > 0
      ? `Other agents on the crew: ${teammates.join(', ')}. To hand work to one, @mention them in your reply and they will pick it up (chains are depth-limited).`
      : ''
  ]
    .filter((line) => line !== '')
    .join('\n')
}
