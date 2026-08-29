import {
  pgTable,
  text,
  integer,
  bigint,
  primaryKey,
  boolean
} from 'drizzle-orm/pg-core'

// Workspace-slug column shared across tables enables per-workspace row-level
// isolation on a shared Postgres cluster. Default 'default' keeps single-
// instance installs zero-config. Multiplayer: each workspace gets its own
// slug — queries will filter by it once Dash's multiplayer design is locked.
const ws = {
  workspaceSlug: text('workspace_slug').notNull().default('default')
}

// Timestamps are stored as bigint (unix milliseconds). IDs are text (nanoid).

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  ...ws,
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member', 'guest'] }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  ...ws,
  userId: text('user_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull()
})

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  ...ws,
  name: text('name').notNull().unique(),
  avatarEmoji: text('avatar_emoji').notNull(),
  currentVersionId: text('current_version_id').notNull(),
  createdBy: text('created_by').notNull(),
  status: text('status', { enum: ['active', 'paused'] }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

// Immutable: rows are inserted, never updated. Edits create the next version.
export const agentVersions = pgTable('agent_versions', {
  id: text('id').primaryKey(),
  ...ws,
  agentId: text('agent_id').notNull(),
  version: integer('version').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  model: text('model').notNull(),
  skills: text('skills').notNull(), // json string[]
  tools: text('tools').notNull(), // json string[]
  capabilities: text('capabilities').notNull(), // json AgentCapabilities
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  changeNote: text('change_note').notNull()
})

export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  ...ws,
  name: text('name').notNull().unique(),
  topic: text('topic').notNull(),
  isPrivate: boolean('is_private').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

export const memberships = pgTable(
  'memberships',
  {
    ...ws,
    channelId: text('channel_id').notNull(),
    memberType: text('member_type', { enum: ['human', 'agent'] }).notNull(),
    memberId: text('member_id').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channelId, t.memberType, t.memberId] })
  })
)

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  ...ws,
  channelId: text('channel_id').notNull(),
  threadRootId: text('thread_root_id'),
  authorType: text('author_type', { enum: ['human', 'agent', 'system'] }).notNull(),
  authorId: text('author_id'),
  content: text('content').notNull(),
  /** JSON-encoded string[] of base64 data-URL images. Null means no images. */
  images: text('images'),
  approvalId: text('approval_id'),
  runId: text('run_id'),
  /** Thread citation — references a thread root in (possibly another) channel. */
  refThreadId: text('ref_thread_id'),
  refChannelId: text('ref_channel_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  ...ws,
  agentId: text('agent_id').notNull(),
  agentVersionId: text('agent_version_id').notNull(),
  triggerMessageId: text('trigger_message_id').notNull(),
  status: text('status', {
    enum: ['queued', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled']
  }).notNull(),
  error: text('error'),
  triggerType: text('trigger_type', { enum: ['mention', 'watch'] })
    .notNull()
    .default('mention'),
  depth: integer('depth').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  startedAt: bigint('started_at', { mode: 'number' }),
  finishedAt: bigint('finished_at', { mode: 'number' })
})

// Append-only audit log: every agent action of any kind lands here.
export const runSteps = pgTable('run_steps', {
  id: text('id').primaryKey(),
  ...ws,
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  type: text('type', {
    enum: [
      'llm_call',
      'tool_call',
      'tool_result',
      'post_message',
      'approval_requested',
      'approval_resolved'
    ]
  }).notNull(),
  payload: text('payload').notNull(), // json
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  ...ws,
  runId: text('run_id').notNull(),
  toolName: text('tool_name').notNull(),
  toolInput: text('tool_input').notNull(), // json
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull(),
  resolvedBy: text('resolved_by'),
  resolvedAt: bigint('resolved_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

// One persistent Claude Code session per (agent, channel, thread): follow-up
// messages RESUME the session, so agents keep full build context across turns.
export const agentSessions = pgTable(
  'agent_sessions',
  {
    ...ws,
    agentId: text('agent_id').notNull(),
    channelId: text('channel_id').notNull(),
    // threadRootId, or 'main' for channel-level conversation.
    threadKey: text('thread_key').notNull(),
    sessionId: text('session_id').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.channelId, t.threadKey] })
  })
)

// Standing admin consent: gated tool calls matching a rule auto-approve
// (an approvals row + audit steps are still written — nothing goes silent).
export const approvalRules = pgTable('approval_rules', {
  id: text('id').primaryKey(),
  ...ws,
  agentId: text('agent_id').notNull(),
  toolName: text('tool_name').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

// Workspace-level settings, editable from the UI (key → JSON-encoded value).
export const settings = pgTable('settings', {
  ...ws,
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
})

export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  ...ws,
  token: text('token').notNull().unique(),
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  usedBy: text('used_by'),
  /** Role granted to the user who redeems this invite. Defaults to 'member'. */
  role: text('role', { enum: ['member', 'guest'] }).notNull().default('member')
})
