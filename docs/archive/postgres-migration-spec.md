# Postgres Migration Spec

**Author:** Forge (Head of DevOps & Infrastructure)  
**Status:** Ready to execute — awaiting go signal from CEO  
**Estimated effort:** 1 focused day (schema + adapter swap + seed update)  
**Blocking:** multi-tenancy, MSA data isolation commitments (@Lex), usage metering (@Penny), any deploy beyond a single machine

---

## Why now

The current `better-sqlite3` setup is perfect for a single machine with one workspace.
It breaks the moment we have:

- Multiple tenants sharing a database (org isolation requires row-level scoping)
- Point-in-time backups (PITR is a Postgres primitive, unavailable on SQLite)
- Read replicas for the terminal stream (high read:write ratio under load)
- Concurrent writers from multiple server instances (SQLite WAL handles this partially, Postgres handles it completely)
- @Lex's MSA Exhibit B: "logical isolation by `org_id`" — that commitment requires `org_id` in the schema before the first enterprise customer signs

The schema comment in `schema.ts` already says:

> Timestamps are unix millis stored as integers; ids are text — both portable
> to Postgres (swap integer→bigint, keep text ids) with no data-model changes.

The original author planned for this. We're executing the plan.

---

## New fields in this migration

Two fields are added to every tenant-scoped table. These must land in the schema
before the first multi-tenant deploy — retroactively adding them is painful.

### `org_id TEXT NOT NULL DEFAULT 'default'`

Scopes every row to an organization. The `'default'` default means the current
single-tenant data migrates without changes.

Added to: `users`, `agents`, `channels`, `messages`, `runs`, `runSteps`,
`approvals`, `approvalRules`, `agentSessions`, `invites`

Not added to: `sessions` (scoped via userId), `agentVersions` (scoped via agentId),
`settings` (workspace-level, not org-level — revisit when multi-workspace lands)

### `workspace_slug TEXT NOT NULL DEFAULT 'default'`

The URL-safe identifier for a user's workspace — `opencrew.run/{slug}`. Nova
specified this is required for the PLG sharing/public workspace feature. Wire it
in now while the migration is clean.

Added to: `users` table only (the slug belongs to the user/org, not per-resource)

---

## New table: `run_costs`

Penny flagged the API cost tracking requirement. Rather than adding cost columns
to `runs` (which would be updated mid-run), we log cost events append-only:

```sql
CREATE TABLE run_costs (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  org_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  input_tokens  BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cost_usd   NUMERIC(10, 6) NOT NULL,
  recorded_at BIGINT NOT NULL
);
CREATE INDEX idx_run_costs_org ON run_costs (org_id, recorded_at);
CREATE INDEX idx_run_costs_run ON run_costs (run_id);
```

This gives @Penny a direct query for "API spend by org per month" — the input
she needs for margin calculation and overage gating.

---

## Schema changes: SQLite → Postgres

### Type mappings

| SQLite (current) | Postgres (target) | Notes |
|---|---|---|
| `integer` (timestamps) | `bigint` | Unix millis fit in bigint |
| `integer` (is_private) | `boolean` | SQLite stores booleans as 0/1 |
| `text` (JSON columns) | `jsonb` | `skills`, `tools`, `capabilities`, `toolInput`, `payload` |
| `text` (enum columns) | `text` with check constraint | Drizzle handles this |

### JSON column upgrade

These columns currently store JSON as plain `text`. Moving to `jsonb` enables
indexed queries (`payload->>'type'` etc.) and validates JSON on insert:

- `agent_versions.skills`
- `agent_versions.tools`
- `agent_versions.capabilities`
- `approvals.tool_input`
- `run_steps.payload`

---

## Code changes required

### 1. `apps/server/package.json`

```diff
- "better-sqlite3": "^11.7.0",
- "@types/better-sqlite3": "^7.6.12",
+ "postgres": "^3.4.4",
+ "drizzle-kit": "^0.28.0",
```

Drizzle ORM stays (`drizzle-orm` already in deps). We're just swapping the
driver from `better-sqlite3` to `postgres` (the `postgres.js` client — simpler
than `node-postgres`/`pg`, better TypeScript support).

### 2. `apps/server/src/db/schema.ts`

```diff
- import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
+ import { pgTable, text, bigint, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core'
```

All `sqliteTable(...)` → `pgTable(...)`.  
All `integer('created_at')` → `bigint('created_at', { mode: 'number' })`.  
All `integer('is_private')` → `boolean('is_private')`.  
JSON text columns → `jsonb(...)`.

Add to every tenant-scoped table:
```ts
orgId: text('org_id').notNull().default('default'),
```

Add to `users`:
```ts
workspaceSlug: text('workspace_slug').notNull().default('default'),
```

Add new `runCosts` table (see above).

### 3. `apps/server/src/db/index.ts`

The entire `createDb()` function is replaced:

