import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../env'
import type { DB } from '../db'
import { projects } from '../db/schema'
import { HQ_REPO_NAME } from './record'

/**
 * Projects survive the database. The database is a cache of what is going
 * on; the record lives in each project's repo. So the one thing worth keeping
 * outside the database is *which repos this machine has used as projects* —
 * a plain JSON file next to the data dir. A fresh database (reset, reinstall,
 * corruption) offers those back as "pick up where you left off" instead of
 * a blank "What are you building?".
 */
export interface KnownProject {
  name: string
  slug: string
  workingDir: string
  lastUsedAt: number
}

export function knownProjectsFile(): string {
  return env.projectsIndex
}

function readKnown(): KnownProject[] {
  const file = knownProjectsFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: KnownProject[] }
    return Array.isArray(parsed.projects) ? parsed.projects : []
  } catch {
    return []
  }
}

function writeKnown(list: KnownProject[]): void {
  const file = knownProjectsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ projects: list }, null, 2) + '\n')
}

/** Record (or refresh) a project this machine uses. Keyed by folder. */
export function rememberProject(project: Pick<KnownProject, 'name' | 'slug' | 'workingDir'>): void {
  const entry: KnownProject = { ...project, lastUsedAt: Date.now() }
  const others = readKnown().filter((p) => p.workingDir !== project.workingDir)
  writeKnown([entry, ...others])
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Projects known to this machine that the database does not have: the
 * remembered ones, plus repos OpenCrew keeps itself under data/repos (a
 * folderless project from before the index existed). Most recent first.
 */
export async function listResumableProjects(db: DB): Promise<KnownProject[]> {
  const inDb = new Set((await db.select({ workingDir: projects.workingDir }).from(projects)).map((p) => p.workingDir))
  const remembered = readKnown()
  const seen = new Set(remembered.map((p) => p.workingDir))

  const kept: KnownProject[] = existsSync(env.reposDir)
    ? readdirSync(env.reposDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== HQ_REPO_NAME)
        .map((d) => join(env.reposDir, d.name))
        .filter((dir) => !seen.has(dir) && existsSync(join(dir, '.git')))
        .map((dir) => ({ name: titleFromSlug(dir.slice(env.reposDir.length + 1)), slug: dir.slice(env.reposDir.length + 1), workingDir: dir, lastUsedAt: 0 }))
    : []

  return [...remembered, ...kept]
    .filter((p) => !inDb.has(p.workingDir) && existsSync(p.workingDir))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}
