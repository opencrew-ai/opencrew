import { createHmac, timingSafeEqual } from 'node:crypto'
import WebSocket from 'ws'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import { users } from '../db/schema'
import { env } from '../env'
import { clearSetting, getRawSetting, setRawSetting } from './settings'

/**
 * Cloud Link — connects this OpenCrew instance to an opencrew.run profile.
 * The local server DIALS OUT (one persistent WSS); the relay forwards the
 * web app's HTTP + WS traffic back over it as frames. The same protocol will
 * later let a managed cell attach in place of a laptop.
 */

const KEYS = {
  relayUrl: 'cloudRelayUrl',
  workspaceId: 'cloudWorkspaceId',
  linkSecret: 'cloudLinkSecret',
  slug: 'cloudSlug'
} as const

const IDENTITY_MAX_SKEW_MS = 60_000
const HEARTBEAT_MS = 30_000
const RECONNECT_MAX_MS = 30_000

interface CloudState {
  socket: WebSocket | null
  connected: boolean
  stopping: boolean
  reconnectDelay: number
  streams: Map<string, WebSocket>
  pendingApproveUrl: string | null
}

const state: CloudState = {
  socket: null,
  connected: false,
  stopping: false,
  reconnectDelay: 1000,
  streams: new Map(),
  pendingApproveUrl: null
}

export async function cloudStatus(ctx: AppContext) {
  return {
    linked: Boolean(await getRawSetting(ctx.db, KEYS.linkSecret)),
    connected: state.connected,
    slug: await getRawSetting(ctx.db, KEYS.slug),
    relayUrl: (await getRawSetting(ctx.db, KEYS.relayUrl)) ?? env.relayUrl,
    pendingApproveUrl: state.pendingApproveUrl
  }
}

/**
 * When cloud-linked, fetch the crew's standing opencrew.run join URL —
 * the invite link that works from anywhere. Null when unlinked or offline.
 */
export async function ensureRelayInviteUrl(ctx: AppContext): Promise<string | null> {
  const [relayUrl, workspaceId, secret] = await Promise.all([
    getRawSetting(ctx.db, KEYS.relayUrl),
    getRawSetting(ctx.db, KEYS.workspaceId),
    getRawSetting(ctx.db, KEYS.linkSecret)
  ])
  if (!relayUrl || !workspaceId || !secret) return null
  try {
    const res = await fetch(`${relayUrl}/connector-api/share/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, secret })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { joinUrl?: string }
    return data.joinUrl ?? null
  } catch {
    return null
  }
}

/** Begin pairing: register a code with the relay and poll until approved. */
export async function startLinking(
  ctx: AppContext,
  instanceName: string
): Promise<{ approveUrl: string; code: string }> {
  const relayUrl = env.relayUrl
  const res = await fetch(`${relayUrl}/connector-api/link/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceName })
  })
  if (!res.ok) throw new Error(`relay rejected link start (${res.status})`)
  const { code, pollSecret, approveUrl } = (await res.json()) as {
    code: string
    pollSecret: string
    approveUrl: string
  }
  state.pendingApproveUrl = approveUrl

  const poll = async (): Promise<void> => {
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      try {
        const pollRes = await fetch(
          `${relayUrl}/connector-api/link/poll?code=${code}&pollSecret=${pollSecret}`
        )
        if (pollRes.status === 404) break // expired
        const data = (await pollRes.json()) as {
          status: string
          workspaceId?: string
          slug?: string
          linkSecret?: string
        }
        if (data.status === 'approved' && data.workspaceId && data.linkSecret) {
          await setRawSetting(ctx.db, KEYS.relayUrl, relayUrl)
          await setRawSetting(ctx.db, KEYS.workspaceId, data.workspaceId)
          await setRawSetting(ctx.db, KEYS.linkSecret, data.linkSecret)
          await setRawSetting(ctx.db, KEYS.slug, data.slug ?? '')
          state.pendingApproveUrl = null
          startCloudLink(ctx)
          return
        }
      } catch {
        // Relay briefly unreachable — keep polling.
      }
    }
    state.pendingApproveUrl = null
  }
  void poll()
  return { approveUrl, code }
}

export async function unlink(ctx: AppContext): Promise<void> {
  state.stopping = true
  state.socket?.close()
  state.socket = null
  state.connected = false
  await Promise.all(Object.values(KEYS).map((key) => clearSetting(ctx.db, key)))
  state.stopping = false
}

