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

export function getSettings(db: DB): WorkspaceSettings {
  const base = defaults()
  const rows = db.select().from(settings).all()
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const depth = Number(byKey.get('maxMentionDepth'))
  return {
    maxMentionDepth: Number.isInteger(depth) && depth >= 1 ? depth : base.maxMentionDepth
  }
}

export function setSetting(db: DB, key: keyof WorkspaceSettings, value: unknown): void {
  db.insert(settings)
    .values({ key, value: String(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(value), updatedAt: Date.now() }
    })
    .run()
}

export function getMaxMentionDepth(db: DB): number {
  return getSettings(db).maxMentionDepth
}

// Re-exported for tests that want to reset state.
export function clearSetting(db: DB, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run()
}

/** Untyped string settings (used by e.g. cloud-link credentials). */
export function getRawSetting(db: DB, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  return row?.value ?? null
}

export function setRawSetting(db: DB, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run()
}
