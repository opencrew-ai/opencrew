export type UserRole = 'admin' | 'member' | 'guest'
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

/** The workspace reaction vocabulary — deliberately constrained. */
export const REACTION_SET = ['🔥', '👍', '😬', '👀', '🎉'] as const
export type ReactionEmoji = (typeof REACTION_SET)[number]

export interface ReactionGroup {
  emoji: string
  /** Human user ids who reacted with this emoji. */
  userIds: string[]
}

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
  /** Current status of the run linked to this message — kept live via WS run_status events. */
  runStatus?: RunStatus
  /** Human override on a conversation root: 'done' closes it regardless of run history. */
  manualStatus?: 'done'
  /** Aggregated emoji reactions, one group per emoji. */
  reactions?: ReactionGroup[]
  /**
   * When set, renders a thread citation card — the UI fetches the referenced
   * thread and shows it inline. May point to a thread in any channel.
   */
  refThreadId?: string
  /** Channel the cited thread lives in (required when refThreadId is set). */
  refChannelId?: string
  /** Anchors an artifact card to this message (e.g. review notices). */
  refArtifactId?: string
  /**
   * For agent/system messages produced by a run: the HUMAN message that
   * ultimately triggered it (walking up agent→agent chains). Lets the feed
   * group responses under the conversation they belong to, not whichever
   * human message happens to be newest when they arrive.
   */
  conversationRootId?: string
}

export type RunTriggerType = 'mention' | 'watch' | 'review'

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

/** One item of an agent's working task list (from TodoWrite). */
export interface AgentTaskItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-continuous label shown while the item is in progress. */
  activeForm?: string
}

export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/**
 * One item of a conversation's SHARED task list. Humans and agents co-edit:
 * humans add/reprioritize/complete items in the UI; agents mirror the list
 * via TodoWrite and their status updates reconcile back by content match.
 */
export interface SharedTask {
  id: string
  conversationRootId: string
  channelId: string
  content: string
  status: TaskStatus
  priority: TaskPriority
  /** Present-continuous label while an agent works the item. */
  activeForm?: string
  createdByType: 'human' | 'agent'
  createdById: string
  /** Agent currently/last working this item (from TodoWrite reconcile). */
  sourceAgentId?: string
  /** 'human' = a manual step only a person can do; surfaces in Needs You. */
  assigneeType: 'agent' | 'human'
  /** Unix ms — agent tasks auto-dispatch then; human tasks become due then. */
  scheduledFor?: number
  position: number
  updatedAt: number
}

/** Full shared task list for one conversation (task_state event payload). */
export interface ConversationTasks {
  conversationRootId: string
  channelId: string
  items: SharedTask[]
}

/**
 * One item in the Needs-You inbox: everything currently waiting on a human,
 * unified — explicit agent requests, docs awaiting review, tool approvals.
 * Deep-links to (channelId, conversationRootId) for context.
 */
export interface AttentionItem {
  /** 'request'/'task' rows resolve via the inbox; the others via their own flows. */
  kind: 'request' | 'doc_review' | 'tool_approval' | 'task'
  /** attention_requests.id / artifact id / approval id */
  refId: string
  title: string
  channelId: string
  conversationRootId: string
  agentId?: string
  agentName?: string
  agentEmoji?: string
  /** Task items: execution priority + plan order, drive inbox sorting. */
  priority?: TaskPriority
  position?: number
  createdAt: number
}

/** A draft task inside a proposed plan artifact. */
export interface PlanTaskDraft {
  content: string
  priority: TaskPriority
  /** 'human' for steps only a person can do (accounts, payments, sign-offs). */
  assignee?: 'agent' | 'human'
  /** ISO datetime — when this step should happen (agent steps auto-fire). */
  scheduledFor?: string
}

/**
 * A conversation artifact — a durable document an agent produced. 'plan'
 * artifacts carry a task list and wait for HUMAN approval: committing them
 * populates the shared task board. The doc, not chat, is the reference.
 */
/** A review comment on an artifact, optionally anchored to selected text. */
export interface ArtifactComment {
  id: string
  artifactId: string
  /** The selected doc text this comment anchors to (undefined = whole doc). */
  quote?: string
  body: string
  createdByUserId: string
  authorName?: string
  createdAt: number
}

export interface Artifact {
  id: string
  conversationRootId: string
  channelId: string
  runId: string
  /** change = a code diff captured from an agent's working dir. */
  kind: 'plan' | 'doc' | 'change'
  /** Folder path in the artifacts tree, e.g. "plans" or "marketing/launch". */
  folder: string
  title: string
  content: string
  tasks: PlanTaskDraft[]
  /** review = doc reviewer gate; proposed = awaiting HUMAN approval. */
  status: 'review' | 'proposed' | 'committed' | 'discarded'
  version: number
  createdByAgentId: string
  committedBy?: string
  createdAt: number
  updatedAt: number
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
  | { type: 'thread_status'; rootId: string; channelId: string; manualStatus: 'done' | null }
  | { type: 'reaction_updated'; messageId: string; channelId: string; reactions: ReactionGroup[] }
  /** Member-visible: an agent's task checklist for a conversation changed. */
  | { type: 'task_state'; tasks: ConversationTasks }
  /** Member-visible: coarse "now doing" label for an agent (null = idle). */
  | {
      type: 'agent_activity'
      agentId: string
      runId: string
      label: string | null
      /** Where the work is happening — lets the UI scope liveness to a conversation. */
      channelId?: string
      threadRootId?: string | null
    }
  /** Member-visible: an artifact was proposed, committed, or discarded. */
  | { type: 'artifact_state'; artifact: Artifact }
  /** Member-visible: a review comment was added to an artifact. */
  | { type: 'artifact_comment'; comment: ArtifactComment }
  /** Member-visible: the Needs-You inbox changed — clients refetch. */
  | { type: 'attention_changed' }
  /** Member-visible: a user marked a thread as read. Other tabs/devices update optimistic state. */
  | {
      type: 'thread_read'
      userId: string
      threadRootId: string
      channelId: string
      /** null = marked unread again. */
      readAt: number | null
    }

/** Client → server WebSocket events. */
export type ClientEvent = { type: 'ping' }
