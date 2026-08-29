import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { asc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { diffVersions } from '@opencrew/shared'
import { env } from '../env'
import type { AppContext } from '../context'
import { agents, agentVersions } from '../db/schema'
import {
  createVersion,
  getAgentWithVersion,
  getVersion,
  listAgentsWithVersions,
  toAgentVersion
} from '../services/agents'
import { isKnownToolName, toolCatalog } from '../tools'
import { adminGuard, authGuard, fail, ok } from './helpers'

const capabilitiesSchema = z.object({
  canPostInChannels: z.array(z.string()),
  maxRunsPerHour: z.number().int().min(1).max(1000),
  requiresApprovalFor: z.array(z.string()),
  watchesChannels: z.array(z.string()).default([])
})

const configSchema = z.object({
  systemPrompt: z.string().min(1).max(50_000),
  model: z.string().min(1).default('claude-sonnet-4-6'),
  skills: z.array(z.string().max(80)).default([]),
  tools: z.array(z.string()).default([]),
  capabilities: capabilitiesSchema
})

const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9 _-]+$/, 'letters, numbers, spaces, dashes only'),
  avatarEmoji: z.string().min(1).max(8),
  config: configSchema,
  changeNote: z.string().max(500).default('initial version')
})

const updateVersionSchema = z.object({
  config: configSchema,
  changeNote: z.string().min(1).max(500)
})

const openBrowserSchema = z.object({
  url: z.string().url().startsWith('http').default('https://x.com')
})

