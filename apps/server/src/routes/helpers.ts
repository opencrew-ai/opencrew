import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiResponse } from '@opencrew/shared'
import type { users } from '../db/schema'
import type { AppContext } from '../context'
import { getSessionUser, SESSION_COOKIE } from '../auth/sessions'

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

export function currentUser(ctx: AppContext, req: FastifyRequest): UserRow | null {
  const cookies = (req as FastifyRequest & { cookies: Record<string, string> }).cookies
  return getSessionUser(ctx.db, cookies?.[SESSION_COOKIE])
}

export function authGuard(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(ctx, req)
    if (!user) {
      return reply.code(401).send(fail('unauthorized'))
    }
    req.user = user
  }
}

export function adminGuard(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(ctx, req)
    if (!user) {
      return reply.code(401).send(fail('unauthorized'))
    }
    if (user.role !== 'admin') {
      return reply.code(403).send(fail('admin only'))
    }
    req.user = user
  }
}
