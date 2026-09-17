import { describe, expect, it } from 'vitest'
import { eq, isNull } from 'drizzle-orm'
import { agents, channels, messages, runs } from '../db/schema'
import { seedIfEmpty } from '../db/seed'
import { enqueueMentionRuns } from '../runs/enqueue'
import { createMessage, GuardrailViolation } from '../services/messages'
import { getAgentWithVersion } from '../services/agents'
import { getRawSetting } from '../services/settings'
import { DOC_REVIEWER_SETTING } from '../services/artifacts'
import { listTemplates } from '../services/templates'
import {
  agentsVisibleInChannel,
  CAPTAIN_SEED,
  CHIEF_OF_STAFF_SEED,
  CHIEF_OF_STAFF_SETTING,
  configuredWorkingDir,
  createProject,
  HQ_CHANNEL_NAME,
  listProjects,
  wildcardCovers
} from '../services/projects'
import { makeTestCtx, seedAgent, seedUser, type TestCtx } from './helpers'

async function generalOf(ctx: TestCtx, projectId: string): Promise<string> {
  const rooms = await ctx.db.select().from(channels).where(eq(channels.projectId, projectId))
  return rooms.find((c) => c.name === 'general')!.id
}

async function hqChannel(ctx: TestCtx): Promise<string> {
  const rows = await ctx.db.select().from(channels).where(isNull(channels.projectId))
  return rows.find((c) => c.name === HQ_CHANNEL_NAME)!.id
}

/** Agents admitted so far, in admission order (run rows outlive fabric task state). */
async function admittedAgentIds(ctx: TestCtx): Promise<string[]> {
  const rows = await ctx.db.select().from(runs)
  const byId = new Map(rows.map((r) => [r.id, r.agentId]))
  return ctx.enqueued.map((runId) => byId.get(runId)!).filter(Boolean)
}

describe('seed', () => {
  it('boots HQ (#hq with a welcome, Chief of Staff, reviewers) and the role templates — no project until the human adds one', async () => {
    const ctx = await makeTestCtx()
    expect(await seedIfEmpty(ctx.db)).toBe(true)

    expect(await listProjects(ctx.db)).toEqual([])
    const rooms = await ctx.db.select().from(channels)
    expect(rooms.map((c) => c.name)).toEqual([HQ_CHANNEL_NAME])
    const welcome = await ctx.db.select().from(messages).where(eq(messages.channelId, rooms[0]!.id))
    expect(welcome).toHaveLength(1)
    expect(welcome[0]?.authorType).toBe('agent')

    const hqAgents = await ctx.db.select().from(agents).where(isNull(agents.projectId))
    expect(hqAgents.map((a) => a.name).sort()).toEqual(
      [CHIEF_OF_STAFF_SEED.name, 'CodeReviewer', 'Librarian'].sort()
    )
    const librarianId = await getRawSetting(ctx.db, DOC_REVIEWER_SETTING)
    expect(hqAgents.some((a) => a.id === librarianId)).toBe(true)
    expect(await getRawSetting(ctx.db, CHIEF_OF_STAFF_SETTING)).toBeTruthy()
    expect(await ctx.db.select().from(runs)).toHaveLength(0)

    const templates = await listTemplates(ctx.db)
    expect(templates.map((t) => t.slug)).toContain('frontend')
    expect(templates.map((t) => t.slug)).toContain('qa')
    expect(await seedIfEmpty(ctx.db)).toBe(false)
  })
})

describe('createProject', () => {
  it('seeds the default rooms and a Captain scoped to the project', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await createProject(ctx, { name: 'Shop App', workingDir: '', createdBy: userId })
    expect(project.slug).toBe('shop-app')
    expect(project.maxConcurrent).toBe(4)
    expect(project.dailyBudgetUsd).toBe(0)

    const rooms = await ctx.db.select().from(channels).where(eq(channels.projectId, project.id))
    expect(rooms.map((c) => c.name).sort()).toEqual(['customers', 'general'])

    const crew = await ctx.db.select().from(agents).where(eq(agents.projectId, project.id))
    expect(crew.map((a) => a.name)).toEqual([CAPTAIN_SEED.name])
    expect(ctx.broadcasts.some((e) => e.type === 'project_created')).toBe(true)

    // Captain greets in #general — a plain row, so no run was admitted.
    const general = rooms.find((c) => c.name === 'general')!
    const welcome = await ctx.db.select().from(messages).where(eq(messages.channelId, general.id))
    expect(welcome).toHaveLength(1)
    expect(welcome[0]?.authorId).toBe(crew[0]!.id)
    expect(ctx.enqueued).toHaveLength(0)
  })

  it('every project gets its own Captain and #general — names are unique per project, not globally', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const a = await createProject(ctx, { name: 'One', createdBy: userId })
    const b = await createProject(ctx, { name: 'One', createdBy: userId })
    expect(b.slug).toBe('one-2')
    const captains = await ctx.db.select().from(agents).where(eq(agents.name, CAPTAIN_SEED.name))
    expect(captains.map((c) => c.projectId).sort()).toEqual([a.id, b.id].sort())
  })
})

