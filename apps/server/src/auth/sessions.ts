import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { DB } from '../db'
import { sessions, users } from '../db/schema'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export const SESSION_COOKIE = 'oc_session'

export async function createSession(db: DB, userId: string): Promise<string> {
  const id = nanoid(32)
  const now = Date.now()
  await db.insert(sessions).values({ id, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS })
  return id
}

export async function getSessionUser(
  db: DB,
  sessionId: string | undefined
): Promise<typeof users.$inferSelect | null> {
  if (!sessionId) return null
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  if (!session || session.expiresAt < Date.now()) return null
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1)
  return user ?? null
}

export async function destroySession(db: DB, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