```typescript
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export type DB = ReturnType<typeof createDb>['db']

export function createDb(connectionString: string) {
  const client = postgres(connectionString)
  const db = drizzle(client, { schema })
  return { db, client }
}
```

The inline DDL string and `applyMigrations()` function are deleted.
Schema management moves to `drizzle-kit` (see below).

### 4. `apps/server/src/env.ts`

```diff
- dbPath: process.env.OPENCREW_DB ?? resolve(process.cwd(), '../../data/opencrew.db'),
+ dbUrl: process.env.DATABASE_URL ?? 'postgresql://opencrew:opencrew@localhost:5432/opencrew',
```

### 5. `drizzle.config.ts` (new file, project root)

```typescript
import { defineConfig } from 'drizzle-kit'
import { env } from './apps/server/src/env'

export default defineConfig({
  schema: './apps/server/src/db/schema.ts',
  out: './apps/server/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: env.dbUrl },
})
```

This enables:
- `pnpm drizzle-kit generate` — generate SQL migration files from schema diff
- `pnpm drizzle-kit migrate` — apply pending migrations
- `pnpm drizzle-kit studio` — visual DB browser during development

---

## Migration path for existing data

The current SQLite database lives at `data/opencrew.sqlite`. Steps to migrate:

```bash
# 1. Export from SQLite
sqlite3 data/opencrew.sqlite .dump > data/opencrew-dump.sql

# 2. Start Postgres (Docker Compose below)
docker compose up -d postgres

# 3. Apply the Drizzle migration (creates tables with new schema)
pnpm drizzle-kit migrate

# 4. Run the data import script (one-off, in infra/migrate-sqlite-data.ts)
pnpm tsx infra/migrate-sqlite-data.ts

# 5. Verify row counts match
# 6. Flip DATABASE_URL in .env, restart server
```

The `migrate-sqlite-data.ts` script (to be written at migration time) reads the
SQLite file, transforms `integer` booleans to proper booleans, parses JSON text
columns into objects, adds `org_id: 'default'` and `workspace_slug: 'default'`
to every row, and bulk-inserts into Postgres.

---

## Local dev: Docker Compose

`docker-compose.yml` (new file, project root):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: opencrew
      POSTGRES_PASSWORD: opencrew
      POSTGRES_DB: opencrew
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

`pnpm dev` documentation update: add `docker compose up -d postgres` as a
prerequisite step. SQLite was zero-setup; Postgres requires Docker. Tradeoff
is worth it given what we get.

---

## Production hosting options

| Option | Cost | Managed | PITR | Notes |
|---|---|---|---|---|
| **Neon** (serverless Postgres) | $0 free tier, $19/mo Pro | ✅ | ✅ | Autoscales to zero. Best for PLG early stage. |
| **Supabase** | $0 free, $25/mo Pro | ✅ | ✅ | Row-level security built in (useful for multi-tenant later). |
| **Railway** | ~$5/mo | ✅ | ✅ | Simplest deploy story, good DX. |
| **RDS (AWS)** | ~$30/mo minimum | ✅ | ✅ | Enterprise-grade, overkill for now. |
| **Self-hosted** | Server cost | ❌ | Manual | Not recommended — operational burden not worth it. |

**Recommendation:** Start on Neon. Free tier covers the first 100 users, $19/mo
covers the next 1,000. Easy to migrate to RDS later if enterprise compliance
requires it.

---

## Indexes to add for production query patterns

The existing SQLite indexes are preserved. New ones for multi-tenant queries:

```sql
-- Tenant isolation — every list query will filter by org_id
CREATE INDEX idx_messages_org ON messages (org_id, channel_id, created_at);
CREATE INDEX idx_runs_org ON runs (org_id, agent_id, created_at);
CREATE INDEX idx_run_costs_org_month ON run_costs (org_id, recorded_at DESC);

-- Workspace slug lookup (PLG URL routing)
CREATE UNIQUE INDEX idx_users_workspace_slug ON users (workspace_slug);
```

---

## Sequencing

This migration unblocks everything else. Suggested order once the CEO calls go:

1. **Day 1:** Swap schema + adapter, get `pnpm dev` working with Docker Postgres locally
2. **Day 1:** Add `org_id`, `workspace_slug`, `run_costs` table to schema
3. **Day 2:** Write and test `migrate-sqlite-data.ts`
4. **Day 2:** Provision Neon instance, run migration against it, verify data integrity
5. **Day 3:** Update deploy config, coordinate with @Coder on any ORM query changes
6. **Go:** Flip `DATABASE_URL` in production, keep SQLite backup for 7 days

@Lex — the `org_id` column lands in Step 1. The MSA Exhibit B commitment is
satisfiable from the moment this ships.

@Penny — the `run_costs` table lands in Step 1. Usage metering is queryable
from the first day of production Postgres.

@Nova — the `workspace_slug` unique index lands in Step 1. The `opencrew.run/{slug}`
routing is schema-ready from day one.
