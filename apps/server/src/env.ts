import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENV_PATH = resolve(process.cwd(), '../../.env')

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n')
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!
    }
  }
}

loadDotEnv()

// Zero-setup: generate a session secret on first boot so `pnpm dev` just works.
if (!process.env.SESSION_SECRET) {
  const secret = randomBytes(32).toString('hex')
  process.env.SESSION_SECRET = secret
  const line = `SESSION_SECRET=${secret}\n`
  if (existsSync(ENV_PATH)) {
    appendFileSync(ENV_PATH, line)
  } else {
    writeFileSync(ENV_PATH, line)
  }
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  sessionSecret: process.env.SESSION_SECRET,
  /**
   * Postgres connection URL, e.g. postgres://user:pass@localhost/opencrew.
   * Omit (or use a bare file path) to run with embedded PGlite — no Postgres
   * server needed for local dev. Full Postgres unlocks multiplayer isolation.
   */
  databaseUrl:
    process.env.DATABASE_URL ??
    resolve(process.cwd(), '../../data/opencrew.pgdata'),
  /** Deprecated: legacy SQLite path kept for the migration script only. */
  dbPath: process.env.OPENCREW_DB ?? resolve(process.cwd(), '../../data/opencrew.sqlite'),
  /**
   * Identifies this workspace in a shared Postgres cluster. Used as the
   * workspace_slug column value — each workspace's rows are tagged with this.
   * Defaults to 'default' for single-workspace installs.
   */
  workspaceSlug: process.env.OPENCREW_WORKSPACE_SLUG ?? 'default',
  /** Each agent gets its own working directory for its Claude Code sessions. */
  workspacesDir:
    process.env.OPENCREW_WORKSPACES ?? resolve(process.cwd(), '../../data/workspaces'),
  /**
   * Agent→agent mention chains stop at this depth (loop protection; rate
   * limits are the second line of defense). Raise for chattier crews.
   */
  maxMentionDepth: Number(process.env.OPENCREW_MAX_MENTION_DEPTH ?? 4),
  /**
   * Max concurrently executing agent turns. Turns are network-bound, so
   * width is cheap — raise this for throughput. A small slice is reserved
   * for human-triggered work so the workspace stays responsive at full load.
   */
  concurrency: Number(process.env.OPENCREW_CONCURRENCY ?? 8),
  /** Port the web app serves on — what LAN URLs and tunnels point at. */
  webPort: Number(process.env.OPENCREW_WEB_PORT ?? 5173),
  /**
   * Named Cloudflare tunnel (stable URL on your own domain, e.g.
   * https://hq.opencrew.run). Create it in Cloudflare Zero Trust pointed at
   * http://localhost:5173, then set both values. Unset = quick tunnel with
   * a random trycloudflare.com URL.
   */
  tunnelToken: process.env.OPENCREW_TUNNEL_TOKEN ?? '',
  tunnelUrl: process.env.OPENCREW_TUNNEL_URL ?? '',
  /** opencrew.run relay for Cloud Link (dev: http://localhost:4100). */
  relayUrl: (process.env.OPENCREW_RELAY_URL ?? 'https://relay.opencrew.run').replace(/\/$/, '')
}
