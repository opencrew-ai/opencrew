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
import { makeTestCtx, seedAgent, seedChannel, seedUser } from './helpers'

function seedRun(ctx: ReturnType<typeof makeTestCtx>, agentId: string, versionId: string) {
  const runId = nanoid()
  ctx.db
    .insert(runs)
    .values({
      id: runId,
      agentId,
      agentVersionId: versionId,
      triggerMessageId: 'msg',
      status: 'running',
      depth: 0,
      createdAt: Date.now()
    })
    .run()
  return runId
}

describe('tool allowlist and approval gates', () => {
  it('denies tools outside the version tool list', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const { versionId } = seedAgent(ctx.db, userId, { tools: ['WebFetch'] })
    const version = getVersion(ctx.db, versionId)!

    expect(evaluateToolUse(version, 'Bash')).toBe('deny')
    expect(evaluateToolUse(version, 'WebFetch')).toBe('allow')
    // ToolSearch only loads schemas — always allowed, even off-list.
    expect(evaluateToolUse(version, 'ToolSearch')).toBe('allow')
  })

  it('requires approval for gated tools', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const { versionId } = seedAgent(ctx.db, userId, {
      tools: ['Bash'],
      capabilities: { requiresApprovalFor: ['Bash'] }
    })
    const version = getVersion(ctx.db, versionId)!

    expect(evaluateToolUse(version, 'Bash')).toBe('needs_approval')
  })

  it('a gated tool without an approved approvals row is impossible', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const { agentId, versionId } = seedAgent(ctx.db, userId, {
      tools: ['Bash'],
      capabilities: { requiresApprovalFor: ['Bash'] }
    })
    const version = getVersion(ctx.db, versionId)!
    const runId = seedRun(ctx, agentId, versionId)

    // No approval id at all.
    expect(() =>
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash')
    ).toThrow(ApprovalRequiredError)

    // Pending (not approved) row.
    const pendingId = nanoid()
    ctx.db
      .insert(approvals)
      .values({
        id: pendingId,
        runId,
        toolName: 'Bash',
        toolInput: '{}',
        status: 'pending',
        createdAt: Date.now()
      })
      .run()
    expect(() =>
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', pendingId)
    ).toThrow(ApprovalRequiredError)

    // Approved row for a DIFFERENT run must not unlock this one.
    const otherRunApproval = nanoid()
    ctx.db
      .insert(approvals)
      .values({
        id: otherRunApproval,
        runId: 'some-other-run',
        toolName: 'Bash',
        toolInput: '{}',
        status: 'approved',
        createdAt: Date.now()
      })
      .run()
    expect(() =>
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', otherRunApproval)
    ).toThrow(ApprovalRequiredError)

    // Properly approved row unlocks exactly this invocation.
    ctx.db
      .update(approvals)
      .set({ status: 'approved' })
      .where(eq(approvals.id, pendingId))
      .run()
    expect(() =>
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', pendingId)
    ).not.toThrow()
  })

  it('forbids tools outside the list even with an approval row', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const { agentId, versionId } = seedAgent(ctx.db, userId, { tools: ['WebFetch'] })
    const version = getVersion(ctx.db, versionId)!
    const runId = seedRun(ctx, agentId, versionId)

    expect(() =>
      assertToolInvocationAllowed(ctx.db, version, runId, 'Bash', nanoid())
    ).toThrow(ToolForbiddenError)
  })
})

describe('auto-approve rules', () => {
  it('rule lookup matches only the exact agent+tool pair', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const { agentId } = seedAgent(ctx.db, userId, {
      tools: ['Bash'],
      capabilities: { requiresApprovalFor: ['Bash'] }
    })
    expect(findAutoApproveRule(ctx.db, agentId, 'Bash')).toBeNull()

    ctx.db
      .insert(approvalRules)
      .values({
        id: nanoid(),
        agentId,
        toolName: 'Bash',
        createdBy: userId,
        createdAt: Date.now()
      })
      .run()
    expect(findAutoApproveRule(ctx.db, agentId, 'Bash')?.createdBy).toBe(userId)
    expect(findAutoApproveRule(ctx.db, agentId, 'Browser')).toBeNull()
    expect(findAutoApproveRule(ctx.db, 'other-agent', 'Bash')).toBeNull()
  })
})

