import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { agents, artifacts, attemptGroups, effects, environments, fabricTasks, runs } from '../db/schema'
import { claimNextTask, createFabricTask } from '../fabric/store'
import { env } from '../env'
import { commitPatch, captureStagedDiff } from '../services/changes'
import {
  destroyEnvironment,
  ensureEnvironment,
  resolveAgentWorkingDir,
  syncEnvironment
} from '../services/environments'
import { alreadyPerformed, recordEffect } from '../services/effects'
import { isOverBudget, sumResultCosts } from '../services/budgets'
import { commitPlan, proposePlan } from '../services/artifacts'
import { createProject, listProjects } from '../services/projects'
import { getTemplateBySlug, seedTemplates } from '../services/templates'
import { maybeJudgeGroup, retireIdleWorkers, spawnWorkers } from '../services/workers'
import { createMessage } from '../services/messages'
import { makeTestCtx, seedAgent, seedUser, type TestCtx } from './helpers'

let repo: string
let envsRoot: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'oc-repo-'))
  envsRoot = mkdtempSync(join(tmpdir(), 'oc-envs-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@opencrew.local')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  ;(env as { envsDir: string }).envsDir = envsRoot
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(envsRoot, { recursive: true, force: true })
})

async function projectWithRepo(ctx: TestCtx, userId: string, name = 'Repo') {
  return createProject(ctx, { name, workingDir: repo, createdBy: userId })
}

describe('environments', () => {
  it('gives each agent its own worktree of the project repo and a distinct port', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await projectWithRepo(ctx, userId)
    const a = await seedAgent(ctx.db, userId, { name: 'A' })
    const b = await seedAgent(ctx.db, userId, { name: 'B' })

    const envA = await ensureEnvironment(ctx.db, project, a.agentId)
    const envB = await ensureEnvironment(ctx.db, project, b.agentId)
    expect(envA.path).not.toBe(envB.path)
    expect(envA.port).not.toBe(envB.port)
    expect(existsSync(join(envA.path, 'README.md'))).toBe(true)
    expect(git(envA.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'))
    // Idempotent
    expect((await ensureEnvironment(ctx.db, project, a.agentId)).id).toBe(envA.id)

    const resolved = await resolveAgentWorkingDir(ctx.db, project, a.agentId, '/should/not/matter', ['Bash'])
    expect(resolved.path).toBe(envA.path)
    expect(resolved.environment?.id).toBe(envA.id)

    await destroyEnvironment(ctx.db, a.agentId, repo)
    expect(existsSync(envA.path)).toBe(false)
    expect(await ctx.db.select().from(environments).where(eq(environments.agentId, a.agentId))).toHaveLength(0)
  })

  it('falls back to the scratch workspace when the project has no git repo', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await createProject(ctx, { name: 'NoRepo', workingDir: '', createdBy: userId })
    const a = await seedAgent(ctx.db, userId, { name: 'A' })
    const resolved = await resolveAgentWorkingDir(ctx.db, project, a.agentId, undefined)
    expect(resolved.environment).toBeNull()
    expect(resolved.path).toContain(a.agentId)
  })

  it("a worker's patch is committed to the project checkout and applied to its working tree; a clean worktree then syncs", async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await projectWithRepo(ctx, userId)
    const a = await seedAgent(ctx.db, userId, { name: 'Worker' })
    const environment = await ensureEnvironment(ctx.db, project, a.agentId)

    writeFileSync(join(environment.path, 'feature.txt'), 'built in a worktree\n')
    const captured = await captureStagedDiff(environment.path)
    if ('error' in captured) throw new Error(captured.error)
    const before = git(repo, 'rev-parse', 'HEAD')
    const result = await commitPatch(repo, captured.patch, 'feat: feature', 'Worker', {
      applyToWorkingTree: true
    })
    if ('error' in result) throw new Error(result.error)
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(before)
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('built in a worktree\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')

    // The worktree still holds its uncommitted copy: dirty → left alone.
    await syncEnvironment(repo, environment)
    expect(git(environment.path, 'rev-parse', 'HEAD')).toBe(before)
    // Once clean (staged work discarded), the next turn starts at the new HEAD.
    git(environment.path, 'reset', '-q', '--hard')
    git(environment.path, 'clean', '-qfd')
    await syncEnvironment(repo, environment)
    expect(git(environment.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'))
  })
})

describe('effects ledger and approval', () => {
  it('records once; a second record is a no-op', async () => {
    const ctx = await makeTestCtx()
    await recordEffect(ctx.db, 'commit', 'x', 'abc1234')
    await recordEffect(ctx.db, 'commit', 'x', 'zzz9999')
    expect(await alreadyPerformed(ctx.db, 'commit', 'x')).toBe('abc1234')
    expect(await alreadyPerformed(ctx.db, 'commit', 'y')).toBeNull()
    expect(await ctx.db.select().from(effects)).toHaveLength(1)
  })

  it('approving the same change twice commits once', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await projectWithRepo(ctx, userId, 'Approve')
    const a = await seedAgent(ctx.db, userId, { name: 'Worker' })
    const environment = await ensureEnvironment(ctx.db, project, a.agentId)
    const general = (await import('../db/schema')).channels
    const [room] = await ctx.db.select().from(general).where(eq(general.projectId, project.id))
    const root = await createMessage(ctx, { channelId: room!.id, authorType: 'human', authorId: userId, content: 'go' })
    const [run] = await ctx.db
      .insert(runs)
      .values({
        id: 'run1',
        agentId: a.agentId,
        agentVersionId: a.versionId,
        triggerMessageId: root.id,
        status: 'running',
        createdAt: Date.now()
      })
      .returning()

    writeFileSync(join(environment.path, 'twice.txt'), 'once\n')
    const captured = await captureStagedDiff(environment.path)
    if ('error' in captured) throw new Error(captured.error)
    const artifact = await proposePlan(ctx, {
      conversationRootId: root.id,
      channelId: room!.id,
      runId: run!.id,
      agentId: a.agentId,
      title: 'feat: twice',
      content: 'x',
      tasks: [],
      kind: 'change',
      sourceDir: environment.path,
      patch: captured.patch
    })
    const first = await commitPlan(ctx, artifact.id, userId)
    expect(first?.status).toBe('committed')
    const headAfterFirst = git(repo, 'rev-parse', 'HEAD')
    // Force the row back to proposed and approve again — the ledger answers.
    await ctx.db.update(artifacts).set({ status: 'proposed', committedBy: null }).where(eq(artifacts.id, artifact.id))
    const second = await commitPlan(ctx, artifact.id, userId)
    expect(second?.status).toBe('committed')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headAfterFirst)
  })
})

