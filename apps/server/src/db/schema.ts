import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

// Timestamps are unix millis stored as integers; ids are text — both portable
// to Postgres (swap integer→bigint, keep text ids) with no data-model changes.

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  createdAt: integer('created_at').notNull()
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull()
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  avatarEmoji: text('avatar_emoji').notNull(),
  currentVersionId: text('current_version_id').notNull(),
  createdBy: text('created_by').notNull(),
  status: text('status', { enum: ['active', 'paused'] }).notNull(),
  createdAt: integer('created_at').notNull()
})

// Immutable: rows are inserted, never updated. Edits create the next version.
export const agentVersions = sqliteTable('agent_versions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  version: integer('version').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  model: text('model').notNull(),
  skills: text('skills').notNull(), // json string[]
  tools: text('tools').notNull(), // json string[]
  capabilities: text('capabilities').notNull(), // json AgentCapabilities
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
  changeNote: text('change_note').notNull()
})

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  topic: text('topic').notNull(),
  isPrivate: integer('is_private').notNull(),
  createdAt: integer('created_at').notNull()
})

export const memberships = sqliteTable(
  'memberships',
  {
    channelId: text('channel_id').notNull(),
    memberType: text('member_type', { enum: ['human', 'agent'] }).notNull(),
    memberId: text('member_id').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channelId, t.memberType, t.memberId] })
  })
)

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull(),
  threadRootId: text('thread_root_id'),
  authorType: text('author_type', { enum: ['human', 'agent', 'system'] }).notNull(),
  authorId: text('author_id'),
  content: text('content').notNull(),
  approvalId: text('approval_id'),
  runId: text('run_id'),
  createdAt: integer('created_at').notNull()
})

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
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
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at')
})

// Append-only audit log: every agent action of any kind lands here.
export const runSteps = sqliteTable('run_steps', {
  id: text('id').primaryKey(),
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
  createdAt: integer('created_at').notNull()
})

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  toolName: text('tool_name').notNull(),
  toolInput: text('tool_input').notNull(), // json
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull(),
  resolvedBy: text('resolved_by'),
  resolvedAt: integer('resolved_at'),
  createdAt: integer('created_at').notNull()
})

// One persistent Claude Code session per (agent, channel, thread): follow-up
// messages RESUME the session, so agents keep full build context across turns.
export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    agentId: text('agent_id').notNull(),
    channelId: text('channel_id').notNull(),
    // threadRootId, or 'main' for channel-level conversation.
    threadKey: text('thread_key').notNull(),
    sessionId: text('session_id').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.channelId, t.threadKey] })
  })
)

// Standing admin consent: gated tool calls matching a rule auto-approve
// (an approvals row + audit steps are still written — nothing goes silent).
export const approvalRules = sqliteTable('approval_rules', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  toolName: text('tool_name').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at').notNull()
})

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedBy: text('used_by')
})
