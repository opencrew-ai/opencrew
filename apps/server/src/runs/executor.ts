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
import type { AgentVersion, Channel, RunStatus, RunTriggerType } from '@opencrew/shared'
import type { AppContext } from '../context'
import type { AttemptHandle, AttemptOutcome } from '../fabric/runtime'
import type { FabricTask } from '../fabric/store'
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
import { denyPendingApprovalsForRun } from '../services/approvals'
import { enqueueMentionRuns } from './enqueue'
import { recordStep } from './audit'
import {
  buildContextTranscript,
  buildIncrementalTranscript,
  buildSystemPrompt
} from './context'
import {
  assertToolInvocationAllowed,
  consumeGrant,
  evaluateToolUse,
  findAutoApproveRule,
  findConsumableGrant
} from './guardrails'
import {
  ALWAYS_AVAILABLE_TOOLS,
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
import {
  buildTaskPromptSection,
  parseTodoWriteInput,
  reconcileTodoSnapshot,
  toolActivityLabel
} from '../services/tasks'
import {
  archiveReplyToDoc,
  buildDocsPromptSection,
  flipRemainingReviewDocs,
  listDocsInReview,
  reviewKindsForAgent
} from '../services/artifacts'
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
  triggerType: RunTriggerType
}

interface ReplyState {
  messageId: string | null
  text: string
}

/** Approval decision carried back into the resumed attempt via the task payload. */
interface ResumeGrant {
  approvalId: string
  decision: 'approved' | 'denied'
  toolName: string
}

/**
 * Per-attempt state shared between the session loop and the tool gate.
 * `park` set means a gated call needs a human: the attempt ends and the
 * fabric task waits in needs_human at zero capacity cost.
 */
interface AttemptState {
  park: { approvalId: string } | null
}

async function setRunStatus(
  ctx: AppContext,
  runEnv: Pick<RunEnv, 'runId' | 'agentId'> & Partial<Pick<RunEnv, 'channel' | 'threadRootId'>>,
  status: RunStatus,
  patch: Partial<typeof runs.$inferInsert> = {}
): Promise<void> {
  await ctx.db
    .update(runs)
    .set({ status, ...patch })
    .where(eq(runs.id, runEnv.runId))
  ctx.hub.broadcast({
    type: 'run_status',
    runId: runEnv.runId,
    agentId: runEnv.agentId,
    status
  })
  // Run reached a terminal state — the agent is no longer "doing" anything.
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    ctx.hub.broadcast({
      type: 'agent_activity',
      agentId: runEnv.agentId,
      runId: runEnv.runId,
      label: null,
      channelId: runEnv.channel?.id,
      threadRootId: runEnv.threadRootId
    })
  }
  broadcastPresence(ctx)
}

/**
 * Execute one ATTEMPT of a 'turn' fabric task. The task id is the run id.
 * Returns the attempt outcome; the fabric runtime owns the task transition
 * (done / parked / redelivered / dead-lettered) — this function owns the run
 * row, the reply, and the conversation-facing notices.
 */
