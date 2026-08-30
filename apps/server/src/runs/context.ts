import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm'
import type { AgentVersion, Channel } from '@opencrew/shared'
import type { DB } from '../db'
import { agents, channels, messages } from '../db/schema'
import { enrichMessage } from '../services/messages'

const CONTEXT_MESSAGE_COUNT = 30

/**
 * Build the conversation context: the last 30 messages of the channel (or
 * thread) as a transcript, ending with the trigger mention.
 */
export async function buildContextTranscript(
  db: DB,
  channelId: string,
  threadRootId: string | null,
  triggerMessageId: string
): Promise<string> {
  const scope = threadRootId
    ? or(eq(messages.id, threadRootId), eq(messages.threadRootId, threadRootId))
    : and(eq(messages.channelId, channelId), isNull(messages.threadRootId))

  const rows = (
    await db
      .select()
      .from(messages)
      .where(scope)
      .orderBy(desc(messages.createdAt))
      .limit(CONTEXT_MESSAGE_COUNT)
  ).reverse()

  const lines = await Promise.all(
    rows.map(async (row) => {
      const m = await enrichMessage(db, row)
      const time = new Date(m.createdAt).toISOString().slice(11, 16)
      const marker = m.id === triggerMessageId ? ' ← you were mentioned here' : ''
      return `[${time}] ${m.authorName} (${m.authorType}): ${m.content}${marker}`
    })
  )
  return lines.join('\n')
}

/**
 * For a RESUMED session: only what happened since the agent's last turn —
 * the session itself already holds everything earlier.
 */
export async function buildIncrementalTranscript(
  db: DB,
  channelId: string,
  threadRootId: string | null,
  sinceTs: number,
  triggerMessageId: string
): Promise<string> {
  const scope = threadRootId
    ? and(
        or(eq(messages.id, threadRootId), eq(messages.threadRootId, threadRootId)),
        gt(messages.createdAt, sinceTs)
      )
    : and(
        eq(messages.channelId, channelId),
        isNull(messages.threadRootId),
        gt(messages.createdAt, sinceTs)
      )

  const rows = await db
    .select()
    .from(messages)
    .where(scope)
    .orderBy(asc(messages.createdAt))
  const lines = await Promise.all(
    rows.map(async (row) => {
      const m = await enrichMessage(db, row)
      const time = new Date(m.createdAt).toISOString().slice(11, 16)
      const marker = m.id === triggerMessageId ? ' ← you were triggered here' : ''
      return `[${time}] ${m.authorName} (${m.authorType}): ${m.content}${marker}`
    })
  )
  return lines.join('\n')
}

/** System prompt: the versioned prompt plus identity, crew, and guardrails. */
export async function buildSystemPrompt(
  db: DB,
  agentName: string,
  version: AgentVersion,
  channel: Channel
): Promise<string> {
  const allChannels = await db.select().from(channels)
  const postAll = version.capabilities.canPostInChannels.includes('*')
  const allowedChannels = allChannels
    .filter((c) => postAll || version.capabilities.canPostInChannels.includes(c.id))
    .map((c) => `#${c.name} (id: ${c.id})`)
  const gated = version.capabilities.requiresApprovalFor
  const allAgents = await db.select().from(agents)
  const teammates = allAgents
    .filter((a) => a.name !== agentName && a.status === 'active')
    .map((a) => `@${a.name}`)
  const watchesAll = (version.capabilities.watchesChannels ?? []).includes('*')

  return [
    version.systemPrompt,
    '',
    '---',
    `You are "${agentName}", an AI teammate in the OpenCrew workspace, currently replying in #${channel.name}.`,
    `You are persistent: this conversation resumes the same session every turn, and your working directory persists — you can build things across many messages. Everything you do is streamed live to the crew's terminal panel.`,
    `Your final text IS your chat reply — write conversational markdown, no preamble about being an AI.`,
    `DOC RULE: substantial output NEVER goes into chat — plans, drafts, specs, reports, ` +
      `posts, and writeups are all DOCS. Call propose_plan (always available) with the full ` +
      `markdown (plus a prioritized task list when it's a plan). Docs await human approval; ` +
      `do not execute a plan's tasks until a human commits it. Your chat reply is a 1-2 ` +
      `sentence summary pointing to the doc by title. Revise docs by re-proposing the SAME ` +
      `title; keep plans small — under ~10 tasks; split bigger efforts into phases. Mark ` +
      `steps only a person can do (their accounts, payments, sign-offs) with assignee ` +
      `"human" — they go to the human's inbox, never to an agent. ` +
      `ENFORCED: chat replies over ~2000 characters are automatically moved into a doc and ` +
      `replaced with a pointer — and any @mentions inside them are dropped, so put ` +
      `delegations in the short reply, not in documents.`,
    `CODE RULE: the codebase is a LOCAL artifact — you edit files freely in your working ` +
      `directory, but you NEVER run git commit. When a focused change is ready, call ` +
      `propose_change (title + summary): it captures your diff for review in chat — ` +
      `CodeReviewer first, then a human, whose approval performs the commit. Keep changes ` +
      `small and coherent; one propose_change per logical change.`,
    `NEEDS-A-HUMAN RULE: when you need a review, a decision, credentials, or a manual step ` +
      `only a human can do (posting on their accounts, payments, external sign-offs), call ` +
      `request_human with one crisp sentence. Never bury asks to humans inside chat prose — ` +
      `chat scrolls away; the inbox does not.`,
    `While executing committed work, track progress with the built-in TodoWrite tool (call it ` +
      `directly — never via ToolSearch). When the shared task list appears in your context, ` +
      `echo item text verbatim so your status updates match the board. BEFORE ENDING EVERY ` +
      `TURN: sync the status of any shared task you worked on via TodoWrite (verbatim text, ` +
      `status completed/in_progress), and record outcomes in the doc with update_doc — a task ` +
      `is not done until the board and the doc say so.`,
    version.skills.length > 0 ? `Your skills: ${version.skills.join(', ')}.` : '',
    `Tools you may use: ${[...version.tools, 'TodoWrite'].join(', ')}.`,
    gated.length > 0
      ? `These tools pause for human approval before running: ${gated.join(', ')}. Use them only when needed.`
      : '',
    allowedChannels.length > 0
      ? `Channels you may post into: ${allowedChannels.join(', ')}.`
      : 'You cannot post to other channels.',
    teammates.length > 0
      ? `Other agents on the crew: ${teammates.join(', ')}. IMPORTANT: writing @Name ` +
        `anywhere in your reply TRIGGERS that agent to run. Never @mention agents ` +
        `casually — in lists, tables, plans, or status summaries write names WITHOUT ` +
        `the @. Only @mention when you are delegating a task to that agent right now, ` +
        `and delegate to the fewest agents the task needs (usually one; fan-out and ` +
        `chain depth are capped).`
      : '',
    watchesAll
      ? `You see every human message in every channel automatically. Humans who @mention a specific agent are handled by that agent — you only receive untargeted messages.`
      : ''
  ]
    .filter((line) => line !== '')
    .join('\n')
}
