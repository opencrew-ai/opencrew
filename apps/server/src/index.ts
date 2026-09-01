import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyWebsocket from '@fastify/websocket'
import { sql } from 'drizzle-orm'
import { env } from './env'
import { createDb } from './db'
import { seedIfEmpty, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } from './db/seed'
import { Hub } from './hub'
import { FabricRuntime } from './fabric/runtime'
import { executeTurn } from './runs/executor'
import { fabricHooksFor } from './runs/glue'
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
import { registerArtifactRoutes } from './routes/artifacts'
import { registerAttentionRoutes } from './routes/attention'
import { ensureBuiltinReviewers } from './services/artifacts'
import { startTaskScheduler } from './services/scheduler'
import { registerReactionRoutes } from './routes/reactions'
import { registerThreadReadRoutes } from './routes/threadreads'
import { registerStatsRoutes } from './routes/stats'
import { registerThreadShareRoutes } from './routes/threadshare'
import { registerCrewsRoutes } from './routes/crews'
import { registerExportRoutes } from './routes/export'
import { startCloudLink } from './services/cloudlink'
import { currentUser } from './routes/helpers'
import { broadcastPresence, computePresence } from './services/presence'
// Side-effect import: registers the OpenCrew MCP tool plugins.
import './tools'

/**
 * Refuse to start when another server owns the port — BEFORE opening the
 * database. PGlite is single-process: a doomed second instance that opens
 * the data dir and then dies on EADDRINUSE can corrupt it.
 */
async function assertPortFree(port: number): Promise<void> {
  const net = await import('node:net')
  await new Promise<void>((resolvePort, rejectPort) => {
    const probe = net
      .createServer()
      .once('error', (err) => rejectPort(err))
      .once('listening', () => probe.close(() => resolvePort()))
    probe.listen(port, '127.0.0.1')
  }).catch(() => {
    console.error(
      `⚓ OpenCrew server already running on port ${env.port} — this instance is exiting.`
    )
    process.exit(0)
  })
}

async function main(): Promise<void> {
  await assertPortFree(env.port)
  const { db } = await createDb(env.databaseUrl)
  const seeded = await seedIfEmpty(db)

  // Pre-fabric installs may have non-terminal runs with no fabric task —
  // nothing will ever execute those; close them out honestly. One-time
  // upgrade reconcile; crash recovery itself is the fabric reaper.
  await db.execute(sql`
    UPDATE runs SET status = 'failed', error = 'server upgraded — re-mention the agent',
      finished_at = ${Date.now()}
    WHERE status IN ('queued', 'running', 'awaiting_approval')
      AND id NOT IN (SELECT id FROM fabric_tasks)
  `)

  const hub = new Hub()
  const fabric = new FabricRuntime(db, {
    capacity: env.concurrency,
    interactiveReserve: Math.min(2, env.concurrency - 1),
    workerId: `local-${process.pid}`
  })
  const ctx: AppContext = { db, hub, fabric }
  fabric.registerExecutor('turn', (task, handle) => executeTurn(ctx, task, handle))
  fabric.setHooks(fabricHooksFor(ctx))

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
  registerArtifactRoutes(app, ctx)
  registerAttentionRoutes(app, ctx)
  registerReactionRoutes(app, ctx)
  registerStatsRoutes(app, ctx)
  registerThreadShareRoutes(app, ctx)
  registerThreadReadRoutes(app, ctx)

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
  await ensureBuiltinReviewers(ctx)
  startTaskScheduler(ctx)
  // The fabric's first resync reaps any leases a dead process left behind —
  // interrupted work redelivers and sessions resume where they left off.
  fabric.start()
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
