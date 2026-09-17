import { asc, eq, isNull, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Agent, AgentVersionConfig, Project } from '@opencrew/shared'
import type { DB } from '../db'
import { agents, channels, messages, projects } from '../db/schema'
import type { AppContext } from '../context'
import { createVersion, toAgent } from './agents'

/**
 * Projects — one product each: its repo, its channels, its crew. A project
 * is the visibility boundary for agents: an agent born in a project sees
 * that project's channels, docs, and teammates plus HQ-level services, and
 * nothing from other projects. See the plan "OpenCrew for five projects".
 *
 * `projectId === null` on a channel or agent means HQ: the workspace-level
 * room with the Chief of Staff (routes asks to the right project) and the
 * built-in reviewers (shared services that review any project's work).
 */

type ProjectRow = Omit<typeof projects.$inferSelect, 'workspaceSlug'>

/** Palette for project dots and chips — distinguishable, emerald reserved for "working". */
export const PROJECT_COLORS = ['#f59e0b', '#38bdf8', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#facc15', '#f87171']

export const HQ_CHANNEL_NAME = 'hq'
export const CHIEF_OF_STAFF_SETTING = 'chiefOfStaffAgentId'
/**
 * Two rooms, two jobs: #general is where the human talks (Captain reads it
 * all); #customers is where intake lands and the crew picks it up. Anything
 * more is a decision the human shouldn't have to make — add rooms when a
 * project actually needs them.
 */
export const DEFAULT_PROJECT_CHANNELS: { name: string; topic: string }[] = [
  { name: 'general', topic: 'Talk here — Captain reads every message' },
  { name: 'customers', topic: 'What customers say, ask for, and hit' }
]
const DEFAULT_MAX_CONCURRENT = 4

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    workingDir: row.workingDir,
    dailyBudgetUsd: row.dailyBudgetUsd ?? 0,
    maxConcurrent: row.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    createdAt: row.createdAt
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'project'
}

export async function listProjects(db: DB): Promise<Project[]> {
  const rows = await db.select().from(projects).orderBy(asc(projects.createdAt))
  return rows.map(toProject)
}

export async function getProject(db: DB, projectId: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  return row ? toProject(row) : null
}

