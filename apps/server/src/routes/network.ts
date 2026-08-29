import { networkInterfaces } from 'node:os'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { tunnel } from '../services/tunnel'
import { adminGuard, authGuard, fail, ok } from './helpers'

function lanIps(): string[] {
  const ips: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        ips.push(entry.address)
      }
    }
  }
  return ips
}

/**
 * Device access: LAN addresses for same-network devices, and a Cloudflare
 * quick tunnel for access from anywhere. The client composes LAN URLs with
 * its own port; the tunnel URL is complete.
 */
export function registerNetworkRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/network', { preHandler: authGuard(ctx) }, async () => {
    return ok({ lanIps: lanIps(), tunnel: tunnel.current() })
  })

  app.post('/api/tunnel/start', { preHandler: adminGuard(ctx) }, async (_req, reply) => {
    try {
      return ok(await tunnel.start())
    } catch (err) {
      return reply
        .code(500)
        .send(fail(err instanceof Error ? err.message : 'tunnel failed to start'))
    }
  })

  app.post('/api/tunnel/stop', { preHandler: adminGuard(ctx) }, async () => {
    tunnel.stop()
    return ok(null)
  })
}
