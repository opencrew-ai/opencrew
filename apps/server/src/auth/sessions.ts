import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { DB } from '../db'
import { sessions, users } from '../db/schema'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export const SESSION_COOKIE = 'oc_session'

export function createSession(db: DB, userId: string): string {
  const id = nanoid(32)
  const now = Date.now()
  db.insert(sessions)
    .values({ id, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS })
    .run()
  return id
}

export function getSessionUser(db: DB, sessionId: string | undefined) {
  if (!sessionId) return null
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!session || session.expiresAt < Date.now()) return null
  const user = db.select().from(users).where(eq(users.id, session.userId)).get()
  return user ?? null
}

export function destroySession(db: DB, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run()
}
