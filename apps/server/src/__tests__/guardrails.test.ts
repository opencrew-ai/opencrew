import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  ApprovalRequiredError,
  ToolForbiddenError,
  assertToolInvocationAllowed,
  evaluateToolUse,
  findAutoApproveRule
} from '../runs/guardrails'
import { approvalRules, approvals, runs, runSteps, messages } from '../db/schema'
import { createVersion, getVersion } from '../services/agents'
import { createMessage, GuardrailViolation } from '../services/messages'
import { getMaxMentionDepth, setSetting } from '../services/settings'
import { enqueueMentionRuns } from '../runs/enqueue'
import { recordStep } from '../runs/audit'
import { makeTestCtx, seedAgent, seedChannel, seedUser, type TestCtx } from './helpers'

async function seedRun(ctx: TestCtx, agentId: string, versionId: string): Promise<string> {
  const runId = nanoid()
  await ctx.db.insert(runs).values({
    id: runId,
    agentId,
    agentVersionId: versionId,
    triggerMessageId: 'msg',
    status: 'running',
    depth: 0,
    createdAt: Date.now()
  })
  return runId
}

describe('tool allowlist and approval gates', () => {
  it('denies tools outside the version tool list', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { versionId } = await seedAgent(ctx.db, userId, { tools: ['WebFetch'] })
    const version = (await getVersion(ctx.db, versionId))!

    expect(evaluateToolUse(version, 'Bash')).toBe('deny')
    expect(evaluateToolUse(version, 'WebFetch')).toBe('allow')
    // ToolSearch only loads schemas — always allowed, even off-list.
    expect(evaluateToolUse(version, 'ToolSearch')).toBe('allow')
  })

  it('requires approval for gated tools', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { versionId } = await seedAgent(ctx.db, userId, {
      tools: ['Bash'],
      capabilities: { requiresApprovalFor: ['Bash'] }
    })
    const version = (await getVersion(ctx.db, versionId))!

    expect(evaluateToolUse(version, 'Bash')).toBe('needs_approval')
  })

  it('a gated tool without an approved approvals row is impossible', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { agentId, versionId } = await seedAgent(ctx.db, userId, {
      tools: ['Bash'],
      capabilities: { requiresApprovalFor: ['Bash'] }
    })
    const version = (await getVersion(ctx.db, versionId))!
    const runId = await seedRun(ctx, agentId, versionId)

    // No approval id at all.
    await expect(
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash')
    ).rejects.toThrow(ApprovalRequiredError)

    // Pending (not approved) row.
    const pendingId = nanoid()
    await ctx.db.insert(approvals).values({
      id: pendingId,
      runId,
      toolName: 'Bash',
      toolInput: '{}',
      status: 'pending',
      createdAt: Date.now()
    })
    await expect(
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', pendingId)
    ).rejects.toThrow(ApprovalRequiredError)

    // Approved row for a DIFFERENT run must not unlock this one.
    const otherRunApproval = nanoid()
    await ctx.db.insert(approvals).values({
      id: otherRunApproval,
      runId: 'some-other-run',
      toolName: 'Bash',
      toolInput: '{}',
      status: 'approved',
      createdAt: Date.now()
    })
    await expect(
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', otherRunApproval)
    ).rejects.toThrow(ApprovalRequiredError)

    // Properly approved row unlocks exactly this invocation.
    await ctx.db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, pendingId))
    await expect(
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', pendingId)
    ).resolves.not.toThrow()
  })

  it('forbids tools outside the list even with an approval row', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { agentId, versionId } = await seedAgent(ctx.db, userId, { tools: ['WebFetch'] })
    const version = (await getVersion(ctx.db, versionId))!
    const runId = await seedRun(ctx, agentId, versionId)

    await expect(
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', nanoid())
    ).rejects.toThrow(ToolForbiddenError)
  })
})