describe('budgets', () => {
  it('sums only result costs and knows when a cap is hit', () => {
    const cost = sumResultCosts([
      JSON.stringify({ phase: 'result', costUsd: 0.5 }),
      JSON.stringify({ model: 'x', usage: {} }),
      'not json',
      JSON.stringify({ phase: 'result', costUsd: 0.25 })
    ])
    expect(cost).toBe(0.75)
    expect(isOverBudget(0.75, 0)).toBe(false)
    expect(isOverBudget(0.75, 1)).toBe(false)
    expect(isOverBudget(1, 1)).toBe(true)
  })

  it('the fabric never leases more turns for a project than its cap', async () => {
    const ctx = await makeTestCtx()
    const mk = (id: string, projectId: string, cap: number) =>
      createFabricTask(ctx.db, {
        id,
        kind: 'turn',
        lane: 'interactive',
        sessionKey: `s-${id}`,
        devices: [],
        payload: { projectCap: cap },
        projectId
      })
    await mk('p1a', 'p1', 1)
    await mk('p1b', 'p1', 1)
    await mk('p2a', 'p2', 2)
    const opts = { workerId: 'w', capacity: 10, interactiveReserve: 1, leaseMs: 1000 }
    const first = await claimNextTask(ctx.db, opts)
    const second = await claimNextTask(ctx.db, opts)
    const third = await claimNextTask(ctx.db, opts)
    expect([first?.id, second?.id].sort()).toEqual(['p1a', 'p2a'])
    expect(third).toBeNull()
    const leased = await ctx.db.select().from(fabricTasks).where(eq(fabricTasks.state, 'leased'))
    expect(leased.map((t) => t.id).sort()).toEqual(['p1a', 'p2a'])
  })
})

