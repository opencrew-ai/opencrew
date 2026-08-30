import { eq } from 'drizzle-orm'
import type { DB } from '../db'
import { settings } from '../db/schema'
import { env } from '../env'

export interface WorkspaceSettings {
  /** How deep agent→agent @mention chains may go before stopping. */
  maxMentionDepth: number
}

/** Defaults come from env (which itself defaults sensibly). */
function defaults(): WorkspaceSettings {
  return { maxMentionDepth: env.maxMentionDepth }
}

export async function getSettings(db: DB): Promise<WorkspaceSettings> {
  const base = defaults()
  const rows = await db.select().from(settings)
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const depth = Number(byKey.get('maxMentionDepth'))
  return {
    maxMentionDepth: Number.isInteger(depth) && depth >= 1 ? depth : base.maxMentionDepth
  }
}

export async function setSetting(
  db: DB,
  key: keyof WorkspaceSettings,
  value: unknown
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: String(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(value), updatedAt: Date.now() }
    })
}

export async function getMaxMentionDepth(db: DB): Promise<number> {
  return (await getSettings(db)).maxMentionDepth
}

// Re-exported for tests that want to reset state.
export async function clearSetting(db: DB, key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key))
}

/** Untyped string settings (used by e.g. cloud-link credentials). */
export async function getRawSetting(db: DB, key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return row?.value ?? null
}

export async function setRawSetting(db: DB, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
}
