import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'

// DDL mirrors schema.ts. TODO: switch to drizzle-kit migrations once the
// schema stabilizes; CREATE IF NOT EXISTS keeps `pnpm dev` zero-setup for now.
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, avatar_emoji TEXT NOT NULL,
  current_version_id TEXT NOT NULL, created_by TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL, model TEXT NOT NULL, skills TEXT NOT NULL,
  tools TEXT NOT NULL, capabilities TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, change_note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, topic TEXT NOT NULL,
  is_private INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  channel_id TEXT NOT NULL, member_type TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_type, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_root_id TEXT,
  author_type TEXT NOT NULL, author_id TEXT, content TEXT NOT NULL,
  approval_id TEXT, run_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_root_id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_version_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'mention',
  depth INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs (agent_id, created_at);
CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps (run_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL, status TEXT NOT NULL, resolved_by TEXT,
  resolved_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_key TEXT NOT NULL,
  session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, channel_id, thread_key)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT
);
`

/** Additive migrations for databases created before a column existed. */
function applyMigrations(sqlite: InstanceType<typeof Database>): void {
  const runColumns = sqlite.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
  if (!runColumns.some((c) => c.name === 'trigger_type')) {
    sqlite.exec(`ALTER TABLE runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'mention'`)
  }
}

export type DB = ReturnType<typeof createDb>['db']

export function createDb(path: string) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  applyMigrations(sqlite)
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}
