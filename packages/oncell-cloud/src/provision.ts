/**
 * opencrew Cloud — oncell.ai provisioning layer.
 *
 * When a user signs up at opencrew.run, `provisionWorkspace()` creates their
 * personal isolated opencrew instance on oncell.ai. The entire opencrew server
 * runs as a cell service; the user's previewUrl IS their workspace.
 *
 * Architecture:
 *   1. We maintain a "golden" agent that has opencrew installed and seeded.
 *      Its latest snapshot is the template every new workspace forks from.
 *   2. On signup: fork golden → new agent → start service → return previewUrl.
 *   3. The service reads PORT from oncell's $PORT env var (opencrew already
 *      supports this via env.ts: `Number(process.env.PORT ?? 3001)`).
 *   4. The user's Anthropic API key goes into the cell's service env —
 *      the cell holds it, our server never touches it.
 *
 * Cost shape: ~$0 idle (oncell pauses sleeping cells), metered when active.
 */

import { OnCell, type OnCellError } from '@oncell/sdk'

export interface ProvisionOpts {
  /** The oncell project that holds model credentials. */
  projectId: string
  /** Snapshot key of the golden opencrew image to fork from. */
  goldenSnapshotKey: string
  /** Unique slug for this user's agent — used as the oncell agent name. */
  userSlug: string
  /** User's Anthropic API key — injected into the cell's service env. */
  anthropicApiKey: string
  /** Session secret for the opencrew instance (auto-generated if omitted). */
  sessionSecret?: string
}

export interface ProvisionedWorkspace {
  /** oncell agent ID — store this in your DB to manage the workspace later. */
  agentId: string
  /** The workspace URL — this is the user's opencrew instance. */
  previewUrl: string
  /** Whether we started a fresh instance or resumed an existing one. */
  status: 'created' | 'resumed'
}

/**
 * Provision (or resume) a user's opencrew workspace on oncell.ai.
 *
 * Idempotent: if the agent is already running, returns it. Safe to call
 * on login if you want to ensure the workspace is warm.
 */
export async function provisionWorkspace(
  oncell: OnCell,
  opts: ProvisionOpts
): Promise<ProvisionedWorkspace> {
  const agentName = `opencrew-user-${opts.userSlug}`

  // Check if this user's agent already exists.
  const existing = await findExistingAgent(oncell, agentName)

  let agentId: string
  let status: 'created' | 'resumed'

  if (existing) {
    agentId = existing.agentId
    status = 'resumed'
  } else {
    // Fork the golden snapshot → new isolated agent for this user.
    // fork() is atomic: clones code, files, and DB state while golden keeps running.
    const forked = await oncell.agents.fork(
      opts.goldenSnapshotKey,
      agentName
    )
    agentId = forked.id
    status = 'created'
  }

  // Start (or resume from snapshot) the agent cell.
  const cell = await oncell.agents.start({ agentId })

  // Start the opencrew server as the cell's one service.
  // The cell injects $PORT; opencrew reads it via `Number(process.env.PORT ?? 3001)`.
  // Services are idempotent: calling this on a running cell is a no-op.
  await oncell.agents.startService(agentId, {
    cmd: 'node dist/server.js',
    env: {
      ANTHROPIC_API_KEY: opts.anthropicApiKey,
      SESSION_SECRET: opts.sessionSecret ?? randomHex(32),
      // Tell opencrew it's running in managed cloud mode — disables local
      // tunnel, local FS tools, and approval prompts. Enables CloudLink for
      // @Coder jobs that need local machine access.
      OPENCREW_CLOUD_MODE: 'true',
      OPENCREW_WORKSPACE_SLUG: opts.userSlug,
    },
  })

  return {
    agentId,
    previewUrl: cell.previewUrl,
    status,
  }
}

/**
 * Pause a user's workspace (snapshot + end instance). Their data is preserved;
 * the next call to provisionWorkspace() resumes from the snapshot.
 * ~$0 cost while paused.
 */
export async function pauseWorkspace(oncell: OnCell, agentId: string): Promise<void> {
  await oncell.agents.pause(agentId)
}

/**
 * Permanently destroy a user's workspace. Removes the agent AND all snapshots.
 * No recovery path — use only on account deletion.
 */
export async function destroyWorkspace(oncell: OnCell, agentId: string): Promise<void> {
  await oncell.agents.destroy(agentId)
}

/**
 * Get the live status and URL of a user's workspace.
 */
export async function workspaceStatus(oncell: OnCell, agentId: string) {
  const cell = await oncell.agents.status(agentId)
  const service = await oncell.agents.getService(agentId).catch(() => null)
  return {
    cellStatus: cell.status,
    serviceRunning: service?.running ?? false,
    previewUrl: cell.previewUrl,
  }
}

// ─── Helpers ───

async function findExistingAgent(oncell: OnCell, name: string) {
  const agents = await oncell.agents.list()
  return agents.find((a) => a.name === name) ?? null
}

function randomHex(bytes: number): string {
  // crypto.randomBytes not available in all environments; use Math.random fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomBytes } = require('node:crypto') as typeof import('node:crypto')
    return randomBytes(bytes).toString('hex')
  } catch {
    return Array.from({ length: bytes * 2 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')
  }
}
