import { and, eq } from 'drizzle-orm'
import type { DB } from '../db'
import { effects } from '../db/schema'

/**
 * Effects ledger — exactly-once for side effects that must never happen
 * twice (a commit, a deploy). Keyed by kind + what it acted on; the stored
 * result (a sha, a URL) is what a retry returns instead of acting again.
 */

export async function alreadyPerformed(db: DB, kind: string, refId: string): Promise<string | null> {
  const [row] = await db
    .select({ result: effects.result })
    .from(effects)
    .where(and(eq(effects.kind, kind), eq(effects.refId, refId)))
    .limit(1)
  return row?.result ?? null
}

export async function recordEffect(db: DB, kind: string, refId: string, result: string): Promise<void> {
  await db
    .insert(effects)
    .values({ kind, refId, result, performedAt: Date.now() })
    .onConflictDoNothing()
}
