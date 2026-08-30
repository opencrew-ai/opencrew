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

/** Friendly name ("post_to_channel") → SDK tool name ("mcp__opencrew__..."). */
export function toSdkToolName(name: string): string {
  if (name === BROWSER_TOOL) return BROWSER_PREFIX
  return openCrewTools.has(name) ? `${MCP_PREFIX}${name}` : name
}

/** SDK tool name → friendly name used in agent configs and guardrails. */
export function fromSdkToolName(sdkName: string): string {
  if (sdkName.startsWith(BROWSER_PREFIX)) return BROWSER_TOOL
  return sdkName.startsWith(MCP_PREFIX) ? sdkName.slice(MCP_PREFIX.length) : sdkName
}
