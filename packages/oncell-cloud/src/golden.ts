/**
 * Golden image management for opencrew Cloud.
 *
 * The "golden agent" is a pre-built, seeded oncell agent that serves as the
 * template for every new user workspace. Forking it takes ~2s vs. a fresh
 * install which takes ~60s+.
 *
 * Golden build process (run once, or on opencrew version bumps):
 *   1. Create the golden agent on oncell
 *   2. Install the opencrew server bundle into its cell
 *   3. Run the seed (creates default channels + agents in the DB)
 *   4. Snapshot it → pinned snapshot key stored as ONCELL_GOLDEN_SNAPSHOT_KEY
 *
 * Every new user gets: `fork(goldenSnapshotKey, userSlug)` → their workspace.
 */

import { OnCell } from '@oncell/sdk'

export interface BuildGoldenOpts {
  projectId: string
  /** Pre-built opencrew server dist bundle as a tar.gz, base64-encoded. */
  bundleBase64: string
}

/**
 * (Re)build the golden opencrew image on oncell.
 *
 * Run this whenever opencrew ships a new version. Returns the snapshot key
 * to store in ONCELL_GOLDEN_SNAPSHOT_KEY.
 *
 * NOTE: This is an ops/deploy script, not part of the hot path.
 */
export async function buildGoldenImage(
  oncell: OnCell,
  opts: BuildGoldenOpts
): Promise<string> {
  console.log('Creating golden agent...')
  const agent = await oncell.agents.create({
    name: `opencrew-golden-${Date.now()}`,
    projectId: opts.projectId,
    identity: {
      instructions: 'Golden opencrew image — template for user workspace forks.',
    },
    capabilities: ['workspace', 'shell', 'db'],
  })

  const agentId = agent.agentId
  console.log(`Golden agent created: ${agentId}`)

  // Start a cell to run setup commands.
  await oncell.agents.start({ agentId })
  console.log('Cell started — deploying bundle...')

  // Write the pre-built server bundle into the cell.
  // exec() has no network so we write files via the API then unpack locally.
  await oncell.agents.writeFile(agentId, '/app/server.tar.gz.b64', opts.bundleBase64)

  // Decode and unpack — exec has local filesystem access, just no network.
  await oncell.agents.exec(agentId, {
    cmd: 'mkdir -p /app/server && base64 -d /app/server.tar.gz.b64 | tar -xz -C /app/server',
    timeoutMs: 30_000,
  })

  // Run the seed (populates channels + default agents in the embedded DB).
  const seedResult = await oncell.agents.exec(agentId, {
    cmd: 'cd /app/server && node dist/seed.js',
    timeoutMs: 30_000,
    idempotencyKey: `seed-${agentId}`,
  })
  console.log('Seed result:', seedResult.stdout)

  // Snapshot the seeded state — this is the template every user forks from.
  console.log('Snapshotting golden state...')
  const snapshot = await oncell.agents.snapshot(agentId)
  console.log(`Golden snapshot: ${snapshot.snapshotKey}`)

  // Pause the golden cell — it's just a template, no need to keep it running.
  await oncell.agents.pause(agentId)

  return snapshot.snapshotKey
}

/**
 * Verify a golden snapshot is healthy by forking it, running a health check,
 * then destroying the test fork.
 */
export async function verifyGoldenSnapshot(
  oncell: OnCell,
  snapshotKey: string
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const testName = `opencrew-golden-verify-${Date.now()}`
  const t0 = Date.now()

  try {
    const fork = await oncell.agents.fork(snapshotKey, testName)
    await oncell.agents.start({ agentId: fork.id })

    // Start service and wait for it to bind
    await oncell.agents.startService(fork.id, {
      cmd: 'node dist/server.js',
      env: { OPENCREW_CLOUD_MODE: 'true' },
    })

    // Quick health check via the cell's preview URL
    const healthUrl = `https://${fork.id}.cells.oncell.ai/api/health`
    const res = await fetch(healthUrl)
    const latencyMs = Date.now() - t0
    const healthy = res.ok

    // Clean up the test fork
    await oncell.agents.destroy(fork.id)

    return { healthy, latencyMs }
  } catch (err) {
    await oncell.agents.destroy(testName).catch(() => {})
    return {
      healthy: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
