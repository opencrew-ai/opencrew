import {
  pgTable,
  text,
  integer,
  bigint,
  primaryKey,
  boolean
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Viral growth & UTM attribution additions
// ---------------------------------------------------------------------------
// referralCode   — user's shareable invite code (e.g. share link: /signup?ref=XXXXX)
// referredBy     — the referralCode that drove this signup (attribution)
// utmSource/Medium/Campaign — captured from query-string at signup
// waitlisted     — true while the user is in the waitlist queue
// proUntil       — unix-ms expiry of a Pro grant (null = not Pro)

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
  /** Anchors an artifact card to this message (e.g. review notices). */
  refArtifactId: text('ref_artifact_id'),
  /** Human override on a conversation root: 'done' marks it complete. */
  manualStatus: text('manual_status'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

/** Threads published as public pages on the relay (opencrew.run/t/:token). */
export const threadShares = pgTable('thread_shares', {
  threadRootId: text('thread_root_id').primaryKey(),
  ...ws,
  channelId: text('channel_id').notNull(),
  /** Relay-side token — resharing with it updates the page in place. */
  token: text('token').notNull(),
  url: text('url').notNull(),
  sharedBy: text('shared_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
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
  triggerType: text('trigger_type', { enum: ['mention', 'watch', 'review'] })
    .notNull()
    .default('mention'),
  depth: integer('depth').notNull().default(0),
  /** Community mode: run triggered by a non-admin — tools clipped to chat-only. */
  restricted: boolean('restricted').notNull().default(false),
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

export const reactions = pgTable(
  'reactions',
  {
    ...ws,
    messageId: text('message_id').notNull(),
    emoji: text('emoji').notNull(),
    userId: text('user_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.emoji, t.userId] })
  })
)

/**
 * Server-persisted thread read state.
 * Records the timestamp when a user last marked a thread as read.
 * Unread = no row exists, or the thread has messages newer than read_at.
 */
export const threadReads = pgTable(
  'thread_reads',
  {
    ...ws,
    userId: text('user_id').notNull(),
    threadRootId: text('thread_root_id').notNull(),
    channelId: text('channel_id').notNull(),
    readAt: bigint('read_at', { mode: 'number' }).notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.threadRootId] })
  })
)

/**
 * SHARED task list items, one row per task, keyed by conversation. Humans
 * create/edit/prioritize in the UI; agents mirror the list via TodoWrite and
 * their snapshots reconcile back into these rows by exact content match.
 */
export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  ...ws,
  conversationRootId: text('conversation_root_id').notNull(),
  channelId: text('channel_id').notNull(),
  content: text('content').notNull(),
  status: text('status', { enum: ['pending', 'in_progress', 'completed'] }).notNull(),
  priority: text('priority', { enum: ['high', 'medium', 'low'] }).notNull(),
  activeForm: text('active_form'),
  createdByType: text('created_by_type', { enum: ['human', 'agent'] }).notNull(),
  createdById: text('created_by_id').notNull(),
  /** Agent currently/last working this item. */
  sourceAgentId: text('source_agent_id'),
  /** 'human' tasks are manual steps only a person can do — they surface in
   *  the Needs-You inbox instead of being worked by agents. */
  assigneeType: text('assignee_type', { enum: ['agent', 'human'] })
    .notNull()
    .default('agent'),
  /** Unix ms. Agent tasks auto-dispatch at this time; human tasks become
   *  due in the Needs-You inbox. Null = unscheduled. */
  scheduledFor: bigint('scheduled_for', { mode: 'number' }),
  position: integer('position').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
})

/**
 * Conversation artifacts — durable documents an agent produces (plans first;
 * design docs and files later). A 'plan' artifact carries a structured task
 * list and waits for HUMAN approval: committing it populates the shared task
 * board. Versions increment per (conversationRootId, title).
 */
export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(),
  ...ws,
  conversationRootId: text('conversation_root_id').notNull(),
  channelId: text('channel_id').notNull(),
  runId: text('run_id').notNull(),
  kind: text('kind', { enum: ['plan', 'doc', 'change'] }).notNull(),
  /** Folder path like "plans" or "marketing/launch" — the artifacts tree. */
  folder: text('folder').notNull().default('plans'),
  title: text('title').notNull(),
  /** Markdown document body. */
  content: text('content').notNull(),
  /** JSON array of {content, priority} drafts (plan kind). */
  tasks: text('tasks').notNull(),
  status: text('status', {
    enum: ['review', 'proposed', 'committed', 'discarded']
  }).notNull(),
  version: integer('version').notNull(),
  createdByAgentId: text('created_by_agent_id').notNull(),
  committedBy: text('committed_by'),
  /** kind 'change' only: the working dir whose staged diff this captures. */
  sourceDir: text('source_dir'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
})

/** Review comments on an artifact, optionally anchored to a quoted selection. */
export const artifactComments = pgTable('artifact_comments', {
  id: text('id').primaryKey(),
  ...ws,
  artifactId: text('artifact_id').notNull(),
  /** The selected text this comment anchors to (null = whole-doc comment). */
  quote: text('quote'),
  body: text('body').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
})

/**
 * Explicit "I need a human" requests from agents — reviews, manual steps,
 * credentials, decisions. Surfaced in the Needs-You inbox, deep-linking back
 * to the conversation for context.
 */
/**
 * Workspace billing state — one row per workspace, mirrored from Stripe via
 * webhooks. `plan` is what was bought; whether it's in force depends on
 * `status` (see services/billing resolvePlan). Absent row = Free.
 */
export const subscriptions = pgTable('subscriptions', {
  workspaceSlug: text('workspace_slug').primaryKey().default('default'),
  plan: text('plan', { enum: ['free', 'pro', 'team', 'enterprise'] }).notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePriceId: text('stripe_price_id'),
  /** Stripe subscription status verbatim (active, trialing, past_due, canceled, …). */
  status: text('status').notNull(),
  interval: text('interval', { enum: ['month', 'year'] }),
  currentPeriodEnd: bigint('current_period_end', { mode: 'number' }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
})

/** Processed Stripe webhook event ids — makes redelivery idempotent. */
export const billingEvents = pgTable('billing_events', {
  id: text('id').primaryKey(),
  ...ws,
  type: text('type').notNull(),
  receivedAt: bigint('received_at', { mode: 'number' }).notNull()
})

/**
 * Crew Replays published to the relay (opencrew.run/replay/:runId). The URL
 * is deterministic per run; the row exists only once an admin publishes.
 */
export const runReplays = pgTable('run_replays', {
  runId: text('run_id').primaryKey(),
  ...ws,
  token: text('token').notNull(),
  url: text('url').notNull(),
  publishedBy: text('published_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
})

export const attentionRequests = pgTable('attention_requests', {
  id: text('id').primaryKey(),
  ...ws,
  conversationRootId: text('conversation_root_id').notNull(),
  channelId: text('channel_id').notNull(),
  agentId: text('agent_id').notNull(),
  runId: text('run_id').notNull(),
  request: text('request').notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  resolvedAt: bigint('resolved_at', { mode: 'number' }),
  resolvedBy: text('resolved_by')
})