export async function executeTurn(
  ctx: AppContext,
  task: FabricTask,
  handle: AttemptHandle
): Promise<AttemptOutcome> {
  const runId = task.id
  const [run] = await ctx.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run) return { outcome: 'fatal', error: 'run row missing for turn task' }
  // A run cancelled while the task sat ready (stop_agent, stop-all) must not
  // execute; a terminal run means the task row is stale — close it out.
  if (['done', 'failed', 'cancelled'].includes(run.status)) {
    return { outcome: 'cancelled' }
  }

  const agent = await getAgent(ctx.db, run.agentId)
  let version = await getVersion(ctx.db, run.agentVersionId)

  // Community mode: run was triggered by a non-admin (public/shared
  // workspace visitor). The agent may talk, never touch the machine —
  // clipping the pinned version's tool list here means the SDK allowlist,
  // the PreToolUse guardrail, and the approval gate all inherit it.
  if (run.restricted && version) {
    const SAFE_TOOLS = new Set(['post_to_channel', 'list_agents'])
    version = {
      ...version,
      tools: version.tools.filter((tool) => SAFE_TOOLS.has(tool)),
      capabilities: { ...version.capabilities, requiresApprovalFor: [] },
      systemPrompt:
        version.systemPrompt +
        '\n\nCOMMUNITY MODE: this message came from a community member, not the ' +
        'workspace owner. Chat freely and be helpful, but you have no file, ' +
        'shell, browser, or hiring tools for this reply — do not promise to ' +
        'build, run, or change anything. If they want a working crew of their ' +
        'own, point them at https://github.com/opencrew-ai/opencrew (free, ' +
        'open source) and opencrew.run to run it from anywhere.'
    }
  }
  const [trigger] = await ctx.db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, run.triggerMessageId))
    .limit(1)
  const [channelRow] = trigger
    ? await ctx.db
        .select()
        .from(channels)
        .where(eq(channels.id, trigger.channelId))
        .limit(1)
    : []
  if (!agent || !version || !trigger || !channelRow) {
    await setRunStatus(ctx, { runId, agentId: run.agentId }, 'failed', {
      error: 'missing agent, version, or trigger message',
      finishedAt: Date.now()
    })
    return { outcome: 'fatal', error: 'missing agent, version, or trigger message' }
  }

  // Captain-orchestration model: ALL run output — the reply, approval
  // prompts, failure notices — lands in the thread rooted at the
  // conversation's human message. Admission computed the root at enqueue
  // time (task payload), so every attempt agrees on it.
  const conversationRoot =
    (task.payload.threadRootId as string | null) ?? trigger.threadRootId ?? trigger.id

  const runEnv: RunEnv = {
    runId,
    agentId: agent.id,
    agentName: agent.name,
    version,
    channel: { ...channelRow, isPrivate: channelRow.isPrivate },
    threadRootId: conversationRoot,
    depth: run.depth,
    triggerType: run.triggerType
  }
  const attemptState: AttemptState = { park: null }
  const resume = (task.payload.resume as ResumeGrant | undefined) ?? null

  await setRunStatus(ctx, runEnv, 'running', { startedAt: run.startedAt ?? Date.now() })

  const timeout = setTimeout(() => {
    handle.abortReason ??= 'turn timed out (30m)'
    handle.abort.abort()
  }, RUN_TIMEOUT_MS)
  const reply: ReplyState = { messageId: null, text: '' }
  try {
    await runSession(ctx, runEnv, trigger.id, handle, attemptState, resume, reply)
    if (attemptState.park) {
      return { outcome: 'parked', pause: { approvalId: attemptState.park.approvalId } }
    }
    return { outcome: 'done' }
  } catch (err) {
    // The park abort races the stream error — parking wins, it isn't a failure.
    if (attemptState.park) {
      return { outcome: 'parked', pause: { approvalId: attemptState.park.approvalId } }
    }
    if (reply.messageId) {
      await updateMessageContent(ctx, reply.messageId, reply.text)
    }
    const [current] = await ctx.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    // stop_agent / stop-all pre-mark the run cancelled before aborting.
    if (current?.status === 'cancelled') return { outcome: 'cancelled' }
    const error = handle.abortReason ?? (err instanceof Error ? err.message : String(err))
    return { outcome: 'error', error }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * One attempt = one TURN of a persistent Claude Code session. The session
 * for (agent, channel, thread) is resumed if it exists — the agent keeps its
 * full working context across turns AND across redeliveries: a re-attempt
 * continues from what the previous attempt already did, not from scratch.
 */
async function runSession(
  ctx: AppContext,
  runEnv: RunEnv,
  triggerMessageId: string,
  handle: AttemptHandle,
  attemptState: AttemptState,
  resume: ResumeGrant | null,
  reply: ReplyState
): Promise<void> {
  const threadKey = runEnv.threadRootId ?? 'main'
  const [existing] = await ctx.db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agentId, runEnv.agentId),
        eq(agentSessions.channelId, runEnv.channel.id),
        eq(agentSessions.threadKey, threadKey)
      )
    )
    .limit(1)

  try {
    await runSessionAttempt(
      ctx, runEnv, triggerMessageId, handle, attemptState, resume, reply, existing ?? null
    )
  } catch (err) {
    // A stale/corrupt session must not strand the conversation — drop it and
    // run the turn fresh once. Never on abort/park: those are not the
    // session's fault, and the session cache is the resume point.
    const canRetryFresh = existing && !attemptState.park && !handle.abort.signal.aborted
    if (canRetryFresh) {
      await ctx.db
        .delete(agentSessions)
        .where(
          and(
            eq(agentSessions.agentId, runEnv.agentId),
            eq(agentSessions.channelId, runEnv.channel.id),
            eq(agentSessions.threadKey, threadKey)
          )
        )
      await recordStep(ctx, runEnv.runId, 'llm_call', {
        phase: 'session_resume_failed',
        error: err instanceof Error ? err.message : String(err)
      })
      await runSessionAttempt(
        ctx, runEnv, triggerMessageId, handle, attemptState, resume, reply, null
      )
    } else {
      throw err
    }
  }
}

