import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { CHROME_TOOL, fromSdkToolName, isChromeLook, toSdkToolName } from '../tools'
import { buildSystemPrompt } from '../runs/context'
import { enqueueMentionRuns, USER_CHROME_DEVICE } from '../runs/enqueue'
import { createMessage } from '../services/messages'
import { getVersion } from '../services/agents'
import { fabricTasks } from '../db/schema'
import { makeTestCtx, seedAgent, seedChannel, seedUser } from './helpers'

describe('Chrome tool mapping', () => {
  it('maps every claude-in-chrome MCP tool to the single Chrome capability', () => {
    expect(fromSdkToolName('mcp__claude-in-chrome__navigate')).toBe(CHROME_TOOL)
    expect(fromSdkToolName('mcp__claude-in-chrome__computer')).toBe(CHROME_TOOL)
    expect(toSdkToolName(CHROME_TOOL)).toBe('mcp__claude-in-chrome')
    expect(fromSdkToolName('mcp__playwright__browser_click')).toBe('Browser')
  })

  it('classifies looking vs acting', () => {
    expect(isChromeLook('mcp__claude-in-chrome__read_page', {})).toBe(true)
    expect(isChromeLook('mcp__claude-in-chrome__get_page_text', {})).toBe(true)
    expect(isChromeLook('mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: true })).toBe(true)
    expect(isChromeLook('mcp__claude-in-chrome__computer', { action: 'screenshot' })).toBe(true)
    expect(isChromeLook('mcp__claude-in-chrome__computer', { action: 'left_click' })).toBe(false)
    expect(isChromeLook('mcp__claude-in-chrome__computer', {})).toBe(false)
    expect(isChromeLook('mcp__claude-in-chrome__navigate', { url: 'http://localhost' })).toBe(false)
    expect(isChromeLook('mcp__claude-in-chrome__javascript_tool', {})).toBe(false)
    expect(isChromeLook('mcp__claude-in-chrome__form_input', {})).toBe(false)
  })
})

describe('Chrome in the runtime', () => {
  it('adds the feedback-loop rule to the system prompt only when granted', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const channel = { id: channelId, name: 'general', topic: '', isPrivate: false, projectId: null, createdAt: 0 }
    const withChrome = await seedAgent(ctx.db, userId, { tools: ['Read', 'Chrome'] })
    const without = await seedAgent(ctx.db, userId, { tools: ['Read'] })
    const promptWith = await buildSystemPrompt(ctx.db, 'A', (await getVersion(ctx.db, withChrome.versionId))!, channel)
    const promptWithout = await buildSystemPrompt(ctx.db, 'B', (await getVersion(ctx.db, without.versionId))!, channel)
    expect(promptWith).toContain('FEEDBACK LOOP')
    expect(promptWith).toContain('NEVER claim a UI change works')
    expect(promptWithout).not.toContain('FEEDBACK LOOP')
  })

  it('serializes agents on the one user Chrome via an exclusive device', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const { agentId } = await seedAgent(ctx.db, userId, { name: 'Eyes', tools: ['Chrome'] })
    const row = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: '@Eyes look at the settings page'
    })
    await enqueueMentionRuns(ctx, row, 0)
    const [task] = await ctx.db.select().from(fabricTasks).where(eq(fabricTasks.state, 'ready'))
    expect(task).toBeDefined()
    expect(JSON.parse(task!.devices)).toContain(USER_CHROME_DEVICE)
    void agentId
  })
})