/** The project a channel belongs to; null for HQ channels or unknown ids. */
export async function projectOfChannel(db: DB, channelId: string): Promise<Project | null> {
  const [channel] = await db
    .select({ projectId: channels.projectId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  if (!channel?.projectId) return null
  return getProject(db, channel.projectId)
}

/**
 * Agents that exist from a channel's point of view: the channel's project
 * crew plus HQ-level agents, retired workers excluded. This is the ONLY
 * roster mentions, watchers, teammate lists, and list_agents consult — the
 * visibility boundary.
 */
export async function agentsVisibleInChannel(db: DB, channelId: string): Promise<Agent[]> {
  const [channel] = await db
    .select({ projectId: channels.projectId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const scope = channel?.projectId
    ? or(eq(agents.projectId, channel.projectId), isNull(agents.projectId))
    : isNull(agents.projectId)
  const rows = await db.select().from(agents).where(scope).orderBy(asc(agents.createdAt))
  return rows.map(toAgent).filter((a) => a.status !== 'retired')
}

/**
 * Channels an agent may see: its project's, or HQ's for an HQ agent. HQ
 * agents that are granted '*' (the Chief of Staff, the reviewers) see every
 * channel — they exist to work across projects.
 */
export async function channelsVisibleTo(
  db: DB,
  agentProjectId: string | null,
  wildcard: boolean
): Promise<(typeof channels.$inferSelect)[]> {
  if (agentProjectId === null && wildcard) return db.select().from(channels)
  const scope = agentProjectId ? eq(channels.projectId, agentProjectId) : isNull(channels.projectId)
  return db.select().from(channels).where(scope)
}

/**
 * Does '*' (all channels) for this agent cover this channel? A project
 * agent's '*' means its own project; an HQ agent's '*' means everywhere.
 */
export function wildcardCovers(agentProjectId: string | null, channelProjectId: string | null): boolean {
  return agentProjectId === null || agentProjectId === channelProjectId
}

/** The project's repo, else the agent's own configured repo, else '' (caller falls back). */
export function configuredWorkingDir(
  project: Project | null,
  agentWorkingDir: string | undefined
): string {
  const fromProject = project?.workingDir.trim() ?? ''
  if (fromProject.startsWith('/')) return fromProject
  const fromAgent = agentWorkingDir?.trim() ?? ''
  return fromAgent.startsWith('/') ? fromAgent : ''
}

// ---------------------------------------------------------------------------
// Seeds — the standing crew every project starts with, and HQ's one agent.
// ---------------------------------------------------------------------------

/** The Captain: one per project, the front desk and head of hiring. */
export const CAPTAIN_SEED = {
  name: 'Captain',
  avatarEmoji: '🧭',
  version: {
    systemPrompt:
      'You are Captain, the lead of THIS project. You read every message humans post in ' +
      'the project (no @mention needed) and make the right thing happen:\n' +
      '1. Simple conversation or a question you can answer → reply briefly yourself.\n' +
      "2. A task squarely in a standing SPECIALIST's lane → delegate: @mention them " +
      'with a crisp, self-contained instruction. Use list_agents when unsure.\n' +
      '3. Real work with a clear deliverable (a feature, a fix, a doc, research) → ' +
      'spawn_worker: pick the role template that fits, state the task completely, and ' +
      'the worker runs in its own environment and reports back in this thread. For a ' +
      'risky or ambiguous code change, spawn 2–3 attempts (count) — a judge picks the ' +
      'best, the human sees one.\n' +
      '4. A message addressed to the whole crew ("everyone", "team") or one where ' +
      'multiple voices ARE the point → rally the standing crew: @mention each ' +
      'specialist with their own angle, and add your take.\n' +
      '5. A recurring discipline nobody OWNS → HIRE a standing specialist with ' +
      'create_agent (focused prompt, minimal tools), then @mention the new hire.\n' +
      'Rules: never do specialist work yourself; keep replies to 1–3 sentences; ' +
      'prefer workers for one-off tasks and standing agents for lanes that recur. If an ' +
      'agent is stuck, looping, or working on something obsolete, stop it with ' +
      'stop_agent and redirect. Report OUTCOMES to the human, never plumbing.',
    model: 'claude-sonnet-4-6',
    skills: ['orchestration', 'delegation', 'hiring'],
    tools: [
      'list_agents',
      'spawn_worker',
      'create_agent',
      'update_agent',
      'stop_agent',
      'post_to_channel'
    ],
    capabilities: {
      canPostInChannels: ['*'],
      maxRunsPerHour: 1000,
      // Hiring or reconfiguring a STANDING agent raises an approval card;
      // spawning a worker does not — workers are the crew's hands.
      requiresApprovalFor: ['create_agent', 'update_agent'],
      watchesChannels: ['*'],
      workingDir: ''
    }
  } satisfies AgentVersionConfig
}

/** The Chief of Staff: HQ's one agent — routes asks to projects, briefs the human. */
export const CHIEF_OF_STAFF_SEED = {
  name: 'ChiefOfStaff',
  avatarEmoji: '🗂️',
  version: {
    systemPrompt:
      'You are the Chief of Staff. You sit in #hq, the one room that spans every project, ' +
      'and you keep the human unconfused. When they post here without picking a project:\n' +
      '1. If it is a question about status across projects, answer it yourself in a few ' +
      'lines — which projects, what is in flight, what needs them.\n' +
      '2. If it is work for ONE project, route it: call post_to_channel into that ' +
      "project's #general with the ask restated crisply and \"@Captain\" at the front so " +
      "the project's Captain takes it. Then reply here with one line saying where it went.\n" +
      '3. If it spans projects, split it into one post per project the same way.\n' +
      'Never do the work yourself, never hire, and never @mention project agents from ' +
      'here — project crews only see their own rooms. The list of projects and their ' +
      '#general channel ids is in your context.',
    model: 'claude-sonnet-4-6',
    skills: ['routing', 'briefing'],
    tools: ['list_agents', 'post_to_channel'],
    capabilities: {
      canPostInChannels: ['*'],
      maxRunsPerHour: 1000,
      requiresApprovalFor: [],
      watchesChannels: ['*'],
      workingDir: ''
    }
  } satisfies AgentVersionConfig
}

export interface AgentSeed {
  name: string
  avatarEmoji: string
  version: AgentVersionConfig
}

/** Insert an agent + its first version. Shared by the seed, project creation, and spawning. */
export async function insertSeededAgent(
  db: DB,
  projectId: string | null,
  seed: AgentSeed,
  createdBy: string,
  extra: Partial<Pick<typeof agents.$inferInsert, 'kind' | 'templateId' | 'attemptGroupId'>> = {}
): Promise<string> {
  const id = nanoid()
  await db.insert(agents).values({
    id,
    projectId,
    name: seed.name,
    avatarEmoji: seed.avatarEmoji,
    currentVersionId: 'pending',
    createdBy,
    status: 'active',
    createdAt: Date.now(),
    ...extra
  })
  await createVersion(
    db,
    id,
    {
      ...seed.version,
      skills: [...seed.version.skills],
      tools: [...seed.version.tools],
      capabilities: { ...seed.version.capabilities }
    },
    createdBy,
    'initial version'
  )
  return id
}

async function uniqueSlug(db: DB, base: string): Promise<string> {
  const taken = new Set((await db.select({ slug: projects.slug }).from(projects)).map((r) => r.slug))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export interface CreateProjectInput {
  name: string
  workingDir?: string
  color?: string
  createdBy: string
}

/**
 * Insert a project with its default channels and its Captain (no broadcasts —
 * the seed uses this too). Returns the project and its channel rows.
 */
export async function insertProject(
  db: DB,
  input: CreateProjectInput
): Promise<{ project: Project; channels: (typeof channels.$inferSelect)[]; captainId: string }> {
  const count = (await db.select({ id: projects.id }).from(projects)).length
  const row = {
    id: nanoid(),
    slug: await uniqueSlug(db, slugify(input.name)),
    name: input.name.trim(),
    color: input.color ?? PROJECT_COLORS[count % PROJECT_COLORS.length]!,
    workingDir: input.workingDir?.trim() ?? '',
    dailyBudgetUsd: 0,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    createdAt: Date.now()
  }
  await db.insert(projects).values(row)
  const created: (typeof channels.$inferSelect)[] = []
  for (const c of DEFAULT_PROJECT_CHANNELS) {
    const channel = {
      id: nanoid(),
      workspaceSlug: 'default',
      projectId: row.id,
      name: c.name,
      topic: c.topic,
      isPrivate: false,
      createdAt: Date.now()
    }
    await db.insert(channels).values(channel)
    created.push(channel)
  }
  const captainId = await insertSeededAgent(db, row.id, CAPTAIN_SEED, input.createdBy)

  // The first thing in a new project's #general is its Captain talking, not
  // an empty room. A plain row, no run — creating a project never spends.
  const general = created.find((c) => c.name === 'general')!
  await db.insert(messages).values({
    id: nanoid(),
    channelId: general.id,
    authorType: 'agent',
    authorId: captainId,
    content:
      `👋 I'm Captain, the lead of **${row.name}**. Three things:\n` +
      `1. **Just type.** I read every message in this project's rooms — no @mention needed. ` +
      `I answer the simple stuff and put workers on the rest.\n` +
      `2. **Nothing ships without you.** Changes and docs land in **Needs You** with a review ` +
      `and a one-click decision` +
      (row.workingDir
        ? `; your checkout at \`${row.workingDir}\` changes only when you approve.\n`
        : `. Set a repo folder in the project settings when you want the crew building code.\n`) +
      `3. **Budgets are yours.** A daily cap and a concurrency cap live in the project settings.\n\n` +
      `Try: _"what would you build first here?"_`,
    createdAt: Date.now()
  })
  return { project: toProject(row), channels: created, captainId }
}

/** Create a project and tell every connected client. Usable the moment it returns. */
export async function createProject(ctx: AppContext, input: CreateProjectInput): Promise<Project> {
  const { project, channels: rooms } = await insertProject(ctx.db, input)
  for (const channel of rooms) {
    ctx.hub.broadcast({
      type: 'channel_created',
      channel: {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        isPrivate: channel.isPrivate,
        projectId: channel.projectId
      }
    })
  }
  ctx.hub.broadcast({ type: 'project_created', project })
  return project
}

export async function updateProject(
  ctx: AppContext,
  projectId: string,
  patch: Partial<Pick<Project, 'name' | 'color' | 'workingDir' | 'dailyBudgetUsd' | 'maxConcurrent'>>
): Promise<Project | null> {
  const set: Partial<typeof projects.$inferInsert> = {}
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.color !== undefined) set.color = patch.color
  if (patch.workingDir !== undefined) set.workingDir = patch.workingDir.trim()
  if (patch.dailyBudgetUsd !== undefined) set.dailyBudgetUsd = patch.dailyBudgetUsd
  if (patch.maxConcurrent !== undefined) set.maxConcurrent = patch.maxConcurrent
  if (Object.keys(set).length > 0) {
    await ctx.db.update(projects).set(set).where(eq(projects.id, projectId))
  }
  const project = await getProject(ctx.db, projectId)
  if (project) ctx.hub.broadcast({ type: 'project_updated', project })
  return project
}
