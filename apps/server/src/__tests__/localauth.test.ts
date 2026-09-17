import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import { nanoid } from 'nanoid'
import { findLocalAdmin, isLoopbackOrigin, RELAY_FORWARDED_FOR } from '../auth/localauth'
import { stampRelayHeaders } from '../services/cloudlink'
import { registerAuthRoutes } from '../routes/auth'
import { users } from '../db/schema'
import { makeTestCtx, seedUser } from './helpers'

describe('isLoopbackOrigin', () => {
  const local = { remoteAddress: '127.0.0.1', forwardedFor: undefined, host: 'localhost:5173' }

  it('accepts a direct loopback request naming this machine', () => {
    expect(isLoopbackOrigin(local)).toBe(true)
    expect(isLoopbackOrigin({ ...local, remoteAddress: '::1', host: '[::1]:5173' })).toBe(true)
    expect(isLoopbackOrigin({ ...local, remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1' })).toBe(true)
  })

  it('accepts the Vite proxy hop when the original client is loopback too', () => {
    expect(isLoopbackOrigin({ ...local, forwardedFor: '127.0.0.1' })).toBe(true)
    expect(isLoopbackOrigin({ ...local, forwardedFor: '::1, 127.0.0.1' })).toBe(true)
  })

  it('rejects a LAN client laundered through the loopback proxy', () => {
    expect(isLoopbackOrigin({ ...local, forwardedFor: '192.168.1.20' })).toBe(false)
    expect(isLoopbackOrigin({ ...local, forwardedFor: '127.0.0.1, 10.0.0.9' })).toBe(false)
  })

  it('rejects a request addressed to a non-local hostname', () => {
    expect(isLoopbackOrigin({ ...local, host: '192.168.1.10:5173' })).toBe(false)
    expect(isLoopbackOrigin({ ...local, host: 'hq.example.com' })).toBe(false)
    expect(isLoopbackOrigin({ ...local, host: undefined })).toBe(false)
  })

  it('rejects a non-loopback peer regardless of headers', () => {
    expect(isLoopbackOrigin({ ...local, remoteAddress: '10.0.0.4' })).toBe(false)
    expect(isLoopbackOrigin({ ...local, remoteAddress: undefined })).toBe(false)
  })

  it('rejects Cloud Link traffic even though the connector replays it from loopback', () => {
    expect(isLoopbackOrigin({ ...local, host: '127.0.0.1:3001', forwardedFor: RELAY_FORWARDED_FOR })).toBe(false)
    expect(isLoopbackOrigin({ ...local, viaRelay: true })).toBe(false)
  })
})

describe('stampRelayHeaders', () => {
  it('overwrites any forwarded-for a visitor smuggled through the relay', () => {
    const stamped = stampRelayHeaders({
      'X-Forwarded-For': '127.0.0.1',
      'x-forwarded-for': '::1',
      cookie: 'oc_session=abc',
      host: 'localhost:3001'
    })
    expect(stamped).toEqual({
      cookie: 'oc_session=abc',
      host: 'localhost:3001',
      'x-forwarded-for': RELAY_FORWARDED_FOR
    })
  })
})

describe('findLocalAdmin', () => {
  it('returns the earliest admin with a local password, skipping relay accounts', async () => {
    const ctx = await makeTestCtx()
    await ctx.db.insert(users).values([
      { id: 'relay', name: 'Cloud', email: 'c@x', passwordHash: 'relay$abc', role: 'admin', createdAt: 1 },
      { id: 'member', name: 'M', email: 'm@x', passwordHash: 'x', role: 'member', createdAt: 2 },
      { id: 'owner', name: 'Owner', email: 'o@x', passwordHash: 'x', role: 'admin', createdAt: 3 },
      { id: 'later', name: 'Later', email: 'l@x', passwordHash: 'x', role: 'admin', createdAt: 4 }
    ])
    expect((await findLocalAdmin(ctx.db))?.id).toBe('owner')
  })

  it('returns null when no local admin exists', async () => {
    const ctx = await makeTestCtx()
    expect(await findLocalAdmin(ctx.db)).toBeNull()
  })
})

describe('GET /api/auth/me on loopback', () => {
  async function makeApp() {
    const ctx = await makeTestCtx()
    const adminId = await seedUser(ctx.db)
    const app = Fastify()
    await app.register(fastifyCookie, { secret: nanoid() })
    registerAuthRoutes(app, ctx)
    return { app, adminId }
  }

  it('signs a local browser in as the admin and sets the session cookie', async () => {
    const { app, adminId } = await makeApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:5173', 'x-forwarded-for': '127.0.0.1' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.id).toBe(adminId)
    expect(res.cookies.some((c) => c.name === 'oc_session' && c.value.length > 0)).toBe(true)
  })

  it('still requires sign-in from another device', async () => {
    const { app } = await makeApp()
    const lan = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      remoteAddress: '127.0.0.1',
      headers: { host: '192.168.1.10:5173', 'x-forwarded-for': '192.168.1.20' }
    })
    expect(lan.statusCode).toBe(401)
    expect(lan.cookies).toHaveLength(0)
  })
})
