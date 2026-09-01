import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Both postgres.js and pglite return the same Drizzle query API — the
// difference is only in the adapter class name. We use the postgres.js type
// as the canonical DB type; pglite instances are cast to it in tests.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
export type DB = PostgresJsDatabase<typeof schema>

// ---------------------------------------------------------------------------
// DDL — runs once on startup to ensure all tables exist.
// ---------------------------------------------------------------------------

export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL UNIQUE,
  avatar_emoji TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  skills TEXT NOT NULL,
  tools TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  change_note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  is_private BOOLEAN NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL,
  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_type, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL,
  thread_root_id TEXT,
  author_type TEXT NOT NULL,
  author_id TEXT,
  content TEXT NOT NULL,
  images TEXT,
  approval_id TEXT,
  run_id TEXT,
  ref_thread_id TEXT,
  ref_channel_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_root_id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'mention',
  depth INTEGER NOT NULL DEFAULT 0,
  restricted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs (agent_id, created_at);
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps (run_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  status TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, channel_id, thread_key)
);
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_by TEXT,
  role TEXT NOT NULL DEFAULT 'member'
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  conversation_root_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT 'plans',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tasks TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_by_agent_id TEXT NOT NULL,
  committed_by TEXT,
  source_dir TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts (conversation_root_id);
CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  artifact_id TEXT NOT NULL,
  quote TEXT,
  body TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact ON artifact_comments (artifact_id);
CREATE TABLE IF NOT EXISTS attention_requests (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  conversation_root_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_status ON attention_requests (status, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_channel ON artifacts (channel_id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  conversation_root_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  active_form TEXT,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  source_agent_id TEXT,
  assignee_type TEXT NOT NULL DEFAULT 'agent',
  scheduled_for BIGINT,
  blocked_by TEXT,
  position INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks (conversation_root_id);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks (channel_id);
CREATE TABLE IF NOT EXISTS thread_shares (
  thread_root_id TEXT PRIMARY KEY,
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL,
  token TEXT NOT NULL,
  url TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS reactions (
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, emoji, user_id)
);
CREATE TABLE IF NOT EXISTS thread_reads (
  workspace_slug TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  thread_root_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  read_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, thread_root_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_reads_user ON thread_reads (user_id);
CREATE INDEX IF NOT EXISTS idx_thread_reads_channel ON thread_reads (channel_id);
`

// ---------------------------------------------------------------------------
// Additive migrations — run after DDL to add columns introduced after launch.
// Uses `IF NOT EXISTS` / error-swallow patterns safe for both pg and pglite.
// ---------------------------------------------------------------------------

export const MIGRATIONS = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ref_thread_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ref_channel_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS manual_status TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS restricted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'plans';
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_dir TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ref_artifact_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_type TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_for BIGINT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_by TEXT;
`

// ---------------------------------------------------------------------------
// Factory — supports postgres.js (production) and pglite (tests / local dev)
// ---------------------------------------------------------------------------

/**
 * Create the DB connection.
 *
 * Pass a postgres:// URL for a real Postgres cluster.
 * Pass ':memory:' (or any non-URL string) to use an in-process PGlite
 * instance (no Postgres server required — perfect for local dev and tests).
 */
export async function createDb(url: string): Promise<{ db: DB; close: () => Promise<void> }> {
  const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://')

  if (isPg) {
    const { default: postgres } = await import('postgres')
    const { drizzle } = await import('drizzle-orm/postgres-js')
    const client = postgres(url)
    const db = drizzle(client, { schema }) as unknown as DB
    await client.unsafe(DDL)
    await client.unsafe(MIGRATIONS)
    return {
      db,
      close: async () => {
        await client.end()
      }
    }
  } else {
    // PGlite: embedded Postgres WASM — zero setup, no server needed.
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const dataDir = url === ':memory:' ? undefined : url
    if (dataDir) mkdirSync(dirname(dataDir), { recursive: true })
    const client = new PGlite(dataDir)
    await client.exec(DDL)
    await client.exec(MIGRATIONS)
    const db = drizzle(client, { schema }) as unknown as DB
    return {
      db,
      close: async () => {
        await client.close()
      }
    }
  }
}
