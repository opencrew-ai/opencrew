import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { and, asc, eq, gte, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { diffVersions } from '@opencrew/shared'
import { env } from '../env'
import type { AppContext } from '../context'
import { agents, agentVersions, runs } from '../db/schema'
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
  watchesChannels: z.array(z.string()).default([]),
  workingDir: z
    .string()
    .max(500)
    .refine((p) => p === '' || p.startsWith('/'), 'must be an absolute path')
    .default(''),
  useSharedBrowserProfile: z.boolean().optional()
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

const COOKIE_COMPAT_FLAGS = ['--use-mock-keychain', '--password-store=basic', '--no-first-run']

function launchProfileBrowser(profileDir: string, url: string): void {
  const dataDirArg = `--user-data-dir=${profileDir}`
  if (process.platform === 'darwin') {
    spawn(
      'open',
      ['-na', 'Google Chrome', '--args', dataDirArg, ...COOKIE_COMPAT_FLAGS, url],
      { detached: true, stdio: 'ignore' }
    ).unref()
    return
  }
  const candidates = ['google-chrome', 'chromium', 'chromium-browser']
  const child = spawn(candidates[0]!, [dataDirArg, ...COOKIE_COMPAT_FLAGS, url], {
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', () => {
    const fallback = spawn(candidates[1]!, [dataDirArg, ...COOKIE_COMPAT_FLAGS, url], {
      detached: true,
      stdio: 'ignore'
    })
    fallback.on('error', () => {
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
    return ok(await listAgentsWithVersions(ctx.db))
  })

  /**
   * GET /api/agents/load
   * Returns per-agent load: idle | busy | rate_limited | paused
   * Used by Captain (and the load tool) before delegating work.
   */
  app.get('/api/agents/load', { preHandler: authGuard(ctx) }, async () => {
    const allAgents = await listAgentsWithVersions(ctx.db)
    const oneHourAgo = Date.now() - 60 * 60 * 1000

    // Active runs (queued + running + awaiting_approval) from DB
    const activeRows = await ctx.db
      .select({ agentId: runs.agentId, status: runs.status })
      .from(runs)
      .where(inArray(runs.status, ['queued', 'running', 'awaiting_approval']))

    const activeByAgent = new Map<string, number>()
    for (const r of activeRows) {
      activeByAgent.set(r.agentId, (activeByAgent.get(r.agentId) ?? 0) + 1)
    }

    // Runs in the last hour per agent (for rate limit check)
    const recentRows = await ctx.db
      .select({ agentId: runs.agentId })
      .from(runs)
      .where(gte(runs.createdAt, oneHourAgo))

    const recentByAgent = new Map<string, number>()
    for (const r of recentRows) {
      recentByAgent.set(r.agentId, (recentByAgent.get(r.agentId) ?? 0) + 1)
    }

    const load = allAgents.map((a) => {
      const activeRuns = activeByAgent.get(a.id) ?? 0
      const runsLastHour = recentByAgent.get(a.id) ?? 0
      const maxRunsPerHour = a.currentVersion.capabilities.maxRunsPerHour
      let status: 'idle' | 'busy' | 'rate_limited' | 'paused'
      if (a.status === 'paused') {
        status = 'paused'
      } else if (runsLastHour >= maxRunsPerHour) {
        status = 'rate_limited'
      } else if (activeRuns > 0) {
        status = 'busy'
      } else {
        status = 'idle'
      }
      return {
        agentId: a.id,
        name: a.name,
        emoji: a.avatarEmoji,
        status,
        activeRuns,
        runsLastHour,
        maxRunsPerHour
      }
    })

    return ok(load)
  })

  app.get('/api/tools', { preHandler: authGuard(ctx) }, async () => {
    return ok(toolCatalog())
  })

  app.get('/api/agents/:agentId', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const agent = await getAgentWithVersion(ctx.db, agentId)
    if (!agent) return reply.code(404).send(fail('agent not found'))
    return ok(agent)
  })

  app.post('/api/agents', { preHandler: adminGuard(ctx) }, async (req, reply) => {
    const parsed = createAgentSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
    const toolError = validateTools(parsed.data.config.tools)
    if (toolError) return reply.code(400).send(fail(toolError))

    const [existing] = await ctx.db
      .select()
      .from(agents)
      .where(eq(agents.name, parsed.data.name))
      .limit(1)
    if (existing) return reply.code(409).send(fail('agent name already exists'))

    const agentId = nanoid()
    await ctx.db.insert(agents).values({
      id: agentId,
      name: parsed.data.name,
      avatarEmoji: parsed.data.avatarEmoji,
      currentVersionId: 'pending',
      createdBy: req.user!.id,
      status: 'active',
      createdAt: Date.now()
    })
    await createVersion(ctx.db, agentId, parsed.data.config, req.user!.id, parsed.data.changeNote)

    const agent = (await getAgentWithVersion(ctx.db, agentId))!
    ctx.hub.broadcast({ type: 'agent_updated', agent })
    return ok(agent)
  })

  app.post(
    '/api/agents/:agentId/versions',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const parsed = updateVersionSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))
      const toolError = validateTools(parsed.data.config.tools)
      if (toolError) return reply.code(400).send(fail(toolError))
      if (!(await getAgentWithVersion(ctx.db, agentId))) {
        return reply.code(404).send(fail('agent not found'))
      }
      await createVersion(
        ctx.db,
        agentId,
        parsed.data.config,
        req.user!.id,
        parsed.data.changeNote
      )
      const agent = (await getAgentWithVersion(ctx.db, agentId))!
      ctx.hub.broadcast({ type: 'agent_updated', agent })
      return ok(agent)
    }
  )

  app.get(
    '/api/agents/:agentId/versions',
    { preHandler: authGuard(ctx) },
    async (req) => {
      const { agentId } = req.params as { agentId: string }
      const rows = await ctx.db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agentId))
        .orderBy(asc(agentVersions.version))
      return ok(rows.map(toAgentVersion))
    }
  )

  app.get('/api/agents/:agentId/diff', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const { from, to } = req.query as { from?: string; to?: string }
    if (!from || !to) return reply.code(400).send(fail('from and to version ids required'))
    const fromVersion = await getVersion(ctx.db, from)
    const toVersion = await getVersion(ctx.db, to)
    if (!fromVersion || !toVersion) return reply.code(404).send(fail('version not found'))
    return ok(diffVersions(fromVersion, toVersion))
  })

  app.post(
    '/api/agents/:agentId/rollback',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const { versionId } = (req.body ?? {}) as { versionId?: string }
      if (!versionId) return reply.code(400).send(fail('versionId required'))
      const target = await getVersion(ctx.db, versionId)
      if (!target || target.agentId !== agentId) {
        return reply.code(404).send(fail('version not found'))
      }
      await createVersion(
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
      const agent = (await getAgentWithVersion(ctx.db, agentId))!
      ctx.hub.broadcast({ type: 'agent_updated', agent })
      return ok(agent)
    }
  )

  app.post(
    '/api/agents/:agentId/browser',
    { preHandler: adminGuard(ctx) },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: string }
      const parsed = openBrowserSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send(fail(parsed.error.message))

      const agent = await getAgentWithVersion(ctx.db, agentId)
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
        note: 'Log in, then you can leave the window open — the agent takes over the profile when it runs.'
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
      await ctx.db.update(agents).set({ status }).where(eq(agents.id, agentId))
      const agent = await getAgentWithVersion(ctx.db, agentId)
      if (!agent) return reply.code(404).send(fail('agent not found'))
      ctx.hub.broadcast({ type: 'agent_updated', agent })
      return ok(agent)
    }
  )
}
