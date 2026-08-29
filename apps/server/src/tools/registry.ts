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

/** Friendly name ("post_to_channel") → SDK tool name ("mcp__opencrew__..."). */
export function toSdkToolName(name: string): string {
  return openCrewTools.has(name) ? `${MCP_PREFIX}${name}` : name
}

/** SDK tool name → friendly name used in agent configs and guardrails. */
export function fromSdkToolName(sdkName: string): string {
  return sdkName.startsWith(MCP_PREFIX) ? sdkName.slice(MCP_PREFIX.length) : sdkName
}