describe('canPostInChannels', () => {
  it('an agent can never post to a channel outside its capability', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const allowed = seedChannel(ctx.db)
    const forbidden = seedChannel(ctx.db)
    const { agentId, versionId } = seedAgent(ctx.db, userId, {
      capabilities: { canPostInChannels: [allowed] }
    })

    expect(() =>
      createMessage(ctx, {
        channelId: forbidden,
        authorType: 'agent',
        authorId: agentId,
        agentVersionId: versionId,
        content: 'sneaky'
      })
    ).toThrow(GuardrailViolation)

    const message = createMessage(ctx, {
      channelId: allowed,
      authorType: 'agent',
      authorId: agentId,
      agentVersionId: versionId,
      content: 'hello'
    })
    expect(message.channelId).toBe(allowed)
  })

  it('agent posts without a pinned version are rejected', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    const { agentId } = seedAgent(ctx.db, userId)

    expect(() =>
      createMessage(ctx, {
        channelId,
        authorType: 'agent',
        authorId: agentId,
        content: 'no version'
      })
    ).toThrow(GuardrailViolation)
  })
})

describe('maxRunsPerHour', () => {
  it('stops enqueuing once the hourly limit is reached', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    const { agentId } = seedAgent(ctx.db, userId, {
      name: 'Limited',
      capabilities: { maxRunsPerHour: 1, canPostInChannels: [channelId] }
    })

    const mention = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'hey @Limited'
    })
    enqueueMentionRuns(ctx, mention, 0)
    expect(ctx.db.select().from(runs).all()).toHaveLength(1)

    enqueueMentionRuns(ctx, mention, 0)
    // Still one run; a visible system notice was posted instead.
    expect(ctx.db.select().from(runs).all()).toHaveLength(1)
    const notices = ctx.db
      .select()
      .from(messages)
      .all()
      .filter((m) => m.authorType === 'system' && m.content.includes('rate limit'))
    expect(notices).toHaveLength(1)
    void agentId
  })
})

describe('channel watchers', () => {
  it('watcher runs on human messages, never on agent or system messages', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    const { agentId: watcherId, versionId } = seedAgent(ctx.db, userId, {
      name: 'Watcher',
      capabilities: { canPostInChannels: [channelId], watchesChannels: [channelId] }
    })
    const { agentId: otherId, versionId: otherVersionId } = seedAgent(ctx.db, userId, {
      name: 'Other',
      capabilities: { canPostInChannels: [channelId] }
    })

    const humanMsg = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'shipped the new onboarding flow'
    })
    enqueueMentionRuns(ctx, humanMsg, 0)
    let all = ctx.db.select().from(runs).all()
    expect(all).toHaveLength(1)
    expect(all[0]!.agentId).toBe(watcherId)
    expect(all[0]!.triggerType).toBe('watch')
    expect(all[0]!.agentVersionId).toBe(versionId)

    // Another agent posting in the watched channel must NOT trigger the watcher.
    const agentMsg = createMessage(ctx, {
      channelId,
      authorType: 'agent',
      authorId: otherId,
      agentVersionId: otherVersionId,
      content: 'status update from an agent'
    })
    enqueueMentionRuns(ctx, agentMsg, 1)
    all = ctx.db.select().from(runs).all()
    expect(all).toHaveLength(1)
  })

  it("'*' watches every channel, but explicit mentions silence all watchers", () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    seedAgent(ctx.db, userId, {
      name: 'Orchestrator',
      capabilities: { canPostInChannels: ['*'], watchesChannels: ['*'] }
    })
    seedAgent(ctx.db, userId, {
      name: 'Specialist',
      capabilities: { canPostInChannels: [channelId] }
    })

    const plain = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'can someone look into the flaky deploy?'
    })
    enqueueMentionRuns(ctx, plain, 0)
    expect(ctx.db.select().from(runs).all()).toHaveLength(1) // orchestrator only

    // Directly-addressed message: the specialist runs, the watcher stays out.
    const targeted = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: '@Specialist take a look please'
    })
    enqueueMentionRuns(ctx, targeted, 0)
    const all = ctx.db.select().from(runs).all()
    expect(all).toHaveLength(2)
    expect(all.filter((r) => r.triggerType === 'mention')).toHaveLength(1)
  })

  it("agents with '*' canPostInChannels may post anywhere", () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    const { agentId, versionId } = seedAgent(ctx.db, userId, {
      capabilities: { canPostInChannels: ['*'] }
    })
    const message = createMessage(ctx, {
      channelId,
      authorType: 'agent',
      authorId: agentId,
      agentVersionId: versionId,
      content: 'orchestrator says hi'
    })
    expect(message.channelId).toBe(channelId)
  })

  it('a mention supersedes the watch — no duplicate run', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    seedAgent(ctx.db, userId, {
      name: 'Watchy',
      capabilities: { canPostInChannels: [channelId], watchesChannels: [channelId] }
    })

    const msg = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'hey @Watchy do the thing'
    })
    enqueueMentionRuns(ctx, msg, 0)
    const all = ctx.db.select().from(runs).all()
    expect(all).toHaveLength(1)
    expect(all[0]!.triggerType).toBe('mention')
  })
})