describe('the project boundary', () => {
  it("an @mention of another project's agent is just text; HQ agents are reachable from any room", async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const a = await createProject(ctx, { name: 'A', createdBy: userId })
    const b = await createProject(ctx, { name: 'B', createdBy: userId })
    const { agentId: coderB } = await seedAgent(ctx.db, userId, { name: 'Coder', tools: [] })
    await ctx.db.update(agents).set({ projectId: b.id }).where(eq(agents.id, coderB))
    const { agentId: hqBot } = await seedAgent(ctx.db, userId, { name: 'Auditor', tools: [] })

    const generalA = await generalOf(ctx, a.id)
    const visible = (await agentsVisibleInChannel(ctx.db, generalA)).map((x) => x.name).sort()
    expect(visible).toEqual(['Auditor', 'Captain'])

    const msg = await createMessage(ctx, {
      channelId: generalA,
      authorType: 'human',
      authorId: userId,
      content: '@Coder and @Auditor please look'
    })
    await enqueueMentionRuns(ctx, msg, 0)
    const triggered = await admittedAgentIds(ctx)
    expect(triggered).toContain(hqBot)
    expect(triggered).not.toContain(coderB)
    const [run] = await ctx.db.select().from(runs)
    expect(run?.projectId).toBe(a.id)
  })

  it("a project Captain's '*' watch covers only its own rooms; the Chief of Staff holds HQ", async () => {
    const ctx = await makeTestCtx()
    await seedIfEmpty(ctx.db)
    const userId = await seedUser(ctx.db)
    const main = await createProject(ctx, { name: 'Main', createdBy: userId })
    const other = await createProject(ctx, { name: 'Other', createdBy: userId })

    const msg = await createMessage(ctx, {
      channelId: await generalOf(ctx, other.id),
      authorType: 'human',
      authorId: userId,
      content: 'can someone check the build?'
    })
    await enqueueMentionRuns(ctx, msg, 0)
    const captains = await ctx.db.select().from(agents).where(eq(agents.name, 'Captain'))
    const otherCaptain = captains.find((c) => c.projectId === other.id)!.id
    const mainCaptain = captains.find((c) => c.projectId === main.id)!.id
    let triggered = await admittedAgentIds(ctx)
    expect(triggered).toEqual([otherCaptain])
    expect(triggered).not.toContain(mainCaptain)

    const hqMsg = await createMessage(ctx, {
      channelId: await hqChannel(ctx),
      authorType: 'human',
      authorId: userId,
      content: "what's in flight today?"
    })
    await enqueueMentionRuns(ctx, hqMsg, 0)
    const chief = await getRawSetting(ctx.db, CHIEF_OF_STAFF_SETTING)
    triggered = await admittedAgentIds(ctx)
    expect(triggered).toEqual([otherCaptain, chief])
    const runRows = await ctx.db.select().from(runs)
    expect(runRows.every((r) => r.triggerType === 'watch')).toBe(true)
  })

  it("a project agent granted '*' may post in its own rooms only; HQ agents everywhere", async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const a = await createProject(ctx, { name: 'A', createdBy: userId })
    const b = await createProject(ctx, { name: 'B', createdBy: userId })
    const captainA = (await ctx.db.select().from(agents).where(eq(agents.projectId, a.id)))[0]!
    const versionA = (await getAgentWithVersion(ctx.db, captainA.id))!.currentVersion
    const generalB = await generalOf(ctx, b.id)
    await expect(
      createMessage(ctx, {
        channelId: generalB,
        authorType: 'agent',
        authorId: captainA.id,
        agentVersionId: versionA.id,
        content: 'hello from A'
      })
    ).rejects.toThrow(GuardrailViolation)

    const { agentId: hqBot, versionId } = await seedAgent(ctx.db, userId, {
      name: 'Auditor',
      tools: [],
      capabilities: { canPostInChannels: ['*'] }
    })
    const posted = await createMessage(ctx, {
      channelId: generalB,
      authorType: 'agent',
      authorId: hqBot,
      agentVersionId: versionId,
      content: 'hello from HQ'
    })
    expect(posted.channelId).toBe(generalB)
  })

  it('working dir: project repo beats the agent setting, which beats nothing', () => {
    const project = {
      id: 'p',
      slug: 'p',
      name: 'P',
      color: '#000',
      workingDir: '/repo',
      dailyBudgetUsd: 0,
      maxConcurrent: 4,
      createdAt: 0
    }
    expect(configuredWorkingDir(project, '/agent')).toBe('/repo')
    expect(configuredWorkingDir({ ...project, workingDir: '' }, '/agent')).toBe('/agent')
    expect(configuredWorkingDir({ ...project, workingDir: '' }, 'relative')).toBe('')
    expect(configuredWorkingDir(null, undefined)).toBe('')
    expect(wildcardCovers(null, 'any')).toBe(true)
    expect(wildcardCovers('p', 'p')).toBe(true)
    expect(wildcardCovers('p', 'q')).toBe(false)
  })
})
