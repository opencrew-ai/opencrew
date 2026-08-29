import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSdkMcpServer,
  query,
  tool as sdkTool,
  type PermissionResult,
  type SDKAssistantMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AgentVersion, Channel, RunStatus } from '@opencrew/shared'
import type { AppContext, ApprovalDecision } from '../context'
import {
  agentSessions,
  approvals,
  channels,
  messages as messagesTable,
  runs
} from '../db/schema'
import { getAgent, getVersion } from '../services/agents'
import {
  createMessage,
  enrichMessage,
  postSystemMessage,
  updateMessageContent
} from '../services/messages'
import { enqueueMentionRuns } from './enqueue'
import { recordStep } from './audit'
import {
  buildContextTranscript,
  buildIncrementalTranscript,
  buildSystemPrompt
} from './context'
import {
  assertToolInvocationAllowed,
  evaluateToolUse,
  findAutoApproveRule
} from './guardrails'
import {
  BROWSER_MCP_SERVER,
  BROWSER_TOOL,
  MCP_SERVER_NAME,
  fromSdkToolName,
  listOpenCrewTools,
  toSdkToolName,
  toolCatalog,
  type ToolRunContext
} from '../tools'
import { broadcastPresence } from '../services/presence'
import { env } from '../env'

// Build sessions can legitimately run long.
const RUN_TIMEOUT_MS = 30 * 60 * 1000
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
  triggerType: 'mention' | 'watch'
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
    depth: run.depth,
    triggerType: run.triggerType
  }

  const runGuarded = async (): Promise<void> => {
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

  // Every agent's runs execute strictly in order: resumed sessions and
  // Chrome profiles both break under concurrent access, and ordered turns
  // are what a conversation means anyway. Different agents still run in
  // parallel.
  const prev = ctx.agentLocks.get(runEnv.agentId) ?? Promise.resolve()
  const current = prev.then(runGuarded) // runGuarded never rejects
  ctx.agentLocks.set(runEnv.agentId, current)
  await current
  if (ctx.agentLocks.get(runEnv.agentId) === current) {
    ctx.agentLocks.delete(runEnv.agentId)
  }
}

/**
 * One run = one TURN of a persistent Claude Code session. The session for
 * (agent, channel, thread) is resumed if it exists — the agent keeps its
 * full working context across turns, like a teammate you keep talking to.
 */
async function runSession(
  ctx: AppContext,
  runEnv: RunEnv,
  triggerMessageId: string,
  abort: AbortController
): Promise<void> {
  setRunStatus(ctx, runEnv, 'running', { startedAt: Date.now() })
  const threadKey = runEnv.threadRootId ?? 'main'
  const existing = ctx.db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agentId, runEnv.agentId),
        eq(agentSessions.channelId, runEnv.channel.id),
        eq(agentSessions.threadKey, threadKey)
      )
    )
    .get()

  try {
    await runSessionAttempt(ctx, runEnv, triggerMessageId, abort, existing ?? null)
  } catch (err) {
    // A stale/corrupt session must not strand the conversation — drop it and
    // run the turn fresh once.
    if (existing) {
      ctx.db
        .delete(agentSessions)
        .where(
          and(
            eq(agentSessions.agentId, runEnv.agentId),
            eq(agentSessions.channelId, runEnv.channel.id),
            eq(agentSessions.threadKey, threadKey)
          )
        )
        .run()
      recordStep(ctx, runEnv.runId, 'llm_call', {
        phase: 'session_resume_failed',
        error: err instanceof Error ? err.message : String(err)
      })
      await runSessionAttempt(ctx, runEnv, triggerMessageId, abort, null)
    } else {
      throw err
    }
  }
}