/** Connect (and keep connected) when link credentials exist. */
export function startCloudLink(ctx: AppContext): void {
  void (async () => {
    const relayUrl = await getRawSetting(ctx.db, KEYS.relayUrl)
    const workspaceId = await getRawSetting(ctx.db, KEYS.workspaceId)
    const secret = await getRawSetting(ctx.db, KEYS.linkSecret)
    if (!relayUrl || !workspaceId || !secret) return
    if (state.socket) return // already connecting/connected

    const wsUrl = relayUrl.replace(/^http/, 'ws') + '/connector-api/ws'
    const socket = new WebSocket(wsUrl)
    state.socket = socket
    let heartbeat: NodeJS.Timeout | null = null

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'auth', workspaceId, secret }))
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, HEARTBEAT_MS)
    })

    socket.on('message', (raw: Buffer) => {
      void handleFrame(ctx, socket, raw)
    })

    socket.on('close', () => {
      if (heartbeat) clearInterval(heartbeat)
      state.connected = false
      state.socket = null
      for (const stream of state.streams.values()) stream.close()
      state.streams.clear()
      if (!state.stopping) {
        setTimeout(() => startCloudLink(ctx), state.reconnectDelay)
        state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS)
      }
    })

    socket.on('error', () => {
      // close handler drives the reconnect.
    })
  })()
}

async function handleFrame(ctx: AppContext, socket: WebSocket, raw: Buffer): Promise<void> {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(raw.toString())
  } catch {
    return
  }

  switch (frame.type) {
    case 'ready':
      state.connected = true
      state.reconnectDelay = 1000
      console.log(`🛰  Cloud Link connected — crew "${frame.slug}" is live on opencrew.run`)
      break

    case 'http_request': {
      const { id, method, path, headers, body } = frame as {
        id: string
        method: string
        path: string
        headers: Record<string, string>
        body: string
      }
      try {
        const response = await fetch(`http://127.0.0.1:${env.port}${path}`, {
          method,
          headers,
          body:
            body && method !== 'GET' && method !== 'HEAD'
              ? Buffer.from(body, 'base64')
              : undefined
        })
        const payload = Buffer.from(await response.arrayBuffer())
        socket.send(
          JSON.stringify({
            type: 'http_response',
            id,
            status: response.status,
            headers: { 'content-type': response.headers.get('content-type') ?? '' },
            body: payload.toString('base64')
          })
        )
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: 'http_response',
            id,
            status: 502,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ success: false, error: String(err) })).toString(
              'base64'
            )
          })
        )
      }
      break
    }

    case 'ws_open': {
      const { streamId, path, headers } = frame as {
        streamId: string
        path: string
        headers: Record<string, string>
      }
      const local = new WebSocket(`ws://127.0.0.1:${env.port}${path}`, { headers })
      state.streams.set(streamId, local)
      local.on('message', (data: Buffer) => {
        socket.send(
          JSON.stringify({ type: 'ws_frame', streamId, data: data.toString('base64') })
        )
      })
      local.on('close', () => {
        if (state.streams.delete(streamId)) {
          socket.send(JSON.stringify({ type: 'ws_close', streamId }))
        }
      })
      local.on('error', () => local.close())
      break
    }

    case 'ws_frame': {
      const { streamId, data } = frame as { streamId: string; data: string }
      const local = state.streams.get(streamId)
      if (local?.readyState === WebSocket.OPEN) {
        local.send(Buffer.from(data, 'base64').toString())
      }
      break
    }

    case 'ws_close': {
      const { streamId } = frame as { streamId: string }
      const local = state.streams.get(streamId)
      if (local) {
        state.streams.delete(streamId)
        local.close()
      }
      break
    }
  }
}

// ---- identity bridge ------------------------------------------------------

export interface RelayIdentity {
  email: string
  name: string
  owner: boolean
}

/**
 * Verify the relay's signed identity header. Only forgeable with the link
 * secret, which exists solely on this machine and (in memory) at the relay.
 */
export async function verifyRelayIdentity(
  ctx: AppContext,
  headers: Record<string, string | string[] | undefined>
): Promise<RelayIdentity | null> {
  const payload = headers['x-opencrew-identity']
  const signature = headers['x-opencrew-signature']
  if (typeof payload !== 'string' || typeof signature !== 'string') return null
  const secret = await getRawSetting(ctx.db, KEYS.linkSecret)
  if (!secret) return null

  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  try {
    const identity = JSON.parse(Buffer.from(payload, 'base64').toString()) as {
      email?: string
      name?: string
      owner?: boolean
      ts?: number
    }
    if (!identity.email || !identity.ts) return null
    if (Math.abs(Date.now() - identity.ts) > IDENTITY_MAX_SKEW_MS) return null
    return {
      email: identity.email,
      name: identity.name ?? identity.email,
      owner: Boolean(identity.owner)
    }
  } catch {
    return null
  }
}

/** Map a relay identity onto a local user (created on first contact). */
export async function resolveRelayUser(ctx: AppContext, identity: RelayIdentity) {
  const [existing] = await ctx.db
    .select()
    .from(users)
    .where(eq(users.email, identity.email))
    .limit(1)
  if (existing) return existing
  const user = {
    id: nanoid(),
    name: identity.name,
    email: identity.email,
    // Cloud-linked users authenticate via the relay, never with a password.
    passwordHash: 'relay$none',
    role: identity.owner ? ('admin' as const) : ('member' as const),
    createdAt: Date.now()
  }
  await ctx.db.insert(users).values(user)
  return user
}
