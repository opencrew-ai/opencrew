import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { AppContext } from '../context'
import { invites, users } from '../db/schema'
import { hashPassword, verifyPassword } from '../auth/passwords'
import { createSession, destroySession, SESSION_COOKIE } from '../auth/sessions'
import { adminGuard, authGuard, currentUser, fail, ok } from './helpers'
import { ensureRelayInviteUrl } from '../services/cloudlink'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const signupSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  inviteToken: z.string().optional()
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
})

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, name: u.name, email: u.email, role: u.role }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/auth/signup', async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const { name, email, password, inviteToken } = parsed.data

    const userCount = (await ctx.db.select().from(users)).length
    let role: 'admin' | 'member' | 'guest' = 'member'
    let inviteId: string | null = null

    if (userCount === 0) {
      // Workspace bootstrap: the first user becomes admin, no invite needed.
      role = 'admin'
    } else {
      if (!inviteToken) return reply.code(403).send(fail('an invite is required'))
      const [invite] = await ctx.db
        .select()
        .from(invites)
        .where(eq(invites.token, inviteToken))
        .limit(1)
      if (!invite || invite.usedBy || invite.expiresAt < Date.now()) {
        return reply.code(403).send(fail('invite is invalid or expired'))
      }
      role = invite.role as 'member' | 'guest'
      inviteId = invite.id
    }

    const [existing] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (existing) return reply.code(409).send(fail('email already registered'))

    const user = {
      id: nanoid(),
      name,
      email,
      passwordHash: hashPassword(password),
      role,
      createdAt: Date.now()
    }
    await ctx.db.insert(users).values(user)
    if (inviteId) {
      await ctx.db.update(invites).set({ usedBy: user.id }).where(eq(invites.id, inviteId))
    }

    const sessionId = await createSession(ctx.db, user.id)
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOpts())
    return ok(publicUser(user))
  })

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const [user] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1)
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send(fail('invalid email or password'))
    }
    const sessionId = await createSession(ctx.db, user.id)
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOpts())
    return ok(publicUser(user))
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const cookies = req.cookies as Record<string, string | undefined>
    const sessionId = cookies[SESSION_COOKIE]
    if (sessionId) await destroySession(ctx.db, sessionId)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return ok(null)
  })

  app.get('/api/auth/me', async (req, reply) => {
    const user = await currentUser(ctx, req)
    const userCount = (await ctx.db.select().from(users)).length
    if (!user) return reply.code(401).send(fail(userCount === 0 ? 'bootstrap' : 'unauthorized'))
    return ok(publicUser(user))
  })

  app.get('/api/users', { preHandler: authGuard(ctx) }, async () => {
    return ok((await ctx.db.select().from(users)).map(publicUser))
  })

  app.post('/api/users/me', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    await ctx.db
      .update(users)
      .set({ name: parsed.data.name.trim() })
      .where(eq(users.id, req.user!.id))
    const [updated] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1)
    ctx.hub.broadcast({ type: 'user_updated', user: publicUser(updated!) })
    return ok(publicUser(updated!))
  })

  app.post('/api/invites', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const parsed = z
      .object({ role: z.enum(['member', 'guest']).default('member') })
      .safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const invite = {
      id: nanoid(),
      token: nanoid(32),
      role: parsed.data.role,
      createdBy: req.user!.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + INVITE_TTL_MS
    }
    await ctx.db.insert(invites).values(invite)
    // Cloud-linked crews also get the opencrew.run join link — the local
    // /invite path only works for people who can already reach this server.
    const relayJoinUrl = await ensureRelayInviteUrl(ctx)
    return ok({
      token: invite.token,
      role: invite.role,
      path: `/invite/${invite.token}`,
      relayJoinUrl
    })
  })

  app.get('/api/invites/:token', async (req, reply) => {
    const { token } = req.params as { token: string }
    const [invite] = await ctx.db
      .select()
      .from(invites)
      .where(eq(invites.token, token))
      .limit(1)
    if (!invite || invite.usedBy || invite.expiresAt < Date.now()) {
      return reply.code(404).send(fail('invite is invalid or expired'))
    }
    return ok({ valid: true, role: invite.role })
  })
}

function cookieOpts() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60
  }
}
