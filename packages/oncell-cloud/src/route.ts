/**
 * Fastify route: POST /api/cloud/provision
 *
 * Called by the web app after a user signs up. Provisions their opencrew
 * workspace on oncell.ai and returns the workspace URL.
 *
 * Add to the server:
 *   import { registerCloudProvisionRoute } from '@opencrew/oncell-cloud'
 *   registerCloudProvisionRoute(app, ctx)
 */

import type { FastifyInstance } from 'fastify'
import { OnCell } from '@oncell/sdk'
import { z } from 'zod'
import type { AppContext } from '../../../apps/server/src/context'
import { authGuard } from '../../../apps/server/src/routes/helpers'
import { provisionWorkspace, pauseWorkspace, workspaceStatus } from './provision'

const provisionSchema = z.object({
  anthropicApiKey: z.string().min(10, 'API key required'),
})

/**
 * Register oncell cloud routes on the Fastify instance.
 *
 * Environment vars required (set in .env or oncell project secrets):
 *   ONCELL_API_KEY           — oncell developer API key
 *   ONCELL_PROJECT_ID        — oncell project that owns model credentials
 *   ONCELL_GOLDEN_SNAPSHOT   — snapshot key of the pre-built opencrew golden image
 */
export function registerCloudProvisionRoute(app: FastifyInstance, ctx: AppContext): void {
  const oncellApiKey = process.env.ONCELL_API_KEY
  const projectId = process.env.ONCELL_PROJECT_ID
  const goldenSnapshotKey = process.env.ONCELL_GOLDEN_SNAPSHOT

  if (!oncellApiKey || !projectId || !goldenSnapshotKey) {
    console.warn(
      '[cloud] Skipping cloud provision routes: ONCELL_API_KEY / ONCELL_PROJECT_ID / ONCELL_GOLDEN_SNAPSHOT not set'
    )
    return
  }

  const oncell = new OnCell({ apiKey: oncellApiKey })

  /**
   * POST /api/cloud/provision
   *
   * Body: { anthropicApiKey: string }
   * Response: { workspaceUrl: string, agentId: string, status: "created" | "resumed" }
   */
  app.post('/api/cloud/provision', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const parsed = provisionSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.message })
    }

    // Use the authenticated user's ID as their workspace slug.
    const user = (req as any).user as { id: string; email: string }
    const userSlug = user.id

    try {
      const workspace = await provisionWorkspace(oncell, {
        projectId,
        goldenSnapshotKey,
        userSlug,
        anthropicApiKey: parsed.data.anthropicApiKey,
      })

      // Persist the agentId so we can manage this workspace later.
      // In production, store in a `cloud_workspaces` DB table.
      // For the spike: stash in the user's settings.
      await ctx.db
        .execute(
          `INSERT OR REPLACE INTO settings (key, value) VALUES ('cloud_agent_id_' || ?, ?)`,
          [userSlug, workspace.agentId]
        )
        .catch(() => {
          /* settings table may not have this key yet — fine for spike */
        })

      return reply.send({
        ok: true,
        workspaceUrl: workspace.previewUrl,
        agentId: workspace.agentId,
        status: workspace.status,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'provisioning failed'
      console.error('[cloud] provision error:', err)
      return reply.code(500).send({ ok: false, error: message })
    }
  })

  /**
   * GET /api/cloud/workspace
   *
   * Returns the current user's workspace status and URL.
   */
  app.get('/api/cloud/workspace', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const user = (req as any).user as { id: string }
    const userSlug = user.id

    // Look up stored agentId
    const row = await ctx.db
      .execute(`SELECT value FROM settings WHERE key = 'cloud_agent_id_' || ?`, [userSlug])
      .catch(() => null)

    const agentId = (row as any)?.[0]?.value as string | undefined

    if (!agentId) {
      return reply.code(404).send({ ok: false, error: 'No cloud workspace found. Call POST /api/cloud/provision first.' })
    }

    const status = await workspaceStatus(oncell, agentId)
    return reply.send({ ok: true, ...status })
  })

  /**
   * POST /api/cloud/workspace/pause
   *
   * Pauses the user's workspace cell (~$0 cost while paused).
   * Their data is preserved; next provision() resumes from snapshot.
   */
  app.post('/api/cloud/workspace/pause', { preHandler: authGuard(ctx) }, async (req, reply) => {
    const user = (req as any).user as { id: string }
    const userSlug = user.id

    const row = await ctx.db
      .execute(`SELECT value FROM settings WHERE key = 'cloud_agent_id_' || ?`, [userSlug])
      .catch(() => null)

    const agentId = (row as any)?.[0]?.value as string | undefined
    if (!agentId) {
      return reply.code(404).send({ ok: false, error: 'No cloud workspace found.' })
    }

    await pauseWorkspace(oncell, agentId)
    return reply.send({ ok: true, message: 'Workspace paused. Data preserved.' })
  })
}
