import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { adminGuard, fail, ok } from './helpers'

const MAX_ENTRIES = 300

/**
 * Directory browser for the working-directory picker. Admin-only; OpenCrew
 * is self-hosted, so the admin is the machine's owner browsing their own
 * filesystem. Only directory NAMES are returned, never file contents.
 */
export function registerFsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/fs/dirs', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const { path } = req.query as { path?: string }
    const target = path && path.startsWith('/') ? path : homedir()

    let dirs: string[]
    try {
      dirs = readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_ENTRIES)
    } catch (err) {
      return reply
        .code(400)
        .send(fail(err instanceof Error ? err.message : 'cannot read directory'))
    }

    return ok({
      path: target,
      parent: target === '/' ? null : dirname(target),
      home: homedir(),
      dirs
    })
  })
}
