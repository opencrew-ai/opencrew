import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm'
import type { AgentVersion, Channel } from '@opencrew/shared'
import type { DB } from '../db'
import { agents, channels, messages } from '../db/schema'
import { enrichMessage } from '../services/messages'
import {
  agentsVisibleInChannel,
  channelsVisibleTo,
  getProject,
  listProjects
} from '../services/projects'
import { CHROME_TOOL } from '../tools/registry'
import { hqRepoDir } from '../services/record'

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
/**
 * The feedback loop. Without it agents argue about whether a change rendered
 * ("must be a build lag") instead of looking — the exact failure this rule
 * exists to end.
 */
function chromeFeedbackLoopRule(): string {
  return (
    `FEEDBACK LOOP (you have the human's own Chrome via the claude-in-chrome tools): ` +
    `NEVER claim a UI change works, renders, or is "findable" without looking. Open the ` +
    `page in their Chrome (tabs_context_mcp with createIfEmpty, then navigate), let it finish ` +
    `loading (single-page apps paint after load: wait ~2s, and if a screenshot is blank wait ` +
    `and retake it once), take a screenshot or read the page, and report what you actually ` +
    `saw — the same served ` +
    `bundle, profile, and logins the human has, so what you see is what they see. ` +
    `Looking (screenshot, read_page, console, network) never needs approval; navigating, ` +
    `clicking, typing, or scripting may pause for one. You only see tabs inside the Claude ` +
    `tab group: open the URL yourself, or ask the human to drag a tab into that group. If the ` +
    `chrome tools are missing, say so — the human needs the Claude in Chrome extension.`
  )
}

/** HQ agents (Chief of Staff, reviewers) get the project directory: where each project's #general is. */
async function hqProjectsLine(db: DB): Promise<string> {
  const all = await listProjects(db)
  if (all.length === 0) return ''
  const generals = await db.select().from(channels).where(eq(channels.name, 'general'))
  const entries = all.map((p) => {
    const general = generals.find((c) => c.projectId === p.id)
    return `"${p.name}"${general ? ` (#general id: ${general.id})` : ''}`
  })
  return (
    `You are an HQ-level agent spanning every project. Projects in this workspace: ` +
    `${entries.join('; ')}. To hand work to a project, post into its #general with @Captain.`
  )
}

export async function buildSystemPrompt(
  db: DB,
  agentName: string,
  version: AgentVersion,
  channel: Channel,
  environment: { path: string; port: number } | null = null
): Promise<string> {
  // PROJECT BOUNDARY: the agent's world is its project (or HQ). Channels
  // and teammates outside it are not listed, so they cannot be addressed.
  const [self] = await db
    .select({ projectId: agents.projectId })
    .from(agents)
    .where(eq(agents.id, version.agentId))
    .limit(1)
  const agentProjectId = self?.projectId ?? null
  const project = agentProjectId ? await getProject(db, agentProjectId) : null
  const postAll = version.capabilities.canPostInChannels.includes('*')
  const visibleChannels = await channelsVisibleTo(db, agentProjectId, postAll)
  const allowedChannels = visibleChannels
    .filter((c) => postAll || version.capabilities.canPostInChannels.includes(c.id))
    .map((c) => `#${c.name} (id: ${c.id})`)
  const gated = version.capabilities.requiresApprovalFor
  const teammates = (await agentsVisibleInChannel(db, channel.id))
    .filter((a) => a.name !== agentName && a.status === 'active')
    .map((a) => `@${a.name}`)
  const watchesAll = (version.capabilities.watchesChannels ?? []).includes('*')
  const hasChrome = version.tools.includes(CHROME_TOOL)
  const projectLine = project
    ? `PROJECT: you work on "${project.name}".` +
      ` Other projects exist in this workspace but are none of your concern; never reference them.`
    : agentProjectId === null
      ? await hqProjectsLine(db)
      : ''
  const recordDir = project?.workingDir || hqRepoDir()
  const environmentLine = environment
    ? `YOUR ENVIRONMENT: a private checkout of the project repo at ${environment.path} (your ` +
      `working directory) with port ${environment.port} reserved for you — PORT is set, so ` +
      `\`pnpm dev\`/\`npm start\` style servers land there; open http://localhost:${environment.port} ` +
      `in the human's Chrome to look. Other agents have their own checkouts; the human's own ` +
      `checkout at ${project?.workingDir ?? 'the project repo'} is NOT yours to edit or run — ` +
      `your changes reach it only through propose_change and the human's approval.`
    : ''

  return [
    version.systemPrompt,
    ...(hasChrome ? [chromeFeedbackLoopRule()] : []),
    '',
    '---',
    `You are "${agentName}", an AI teammate in the OpenCrew workspace, currently replying in ` +
      `#${channel.name}${channel.topic ? ` — this channel is for: "${channel.topic}"` : ''}.`,
    projectLine,
    environmentLine,
    `THE RECORD: \`${recordDir}/.opencrew/\` is this ${project ? 'project' : 'workspace'}'s ` +
      `memory, committed with git — docs and plans as files, one line per decision in ` +
      `decisions.md, the review thread behind each commit as a git note. Read docs there ` +
      `with read_doc; a doc you propose becomes a file there the moment a human approves it.`,
    `CHANNEL FIT: answer through the lens of THIS channel's purpose. Workspace docs are ` +
      `shared truth, but filter them to what belongs here — in a build channel talk about ` +
      `what gets built, not marketing logistics. If the ask (or part of it) belongs in ` +
      `another channel, cover it in one line and point there instead of importing it.`,
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
    `Channel replies are STATUS LINES, not reports: lead with the outcome, 1-2 sentences, ` +
      `then stop. Details, analysis, and specs go into docs (propose_plan / update_doc) — ` +
      `chat scrolls away, docs are the record. Never restate a doc's content in chat; link ` +
      `it by title.`,
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
        `the @. Only @mention when you are delegating a task to that agent right now. ` +
        `Match delegation breadth to the ask: a narrow task goes to the one best ` +
        `specialist, but when the human addresses the whole crew ("everyone", "team") ` +
        `or the work spans specialties, @mention each relevant specialist in the same ` +
        `reply with their slice of the work — that is the crew working as a team, not ` +
        `noise. (Fan-out and chain depth are capped, so over-delegation is bounded.)`
      : '',
    watchesAll
      ? `You see every human message in every channel automatically. Humans who @mention a specific agent are handled by that agent — you only receive untargeted messages.`
      : ''
  ]
    .filter((line) => line !== '')
    .join('\n')
}
