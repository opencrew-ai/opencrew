/**
 * One-shot migration: copy every row from the legacy SQLite database
 * (env.dbPath) into the PGlite/Postgres store (env.databaseUrl).
 *
 * Idempotent-ish: refuses to run if the target already has users, so it
 * cannot clobber a live workspace. Run with:
 *   npx tsx scripts/migrate-sqlite-to-pg.ts
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { env } from '../src/env'

const TABLES = [
  'users',
  'sessions',
  'channels',
  'memberships',
  'agents',
  'agent_versions',
  'messages',
  'runs',
  'run_steps',
  'approvals',
  'agent_sessions',
  'approval_rules',
  'settings',
  'invites'
] as const

const BOOLEAN_COLUMNS = new Set(['is_private'])
const BATCH_SIZE = 500

async function main(): Promise<void> {
  if (!existsSync(env.dbPath)) {
    throw new Error(`legacy sqlite db not found at ${env.dbPath}`)
  }

  const sqlite = new Database(env.dbPath, { readonly: true })

  const { PGlite } = await import('@electric-sql/pglite')
  const { mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  if (env.databaseUrl.startsWith('postgres://') || env.databaseUrl.startsWith('postgresql://')) {
    throw new Error('this script targets PGlite paths; use pg_dump tooling for real Postgres')
  }
  mkdirSync(dirname(env.databaseUrl), { recursive: true })
  const pg = new PGlite(env.databaseUrl)

  // Let the app's own factory create the schema, then reuse the connection.
  // createDb would open its own PGlite handle on the same dir — instead run
  // the DDL through this handle by importing it from the db module.
  const dbModule = await import('../src/db/index')
  type DdlModule = { DDL?: string; MIGRATIONS?: string }
  const { DDL, MIGRATIONS } = dbModule as unknown as DdlModule
  if (DDL) await pg.exec(DDL)
  if (MIGRATIONS) await pg.exec(MIGRATIONS)

  const existing = await pg.query<{ count: string }>('SELECT count(*)::text AS count FROM users')
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    throw new Error('target database already has users — refusing to overwrite')
  }

  for (const table of TABLES) {
    const tableExists = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table)
    if (!tableExists) {
      console.log(`skip ${table} (absent in sqlite)`)
      continue
    }

    const pgCols = await pg.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      [table]
    )
    const pgColSet = new Set(pgCols.rows.map((r) => r.column_name))
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
    if (rows.length === 0) {
      console.log(`copy ${table}: 0 rows`)
      continue
    }

    const cols = Object.keys(rows[0]!).filter((c) => pgColSet.has(c))
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const insertSql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`

    let copied = 0
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE)
      for (const row of batch) {
        const values = cols.map((c) =>
          BOOLEAN_COLUMNS.has(c) ? Boolean(row[c]) : (row[c] ?? null)
        )
        await pg.query(insertSql, values)
        copied += 1
      }
    }
    console.log(`copy ${table}: ${copied} rows`)
  }

  await pg.close()
  sqlite.close()
  console.log('migration complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
