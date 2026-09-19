import { eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import type { DB } from '../db'
import { artifacts, channels, docShares } from '../db/schema'
import { getAgent } from './agents'
import { relayCredentials } from './threadshare'

/**
 * Share a committed doc over the internet: a frozen copy goes to the relay,
 * which hosts it at opencrew.run/t/:token — for anyone with the link, or
 * only for the emails listed (they sign in at opencrew.run to read it).
 * Re-sharing refreshes the same URL; the laptop can be off.
 */

const CONTENT_CAP = 280_000
const EMAILS_CAP = 50

export interface DocShareState {
  url: string
  allowedEmails: string[] | null
  updatedAt: number
}

function normalizeEmails(emails: string[] | undefined): string[] | null {
  const clean = [...new Set((emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
  return clean.length > 0 ? clean.slice(0, EMAILS_CAP) : null
}

function toState(row: typeof docShares.$inferSelect): DocShareState {
  return {
    url: row.url,
    allowedEmails: row.allowedEmails ? (JSON.parse(row.allowedEmails) as string[]) : null,
    updatedAt: row.updatedAt
  }
}

export async function getDocShareState(db: DB, artifactId: string): Promise<DocShareState | null> {
  const [row] = await db.select().from(docShares).where(eq(docShares.artifactId, artifactId)).limit(1)
  return row ? toState(row) : null
}

export async function shareDoc(
  ctx: AppContext,
  artifactId: string,
  userId: string,
  emails?: string[]
): Promise<DocShareState> {
  const { relayUrl, workspaceId, secret } = await relayCredentials(ctx.db)
  const [row] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!row) throw new Error('doc not found')
  if (row.status !== 'committed') throw new Error('only an approved doc can be shared')
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, row.channelId)).limit(1)
  const agent = await getAgent(ctx.db, row.createdByAgentId)
  const allowedEmails = normalizeEmails(emails)

  const [existing] = await ctx.db.select().from(docShares).where(eq(docShares.artifactId, artifactId)).limit(1)
  const content = row.content.length > CONTENT_CAP ? `${row.content.slice(0, CONTENT_CAP)}\n\n_…truncated_` : row.content
  const res = await fetch(`${relayUrl}/connector-api/thread-shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      secret,
      token: existing?.token,
      title: row.title.slice(0, 200),
      snapshot: {
        kind: 'doc',
        crewName: channel?.name ?? 'crew',
        title: row.title.slice(0, 200),
        content,
        author: agent?.name ?? 'OpenCrew agent',
        version: row.version,
        path: row.path ?? null,
        sha: row.sha ?? null
      },
      ...(allowedEmails ? { allowedEmails } : {})
    })
  })
  if (!res.ok) throw new Error(`relay rejected the share (${res.status})`)
  const { token, url } = (await res.json()) as { token: string; url: string }

  const now = Date.now()
  const allowedJson = allowedEmails ? JSON.stringify(allowedEmails) : null
  if (existing) {
    await ctx.db
      .update(docShares)
      .set({ token, url, allowedEmails: allowedJson, updatedAt: now })
      .where(eq(docShares.artifactId, artifactId))
  } else {
    await ctx.db.insert(docShares).values({
      artifactId,
      workspaceSlug: 'default',
      channelId: row.channelId,
      token,
      url,
      allowedEmails: allowedJson,
      sharedBy: userId,
      createdAt: now,
      updatedAt: now
    })
  }
  return { url, allowedEmails, updatedAt: now }
}

export async function unshareDoc(ctx: AppContext, artifactId: string): Promise<void> {
  const [existing] = await ctx.db.select().from(docShares).where(eq(docShares.artifactId, artifactId)).limit(1)
  if (!existing) return
  const { relayUrl, workspaceId, secret } = await relayCredentials(ctx.db)
  const res = await fetch(`${relayUrl}/connector-api/thread-shares/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, secret, token: existing.token })
  })
  // The page MUST come down when asked: keep the local record on failure so
  // the person can retry rather than see "not shared" while it is still up.
  if (!res.ok) throw new Error(`relay refused to revoke (${res.status})`)
  await ctx.db.delete(docShares).where(eq(docShares.artifactId, artifactId))
}
