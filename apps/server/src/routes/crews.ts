/**
 * /api/crews – crew.json export/import and the badge SVG endpoint.
 *
 * GET  /badge.svg          – shields.io-style "built with opencrew" badge (public)
 * GET  /api/crews/export   – export current agents as a portable crew.json (auth required)
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { authGuard, ok } from './helpers'
import { listAgentsWithVersions } from '../services/agents'

// ---------------------------------------------------------------------------
// Badge SVG
// ---------------------------------------------------------------------------

const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="154" height="20" role="img" aria-label="built with: opencrew">
  <title>built with: opencrew</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0"  stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1"  stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="154" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="72"  height="20" fill="#555"/>
    <rect x="72" width="82" height="20" fill="#6366f1"/>
    <rect width="154" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="365" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="620" lengthAdjust="spacing">built with</text>
    <text x="365" y="140" transform="scale(.1)"             textLength="620" lengthAdjust="spacing">built with</text>
    <text x="1120" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="710" lengthAdjust="spacing">opencrew</text>
    <text x="1120" y="140" transform="scale(.1)"             textLength="710" lengthAdjust="spacing">opencrew</text>
  </g>
</svg>`

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCrewsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Public badge — no auth, no CORS restrictions
  app.get('/badge.svg', async (_req, reply) => {
    void reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=3600')
      .send(BADGE_SVG)
  })

  // Authenticated export — returns a portable crew.json
  app.get('/api/crews/export', { preHandler: authGuard(ctx) }, async () => {
    const agents = await listAgentsWithVersions(ctx.db)

    const crew = agents.map((a) => ({
      name: a.name,
      avatarEmoji: a.avatarEmoji,
      config: {
        systemPrompt: a.currentVersion.systemPrompt,
        model: a.currentVersion.model,
        skills: a.currentVersion.skills,
        tools: a.currentVersion.tools,
        capabilities: a.currentVersion.capabilities
      }
    }))

    return ok({
      version: '1',
      exportedAt: new Date().toISOString(),
      source: 'opencrew',
      crew
    })
  })
}
