import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { agents, runs } from '../db/schema'
import { buildHeartbeat, installId, telemetryEnabled } from '../services/telemetry'
import { createProject } from '../services/projects'
import { setSetting } from '../services/settings'
import { makeTestCtx, seedAgent, seedUser } from './helpers'

describe('telemetry heartbeat', () => {
  it('sends counts and versions only — nothing that could identify a person or a repo', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    await createProject(ctx, { name: 'Secret Product', workingDir: '/Users/someone/private', createdBy: userId })
    const { agentId } = await seedAgent(ctx.db, userId, { name: 'Worker' })
    await ctx.db.update(agents).set({ kind: 'worker' }).where(eq(agents.id, agentId))
    await ctx.db.insert(runs).values({
      id: 'r1',
      agentId,
      agentVersionId: 'v',
      triggerMessageId: 'm',
      status: 'done',
      createdAt: Date.now() - 1000
    })

    const beat = await buildHeartbeat(ctx.db)
    expect(Object.keys(beat).sort()).toEqual(
      [
        'activeWorkers',
        'arch',
        'harness',
        'installId',
        'node',
        'os',
        'osRelease',
        'projects',
        'runs24h',
        'standingAgents',
        'uptimeHours',
        'version'
      ].sort()
    )
    expect(beat.projects).toBe(1)
    expect(beat.standingAgents).toBe(1) // the project's Captain
    expect(beat.activeWorkers).toBe(1)
    expect(beat.runs24h).toBe(1)
    const serialized = JSON.stringify(beat)
    expect(serialized).not.toContain('Secret Product')
    expect(serialized).not.toContain('/Users/')
    expect(serialized).not.toContain('@')
  })

  it('mints one install id per database and keeps it', async () => {
    const ctx = await makeTestCtx()
    const a = await installId(ctx.db)
    const b = await installId(ctx.db)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(10)
  })

  it('the Settings toggle turns it off', async () => {
    const ctx = await makeTestCtx()
    expect(await telemetryEnabled(ctx.db)).toBe(true)
    await setSetting(ctx.db, 'telemetryEnabled', false)
    expect(await telemetryEnabled(ctx.db)).toBe(false)
  })
})
