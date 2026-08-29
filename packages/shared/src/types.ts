export type UserRole = 'admin' | 'member'
export type AgentStatus = 'active' | 'paused'
export type MemberType = 'human' | 'agent'
export type AuthorType = 'human' | 'agent' | 'system'
export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled'
export type RunStepType =
  | 'llm_call'
  | 'tool_call'
  | 'tool_result'
  | 'post_message'
  | 'approval_requested'
  | 'approval_resolved'
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface User {
  id: string
  name: string
  email: string
  role: UserRole
}

export interface AgentCapabilities {
  /** Channel ids the agent may post into. Empty array = nowhere. */
  canPostInChannels: string[]
  maxRunsPerHour: number
  /** Tool names that pause the run for human approval. */
  requiresApprovalFor: string[]
  /**
   * Channel ids the agent watches: every new HUMAN message there triggers a
   * run without an @mention (agent/system messages never trigger watchers,
   * which keeps watch loops impossible). Optional for back-compat.
   */
  watchesChannels?: string[]
  /**
   * Absolute path the agent's sessions run in — point it at a real repo to
   * build there. Empty/unset = the agent's private workspace directory.
   */
  workingDir?: string
  /**
   * When true, the agent's Playwright MCP server uses the workspace-level
   * _shared/.browser-profile instead of the agent's own profile. Anup logs
   * in once (X, Gmail, LinkedIn…) and every agent with this flag set can
   * reuse those sessions immediately — no per-agent login required.
   */
  useSharedBrowserProfile?: boolean
}

export interface AgentVersionConfig {
  systemPrompt: string
  model: string
  skills: string[]
  tools: string[]
  capabilities: AgentCapabilities
}

export interface AgentVersion extends AgentVersionConfig {
  id: string
  agentId: string
  version: number
  createdBy: string
  createdAt: number
  changeNote: string
}

export interface Agent {
  id: string
  name: string
  avatarEmoji: string
  currentVersionId: string
  createdBy: string
  status: AgentStatus
}

export interface AgentWithVersion extends Agent {
  currentVersion: AgentVersion
}

export interface Channel {
  id: string
  name: string
  topic: string
  isPrivate: boolean
}

export interface Message {
  id: string
  channelId: string
  threadRootId: string | null
  authorType: AuthorType
  authorId: string | null
  content: string
  /** Base64 data-URL images attached to this message. */
  images?: string[]
  createdAt: number
  /** Populated server-side for convenience. */
  authorName?: string
  authorEmoji?: string
  replyCount?: number
  /** Set when this system message is an approval card. */
  approvalId?: string
  runId?: string
}

export type RunTriggerType = 'mention' | 'watch'

export interface Run {
  id: string
  agentId: string
  agentVersionId: string
  triggerMessageId: string
  triggerType?: RunTriggerType
  status: RunStatus
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
  depth: number
}

export interface RunStep {
  id: string
  runId: string
  seq: number
  type: RunStepType
  payload: Record<string, unknown>
  createdAt: number
}

export interface Approval {
  id: string
  runId: string
  toolName: string
  toolInput: Record<string, unknown>
  status: ApprovalStatus
  resolvedBy: string | null
  resolvedAt: number | null
  createdAt: number
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export type PresenceState = 'online' | 'offline' | 'idle' | 'running'

export interface PresenceEntry {
  memberType: MemberType
  memberId: string
  state: PresenceState
}

/** Server → client WebSocket events. */
export type ServerEvent =
  | { type: 'message_created'; message: Message }
  | { type: 'message_updated'; message: Message }
  | { type: 'message_stream'; messageId: string; channelId: string; content: string }
  | { type: 'presence'; entries: PresenceEntry[] }
  | { type: 'run_status'; runId: string; agentId: string; status: RunStatus }
  | { type: 'approval_updated'; approval: Approval }
  | { type: 'run_step'; agentId: string; step: RunStep }
  | { type: 'channel_created'; channel: Channel }
  | { type: 'agent_updated'; agent: AgentWithVersion }
  | { type: 'user_updated'; user: User }

/** Client → server WebSocket events. */
export type ClientEvent = { type: 'ping' }
