import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_ADMIN_EMAIL } from '../db/seed'
import { messages, users } from '../db/schema'
import { resolveRelayUser } from '../services/cloudlink'
import { makeTestCtx, type TestCtx } from './helpers'

describe('the owner through opencrew.run is the local admin', () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await makeTestCtx()
    await ctx.db.insert(users).values({
      id: 'admin',
      name: 'anup-singhai',
      email: SEED_ADMIN_EMAIL,
      passwordHash: 'local',
      role: 'admin',
      createdAt: Date.now()
    })
  })

  it('adopts the seeded admin: same user, real email, local password kept', async () => {
    const user = await resolveRelayUser(ctx, { email: 'anup@example.test', name: 'Anup Singh', owner: true })
    expect(user.id).toBe('admin')
    expect(user.name).toBe('anup-singhai')
    const [row] = await ctx.db.select().from(users).where(eq(users.id, 'admin'))
    expect(row!.email).toBe('anup@example.test')
    expect(row!.passwordHash).toBe('local')
    expect((await ctx.db.select().from(users)).length).toBe(1)
    // Second visit resolves by email — still one person.
    expect((await resolveRelayUser(ctx, { email: 'anup@example.test', name: 'Anup Singh', owner: true })).id).toBe('admin')
  })

  it('a duplicate owner made before the rule is folded into the admin, messages kept', async () => {
    await ctx.db.insert(users).values({ id: 'dup', name: 'Anup Singh', email: 'anup@example.test', passwordHash: 'relay$none', role: 'admin', createdAt: Date.now() })
    await ctx.db.insert(messages).values({ id: 'm1', channelId: 'c', authorId: 'dup', authorType: 'human', content: 'hi', createdAt: Date.now() })
    const user = await resolveRelayUser(ctx, { email: 'anup@example.test', name: 'Anup Singh', owner: true })
    expect(user.id).toBe('admin')
    expect((await ctx.db.select().from(users)).map((u) => u.id)).toEqual(['admin'])
    const [m] = await ctx.db.select().from(messages).where(eq(messages.id, 'm1'))
    expect(m!.authorId).toBe('admin')
  })

  it('a teammate is a new member, and an owner is not merged once the admin has a real email', async () => {
    const member = await resolveRelayUser(ctx, { email: `${nanoid(6)}@example.test`, name: 'Sam', owner: false })
    expect(member.role).toBe('member')
    expect(member.id).not.toBe('admin')
    await ctx.db.update(users).set({ email: 'real@example.test' }).where(eq(users.id, 'admin'))
    const other = await resolveRelayUser(ctx, { email: 'second-owner@example.test', name: 'Other', owner: true })
    expect(other.id).not.toBe('admin')
  })
})
