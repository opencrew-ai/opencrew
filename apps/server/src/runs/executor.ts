import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSdkMcpServer,
  query,
  tool as sdkTool,
  type PermissionResult,
  type SDKAssistantMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AgentVersion, Channel, RunStatus } from '@opencrew/shared'
import type { AppContext, ApprovalDecision } from '../context'
import { approvals, channels, messages as messagesTable, runs } from '../db/schema'
import { getAgent, getVersion } from '../services/agents'
import {
  createMessage,
  enrichMessage,
  postSystemMessage,
  updateMessageContent
} from '../services/messages'
import { enqueueMentionRuns } from './enqueue'
import { recordStep } from './audit'
import { buildContextTranscript, buildSystemPrompt } from './context'
import { assertToolInvocationAllowed, evaluateToolUse } from './guardrails'
import {
  MCP_SERVER_NAME,
  fromSdkToolName,
  listOpenCrewTools,
  toSdkToolName,
  toolCatalog,
  type ToolRunContext
} from '../tools'
import { broadcastPresence } from '../services/presence'
import { env } from '../env'

const RUN_TIMEOUT_MS = 15 * 60 * 1000
const MAX_TURNS = 50
const STEP_CONTENT_LIMIT = 4000

// Claude Code tools we never expose to OpenCrew agents.
const ALWAYS_DISALLOWED = ['Task', 'NotebookEdit']

interface RunEnv {
  runId: string
  agentId: string
  agentName: string
  version: AgentVersion
  channel: Channel
  threadRootId: string | null
  depth: number
}

interface ReplyState {
  messageId: string | null
  text: string
}

function setRunStatus(
  ctx: AppContext,
  runEnv: Pick<RunEnv, 'runId' | 'agentId'>,
  status: RunStatus,
  patch: Partial<typeof runs.$inferInsert> = {}
): void {
  ctx.db
    .update(runs)
    .set({ status, ...patch })
    .where(eq(runs.id, runEnv.runId))
    .run()
  ctx.hub.broadcast({
    type: 'run_status',
    runId: runEnv.runId,
    agentId: runEnv.agentId,
    status
  })
  broadcastPresence(ctx)
}

export async function executeRun(ctx: AppContext, runId: string): Promise<void> {
  const run = ctx.db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run || run.status !== 'queued') return

  const agent = getAgent(ctx.db, run.agentId)
  const version = getVersion(ctx.db, run.agentVersionId)
  const trigger = ctx.db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, run.triggerMessageId))
    .get()
  const channelRow = trigger
    ? ctx.db.select().from(channels).where(eq(channels.id, trigger.channelId)).get()
    : undefined
  if (!agent || !version || !trigger || !channelRow) {
    setRunStatus(ctx, { runId, agentId: run.agentId }, 'failed', {
      error: 'missing agent, version, or trigger message',
      finishedAt: Date.now()
    })
    return
  }

  const runEnv: RunEnv = {
    runId,
    agentId: agent.id,
    agentName: agent.name,
    version,
    channel: { ...channelRow, isPrivate: Boolean(channelRow.isPrivate) },
    threadRootId: trigger.threadRootId,
    depth: run.depth
  }

  const abort = new AbortController()
  ctx.activeRuns.set(runId, abort)
  const timeout = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS)
  try {
    await runSession(ctx, runEnv, trigger.id, abort)
  } catch (err) {
    const current = ctx.db.select().from(runs).where(eq(runs.id, runId)).get()
    // A cancelled run (denied approval) already has its terminal status.
    if (current && ['running', 'awaiting_approval', 'queued'].includes(current.status)) {
      failRun(ctx, runEnv, err instanceof Error ? err.message : String(err))
    }
  } finally {
    clearTimeout(timeout)
    ctx.activeRuns.delete(runId)
  }
}

