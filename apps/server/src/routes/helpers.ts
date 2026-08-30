import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiResponse } from '@opencrew/shared'
import type { users } from '../db/schema'
import type { AppContext } from '../context'
import { getSessionUser, SESSION_COOKIE } from '../auth/sessions'
import { verifyRelayIdentity, resolveRelayUser } from '../services/cloudlink'

export type UserRow = typeof users.$inferSelect

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null
  }
}

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data }
}

export function fail(error: string): ApiResponse<never> {
  return { success: false, error }
}

export async function currentUser(
  ctx: AppContext,
  req: FastifyRequest
): Promise<UserRow | null> {
  // Cloud Link: requests forwarded by the opencrew.run relay carry a signed
  // identity header instead of a cookie. Verification requires the link
  // secret, so nothing outside the relay can mint one.
  const identity = await verifyRelayIdentity(ctx, req.headers)
  if (identity) return resolveRelayUser(ctx, identity)

  const cookies = (req as FastifyRequest & { cookies: Record<string, string> }).cookies
  return getSessionUser(ctx.db, cookies?.[SESSION_COOKIE])
}

export function authGuard(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await currentUser(ctx, req)
    if (!user) {
      return reply.code(401).send(fail('unauthorized'))
    }
    req.user = user
  }
}

export function adminGuard(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await currentUser(ctx, req)
    if (!user) {
      return reply.code(401).send(fail('unauthorized'))
    }
    if (user.role !== 'admin') {
      return reply.code(403).send(fail('admin only'))
    }
    req.user = user
  }
}

/** Allows admin and member; blocks guests (403). */
export function memberGuard(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await currentUser(ctx, req)
    if (!user) {
      return reply.code(401).send(fail('unauthorized'))
    }
    if (user.role === 'guest') {
      return reply.code(403).send(fail('guests cannot perform this action'))
    }
    req.user = user
  }
}