async function runSessionAttempt(
  ctx: AppContext,
  runEnv: RunEnv,
  triggerMessageId: string,
  handle: AttemptHandle,
  attemptState: AttemptState,
  resume: ResumeGrant | null,
  reply: ReplyState,
  session: { sessionId: string; updatedAt: number } | null
): Promise<void> {
  const promptBuiltAt = Date.now()
  const cwd = resolveWorkingDir(runEnv)
  if (runEnv.version.tools.includes(BROWSER_TOOL)) {
    await prepareBrowserProfile(browserProfileDir(runEnv))
  }

  const transcript = session
    ? await buildIncrementalTranscript(
        ctx.db,
        runEnv.channel.id,
        runEnv.threadRootId,
        session.updatedAt,
        triggerMessageId
      )
    : await buildContextTranscript(
        ctx.db,
        runEnv.channel.id,
        runEnv.threadRootId,
        triggerMessageId
      )

  const intro = session
    ? `The conversation in #${runEnv.channel.name} continues. New messages since your last turn:`
    : `Recent conversation in #${runEnv.channel.name}:`
  // Humans co-edit the conversation's task list (with priorities) — the agent
  // must see it every turn so human-added items and priorities steer the work.
  const taskSection = runEnv.threadRootId
    ? await buildTaskPromptSection(ctx.db, runEnv.threadRootId)
    : ''
  // Existing docs + their review comments — agents point to docs by title,
  // and revisions must address the feedback.
  const docsSection = runEnv.threadRootId
    ? await buildDocsPromptSection(ctx.db, runEnv.threadRootId)
    : ''
  let instruction: string
  if (resume) {
    // The grant matches EXACT input. A resumed session remembers its own
    // call; a cold-started one (session cache lost) needs the input restated.
    const approvedInput = resume.decision === 'approved'
      ? await grantInputPreview(ctx, resume.approvalId)
      : ''
    instruction =
      resume.decision === 'approved'
        ? `Earlier this turn you requested approval to use \`${resume.toolName}\` and were ` +
          `paused. The admin APPROVED it — a one-time grant is active for exactly the call ` +
          `you proposed.${approvedInput} Make that call again now with identical input, ` +
          `then continue the task and write your reply.`
        : `Earlier this turn you requested approval to use \`${resume.toolName}\` and were ` +
          `paused. The admin DENIED it. Do not attempt that call again — adjust your ` +
          `approach or wrap up with what you have, then write your reply.`
  } else if (runEnv.triggerType === 'review' && runEnv.threadRootId) {
    const ownedKinds = await reviewKindsForAgent(ctx.db, runEnv.agentId)
    const inReview = await listDocsInReview(ctx.db, runEnv.threadRootId, ownedKinds)
    const docList = inReview
      .map((d) => `"${d.title}" (${d.kind}, author: @${d.authorName})`)
      .join(', ')
    instruction =
      `You are a workspace REVIEWER. Items awaiting your review in this conversation: ` +
      `${docList || '(none — they may already be resolved; just reply briefly)'}. For EACH: ` +
      `read it with read_doc and judge it per your review charter. Then call review_doc with ` +
      `verdict "clear" (worth the human's attention) or "revise" (needs work — your reply must ` +
      `@mention the author with concrete, specific guidance). Be strict: you are the filter ` +
      `that keeps the human's review queue high-signal. Keep your reply to 1-3 sentences.`
  } else if (runEnv.triggerType === 'watch') {
    instruction =
      `A new message was just posted in #${runEnv.channel.name}, a channel you watch ` +
      `(you were NOT @mentioned). Follow your standing instructions for handling new ` +
      `posts in this channel, then write a short status reply.`
  } else {
    instruction =
      `You were @mentioned. Do what was asked (use your tools if needed), ` +
      `then write your reply message.`
  }
  const prompt = `${intro}\n\n${transcript}${taskSection}${docsSection}\n\n${instruction}`

  const toolCtx: ToolRunContext = {
    app: ctx,
    runId: runEnv.runId,
    agentId: runEnv.agentId,
    version: runEnv.version,
    channelId: runEnv.channel.id,
    threadRootId: runEnv.threadRootId,
    depth: runEnv.depth
  }

  const systemPrompt = await buildSystemPrompt(
    ctx.db,
    runEnv.agentName,
    runEnv.version,
    runEnv.channel
  )

  const stream = query({
    prompt,
    options: {
      model: runEnv.version.model,
      systemPrompt,
      cwd,
      maxTurns: MAX_TURNS,
      abortController: handle.abort,
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
                  attemptState,
                  handle,
                  hookInput.tool_name,
                  hookInput.tool_input
                )
                if (decision === 'park') {
                  return permissionHookOutput(
                    'deny',
                    'Approval requested from the admin — this turn is paused; ' +
                      'you will be resumed with the decision.'
                  )
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
        const decision = await gateToolUse(ctx, runEnv, attemptState, handle, sdkName, input)
        if (decision === 'park') {
          return {
            behavior: 'deny',
            message: 'Approval requested from the admin — this turn is paused.',
            interrupt: true
          }
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
  try {
    for await (const msg of stream) {
      capturedSessionId ??= msg.session_id ?? null
      handle.beat()
      if (msg.type === 'assistant') {
        await handleAssistantMessage(ctx, runEnv, handle, reply, msg)
      } else if (msg.type === 'user') {
        await handleUserMessage(ctx, runEnv, handle, msg)
      } else if (msg.type === 'result') {
        await recordStep(ctx, runEnv.runId, 'llm_call', {
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
  } finally {
    // The session is the resume point for parked and redelivered attempts —
    // persist it even when the stream ended by abort.
    if (capturedSessionId) {
      await saveSession(ctx, runEnv, capturedSessionId, promptBuiltAt)
    }
  }

  if (attemptState.park) return
  if (resultError) throw new Error(`session ended with ${resultError}`)
  await finalizeRun(ctx, runEnv, reply)
}

const GRANT_PREVIEW_LIMIT = 2000

/** The approved call's input, restated for cold-started resumes. */
async function grantInputPreview(ctx: AppContext, approvalId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ toolInput: approvals.toolInput })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1)
  if (!row || row.toolInput.length > GRANT_PREVIEW_LIMIT) return ''
  return ` The approved input was: ${row.toolInput}.`
}

/** Remember the session so the NEXT turn in this conversation resumes it. */
async function saveSession(
  ctx: AppContext,
  runEnv: RunEnv,
  sessionId: string,
  promptBuiltAt: number
): Promise<void> {
  await ctx.db
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

async function prepareBrowserProfile(profileDir: string): Promise<void> {
  const pattern = `user-data-dir=${profileDir}`
  spawnSync('pkill', ['-f', pattern])
  for (let i = 0; i < 20; i++) {
    const check = spawnSync('pgrep', ['-f', pattern])
    if (check.status !== 0) break
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

function chromeExecutablePath(): string | null {
  return CHROME_PATHS.find((p) => existsSync(p)) ?? null
}

function browserProfileDir(runEnv: RunEnv): string {
  if (runEnv.version.capabilities.useSharedBrowserProfile) {
    return join(env.workspacesDir, '_shared', '.browser-profile')
  }
  return join(env.workspacesDir, runEnv.agentId, '.browser-profile')
}

function browserMcpServer(
  runEnv: RunEnv
): Record<string, { command: string; args: string[] }> {
  if (!runEnv.version.tools.includes(BROWSER_TOOL)) return {}
  const profileDir = browserProfileDir(runEnv)
  mkdirSync(profileDir, { recursive: true })
  const chrome = chromeExecutablePath()
  const browserArgs = chrome ? ['--executable-path', chrome] : ['--browser', 'chrome']
  return {
    [BROWSER_MCP_SERVER]: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', ...browserArgs, '--user-data-dir', profileDir]
    }
  }
}

function allowedToolsFor(version: AgentVersion): string[] {
  return [
    'ToolSearch',
    // Safe-by-construction tools every agent gets — see tools/registry.ts.
    ...ALWAYS_AVAILABLE_TOOLS.map(toSdkToolName),
    ...version.tools
      .filter((t) => !version.capabilities.requiresApprovalFor.includes(t))
      .map(toSdkToolName)
  ]
}

function disallowedToolsFor(version: AgentVersion): string[] {
  const catalogNames = toolCatalog().map((t) => t.name)
  const alwaysAvailable = new Set<string>(ALWAYS_AVAILABLE_TOOLS)
  return [
    ...ALWAYS_DISALLOWED,
    ...catalogNames
      .filter((name) => !alwaysAvailable.has(name) && !version.tools.includes(name))
      .map(toSdkToolName)
  ]
}

type GateOutcome = 'allowed' | 'forbidden' | 'park'

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
 * The tool gate — PreToolUse fires for EVERY call, so this is the one true
 * choke point. Gated calls PARK the attempt instead of blocking it: the
 * approval is recorded, the turn is aborted, the slot frees, and the human's
 * decision later unparks the task with a one-shot grant.
 */
async function gateToolUse(
  ctx: AppContext,
  runEnv: RunEnv,
  attemptState: AttemptState,
  handle: AttemptHandle,
  sdkName: string,
  input: Record<string, unknown>
): Promise<GateOutcome> {
  const name = fromSdkToolName(sdkName)
  const verdict = evaluateToolUse(runEnv.version, name)
  if (verdict === 'deny') return 'forbidden'
  if (verdict === 'allow') return 'allowed'

  // Already parking — deny any further gated calls without new paperwork.
  if (attemptState.park) return 'park'

  // One-shot grant from the resumed attempt's approval: consume and pass.
  const grant = await findConsumableGrant(ctx.db, runEnv.runId, name, input)
  if (grant) {
    await consumeGrant(ctx.db, grant.id)
    await assertToolInvocationAllowed(ctx.db, runEnv.version, runEnv.runId, name, grant.id)
    return 'allowed'
  }

  // Standing auto-approve rule: skip the human click, keep the full audit.
  const rule = await findAutoApproveRule(ctx.db, runEnv.agentId, name)
  if (rule) {
    const autoId = nanoid()
    await ctx.db.insert(approvals).values({
      id: autoId,
      runId: runEnv.runId,
      toolName: name,
      toolInput: JSON.stringify(input),
      status: 'approved',
      resolvedBy: `rule:${rule.createdBy}`,
      resolvedAt: Date.now(),
      consumedAt: Date.now(),
      createdAt: Date.now()
    })
    await recordStep(ctx, runEnv.runId, 'approval_requested', {
      approvalId: autoId,
      tool: name,
      input,
      autoApproved: true
    })
    await recordStep(ctx, runEnv.runId, 'approval_resolved', {
      approvalId: autoId,
      tool: name,
      decision: 'approved',
      resolvedBy: `rule:${rule.createdBy}`,
      autoApproved: true
    })
    await assertToolInvocationAllowed(ctx.db, runEnv.version, runEnv.runId, name, autoId)
    return 'allowed'
  }

  // Park: record the ask, free the capacity, wait on the human in the store.
  const approvalId = nanoid()
  await ctx.db.insert(approvals).values({
    id: approvalId,
    runId: runEnv.runId,
    toolName: name,
    toolInput: JSON.stringify(input),
    status: 'pending',
    createdAt: Date.now()
  })
  await recordStep(ctx, runEnv.runId, 'approval_requested', { approvalId, tool: name, input })
  await setRunStatus(ctx, runEnv, 'awaiting_approval')
  await postSystemMessage(
    ctx,
    runEnv.channel.id,
    `🟡 **${runEnv.agentName}** wants to use \`${name}\` — waiting for an admin. ` +
      `The agent is paused (not holding a worker slot) until you decide.`,
    { threadRootId: runEnv.threadRootId, approvalId, runId: runEnv.runId }
  )
  attemptState.park = { approvalId }
  handle.abortReason ??= 'parked for approval'
  // Deliver the deny to the SDK first, then end the attempt.
  setTimeout(() => handle.abort.abort(), 0)
  return 'park'
}

async function handleAssistantMessage(
  ctx: AppContext,
  runEnv: RunEnv,
  handle: AttemptHandle,
  reply: ReplyState,
  msg: SDKAssistantMessage
): Promise<void> {
  let text = ''
  for (const block of msg.message.content) {
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'tool_use') {
      const tool = fromSdkToolName(block.name)
      handle.toolStarted()
      await recordStep(ctx, runEnv.runId, 'tool_call', {
        tool,
        input: block.input,
        toolUseId: block.id
      })
      await publishActivity(ctx, runEnv, tool, block.input)
    }
  }
  await recordStep(ctx, runEnv.runId, 'llm_call', {
    model: msg.message.model,
    stopReason: msg.message.stop_reason,
    usage: msg.message.usage
  })
  if (text.trim()) await appendReplyText(ctx, runEnv, reply, text)
}

/**
 * Surface what the agent is doing right now, member-visibly. TodoWrite calls
 * additionally persist the full checklist for the conversation's task board.
 */
async function publishActivity(
  ctx: AppContext,
  runEnv: RunEnv,
  tool: string,
  input: unknown
): Promise<void> {
  let label = toolActivityLabel(tool)
  if (tool === 'TodoWrite' && runEnv.threadRootId) {
    const items = parseTodoWriteInput(input)
    if (items) {
      await reconcileTodoSnapshot(ctx, {
        conversationRootId: runEnv.threadRootId,
        channelId: runEnv.channel.id,
        agentId: runEnv.agentId,
        items
      })
      const active = items.find((item) => item.status === 'in_progress')
      if (active) label = active.activeForm ?? active.content
    }
  }
  ctx.hub.broadcast({
    type: 'agent_activity',
    agentId: runEnv.agentId,
    runId: runEnv.runId,
    label,
    channelId: runEnv.channel.id,
    threadRootId: runEnv.threadRootId
  })
}

async function handleUserMessage(
  ctx: AppContext,
  runEnv: RunEnv,
  handle: AttemptHandle,
  msg: SDKUserMessage
): Promise<void> {
  const content = msg.message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    handle.toolFinished()
    const raw =
      typeof block.content === 'string'
        ? block.content
        : (block.content ?? [])
            .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
            .join('\n')
    await recordStep(ctx, runEnv.runId, 'tool_result', {
      toolUseId: block.tool_use_id,
      isError: block.is_error ?? false,
      content:
        raw.length > STEP_CONTENT_LIMIT
          ? `${raw.slice(0, STEP_CONTENT_LIMIT)}… [truncated]`
          : raw
    })
  }
}

async function appendReplyText(
  ctx: AppContext,
  runEnv: RunEnv,
  reply: ReplyState,
  text: string
): Promise<void> {
  if (!reply.messageId) {
    const message = await createMessage(ctx, {
      channelId: runEnv.channel.id,
      threadRootId: runEnv.threadRootId,
      authorType: 'agent',
      authorId: runEnv.agentId,
      agentVersionId: runEnv.version.id,
      content: '',
      runId: runEnv.runId,
      // A mention is an invitation — replying in this conversation is always
      // allowed; canPostInChannels keeps governing post_to_channel.
      isRunReply: true
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

// Replies longer than this are auto-moved into a doc artifact — chat stays
// scannable, deliverables land in the Artifacts tree. Enforced, not asked.
const CHAT_REPLY_DOC_LIMIT = 2000

async function finalizeRun(
  ctx: AppContext,
  runEnv: RunEnv,
  reply: ReplyState
): Promise<void> {
  if (reply.messageId) {
    let finalText = reply.text
    if (finalText.length > CHAT_REPLY_DOC_LIMIT && runEnv.threadRootId) {
      // Mentions are re-scanned on the SHORT text below, so a mention buried
      // inside an archived wall never fans out — delegations must be explicit
      // in the reply itself.
      const archived = await archiveReplyToDoc(ctx, {
        conversationRootId: runEnv.threadRootId,
        channelId: runEnv.channel.id,
        runId: runEnv.runId,
        agentId: runEnv.agentId,
        text: finalText
      })
      finalText = archived.pointerText
    }
    await updateMessageContent(ctx, reply.messageId, finalText)
    await recordStep(ctx, runEnv.runId, 'post_message', {
      messageId: reply.messageId,
      channelId: runEnv.channel.id,
      via: 'reply'
    })
    const [row] = await ctx.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, reply.messageId))
      .limit(1)
    if (row) {
      await enqueueMentionRuns(ctx, await enrichMessage(ctx.db, row), runEnv.depth + 1)
    }
  }
  // Safety net: a review run must never strand docs in 'review' — anything
  // the reviewer didn't verdict goes to the human by default.
  if (runEnv.triggerType === 'review' && runEnv.threadRootId) {
    await flipRemainingReviewDocs(ctx, runEnv.threadRootId)
  }
  await denyPendingApprovalsForRun(ctx, runEnv.runId, 'system:run-ended')
  await setRunStatus(ctx, runEnv, 'done', { finishedAt: Date.now() })
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