/** One run = one headless Claude Code session in the agent's workspace dir. */
async function runSession(
  ctx: AppContext,
  runEnv: RunEnv,
  triggerMessageId: string,
  abort: AbortController
): Promise<void> {
  setRunStatus(ctx, runEnv, 'running', { startedAt: Date.now() })

  const cwd = join(env.workspacesDir, runEnv.agentId)
  mkdirSync(cwd, { recursive: true })

  const transcript = buildContextTranscript(
    ctx.db,
    runEnv.channel.id,
    runEnv.threadRootId,
    triggerMessageId
  )
  const prompt =
    `Recent conversation in #${runEnv.channel.name}:\n\n${transcript}\n\n` +
    `You were @mentioned. Do what was asked (use your tools if needed), ` +
    `then write your reply message.`

  const reply: ReplyState = { messageId: null, text: '' }
  let cancelled = false

  const toolCtx: ToolRunContext = {
    app: ctx,
    runId: runEnv.runId,
    agentId: runEnv.agentId,
    version: runEnv.version,
    channelId: runEnv.channel.id,
    threadRootId: runEnv.threadRootId,
    depth: runEnv.depth
  }

  const session = query({
    prompt,
    options: {
      model: runEnv.version.model,
      systemPrompt: buildSystemPrompt(ctx.db, runEnv.agentName, runEnv.version, runEnv.channel),
      cwd,
      maxTurns: MAX_TURNS,
      abortController: abort,
      mcpServers: { [MCP_SERVER_NAME]: buildMcpServer(toolCtx) },
      allowedTools: allowedToolsFor(runEnv.version),
      disallowedTools: disallowedToolsFor(runEnv.version),
      canUseTool: async (sdkName, input): Promise<PermissionResult> => {
        const decision = await gateToolUse(ctx, runEnv, sdkName, input)
        if (decision === 'denied_by_admin') {
          cancelled = true
          cancelRun(ctx, runEnv, reply)
          return { behavior: 'deny', message: 'Denied by admin. Stop working.', interrupt: true }
        }
        if (decision === 'forbidden') {
          return {
            behavior: 'deny',
            message: `Tool ${fromSdkToolName(sdkName)} is not permitted for this agent.`
          }
        }
        return { behavior: 'allow', updatedInput: input }
      }
    }
  })

  let resultError: string | null = null
  for await (const msg of session) {
    if (msg.type === 'assistant') {
      handleAssistantMessage(ctx, runEnv, reply, msg)
    } else if (msg.type === 'user') {
      handleUserMessage(ctx, runEnv, msg)
    } else if (msg.type === 'result') {
      recordStep(ctx, runEnv.runId, 'llm_call', {
        phase: 'result',
        subtype: msg.subtype,
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
        costUsd: msg.total_cost_usd,
        usage: msg.usage
      })
      if (msg.subtype !== 'success') resultError = msg.subtype
    }
  }

  if (cancelled) return
  if (resultError) {
    failRun(ctx, runEnv, `session ended with ${resultError}`, reply)
    return
  }
  finalizeRun(ctx, runEnv, reply)
}

function allowedToolsFor(version: AgentVersion): string[] {
  return version.tools
    .filter((t) => !version.capabilities.requiresApprovalFor.includes(t))
    .map(toSdkToolName)
}

/** Everything in the catalog the version didn't opt into is hard-blocked. */
function disallowedToolsFor(version: AgentVersion): string[] {
  const catalogNames = toolCatalog().map((t) => t.name)
  return [
    ...ALWAYS_DISALLOWED,
    ...catalogNames.filter((name) => !version.tools.includes(name)).map(toSdkToolName)
  ]
}

type GateOutcome = 'allowed' | 'forbidden' | 'denied_by_admin'

/**
 * GUARDRAIL choke point: the SDK consults this for tool calls not already
 * decided by allowed/disallowed lists. Gated tools block here until an admin
 * resolves the approval card, then the approvals row is re-verified in the DB.
 */
async function gateToolUse(
  ctx: AppContext,
  runEnv: RunEnv,
  sdkName: string,
  input: Record<string, unknown>
): Promise<GateOutcome> {
  const name = fromSdkToolName(sdkName)
  const verdict = evaluateToolUse(runEnv.version, name)
  if (verdict === 'deny') return 'forbidden'
  if (verdict === 'allow') return 'allowed'

  const approvalId = nanoid()
  ctx.db
    .insert(approvals)
    .values({
      id: approvalId,
      runId: runEnv.runId,
      toolName: name,
      toolInput: JSON.stringify(input),
      status: 'pending',
      createdAt: Date.now()
    })
    .run()
  recordStep(ctx, runEnv.runId, 'approval_requested', { approvalId, tool: name, input })
  setRunStatus(ctx, runEnv, 'awaiting_approval')
  postSystemMessage(
    ctx,
    runEnv.channel.id,
    `🟡 **${runEnv.agentName}** wants to use \`${name}\` — waiting for an admin.`,
    { threadRootId: runEnv.threadRootId, approvalId, runId: runEnv.runId }
  )

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    ctx.approvalWaiters.set(approvalId, resolve)
  })
  ctx.approvalWaiters.delete(approvalId)

  if (decision === 'approved') {
    // Never trust the in-memory signal alone — re-verify the DB row.
    assertToolInvocationAllowed(ctx.db, runEnv.version, runEnv.runId, name, approvalId)
    setRunStatus(ctx, runEnv, 'running')
    return 'allowed'
  }
  return 'denied_by_admin'
}

