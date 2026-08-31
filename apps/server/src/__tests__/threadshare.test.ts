import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { nanoid } from 'nanoid'
import { channels, messages, threadShares, users } from '../db/schema'
import { setRawSetting } from '../services/settings'
import {
  getThreadShareState,
  NotCloudLinkedError,
  shareThread,
  unshareThread
} from '../services/threadshare'
import { makeTestCtx, type TestCtx } from './helpers'
import { eq } from 'drizzle-orm'

const RELAY_URL = 'https://relay.test'

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

function mockRelay(captured: CapturedRequest[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(
        JSON.stringify({ token: 'tok-123', url: `${RELAY_URL}/t/tok-123`, revoked: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
  )
}

describe('thread sharing', () => {
  let ctx: TestCtx
  let channelId: string
  let rootId: string
  let userId: string

  beforeEach(async () => {
    ctx = await makeTestCtx()
    userId = nanoid()
    channelId = nanoid()
    rootId = nanoid()
    const now = Date.now()

    await ctx.db.insert(users).values({
      id: userId,
      name: 'Anup',
      email: 'a@test.dev',
      passwordHash: 'x',
      role: 'admin',
      createdAt: now
    })
    await ctx.db.insert(channels).values({
      id: channelId,
      name: 'general',
      topic: '',
      isPrivate: false,
      createdAt: now
    })
    await ctx.db.insert(messages).values([
      {
        id: rootId,
        channelId,
        threadRootId: null,
        authorType: 'human',
        authorId: userId,
        content: '# Ship the landing page\nplease coordinate',
        createdAt: now
      },
      {
        id: nanoid(),
        channelId,
        threadRootId: rootId,
        authorType: 'system',
        authorId: null,
        content: 'run failed: boom',
        createdAt: now + 1
      },
      {
        id: nanoid(),
        channelId,
        threadRootId: rootId,
        authorType: 'human',
        authorId: userId,
        content: 'screenshot attached',
        images: JSON.stringify(['data:image/png;base64,AAAA']),
        createdAt: now + 2
      }
    ])

    await setRawSetting(ctx.db, 'cloudRelayUrl', RELAY_URL)
    await setRawSetting(ctx.db, 'cloudWorkspaceId', 'ws-1')
    await setRawSetting(ctx.db, 'cloudLinkSecret', 's'.repeat(32))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('throws NotCloudLinkedError when the crew is not linked', async () => {
    const unlinked = await makeTestCtx()
    await expect(shareThread(unlinked, rootId, userId)).rejects.toBeInstanceOf(
      NotCloudLinkedError
    )
  })

  test('pushes a sanitized snapshot and stores the share', async () => {
    const captured: CapturedRequest[] = []
    mockRelay(captured)

    const state = await shareThread(ctx, rootId, userId)
    expect(state.url).toBe(`${RELAY_URL}/t/tok-123`)

    expect(captured).toHaveLength(1)
    const body = captured[0]!.body as {
      title: string
      snapshot: { messages: { content: string; author: string }[] }
    }
    expect(body.title).toBe('Ship the landing page')
    const contents = body.snapshot.messages.map((m) => m.content)
    // System plumbing stays private; base64 images never leave the machine.
    expect(contents.some((c) => c.includes('run failed'))).toBe(false)
    expect(contents.some((c) => c.includes('base64'))).toBe(false)
    expect(contents.some((c) => c.includes('[image attached]'))).toBe(true)

    const stored = await getThreadShareState(ctx.db, rootId)
    expect(stored?.url).toBe(state.url)
  })

  test('re-share sends the stored token so the URL stays stable', async () => {
    const captured: CapturedRequest[] = []
    mockRelay(captured)

    await shareThread(ctx, rootId, userId)
    await shareThread(ctx, rootId, userId)

    expect(captured[0]!.body.token).toBeUndefined()
    expect(captured[1]!.body.token).toBe('tok-123')
    const rows = await ctx.db
      .select()
      .from(threadShares)
      .where(eq(threadShares.threadRootId, rootId))
    expect(rows).toHaveLength(1)
  })

  test('unshare revokes at the relay and deletes the local record', async () => {
    const captured: CapturedRequest[] = []
    mockRelay(captured)

    await shareThread(ctx, rootId, userId)
    await unshareThread(ctx, rootId)

    expect(captured.some((r) => r.url.endsWith('/thread-shares/revoke'))).toBe(true)
    expect(await getThreadShareState(ctx.db, rootId)).toBeNull()
  })

  test('unshare keeps the local record when the relay refuses', async () => {
    const captured: CapturedRequest[] = []
    mockRelay(captured)
    await shareThread(ctx, rootId, userId)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 }))
    )
    await expect(unshareThread(ctx, rootId)).rejects.toThrow()
    expect(await getThreadShareState(ctx.db, rootId)).not.toBeNull()
  })
})
