import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { asc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Project } from '@opencrew/shared'
import type { DB } from '../db'
import { environments } from '../db/schema'
import { env } from '../env'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 60_000

/**
 * Environments — isolation is the environment, not the workspace.
 *
 * Every agent that works in a project repo gets its OWN checkout: a git
 * worktree of the project's repo under data/envs/<project>/<agent>, plus a
 * reserved port for whatever dev server it starts (exported as PORT and
 * OPENCREW_ENV_PORT into its sessions). Two agents never edit the same
 * files, never fight over one dev server, and the human's checkout is
 * never touched by an agent — changes reach it only as a reviewed patch
 * committed on approval (services/changes.ts).
 *
 * Databases are not forked here: apps differ too much for a generic fork.
 * An environment is told where it lives and which port is its own; an
 * agent that needs isolated data copies its project's dev database into
 * its worktree like any developer would.
 */

export interface Environment {
  id: string
  projectId: string
  agentId: string
  path: string
  port: number
}

function toEnvironment(row: Omit<typeof environments.$inferSelect, 'workspaceSlug'>): Environment {
  return { id: row.id, projectId: row.projectId, agentId: row.agentId, path: row.path, port: row.port }
}

export function environmentsRoot(): string {
  return env.envsDir
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false
  return git(dir, ['rev-parse', '--is-inside-work-tree'])
    .then((out) => out === 'true')
    .catch(() => false)
}

/** The project repo's current HEAD, or null before the first commit. */
export async function projectHead(projectDir: string): Promise<string | null> {
  return git(projectDir, ['rev-parse', '--verify', 'HEAD']).catch(() => null)
}

async function nextPort(db: DB): Promise<number> {
  const rows = await db.select({ port: environments.port }).from(environments).orderBy(asc(environments.port))
  const taken = new Set(rows.map((r) => r.port))
  for (let port = env.envPortBase; port < env.envPortBase + 10_000; port++) {
    if (!taken.has(port)) return port
  }
  throw new Error('no free environment ports')
}

export async function getEnvironmentForAgent(db: DB, agentId: string): Promise<Environment | null> {
  const [row] = await db.select().from(environments).where(eq(environments.agentId, agentId)).limit(1)
  return row ? toEnvironment(row) : null
}

/**
 * The agent's environment in this project, created on first use: a detached
 * worktree at the project's HEAD. Idempotent; heals a worktree whose
 * directory vanished.
 */
export async function ensureEnvironment(
  db: DB,
  project: Project,
  agentId: string
): Promise<Environment> {
  const projectDir = project.workingDir
  const existing = await getEnvironmentForAgent(db, agentId)
  if (existing && existing.projectId === project.id && existsSync(join(existing.path, '.git'))) {
    return existing
  }
  if (existing) {
    // Project moved or the worktree was deleted by hand — start clean.
    await removeWorktree(projectDir, existing.path)
    await db.delete(environments).where(eq(environments.id, existing.id))
  }

  const path = join(environmentsRoot(), project.slug, agentId)
  mkdirSync(join(environmentsRoot(), project.slug), { recursive: true })
  const head = await projectHead(projectDir)
  if (head) {
    await git(projectDir, ['worktree', 'add', '--detach', path, head])
  } else {
    // A repo with no commits yet: nothing to check out, so a plain folder
    // the agent can initialise; propose_change captures its diff all the same.
    mkdirSync(path, { recursive: true })
    await git(path, ['init', '-q'])
  }
  const row = {
    id: nanoid(),
    projectId: project.id,
    agentId,
    path,
    port: await nextPort(db),
    createdAt: Date.now()
  }
  await db.insert(environments).values(row)
  return toEnvironment(row)
}

/**
 * Before a turn: bring a CLEAN worktree up to the project's HEAD so the
 * agent builds on what was last approved. A dirty worktree (work in
 * progress from earlier turns) is left alone — the agent keeps going, and
 * its next propose_change diffs against the base it started from.
 */
export async function syncEnvironment(projectDir: string, environment: Environment): Promise<void> {
  const head = await projectHead(projectDir)
  if (!head) return
  const dirty = await git(environment.path, ['status', '--porcelain']).catch(() => 'unknown')
  if (dirty !== '') return
  const at = await git(environment.path, ['rev-parse', 'HEAD']).catch(() => '')
  if (at === head) return
  await git(environment.path, ['checkout', '-q', '--detach', head]).catch(() => {
    // A worktree that can't move stays where it is; the agent still works.
  })
}

export async function removeWorktree(projectDir: string, path: string): Promise<void> {
  if (existsSync(projectDir)) {
    await git(projectDir, ['worktree', 'remove', '--force', path]).catch(() => {})
    await git(projectDir, ['worktree', 'prune']).catch(() => {})
  }
  rmSync(path, { recursive: true, force: true })
}

/** Retiring a worker frees its checkout and port. */
export async function destroyEnvironment(db: DB, agentId: string, projectDir: string): Promise<void> {
  const existing = await getEnvironmentForAgent(db, agentId)
  if (!existing) return
  await removeWorktree(projectDir, existing.path)
  await db.delete(environments).where(eq(environments.id, existing.id))
}

export interface ResolvedWorkingDir {
  path: string
  /** Set when the agent works in a worktree of the project repo. */
  environment: Environment | null
}

/**
 * Where an agent works, in precedence order:
 *  1. its own environment — a worktree of the project repo (when the project
 *     has a git repo);
 *  2. the agent's configured absolute directory (legacy per-agent repos);
 *  3. its private scratch workspace.
 * `syncEnvironment` is left to the executor so it happens once per turn.
 */
/** Tools that touch files or run things — the only reason an agent needs a checkout. */
const REPO_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Chrome', 'Browser'])

export function needsRepo(tools: string[]): boolean {
  return tools.some((t) => REPO_TOOLS.has(t))
}

export async function resolveAgentWorkingDir(
  db: DB,
  project: Project | null,
  agentId: string,
  agentWorkingDir: string | undefined,
  tools: string[] = []
): Promise<ResolvedWorkingDir> {
  const projectDir = project?.workingDir.trim() ?? ''
  // Orchestrators and pure talkers (Captain, reviewers) get no worktree —
  // a checkout per agent is for agents that edit or run code.
  if (project && needsRepo(tools) && projectDir.startsWith('/') && (await isGitRepo(projectDir))) {
    const environment = await ensureEnvironment(db, project, agentId)
    return { path: environment.path, environment }
  }
  const configured = agentWorkingDir?.trim() ?? ''
  if (configured.startsWith('/') && existsSync(configured)) {
    return { path: configured, environment: null }
  }
  const scratch = join(env.workspacesDir, agentId)
  mkdirSync(scratch, { recursive: true })
  return { path: scratch, environment: null }
}

/** Env vars an agent session gets so it knows where it lives. */
export function environmentEnv(environment: Environment): Record<string, string> {
  return {
    PORT: String(environment.port),
    OPENCREW_ENV_PORT: String(environment.port),
    OPENCREW_ENV_DIR: environment.path
  }
}