function handleAssistantMessage(
  ctx: AppContext,
  runEnv: RunEnv,
  reply: ReplyState,
  msg: SDKAssistantMessage
): void {
  let text = ''
  for (const block of msg.message.content) {
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'tool_use') {
      recordStep(ctx, runEnv.runId, 'tool_call', {
        tool: fromSdkToolName(block.name),
        input: block.input,
        toolUseId: block.id
      })
    }
  }
  recordStep(ctx, runEnv.runId, 'llm_call', {
    model: msg.message.model,
    stopReason: msg.message.stop_reason,
    usage: msg.message.usage
  })
  if (text.trim()) appendReplyText(ctx, runEnv, reply, text)
}

function handleUserMessage(ctx: AppContext, runEnv: RunEnv, msg: SDKUserMessage): void {
  const content = msg.message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    const raw =
      typeof block.content === 'string'
        ? block.content
        : (block.content ?? [])
            .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
            .join('\n')
    recordStep(ctx, runEnv.runId, 'tool_result', {
      toolUseId: block.tool_use_id,
      isError: block.is_error ?? false,
      content:
        raw.length > STEP_CONTENT_LIMIT
          ? `${raw.slice(0, STEP_CONTENT_LIMIT)}… [truncated]`
          : raw
    })
  }
}

function appendReplyText(
  ctx: AppContext,
  runEnv: RunEnv,
  reply: ReplyState,
  text: string
): void {
  if (!reply.messageId) {
    // GUARDRAIL: createMessage enforces canPostInChannels for agent authors.
    const message = createMessage(ctx, {
      channelId: runEnv.channel.id,
      threadRootId: runEnv.threadRootId,
      authorType: 'agent',
      authorId: runEnv.agentId,
      agentVersionId: runEnv.version.id,
      content: '',
      runId: runEnv.runId
    })
    reply.messageId = message.id
  }
  reply.text = reply.text ? `${reply.text}\n\n${text}` : text
  ctx.hub.broadcast({
    type: 'message_stream',
    messageId: reply.messageId,
    channelId: runEnv.channel.id,
    content: reply.text
  })
}

function finalizeRun(ctx: AppContext, runEnv: RunEnv, reply: ReplyState): void {
  if (reply.messageId) {
    updateMessageContent(ctx, reply.messageId, reply.text)
    recordStep(ctx, runEnv.runId, 'post_message', {
      messageId: reply.messageId,
      channelId: runEnv.channel.id,
      via: 'reply'
    })
    // The reply may @mention other agents — collaboration chain, depth-capped.
    const row = ctx.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, reply.messageId))
      .get()
    if (row) {
      enqueueMentionRuns(ctx, enrichMessage(ctx.db, row), runEnv.depth + 1)
    }
  }
  setRunStatus(ctx, runEnv, 'done', { finishedAt: Date.now() })
}

function cancelRun(ctx: AppContext, runEnv: RunEnv, reply: ReplyState): void {
  if (reply.messageId) {
    updateMessageContent(
      ctx,
      reply.messageId,
      `${reply.text}\n\n_(run cancelled — tool use was denied)_`
    )
  }
  setRunStatus(ctx, runEnv, 'cancelled', {
    error: 'tool use denied by admin',
    finishedAt: Date.now()
  })
  postSystemMessage(
    ctx,
    runEnv.channel.id,
    `🛑 **${runEnv.agentName}**'s run was cancelled — tool use was denied.`,
    { threadRootId: runEnv.threadRootId, runId: runEnv.runId }
  )
}

function failRun(
  ctx: AppContext,
  runEnv: RunEnv,
  error: string,
  reply?: ReplyState
): void {
  if (reply?.messageId) {
    updateMessageContent(ctx, reply.messageId, reply.text)
  }
  setRunStatus(ctx, runEnv, 'failed', { error, finishedAt: Date.now() })
  try {
    postSystemMessage(
      ctx,
      runEnv.channel.id,
      `❌ **${runEnv.agentName}** run failed: ${error}`,
      { threadRootId: runEnv.threadRootId, runId: runEnv.runId }
    )
  } catch {
    // Posting the failure notice must never crash the worker loop.
  }
}

function buildMcpServer(toolCtx: ToolRunContext) {
  const tools = listOpenCrewTools().map((def) =>
    sdkTool(def.name, def.description, def.inputShape, async (input: unknown) => {
      try {
        const text = await def.execute(input as never, toolCtx)
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool error: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        }
      }
    })
  )
  return createSdkMcpServer({ name: MCP_SERVER_NAME, tools })
}
