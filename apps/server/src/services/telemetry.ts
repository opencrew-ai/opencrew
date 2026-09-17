import { readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { DB } from '../db'
import { agents, projects, runs } from '../db/schema'
import type { AppContext } from '../context'
import { env } from '../env'
import { getRawSetting, getSettings, setRawSetting } from './settings'

/**
 * Anonymous heartbeat — how we know free installs exist and whether they
 * come back, without learning anything about what they do.
 *
 * Once a day (and shortly after boot) the server posts the payload below.
 * Every field is a count or a version string. There is no content, no repo
 * path, no prompt, no email, no hostname. The install id is a random string
 * minted once per database and stored in settings; it identifies an install
 * only to itself. Off with OPENCREW_TELEMETRY=0 or the Settings toggle.
 *
 * The reply carries the latest released version, which is what powers the
 * "update available" line in Settings — the one thing users get back.
 */

export interface Heartbeat {
  installId: string
  version: string
  os: string
  osRelease: string
  arch: string
  node: string
  harness: 'claude-code'
  projects: number
  standingAgents: number
  activeWorkers: number
  runs24h: number
  uptimeHours: number
}

const INSTALL_ID_KEY = 'installId'
const FIRST_SEND_MS = 20_000
const INTERVAL_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const startedAt = Date.now()
let latestVersion: string | null = null

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'dev'
  } catch {
    return 'dev'
  }
}

/** Latest version the ping endpoint reported, if any heartbeat has run. */
export function updateStatus(): { current: string; latest: string | null; updateAvailable: boolean } {
  const current = currentVersion()
  return {
    current,
    latest: latestVersion,
    updateAvailable: latestVersion !== null && latestVersion !== current
  }
}

export async function installId(db: DB): Promise<string> {
  const existing = await getRawSetting(db, INSTALL_ID_KEY)
  if (existing) return existing
  const id = nanoid()
  await setRawSetting(db, INSTALL_ID_KEY, id)
  return id
}

export async function telemetryEnabled(db: DB): Promise<boolean> {
  if (!env.telemetry) return false
  return (await getSettings(db)).telemetryEnabled
}

export async function buildHeartbeat(db: DB, now: number = Date.now()): Promise<Heartbeat> {
  const projectRows = await db.select({ id: projects.id }).from(projects)
  const agentRows = await db
    .select({ kind: agents.kind, status: agents.status })
    .from(agents)
    .where(isNull(agents.retiredAt))
  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(gt(runs.createdAt, now - DAY_MS), eq(runs.status, 'done')))
  return {
    installId: await installId(db),
    version: currentVersion(),
    os: platform(),
    osRelease: release(),
    arch: arch(),
    node: process.version,
    harness: 'claude-code',
    projects: projectRows.length,
    standingAgents: agentRows.filter((a) => a.kind !== 'worker' && a.status === 'active').length,
    activeWorkers: agentRows.filter((a) => a.kind === 'worker' && a.status === 'active').length,
    runs24h: runRows.length,
    uptimeHours: Math.round(((now - startedAt) / 3_600_000) * 10) / 10
  }
}

async function send(ctx: AppContext): Promise<void> {
  if (!(await telemetryEnabled(ctx.db))) return
  const body = await buildHeartbeat(ctx.db)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(env.telemetryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { latestVersion?: string } | null
      if (data && typeof data.latestVersion === 'string') latestVersion = data.latestVersion
    }
  } catch {
    // Offline or blocked: nothing to do, nothing to log. Next day retries.
  } finally {
    clearTimeout(timer)
  }
}

/** Schedule the heartbeat: once shortly after boot, then daily. Never blocks boot. */
export function startTelemetry(ctx: AppContext): void {
  if (!env.telemetry) return
  const first = setTimeout(() => void send(ctx), FIRST_SEND_MS)
  first.unref()
  const timer = setInterval(() => void send(ctx), INTERVAL_MS)
  timer.unref()
}