describe('workspace settings', () => {
  it('mention-chain depth limit comes from the settings table', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    seedAgent(ctx.db, userId, {
      name: 'Chainy',
      capabilities: { canPostInChannels: [channelId] }
    })
    setSetting(ctx.db, 'maxMentionDepth', 1)
    expect(getMaxMentionDepth(ctx.db)).toBe(1)

    // depth 1 == the configured limit → chain stops, no run created.
    const msg = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: 'hey @Chainy'
    })
    enqueueMentionRuns(ctx, msg, 1)
    expect(ctx.db.select().from(runs).all()).toHaveLength(0)
    const notice = ctx.db
      .select()
      .from(messages)
      .all()
      .find((m) => m.authorType === 'system' && m.content.includes('depth limit (1)'))
    expect(notice).toBeDefined()

    // Below the limit → run created.
    enqueueMentionRuns(ctx, msg, 0)
    expect(ctx.db.select().from(runs).all()).toHaveLength(1)
  })
})

describe('version pinning', () => {
  it('runs stay pinned to the version at enqueue time across config edits', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const channelId = seedChannel(ctx.db)
    const { agentId, versionId } = seedAgent(ctx.db, userId, { name: 'Pinny' })

    const mention = createMessage(ctx, {
      channelId,
      authorType: 'human',
      authorId: userId,
      content: '@Pinny do a thing'
    })
    enqueueMentionRuns(ctx, mention, 0)

    const run = ctx.db.select().from(runs).all()[0]!
    expect(run.agentVersionId).toBe(versionId)

    // Config edit creates v2 — the in-flight run keeps pointing at v1.
    createVersion(
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
    const after = ctx.db.select().from(runs).all()[0]!
    expect(after.agentVersionId).toBe(versionId)
  })
})

describe('audit log', () => {
  it('recordStep appends ordered steps and broadcasts them', () => {
    const ctx = makeTestCtx()
    const userId = seedUser(ctx.db)
    const { agentId, versionId } = seedAgent(ctx.db, userId)
    const runId = seedRun(ctx, agentId, versionId)

    recordStep(ctx, runId, 'tool_call', { tool: 'Bash' })
    recordStep(ctx, runId, 'tool_result', { content: 'ok' })

    const steps = ctx.db.select().from(runSteps).all()
    expect(steps.map((s) => s.seq)).toEqual([1, 2])
    expect(ctx.broadcasts.filter((b) => b.type === 'run_step')).toHaveLength(2)
  })
})
