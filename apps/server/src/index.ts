import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyWebsocket from '@fastify/websocket'
import { env } from './env'
import { createDb } from './db'
import { seedIfEmpty, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } from './db/seed'
import { Hub } from './hub'
import { RunQueue, failInterruptedRuns, getRunAgentId } from './runs/queue'
import { executeRun } from './runs/executor'
import type { AppContext } from './context'
import { registerAuthRoutes } from './routes/auth'
import { registerChannelRoutes } from './routes/channels'
import { registerAgentRoutes } from './routes/agents'
import { registerRunRoutes } from './routes/runs'
import { registerFsRoutes } from './routes/fs'
import { registerSettingsRoutes } from './routes/settings'
import { registerNetworkRoutes } from './routes/network'
import { registerCloudLinkRoutes } from './routes/cloudlink'
import { registerSearchRoutes } from './routes/search'
import { registerWorkRoutes } from './routes/work'
import { registerReactionRoutes } from './routes/reactions'
import { registerStatsRoutes } from './routes/stats'
import { startCloudLink } from './services/cloudlink'
import { currentUser } from './routes/helpers'
import { broadcastPresence, computePresence } from './services/presence'
// Side-effect import: registers the OpenCrew MCP tool plugins.
import './tools'

async function main(): Promise<void> {
  const { db } = await createDb(env.databaseUrl)
  await failInterruptedRuns(db)
  const seeded = await seedIfEmpty(db)

  const hub = new Hub()
  const queue = new RunQueue()
  const ctx: AppContext = {
    db,
    hub,
    queue,
    approvalWaiters: new Map(),
    activeRuns: new Map(),
    agentLocks: new Map()
  }
  queue.configure(
    (runId) => executeRun(ctx, runId),
    (runId) => getRunAgentId(db, runId)
  )

  const app = Fastify({ logger: { level: 'warn' } })
  await app.register(fastifyCookie, { secret: env.sessionSecret })
  await app.register(fastifyWebsocket)

  registerAuthRoutes(app, ctx)
  registerChannelRoutes(app, ctx)
  registerAgentRoutes(app, ctx)
  registerRunRoutes(app, ctx)
  registerFsRoutes(app, ctx)
  registerSettingsRoutes(app, ctx)
  registerNetworkRoutes(app, ctx)
  registerCloudLinkRoutes(app, ctx)
  registerSearchRoutes(app, ctx)
  registerWorkRoutes(app, ctx)
  registerReactionRoutes(app, ctx)
  registerStatsRoutes(app, ctx)

  app.get('/api/health', async () => ({ ok: true }))

  app.register(async (scope) => {
    scope.get('/api/ws', { websocket: true }, async (socket, req) => {
      const user = await currentUser(ctx, req)
      if (!user) {
        socket.close(4001, 'unauthorized')
        return
      }
      hub.add(socket, user.id, user.role === 'admin')
      broadcastPresence(ctx)
      socket.send(JSON.stringify({ type: 'presence', entries: await computePresence(ctx) }))
      socket.on('message', (raw: Buffer) => {
        try {
          const event = JSON.parse(raw.toString())
          if (event.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
        } catch {
          // Ignore malformed frames.
        }
      })
      socket.on('close', () => {
        hub.remove(socket)
        broadcastPresence(ctx)
      })
    })
  })

  // Reconnect to opencrew.run if this instance is cloud-linked.
  startCloudLink(ctx)

  await app.listen({ port: env.port, host: '127.0.0.1' })
  console.log(`\n⚓ OpenCrew server on http://localhost:${env.port}`)
  console.log('   Agents run as local Claude Code sessions (uses your `claude` login or ANTHROPIC_API_KEY).')
  if (seeded) {
    console.log(`   Seeded workspace "OpenCrew HQ".`)
    console.log(`   Admin login: ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
