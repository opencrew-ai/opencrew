import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AgentTemplate } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, artifacts, attemptGroups, channels, messages, runs } from '../db/schema'
import { getAgentWithVersion } from './agents'
import { destroyEnvironment } from './environments'
import { getProject, insertSeededAgent, projectOfChannel } from './projects'
import { enrichMessage, postSystemMessage } from './messages'
import { postMessage } from './post'
import { getCodeReviewerId } from './artifacts'
import { enqueueRun } from '../runs/enqueue'

/**
 * Workers — ephemeral agents spawned from a template for one task, each in
 * its own environment, retired when the task is done. Hundreds of agents
 * means hundreds of workers in flight, not hundreds of names to remember:
 * the sidebar shows standing crew; workers live in their task threads.
 */

export const MAX_ATTEMPTS = 3
/** A worker with no run for this long, and nothing awaiting a human, is done. */
const WORKER_IDLE_MS = 2 * 60 * 60 * 1000

export interface SpawnWorkersInput {
  template: AgentTemplate
  task: string
  count: number
  channelId: string
  conversationRootId: string
  spawnedByAgentId: string
  /** The spawner's run: the kickoff inherits its trust (admin vs community). */
  runId: string
  depth: number
}

async function nextWorkerName(ctx: AppContext, projectId: string, slug: string): Promise<string> {
  const rows = await ctx.db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.projectId, projectId))
  const taken = new Set(rows.map((r) => r.name))
  for (let n = 1; ; n++) {
    const name = `${slug}-${n}`
    if (!taken.has(name)) return name
  }
}

/**
 * Create the worker agent(s) in the spawner's project and kick each off by
 * posting the task as the spawner, @mentioning the worker — the normal
 * mention pipeline admits the run, so guardrails, budgets, and the fabric
 * apply exactly as for any agent.
 */
export async function spawnWorkers(
  ctx: AppContext,
  input: SpawnWorkersInput
): Promise<{ names: string[]; attemptGroupId: string | null } | { error: string }> {
  const project = await projectOfChannel(ctx.db, input.channelId)
  if (!project) return { error: 'workers can only be spawned inside a project room (not HQ)' }
  const spawner = await getAgentWithVersion(ctx.db, input.spawnedByAgentId)
  if (!spawner) return { error: 'spawning agent not found' }
  const count = Math.max(1, Math.min(MAX_ATTEMPTS, input.count))

  const attemptGroupId = count > 1 ? nanoid() : null
  if (attemptGroupId) {
    await ctx.db.insert(attemptGroups).values({
      id: attemptGroupId,
      projectId: project.id,
      channelId: input.channelId,
      conversationRootId: input.conversationRootId,
      task: input.task,
      size: count,
      spawnedByAgentId: input.spawnedByAgentId,
      createdAt: Date.now()
    })
  }

  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const name = await nextWorkerName(ctx, project.id, input.template.slug)
    const attemptNote =
      count > 1
        ? `\n\nYou are attempt ${i + 1} of ${count} at this task; others work in parallel in their own environments. Do your best independent version — a judge picks one.`
        : ''
    const id = await insertSeededAgent(
      ctx.db,
      project.id,
      {
        name,
        avatarEmoji: input.template.avatarEmoji,
        version: {
          systemPrompt: input.template.systemPrompt + attemptNote,
          model: input.template.model,
          skills: [...input.template.skills],
          tools: [...input.template.tools],
          capabilities: {
            canPostInChannels: ['*'],
            maxRunsPerHour: 1000,
            requiresApprovalFor: input.template.gatedTools.filter((t) => input.template.tools.includes(t)),
            watchesChannels: [],
            workingDir: ''
          }
        }
      },
      `agent:${input.spawnedByAgentId}`,
      { kind: 'worker', templateId: input.template.id, attemptGroupId }
    )
    const created = await getAgentWithVersion(ctx.db, id)
    if (created) ctx.hub.broadcast({ type: 'agent_updated', agent: created })
    names.push(name)
  }

  // One kickoff per worker so the fan-out cap can never swallow an attempt.
  for (const name of names) {
    await postMessage(
      ctx,
      {
        channelId: input.channelId,
        threadRootId: input.conversationRootId,
        authorType: 'agent',
        authorId: spawner.id,
        agentVersionId: spawner.currentVersionId,
        runId: input.runId,
        content: `@${name} ${input.task}`,
        isRunReply: true
      },
      input.depth + 1
    )
  }
  return { names, attemptGroupId }
}

/** Retire a worker: it stops being mentionable, its environment is freed, its history stays. */
export async function retireWorker(ctx: AppContext, agentId: string): Promise<void> {
  const [row] = await ctx.db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
  if (!row || row.kind !== 'worker' || row.status === 'retired') return
  await ctx.db
    .update(agents)
    .set({ status: 'retired', retiredAt: Date.now() })
    .where(eq(agents.id, agentId))
  const project = row.projectId ? await getProject(ctx.db, row.projectId) : null
  if (project?.workingDir) await destroyEnvironment(ctx.db, agentId, project.workingDir)
  const updated = await getAgentWithVersion(ctx.db, agentId)
  if (updated) ctx.hub.broadcast({ type: 'agent_updated', agent: updated })
}

