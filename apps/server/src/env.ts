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
  dbPath: process.env.OPENCREW_DB ?? resolve(process.cwd(), '../../data/opencrew.sqlite'),
  /** Each agent gets its own working directory for its Claude Code sessions. */
  workspacesDir:
    process.env.OPENCREW_WORKSPACES ?? resolve(process.cwd(), '../../data/workspaces')
}