describe('workers', () => {
  it('spawns N attempts in the project with their own names and an attempt group, and kicks each off', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    await seedTemplates(ctx.db)
    const project = await projectWithRepo(ctx, userId, 'Workers')
    const captain = (await ctx.db.select().from(agents).where(eq(agents.projectId, project.id)))[0]!
    const { channels } = await import('../db/schema')
    const [room] = await ctx.db.select().from(channels).where(eq(channels.projectId, project.id))
    const root = await createMessage(ctx, { channelId: room!.id, authorType: 'human', authorId: userId, content: 'build it' })
    const template = (await getTemplateBySlug(ctx.db, 'frontend'))!

    const result = await spawnWorkers(ctx, {
      template,
      task: 'Add a dark mode toggle to the settings page with tests.',
      count: 2,
      channelId: room!.id,
      conversationRootId: root.id,
      spawnedByAgentId: captain.id,
      runId: 'r',
      depth: 0
    })
    if ('error' in result) throw new Error(result.error)
    expect(result.names).toEqual(['frontend-1', 'frontend-2'])
    expect(result.attemptGroupId).toBeTruthy()
    const workers = await ctx.db.select().from(agents).where(eq(agents.kind, 'worker'))
    expect(workers).toHaveLength(2)
    expect(workers.every((w) => w.projectId === project.id && w.attemptGroupId === result.attemptGroupId)).toBe(true)
    // Each worker was @mentioned → admitted as its own run.
    expect(ctx.enqueued).toHaveLength(2)
    const groups = await ctx.db.select().from(attemptGroups)
    expect(groups[0]?.size).toBe(2)
  })

  it('judges a group once every attempt has proposed, with a single review run', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    await seedTemplates(ctx.db)
    // A CodeReviewer at HQ so the judge has someone to run.
    const { CODE_REVIEWER_SETTING } = await import('../services/artifacts')
    const { setRawSetting } = await import('../services/settings')
    const reviewer = await seedAgent(ctx.db, userId, { name: 'CodeReviewer', tools: [] })
    await setRawSetting(ctx.db, CODE_REVIEWER_SETTING, reviewer.agentId)

    const project = await projectWithRepo(ctx, userId, 'Judge')
    const captain = (await ctx.db.select().from(agents).where(eq(agents.projectId, project.id)))[0]!
    const { channels } = await import('../db/schema')
    const [room] = await ctx.db.select().from(channels).where(eq(channels.projectId, project.id))
    const root = await createMessage(ctx, { channelId: room!.id, authorType: 'human', authorId: userId, content: 'fix it' })
    const template = (await getTemplateBySlug(ctx.db, 'backend'))!
    const spawned = await spawnWorkers(ctx, {
      template,
      task: 'Fix the flaky test in the billing module.',
      count: 2,
      channelId: room!.id,
      conversationRootId: root.id,
      spawnedByAgentId: captain.id,
      runId: 'r',
      depth: 0
    })
    if ('error' in spawned) throw new Error(spawned.error)
    const workers = await ctx.db.select().from(agents).where(eq(agents.kind, 'worker'))
    const runsBefore = ctx.enqueued.length

    const propose = async (w: (typeof workers)[number], title: string) =>
      proposePlan(ctx, {
        conversationRootId: root.id,
        channelId: room!.id,
        runId: 'r',
        agentId: w.id,
        title,
        content: 'diff',
        tasks: [],
        kind: 'change',
        sourceDir: '/x',
        patch: 'p'
      })
    await propose(workers[0]!, 'fix: attempt one')
    // First proposal: no review run yet — the judge waits for the second.
    expect(ctx.enqueued.length).toBe(runsBefore)
    expect(await maybeJudgeGroup(ctx, spawned.attemptGroupId!)).toBe(false)
    await propose(workers[1]!, 'fix: attempt two')
    // Second proposal: exactly one review run for the reviewer, group marked judged.
    expect(ctx.enqueued.length).toBe(runsBefore + 1)
    const [group] = await ctx.db.select().from(attemptGroups)
    expect(group?.judgedAt).toBeTruthy()
    const reviewRuns = (await ctx.db.select().from(runs)).filter((r) => r.agentId === reviewer.agentId)
    expect(reviewRuns).toHaveLength(1)
    expect(reviewRuns[0]?.triggerType).toBe('review')
  })

  it('retires idle workers and frees their environments; busy or waiting ones stay', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    await seedTemplates(ctx.db)
    const project = await projectWithRepo(ctx, userId, 'Retire')
    const captain = (await ctx.db.select().from(agents).where(eq(agents.projectId, project.id)))[0]!
    const { channels } = await import('../db/schema')
    const [room] = await ctx.db.select().from(channels).where(eq(channels.projectId, project.id))
    const root = await createMessage(ctx, { channelId: room!.id, authorType: 'human', authorId: userId, content: 'go' })
    const template = (await getTemplateBySlug(ctx.db, 'qa'))!
    const spawned = await spawnWorkers(ctx, {
      template,
      task: 'Verify the signup flow end to end.',
      count: 1,
      channelId: room!.id,
      conversationRootId: root.id,
      spawnedByAgentId: captain.id,
      runId: 'r',
      depth: 0
    })
    if ('error' in spawned) throw new Error(spawned.error)
    const [worker] = await ctx.db.select().from(agents).where(eq(agents.kind, 'worker'))
    const environment = await ensureEnvironment(ctx.db, project, worker!.id)
    expect(existsSync(environment.path)).toBe(true)

    // Its kickoff run is still queued → not idle.
    expect(await retireIdleWorkers(ctx, Date.now() + 3 * 60 * 60 * 1000)).toBe(0)
    await ctx.db.update(runs).set({ status: 'done', finishedAt: Date.now() }).where(eq(runs.agentId, worker!.id))
    // Done just now → not idle yet.
    expect(await retireIdleWorkers(ctx, Date.now())).toBe(0)
    // Three hours later → retired, environment gone.
    expect(await retireIdleWorkers(ctx, Date.now() + 3 * 60 * 60 * 1000)).toBe(1)
    const [after] = await ctx.db.select().from(agents).where(eq(agents.id, worker!.id))
    expect(after?.status).toBe('retired')
    expect(existsSync(environment.path)).toBe(false)
    const [p] = await listProjects(ctx.db)
    expect(p).toBeDefined()
  })
})
