import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { env } from '../env'
import { getAgentWithVersion } from '../services/agents'
import { authGuard, adminGuard, fail, ok } from './helpers'

const MAX_ENTRIES = 300
/** Hard cap on file size returned over the wire (512 KB). */
const MAX_FILE_BYTES = 512 * 1024

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

  /**
   * Read a file from an agent's working directory so the UI can display it
   * inline. Supply either:
   *   - agentId + path (relative or absolute): resolves relative paths against
   *     the agent's configured workingDir (or its private workspace dir).
   *   - path only (must be absolute): used when the caller already knows the
   *     full path.
   *
   * Security: relative paths are rejected if they would escape the base dir
   * (path-traversal guard). File size is capped at MAX_FILE_BYTES.
   * Auth: any logged-in member (not admin-only — devs need to browse files).
   */
  app.get('/api/fs/file', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { agentId, path: rawPath } = req.query as { agentId?: string; path?: string }

    if (!rawPath) {
      return reply.code(400).send(fail('path is required'))
    }

    let target: string

    if (isAbsolute(rawPath)) {
      // Absolute path — use as-is (self-hosted, user owns the machine)
      target = normalize(rawPath)
    } else if (agentId) {
      // Relative path — resolve against the agent's working directory
      const agent = await getAgentWithVersion(ctx.db, agentId)
      const configured = agent?.currentVersion.capabilities.workingDir?.trim()
      const baseDir =
        configured && configured.startsWith('/') && existsSync(configured)
          ? configured
          : join(env.workspacesDir, agentId)

      target = resolve(baseDir, rawPath)
      // Traverse guard: resolved path must stay inside the base dir
      if (!target.startsWith(baseDir + '/') && target !== baseDir) {
        return reply.code(400).send(fail('path traversal not allowed'))
      }
    } else {
      return reply
        .code(400)
        .send(fail('absolute path or agentId+relative-path required'))
    }

    let content: string
    try {
      const buf = readFileSync(target)
      if (buf.byteLength > MAX_FILE_BYTES) {
        return reply.code(413).send(fail(`file too large (max ${MAX_FILE_BYTES / 1024} KB)`))
      }
      content = buf.toString('utf8')
    } catch {
      return reply.code(404).send(fail('file not found or not readable'))
    }

    return ok({ path: target, content })
  })
}
