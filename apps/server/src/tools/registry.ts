import type { ZodRawShape, z } from 'zod'
import type { AgentVersion } from '@opencrew/shared'
import type { AppContext } from '../context'

export const MCP_SERVER_NAME = 'opencrew'
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`

export interface ToolRunContext {
  app: AppContext
  runId: string
  agentId: string
  /** Pinned version — capabilities are read from here, never from "current". */
  version: AgentVersion
  channelId: string
  threadRootId: string | null
  depth: number
}

/**
 * An OpenCrew-native tool, served to agent sessions over MCP.
 * Contributors add one file that calls registerOpenCrewTool() — that's it.
 */
export interface OpenCrewToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  inputShape: Shape
  execute: (
    input: z.objectOutputType<Shape, z.ZodTypeAny>,
    ctx: ToolRunContext
  ) => Promise<string>
}

/**
 * Tools every agent gets regardless of its configured tool list. All of them
 * are safe by construction: TodoWrite records the agent's own plan,
 * propose_plan awaits human approval, update_doc touches only already-
 * committed docs, read_doc is read-only.
 */
export const ALWAYS_AVAILABLE_TOOLS = [
  'TodoWrite',
  'propose_plan',
  'update_doc',
  'read_doc',
  'request_human',
  // Scoped to the agent's own conversation; human-assigned tasks refused.
  'update_task',
  // Identity-gated inside execute(): only configured reviewers.
  'review_doc',
  // The ONLY path to a git commit — reviewed diff + human approval.
  'propose_change'
] as const

const openCrewTools = new Map<string, OpenCrewToolDef>()

export function registerOpenCrewTool<Shape extends ZodRawShape>(
  def: OpenCrewToolDef<Shape>
): void {
  if (openCrewTools.has(def.name)) {
    throw new Error(`duplicate tool registration: ${def.name}`)
  }
  openCrewTools.set(def.name, def as unknown as OpenCrewToolDef)
}

export function listOpenCrewTools(): OpenCrewToolDef[] {
  return [...openCrewTools.values()]
}

/**
 * "Browser" is a virtual tool: granting it attaches a Playwright MCP server
 * (a real local Chrome with a persistent per-agent profile) to the session.
 * All mcp__playwright__* tools map back to this one name, so the allowlist
 * and approval gate treat the whole browser as a single capability.
 */
export const BROWSER_TOOL = 'Browser'
export const BROWSER_MCP_SERVER = 'playwright'
const BROWSER_PREFIX = `mcp__${BROWSER_MCP_SERVER}`

/**
 * "Chrome" is the feedback loop: the human's OWN Chrome, via the Claude in
 * Chrome extension (Claude Code's `--chrome`). Same profile, same logins,
 * same served bundle the human is looking at — so "does the change render?"
 * is answered by looking, not by reasoning about the build. All
 * mcp__claude-in-chrome__* tools map back to this one name.
 */
export const CHROME_TOOL = 'Chrome'
export const CHROME_MCP_SERVER = 'claude-in-chrome'
const CHROME_PREFIX = `mcp__${CHROME_MCP_SERVER}`

/**
 * Chrome calls that only LOOK. Looking never needs approval even when
 * `Chrome` is in requiresApprovalFor — the gate is for acting (navigating,
 * clicking, typing, running scripts, uploading), where the human's logged-in
 * sessions are on the line.
 */
const CHROME_LOOK_TOOLS = new Set([
  `${CHROME_PREFIX}__tabs_context_mcp`,
  `${CHROME_PREFIX}__read_page`,
  `${CHROME_PREFIX}__get_page_text`,
  `${CHROME_PREFIX}__find`,
  `${CHROME_PREFIX}__read_console_messages`,
  `${CHROME_PREFIX}__read_network_requests`,
  `${CHROME_PREFIX}__list_connected_browsers`,
  `${CHROME_PREFIX}__shortcuts_list`
])
const CHROME_LOOK_COMPUTER_ACTIONS = new Set(['screenshot', 'zoom', 'cursor_position'])

export function isChromeLook(sdkName: string, input: Record<string, unknown>): boolean {
  if (CHROME_LOOK_TOOLS.has(sdkName)) return true
  if (sdkName === `${CHROME_PREFIX}__computer`) {
    return typeof input.action === 'string' && CHROME_LOOK_COMPUTER_ACTIONS.has(input.action)
  }
  return false
}

/** Friendly name ("post_to_channel") → SDK tool name ("mcp__opencrew__..."). */
export function toSdkToolName(name: string): string {
  if (name === BROWSER_TOOL) return BROWSER_PREFIX
  if (name === CHROME_TOOL) return CHROME_PREFIX
  return openCrewTools.has(name) ? `${MCP_PREFIX}${name}` : name
}

/** SDK tool name → friendly name used in agent configs and guardrails. */
export function fromSdkToolName(sdkName: string): string {
  if (sdkName.startsWith(BROWSER_PREFIX)) return BROWSER_TOOL
  if (sdkName.startsWith(CHROME_PREFIX)) return CHROME_TOOL
  return sdkName.startsWith(MCP_PREFIX) ? sdkName.slice(MCP_PREFIX.length) : sdkName
}