/**
 * Sweep: workers idle for WORKER_IDLE_MS with nothing of theirs waiting on a
 * human are retired. Groups whose remaining workers are all done get judged.
 */
export async function retireIdleWorkers(ctx: AppContext, now: number = Date.now()): Promise<number> {
  const workers = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.kind, 'worker'), eq(agents.status, 'active')))
  let retired = 0
  for (const w of workers) {
    const [lastRun] = await ctx.db
      .select({ createdAt: runs.createdAt, finishedAt: runs.finishedAt, status: runs.status })
      .from(runs)
      .where(eq(runs.agentId, w.id))
      .orderBy(desc(runs.createdAt))
      .limit(1)
    const active = lastRun && ['queued', 'running', 'awaiting_approval'].includes(lastRun.status)
    if (active) continue
    const lastAt = lastRun?.finishedAt ?? lastRun?.createdAt ?? w.createdAt
    if (now - lastAt < WORKER_IDLE_MS) continue
    const waiting = await ctx.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.createdByAgentId, w.id), inArray(artifacts.status, ['review', 'proposed'])))
    if (waiting.length > 0) continue
    await retireWorker(ctx, w.id)
    retired++
    if (w.attemptGroupId) await maybeJudgeGroup(ctx, w.attemptGroupId)
  }
  return retired
}

/**
 * Judging: once every attempt in a group has a change proposal (or has
 * retired without one), ONE review run judges them together instead of the
 * usual one-review-per-proposal, so the human sees a single winner.
 */
export async function maybeJudgeGroup(ctx: AppContext, groupId: string): Promise<boolean> {
  const [group] = await ctx.db
    .select()
    .from(attemptGroups)
    .where(and(eq(attemptGroups.id, groupId), isNull(attemptGroups.judgedAt)))
    .limit(1)
  if (!group) return false
  const members = await ctx.db.select().from(agents).where(eq(agents.attemptGroupId, groupId))
  const proposals = await ctx.db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationRootId, group.conversationRootId),
        eq(artifacts.kind, 'change'),
        inArray(artifacts.status, ['review', 'proposed'])
      )
    )
  const proposed = new Set(proposals.map((p) => p.createdByAgentId))
  const outstanding = members.filter((m) => m.status !== 'retired' && !proposed.has(m.id))
  if (outstanding.length > 0) return false
  if (proposals.filter((p) => members.some((m) => m.id === p.createdByAgentId)).length === 0) {
    await ctx.db.update(attemptGroups).set({ judgedAt: Date.now() }).where(eq(attemptGroups.id, groupId))
    return false
  }

  await ctx.db.update(attemptGroups).set({ judgedAt: Date.now() }).where(eq(attemptGroups.id, groupId))
  const reviewerId = await getCodeReviewerId(ctx.db)
  const list = proposals
    .filter((p) => members.some((m) => m.id === p.createdByAgentId))
    .map((p) => {
      const author = members.find((m) => m.id === p.createdByAgentId)
      return `"${p.title}" by ${author?.name ?? 'a worker'}`
    })
    .join('; ')
  const notice = await postSystemMessage(
    ctx,
    group.channelId,
    `⚖️ ${proposals.length} parallel attempts at the same task are ready: ${list}. ` +
      `CodeReviewer judges them together: verdict "clear" on exactly ONE (the best on correctness, ` +
      `scope, and simplicity) and "revise" on the rest with a one-line reason each — the human ` +
      `should see a single winner.`,
    { threadRootId: group.conversationRootId }
  )
  if (reviewerId && notice) {
    const [root] = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, group.conversationRootId))
      .limit(1)
    if (root) await enqueueRun(ctx, reviewerId, await enrichMessage(ctx.db, root), 0, 'review', false)
  }
  return true
}

/** The group a worker belongs to, if it's an attempt at a judged task. */
export async function attemptGroupOfAgent(ctx: AppContext, agentId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ attemptGroupId: agents.attemptGroupId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  return row?.attemptGroupId ?? null
}

/** Worker counts per project for the Today page. */
export async function activeWorkerCount(ctx: AppContext, projectId: string | null): Promise<number> {
  const scope = projectId ? eq(agents.projectId, projectId) : isNull(agents.projectId)
  const rows = await ctx.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(scope, eq(agents.kind, 'worker'), eq(agents.status, 'active')))
  return rows.length
}

/** Channels of a project, for callers that only hold a project id. */
export async function channelIdsOfProject(ctx: AppContext, projectId: string | null): Promise<string[]> {
  const scope = projectId ? eq(channels.projectId, projectId) : isNull(channels.projectId)
  return (await ctx.db.select({ id: channels.id }).from(channels).where(scope)).map((r) => r.id)
}
