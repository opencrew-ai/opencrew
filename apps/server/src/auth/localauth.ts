import { asc, eq } from 'drizzle-orm'
import type { DB } from '../db'
import { users } from '../db/schema'

/**
 * Loopback trust: a browser on THIS machine is its owner. Anyone who can
 * reach 127.0.0.1 can already read the database file and the Claude login,
 * so a password adds ceremony, not security. Every other origin — a phone on
 * the LAN through the Vite proxy, a tunnel, the opencrew.run relay — still
 * signs in.
 *
 * The check is three-way so a proxy can't launder a remote client:
 *   1. the TCP peer is loopback;
 *   2. every X-Forwarded-For hop (the Vite dev proxy sets it — `xfwd`) is
 *      loopback too;
 *   3. the Host header names this machine (the proxy preserves it).
 */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

export interface RequestOrigin {
  remoteAddress: string | undefined
  forwardedFor: string | undefined
  host: string | undefined
  /** Carries an opencrew.run relay identity header — never a local browser. */
  viaRelay?: boolean
}

/**
 * Value the Cloud Link connector forces into X-Forwarded-For on every request
 * it replays into the local server: relay traffic arrives from loopback, and
 * a visitor's own headers pass through the relay — so the last hop, our
 * code, overwrites rather than trusts.
 */
export const RELAY_FORWARDED_FOR = 'cloud-link'

function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_ADDRESSES.has(address.trim())
}

/** `localhost:5173` → `localhost`; `[::1]:5173` → `::1`. */
function hostnameOf(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

export function isLoopbackOrigin(origin: RequestOrigin): boolean {
  if (origin.viaRelay) return false
  if (!origin.remoteAddress || !isLoopbackAddress(origin.remoteAddress)) return false
  if (origin.forwardedFor) {
    const hops = origin.forwardedFor.split(',')
    if (!hops.every(isLoopbackAddress)) return false
  }
  if (!origin.host) return false
  return LOCAL_HOSTNAMES.has(hostnameOf(origin.host).toLowerCase())
}

/**
 * The account a loopback browser becomes: the workspace's first admin with
 * a local password (relay-provisioned accounts have none — their identity
 * lives at opencrew.run).
 */
export async function findLocalAdmin(db: DB): Promise<typeof users.$inferSelect | null> {
  const admins = await db
    .select()
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.createdAt))
  return admins.find((u) => !u.passwordHash.startsWith('relay$')) ?? null
}