describe('auto-approve rules', () => {
  it('rule lookup matches only the exact agent+tool pair', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { agentId } = await seedAgent(ctx.db, userId, {
      tools: ['Bash'],
      capabilities: { requiresApprovalFor: ['Bash'] }
    })
    expect(await findAutoApproveRule(ctx.db, agentId, 'Bash')).toBeNull()

    await ctx.db.insert(approvalRules).values({
      id: nanoid(),
      agentId,
      toolName: 'Bash',
      createdBy: userId,
      createdAt: Date.now()
    })
    expect((await findAutoApproveRule(ctx.db, agentId, 'Bash'))?.createdBy).toBe(userId)
    expect(await findAutoApproveRule(ctx.db, agentId, 'Browser')).toBeNull()
    expect(await findAutoApproveRule(ctx.db, 'other-agent', 'Bash')).toBeNull()
  })
})

describe('canPostInChannels', () => {
  it('an agent can never post to a channel outside its capability', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const allowed = await seedChannel(ctx.db)
    const forbidden = await seedChannel(ctx.db)
    const { agentId, versionId } = await seedAgent(ctx.db, userId, {
      capabilities: { canPostInChannels: [allowed] }
    })

    await expect(
      createMessage(ctx, {
        channelId: forbidden,
        authorType: 'agent',
        authorId: agentId,
        agentVersionId: versionId,
        content: 'sneaky'
      })
    ).rejects.toThrow(GuardrailViolation)

    const message = await createMessage(ctx, {
      channelId: allowed,
      authorType: 'agent',
      authorId: agentId,
      agentVersionId: versionId,
      content: 'hello'
    })
    expect(message.channelId).toBe(allowed)
  })

  it('agent posts without a pinned version are rejected', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const { agentId } = await seedAgent(ctx.db, userId)

    await expect(
      createMessage(ctx, {
        channelId,
        authorType: 'agent',
        authorId: agentId,
        content: 'no version'
      })
    ).rejects.toThrow(GuardrailViolation)
  })
})

describe('maxRunsPerHour', () => {
  it('stops enqueuing once the hourly limit is reached', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const { agentId } = await seedAgent(ctx.db, userId, {
      name: 'Limited',
      capabilities: { maxRunsPerHour: 1, canPostInChannels: [channelId] }
    })

    const mention = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'hey @Limited'
    })
    await enqueueMentionRuns(ctx, mention, 0)
    expect(await ctx.db.select().from(runs)).toHaveLength(1)

    await enqueueMentionRuns(ctx, mention, 0)
    // Still one run; a visible system notice was posted instead.
    expect(await ctx.db.select().from(runs)).toHaveLength(1)
    const notices = (await ctx.db.select().from(messages)).filter(
      (m) => m.authorType === 'system' && m.content.includes('rate limit')
    )
    expect(notices).toHaveLength(1)
    void agentId
  })
})

describe('channel watchers', () => {
  it('watcher runs on human messages, never on agent or system messages', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const { agentId: watcherId, versionId } = await seedAgent(ctx.db, userId, {
      name: 'Watcher',
      capabilities: { canPostInChannels: [channelId], watchesChannels: [channelId] }
    })
    const { agentId: otherId, versionId: otherVersionId } = await seedAgent(ctx.db, userId, {
      name: 'Other',
      capabilities: { canPostInChannels: [channelId] }
    })

    const humanMsg = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'shipped the new onboarding flow'
    })
    await enqueueMentionRuns(ctx, humanMsg, 0)
    let all = await ctx.db.select().from(runs)
    expect(all).toHaveLength(1)
    expect(all[0]!.agentId).toBe(watcherId)
    expect(all[0]!.triggerType).toBe('watch')
    expect(all[0]!.agentVersionId).toBe(versionId)

    // Another agent posting in the watched channel must NOT trigger the watcher.
    const agentMsg = await createMessage(ctx, {
      channelId,
      authorType: 'agent',
      authorId: otherId,
      agentVersionId: otherVersionId,
      content: 'status update from an agent'
    })
    await enqueueMentionRuns(ctx, agentMsg, 1)
    all = await ctx.db.select().from(runs)
    expect(all).toHaveLength(1)
  })

  it("'*' watches every channel, but explicit mentions silence all watchers", async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    await seedAgent(ctx.db, userId, {
      name: 'Orchestrator',
      capabilities: { canPostInChannels: ['*'], watchesChannels: ['*'] }
    })
    await seedAgent(ctx.db, userId, {
      name: 'Specialist',
      capabilities: { canPostInChannels: [channelId] }
    })

    const plain = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'can someone look into the flaky deploy?'
    })
    await enqueueMentionRuns(ctx, plain, 0)
    expect(await ctx.db.select().from(runs)).toHaveLength(1) // orchestrator only

    // Directly-addressed message: the specialist runs, the watcher stays out.
    const targeted = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: '@Specialist take a look please'
    })
    await enqueueMentionRuns(ctx, targeted, 0)
    const all = await ctx.db.select().from(runs)
    expect(all).toHaveLength(2)
    expect(all.filter((r) => r.triggerType === 'mention')).toHaveLength(1)
  })

  it("agents with '*' canPostInChannels may post anywhere", async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const { agentId, versionId } = await seedAgent(ctx.db, userId, {
      capabilities: { canPostInChannels: ['*'] }
    })
    const message = await createMessage(ctx, {
      channelId,
      authorType: 'agent',
      authorId: agentId,
      agentVersionId: versionId,
      content: 'orchestrator says hi'
    })
    expect(message.channelId).toBe(channelId)
  })

  it('a mention supersedes the watch — no duplicate run', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    await seedAgent(ctx.db, userId, {
      name: 'Watchy',
      capabilities: { canPostInChannels: [channelId], watchesChannels: [channelId] }
    })

    const msg = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'hey @Watchy do the thing'
    })
    await enqueueMentionRuns(ctx, msg, 0)
    const all = await ctx.db.select().from(runs)
    expect(all).toHaveLength(1)
    expect(all[0]!.triggerType).toBe('mention')
  })
})