function launchProfileBrowser(profileDir: string, url: string): void {
  const dataDirArg = `--user-data-dir=${profileDir}`
  if (process.platform === 'darwin') {
    spawn('open', ['-na', 'Google Chrome', '--args', dataDirArg, url], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    return
  }
  // Linux: try common Chrome binaries in order.
  const candidates = ['google-chrome', 'chromium', 'chromium-browser']
  const child = spawn(candidates[0]!, [dataDirArg, url], {
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', () => {
    const fallback = spawn(candidates[1]!, [dataDirArg, url], {
      detached: true,
      stdio: 'ignore'
    })
    fallback.on('error', () => {
      // Last resort logged server-side; the API response already succeeded.
      console.error('could not find a Chrome/Chromium binary to open the profile')
    })
    fallback.unref()
  })
  child.unref()
}

function validateTools(tools: string[]): string | null {
  const unknown = tools.filter((t) => !isKnownToolName(t))
  return unknown.length > 0 ? `unknown tools: ${unknown.join(', ')}` : null
}

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/agents', { preHandler: authGuard(ctx) }, async () => {
    return ok(listAgentsWithVersions(ctx.db))
  })

  app.get('/api/tools', { preHandler: authGuard(ctx) }, async () => {
    return ok(toolCatalog())
  })

  app.get('/api/agents/:agentId', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const agent = getAgentWithVersion(ctx.db, agentId)
    if (!agent) return reply.code(404).send(fail('agent not found'))
    return ok(agent)
  })

  app.post('/api/agents', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const parsed = createAgentSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const toolError = validateTools(parsed.data.config.tools)
    if (toolError) return reply.code(400).send(fail(toolError))

    const existing = ctx.db
      .select()
      .from(agents)
      .where(eq(agents.name, parsed.data.name))
      .get()
    if (existing) return reply.code(409).send(fail('agent name already exists'))

    const agentId = nanoid()
    ctx.db
      .insert(agents)
      .values({
        id: agentId,
        name: parsed.data.name,
        avatarEmoji: parsed.data.avatarEmoji,
        currentVersionId: 'pending',
        createdBy: req.user!.id,
        status: 'active',
        createdAt: Date.now()
      })
      .run()
    createVersion(ctx.db, agentId, parsed.data.config, req.user!.id, parsed.data.changeNote)

    const agent = getAgentWithVersion(ctx.db, agentId)!
    ctx.hub.broadcast({ type: 'agent_updated', agent })
    return ok(agent)
  })

  // Editing config = appending an immutable version. There is no PUT.
  app.post(
    '/api/agents/:agentId/versions',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const parsed = updateVersionSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      const toolError = validateTools(parsed.data.config.tools)
      if (toolError) return reply.code(400).send(fail(toolError))
      if (!getAgentWithVersion(ctx.db, agentId)) {
        return reply.code(404).send(fail('agent not found'))
      }
      createVersion(ctx.db, agentId, parsed.data.config, req.user!.id, parsed.data.changeNote)
      const agent = getAgentWithVersion(ctx.db, agentId)!
      ctx.hub.broadcast({ type: 'agent_updated', agent })
      return ok(agent)
    }
  )

  app.get(
    '/api/agents/:agentId/versions',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { agentId } = req.params as { agentId: string }
      const rows = ctx.db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agentId))
        .orderBy(asc(agentVersions.version))
        .all()
      return ok(rows.map(toAgentVersion))
    }
  )

  app.get('/api/agents/:agentId/diff', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { from, to } = req.query as { from?: string; to?: string }
    if (!from || !to) return reply.code(400).send(fail('from and to version ids required'))
    const fromVersion = getVersion(ctx.db, from)
    const toVersion = getVersion(ctx.db, to)
    if (!fromVersion || !toVersion) return reply.code(404).send(fail('version not found'))
    return ok(diffVersions(fromVersion, toVersion))
  })

  // Rollback = a NEW version copying the old config; history stays intact.
  app.post(
    '/api/agents/:agentId/rollback',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const { versionId } = (req.body ?? {}) as { versionId?: string }
      if (!versionId) return reply.code(400).send(fail('versionId required'))
      const target = getVersion(ctx.db, versionId)
      if (!target || target.agentId !== agentId) {
        return reply.code(404).send(fail('version not found'))
      }
      createVersion(
        ctx.db,
        agentId,
        {
          systemPrompt: target.systemPrompt,
          model: target.model,
          skills: target.skills,
          tools: target.tools,
          capabilities: target.capabilities
        },
        req.user!.id,
        `rollback to v${target.version}`
      )
      const agent = getAgentWithVersion(ctx.db, agentId)!
      ctx.hub.broadcast({ type: 'agent_updated', agent })
      return ok(agent)
    }
  )

  // Open the agent's persistent Chrome profile in a visible window so a
  // human can log into sites (e.g. x.com) on the agent's behalf. The same
  // profile is what Playwright drives during runs — log in once, it sticks.
  app.post(
    '/api/agents/:agentId/browser',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const parsed = openBrowserSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))

      const agent = getAgentWithVersion(ctx.db, agentId)
      if (!agent) return reply.code(404).send(fail('agent not found'))
      if (!agent.currentVersion.tools.includes('Browser')) {
        return reply.code(400).send(fail('this agent does not have the Browser tool'))
      }

      const profileDir = join(env.workspacesDir, agentId, '.browser-profile')
      mkdirSync(profileDir, { recursive: true })
      try {
        launchProfileBrowser(profileDir, parsed.data.url)
      } catch (err) {
        return reply
          .code(500)
          .send(fail(err instanceof Error ? err.message : 'failed to launch browser'))
      }
      return ok({
        opened: true,
        note: 'Log in, then close the window before the agent runs — Chrome locks the profile.'
      })
    }
  )

  app.post(
    '/api/agents/:agentId/status',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const { status } = (req.body ?? {}) as { status?: string }
      if (status !== 'active' && status !== 'paused') {
        return reply.code(400).send(fail('status must be active or paused'))
      }
      ctx.db.update(agents).set({ status }).where(eq(agents.id, agentId)).run()
      const agent = getAgentWithVersion(ctx.db, agentId)
      if (!agent) return reply.code(404).send(fail('agent not found'))
      ctx.hub.broadcast({ type: 'agent_updated', agent })
      return ok(agent)
    }
  )
}