async function runSessionAttempt(
  ctx: AppContext,
  runEnv: RunEnv,
  triggerMessageId: string,
  abort: AbortController,
  session: { sessionId: string; updatedAt: number } | null
): Promise<void> {
  const promptBuiltAt = Date.now()
  const cwd = resolveWorkingDir(runEnv)
  if (runEnv.version.tools.includes(BROWSER_TOOL)) {
    await prepareBrowserProfile(join(env.workspacesDir, runEnv.agentId, '.browser-profile'))
  }

  const transcript = session
    ? buildIncrementalTranscript(
        ctx.db,
        runEnv.channel.id,
        runEnv.threadRootId,
        session.updatedAt,
        triggerMessageId
      )
    : buildContextTranscript(ctx.db, runEnv.channel.id, runEnv.threadRootId, triggerMessageId)

  const intro = session
    ? `The conversation in #${runEnv.channel.name} continues. New messages since your last turn:`
    : `Recent conversation in #${runEnv.channel.name}:`
  const prompt =
    `${intro}\n\n${transcript}\n\n` +
    (runEnv.triggerType === 'watch'
      ? `A new message was just posted in #${runEnv.channel.name}, a channel you watch ` +
        `(you were NOT @mentioned). Follow your standing instructions for handling new ` +
        `posts in this channel, then write a short status reply.`
      : `You were @mentioned. Do what was asked (use your tools if needed), ` +
        `then write your reply message.`)

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

  const stream = query({
    prompt,
    options: {
      model: runEnv.version.model,
      systemPrompt: buildSystemPrompt(ctx.db, runEnv.agentName, runEnv.version, runEnv.channel),
      cwd,
      maxTurns: MAX_TURNS,
      abortController: abort,
      // Continue the persistent conversation session when one exists.
      ...(session ? { resume: session.sessionId } : {}),
      // GUARDRAIL: never load the host user's ~/.claude or project settings —
      // their allow rules would shadow canUseTool and bypass approval gates.
      settingSources: [],
      permissionMode: 'default',
      env: sessionEnv(),
      mcpServers: {
        [MCP_SERVER_NAME]: buildMcpServer(toolCtx),
        ...browserMcpServer(runEnv)
      },
      allowedTools: allowedToolsFor(runEnv.version),
      disallowedTools: disallowedToolsFor(runEnv.version),
      // GUARDRAIL: the PreToolUse hook fires for EVERY tool call — including
      // ones Claude Code would auto-allow (e.g. sandboxable read-only Bash) —
      // so the allowlist + approval gate cannot be sidestepped by the
      // runtime's own permission shortcuts.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const hookInput = input as {
                  tool_name: string
                  tool_input: Record<string, unknown>
                }
                const decision = await gateToolUse(
                  ctx,
                  runEnv,
                  hookInput.tool_name,
                  hookInput.tool_input
                )
                if (decision === 'denied_by_admin') {
                  cancelled = true
                  cancelRun(ctx, runEnv, reply)
                  return permissionHookOutput('deny', 'Denied by admin. Stop working.')
                }
                if (decision === 'forbidden') {
                  return permissionHookOutput(
                    'deny',
                    `Tool ${fromSdkToolName(hookInput.tool_name)} is not permitted for this agent.`
                  )
                }
                return permissionHookOutput('allow', 'opencrew guardrails')
              }
            ]
          }
        ]
      },
      // Fallback choke point if a permission prompt ever reaches this far.
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
  let capturedSessionId: string | null = null
  for await (const msg of stream) {
    capturedSessionId ??= msg.session_id ?? null
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

  if (capturedSessionId) {
    saveSession(ctx, runEnv, capturedSessionId, promptBuiltAt)
  }
  if (cancelled) return
  if (resultError) {
    failRun(ctx, runEnv, `session ended with ${resultError}`, reply)
    return
  }
  finalizeRun(ctx, runEnv, reply)
}

/** Remember the session so the NEXT turn in this conversation resumes it. */
function saveSession(
  ctx: AppContext,
  runEnv: RunEnv,
  sessionId: string,
  promptBuiltAt: number
): void {
  ctx.db
    .insert(agentSessions)
    .values({
      agentId: runEnv.agentId,
      channelId: runEnv.channel.id,
      threadKey: runEnv.threadRootId ?? 'main',
      sessionId,
      updatedAt: promptBuiltAt
    })
    .onConflictDoUpdate({
      target: [agentSessions.agentId, agentSessions.channelId, agentSessions.threadKey],
      set: { sessionId, updatedAt: promptBuiltAt }
    })
    .run()
}