describe('workspace settings', () => {
  it('mention-chain depth limit comes from the settings table', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    await seedAgent(ctx.db, userId, {
      name: 'Chainy',
      capabilities: { canPostInChannels: [channelId] }
    })
    await setSetting(ctx.db, 'maxMentionDepth', 1)
    expect(await getMaxMentionDepth(ctx.db)).toBe(1)

    // depth 1 == the configured limit → chain stops, no run created.
    const msg = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'hey @Chainy'
    })
    await enqueueMentionRuns(ctx, msg, 1)
    expect(await ctx.db.select().from(runs)).toHaveLength(0)
    const notice = (await ctx.db.select().from(messages)).find(
      (m) => m.authorType === 'system' && m.content.includes('depth limit (1)')
    )
    expect(notice).toBeDefined()

    // Below the limit → run created.
    await enqueueMentionRuns(ctx, msg, 0)
    expect(await ctx.db.select().from(runs)).toHaveLength(1)
  })
})

describe('version pinning', () => {
  it('runs stay pinned to the version at enqueue time across config edits', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const channelId = await seedChannel(ctx.db)
    const { agentId, versionId } = await seedAgent(ctx.db, userId, { name: 'Pinny' })

    const mention = await createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: '@Pinny do a thing'
    })
    await enqueueMentionRuns(ctx, mention, 0)

    const run = (await ctx.db.select().from(runs))[0]!
    expect(run.agentVersionId).toBe(versionId)

    // Config edit creates v2 — the in-flight run keeps pointing at v1.
    await createVersion(
      ctx.db,
      agentId,
      {
        systemPrompt: 'changed',
        model: 'claude-sonnet-4-6',
        skills: [],
        tools: [],
        capabilities: { canPostInChannels: [], maxRunsPerHour: 5, requiresApprovalFor: [] }
      },
      userId,
      'edit'
    )
    const after = (await ctx.db.select().from(runs))[0]!
    expect(after.agentVersionId).toBe(versionId)
  })
})

describe('audit log', () => {
  it('recordStep appends ordered steps and broadcasts them', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { agentId, versionId } = await seedAgent(ctx.db, userId)
    const runId = await seedRun(ctx, agentId, versionId)

    await recordStep(ctx, runId, 'tool_call', { tool: 'Bash' })
    await recordStep(ctx, runId, 'tool_result', { content: 'ok' })

    const steps = await ctx.db.select().from(runSteps)
    expect(steps.map((s) => s.seq)).toEqual([1, 2])
    expect(ctx.broadcasts.filter((b) => b.type === 'run_step')).toHaveLength(2)
  })
})
