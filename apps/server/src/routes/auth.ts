import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { AppContext } from '../context'
import { invites, users } from '../db/schema'
import { hashPassword, verifyPassword } from '../auth/passwords'
import { createSession, destroySession, SESSION_COOKIE } from '../auth/sessions'
import { adminGuard, authGuard, currentUser, fail, ok } from './helpers'

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

    const userCount = ctx.db.select().from(users).all().length
    let role: 'admin' | 'member' = 'member'
    let inviteId: string | null = null

    if (userCount === 0) {
      // Workspace bootstrap: the first user becomes admin, no invite needed.
      role = 'admin'
    } else {
      if (!inviteToken) return reply.code(403).send(fail('an invite is required'))
      const invite = ctx.db
        .select()
        .from(invites)
        .where(eq(invites.token, inviteToken))
        .get()
      if (!invite || invite.usedBy || invite.expiresAt < Date.now()) {
        return reply.code(403).send(fail('invite is invalid or expired'))
      }
      inviteId = invite.id
    }

    const existing = ctx.db.select().from(users).where(eq(users.email, email)).get()
    if (existing) return reply.code(409).send(fail('email already registered'))

    const user = {
      id: nanoid(),
      name,
      email,
      passwordHash: hashPassword(password),
      role,
      createdAt: Date.now()
    }
    ctx.db.insert(users).values(user).run()
    if (inviteId) {
      ctx.db.update(invites).set({ usedBy: user.id }).where(eq(invites.id, inviteId)).run()
    }

    const sessionId = createSession(ctx.db, user.id)
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOpts())
    return ok(publicUser(user))
  })

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const user = ctx.db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .get()
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send(fail('invalid email or password'))
    }
    const sessionId = createSession(ctx.db, user.id)
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOpts())
    return ok(publicUser(user))
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const cookies = req.cookies as Record<string, string | undefined>
    const sessionId = cookies[SESSION_COOKIE]
    if (sessionId) destroySession(ctx.db, sessionId)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return ok(null)
  })

  app.get('/api/auth/me', async (req, reply) => {
    const user = currentUser(ctx, req)
    const userCount = ctx.db.select().from(users).all().length
    if (!user) return reply.code(401).send(fail(userCount === 0 ? 'bootstrap' : 'unauthorized'))
    return ok(publicUser(user))
  })

  app.get('/api/users', { preHandler: authGuard(ctx) }, async () => {
    return ok(ctx.db.select().from(users).all().map(publicUser))
  })

  app.post('/api/invites', { preHandler: adminGuard(ctx) }, async (req) => {
    const invite = {
      id: nanoid(),
      token: nanoid(32),
      createdBy: req.user!.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + INVITE_TTL_MS
    }
    ctx.db.insert(invites).values(invite).run()
    return ok({ token: invite.token, path: `/invite/${invite.token}` })
  })

  app.get('/api/invites/:token', async (req, reply) => {
    const { token } = req.params as { token: string }
    const invite = ctx.db.select().from(invites).where(eq(invites.token, token)).get()
    if (!invite || invite.usedBy || invite.expiresAt < Date.now()) {
      return reply.code(404).send(fail('invite is invalid or expired'))
    }
    return ok({ valid: true })
  })
}

function cookieOpts() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    // TODO: set secure:true behind HTTPS in production deployments.
    maxAge: 30 * 24 * 60 * 60
  }
}