/** Point the agent at a real repo when configured; its workspace otherwise. */
function resolveWorkingDir(runEnv: RunEnv): string {
  const configured = runEnv.version.capabilities.workingDir?.trim()
  if (configured && configured.startsWith('/') && existsSync(configured)) {
    return configured
  }
  const fallback = join(env.workspacesDir, runEnv.agentId)
  mkdirSync(fallback, { recursive: true })
  return fallback
}

/**
 * GUARDRAIL: strip Claude Code session markers from the environment. When the
 * OpenCrew server itself runs inside a Claude Code terminal, inherited
 * CLAUDECODE / CLAUDE_ / IS_SANDBOX vars make spawned agent sessions
 * auto-trust tool calls and skip the canUseTool approval gate entirely.
 */
function sessionEnv(): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^(CLAUDECODE|CLAUDE_|IS_SANDBOX)/.test(key)) continue
    clean[key] = value
  }
  return clean
}

/**
 * The "Browser" capability: a Playwright MCP server driving the locally
 * installed Chrome with a persistent profile inside the agent's workspace.
 * The human logs into sites (e.g. x.com) once in that profile — every later
 * run reuses the session. Runs headed, so you can literally watch it work.
 */
/**
 * Take over the agent's Chrome profile before a run: close any leftover
 * window using it (e.g. the login window opened from the agent page) and
 * remove stale Singleton* lock files, so Playwright can always launch.
 * Safe because browser runs are serialized per agent — anything still
 * holding the profile here is not an active run.
 */
async function prepareBrowserProfile(profileDir: string): Promise<void> {
  const pattern = `user-data-dir=${profileDir}`
  spawnSync('pkill', ['-f', pattern])
  for (let i = 0; i < 20; i++) {
    const check = spawnSync('pgrep', ['-f', pattern])
    if (check.status !== 0) break // no processes left
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profileDir, file), { force: true })
  }
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

/**
 * The agent must drive the SAME browser binary the human logs in with —
 * cookies are encrypted with a per-browser keychain key, so Playwright's
 * bundled Chromium cannot read a login made in real Chrome (and vice versa).
 */
function chromeExecutablePath(): string | null {
  return CHROME_PATHS.find((p) => existsSync(p)) ?? null
}

function browserMcpServer(
  runEnv: RunEnv
): Record<string, { command: string; args: string[] }> {
  if (!runEnv.version.tools.includes(BROWSER_TOOL)) return {}
  // The browser profile always lives in the agent workspace, even when the
  // session itself runs in a configured project directory.
  const profileDir = join(env.workspacesDir, runEnv.agentId, '.browser-profile')
  mkdirSync(profileDir, { recursive: true })
  const chrome = chromeExecutablePath()
  const browserArgs = chrome
    ? ['--executable-path', chrome]
    : ['--browser', 'chrome']
  return {
    [BROWSER_MCP_SERVER]: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', ...browserArgs, '--user-data-dir', profileDir]
    }
  }
}

function allowedToolsFor(version: AgentVersion): string[] {
  return [
    // Schema loader for deferred MCP tools — always available, never a gate.
    'ToolSearch',
    ...version.tools
      .filter((t) => !version.capabilities.requiresApprovalFor.includes(t))
      .map(toSdkToolName)
  ]
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

function permissionHookOutput(decision: 'allow' | 'deny', reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }
}

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

  // Standing auto-approve rule: skip the human click, keep the full audit.
  const rule = findAutoApproveRule(ctx.db, runEnv.agentId, name)
  if (rule) {
    const autoId = nanoid()
    ctx.db
      .insert(approvals)
      .values({
        id: autoId,
        runId: runEnv.runId,
        toolName: name,
        toolInput: JSON.stringify(input),
        status: 'approved',
        resolvedBy: `rule:${rule.createdBy}`,
        resolvedAt: Date.now(),
        createdAt: Date.now()
      })
      .run()
    recordStep(ctx, runEnv.runId, 'approval_requested', {
      approvalId: autoId,
      tool: name,
      input,
      autoApproved: true
    })
    recordStep(ctx, runEnv.runId, 'approval_resolved', {
      approvalId: autoId,
      tool: name,
      decision: 'approved',
      resolvedBy: `rule:${rule.createdBy}`,
      autoApproved: true
    })
    assertToolInvocationAllowed(ctx.db, runEnv.version, runEnv.runId, name, autoId)
    return 'allowed'
  }

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
