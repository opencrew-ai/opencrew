import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { env } from '../env'

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000

/**
 * The record — `.opencrew/` in the project repo.
 *
 * Everything the crew decides lands here as plain files, committed with git:
 * docs and plans the human approved, one line per decision, and the review
 * thread behind each commit as a git note. Nothing else is the memory: a
 * clone of the repo, opened with no OpenCrew installed, tells the whole
 * story. That is why every project has a repo — one is created when none is
 * given — and why HQ has one too.
 */

export const RECORD_DIR = '.opencrew'
export const DECISIONS_FILE = `${RECORD_DIR}/decisions.md`
const README_FILE = `${RECORD_DIR}/README.md`
export const HQ_REPO_NAME = 'hq'
/** How much of the record a prompt carries: enough to orient, never a dump. */
const RECORD_DOC_LIMIT = 30
const RECORD_DECISION_LIMIT = 15
const RECORD_COMMIT_LIMIT = 20

const README = `# Your crew's record

Everything OpenCrew decides lands here as plain files, committed with git:

- \`plans/\`, \`notes/\`, and any other folder — docs the crew proposed and you approved
- \`decisions.md\` — one line per approval, rejection, or change request
- \`git log --notes=opencrew\` — the review thread behind each commit

Nothing in this repo changes without your approval.
`

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

async function isRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false
  return git(dir, ['rev-parse', '--is-inside-work-tree'])
    .then((out) => out === 'true')
    .catch(() => false)
}

/** The root of the repo `dir` sits in, or null when it is not in one. */
async function repoTopLevel(dir: string): Promise<string | null> {
  return git(dir, ['rev-parse', '--show-toplevel'])
    .then((out) => realpathSync(out))
    .catch(() => null)
}

/**
 * A folder that lives inside a bigger repo is not that repo's problem to
 * carry — except when the "bigger repo" is the home directory or the disk
 * root (a stray `git init` in ~ happens), where a nested repo is exactly
 * right. Anywhere else, the person should point at the real root.
 */
function nestingAllowed(dir: string, topLevel: string): boolean {
  // Repos OpenCrew keeps itself sit under data/ inside the install clone,
  // which is a git repo too; they are always their own repos.
  if (dir.startsWith(realpathSync(env.reposDir) + '/')) return true
  const home = realpathSync(homedir())
  return topLevel === home || topLevel === '/' || topLevel === dirname(home)
}

async function hasHead(dir: string): Promise<boolean> {
  return git(dir, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false)
}

export interface EnsuredRepo {
  dir: string
  /** True when this call ran `git init` in a folder that was not a repo. */
  initialized: boolean
  /** True when the folder already held files that are not committed. */
  hadUntrackedFiles: boolean
}

/**
 * Make `dir` a git repo with a record in it. Idempotent. A folder that is
 * not a repo gets `git init`; a repo with no commits gets one commit holding
 * only `.opencrew/README.md` — never the owner's files, which stay theirs to
 * commit (a first commit that swallowed a node_modules would be a disaster).
 */
export async function ensureRepo(dir: string): Promise<EnsuredRepo> {
  mkdirSync(dir, { recursive: true })
  let initialized = false
  const topLevel = (await isRepo(dir)) ? await repoTopLevel(dir) : null
  const real = realpathSync(dir)
  const isOwnRepo = topLevel !== null && topLevel === real
  if (topLevel !== null && !isOwnRepo && !nestingAllowed(real, topLevel)) {
    throw new Error(
      `${dir} is inside the repo at ${topLevel} — point the project at ${topLevel}, or pick a folder outside it`
    )
  }
  if (!isOwnRepo) {
    // Not a repo, or only inside an accidental one (home): this folder gets
    // its own, so the record never lands in someone else's history.
    await git(dir, ['init', '-q', '-b', 'main'])
    initialized = true
  }
  const hadUntrackedFiles = readdirSync(dir).some((name) => name !== '.git' && name !== RECORD_DIR)
  if (!(await hasHead(dir))) {
    mkdirSync(join(dir, RECORD_DIR), { recursive: true })
    if (!existsSync(join(dir, README_FILE))) writeFileSync(join(dir, README_FILE), README)
    await git(dir, ['add', '--', README_FILE])
    await git(dir, [
      '-c',
      'user.name=OpenCrew',
      '-c',
      'user.email=crew@opencrew.local',
      'commit',
      '-q',
      '-m',
      'Start the record (.opencrew/)'
    ])
  }
  return { dir, initialized, hadUntrackedFiles }
}

/** Where a project's repo goes when the human gave no folder. */
export function defaultRepoDir(slug: string): string {
  return join(env.reposDir, slug)
}

/** HQ's record lives in a repo OpenCrew keeps for it. */
export function hqRepoDir(): string {
  return join(env.reposDir, HQ_REPO_NAME)
}

export async function ensureHqRepo(): Promise<string> {
  return (await ensureRepo(hqRepoDir())).dir
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'doc'
}

/** Repo-relative file for a doc: `.opencrew/<folder>/<slug>.md`. */
export function docPath(folder: string, title: string): string {
  const cleanFolder = folder
    .split('/')
    .map((s) => slugifyTitle(s))
    .filter((s) => s && s !== 'doc')
    .join('/')
  return `${RECORD_DIR}/${cleanFolder ? `${cleanFolder}/` : ''}${slugifyTitle(title)}.md`
}

/** Docs open with their title as an H1 so the file reads on its own. */
export function docFileContent(title: string, content: string): string {
  const body = content.replace(/^\s+/, '')
  const opensWithTitle = /^#\s/.test(body)
  return `${opensWithTitle ? '' : `# ${title}\n\n`}${body.replace(/\s+$/, '')}\n`
}

export type DecisionVerb = 'Approved' | 'Approved & committed' | 'Rejected' | 'Sent back' | 'Updated'

/** One line, one decision: date, what, who, where. */
export function decisionLine(input: {
  verb: DecisionVerb
  what: string
  version?: number
  by: string
  ref?: string
  note?: string
  at?: number
}): string {
  const date = new Date(input.at ?? Date.now()).toISOString().slice(0, 10)
  const version = input.version ? ` v${input.version}` : ''
  const ref = input.ref ? ` · ${input.ref}` : ''
  const note = input.note ? ` — ${input.note.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''
  return `- ${date} · ${input.verb} "${input.what}"${version} · ${input.by}${ref}${note}`
}

/** `decisions.md` with one more line; the file starts with a heading on first write. */
export function appendDecision(dir: string, line: string): string {
  const abs = join(dir, DECISIONS_FILE)
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const base = current.trim() ? current.replace(/\s+$/, '') : '# Decisions\n\nOne line per approval, rejection, or change request. Newest last.\n'
  return `${base}\n${line}\n`
}

export function readRecordFile(dir: string, relPath: string): string | null {
  const abs = join(dir, relPath)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

export interface RecordDoc {
  path: string
  title: string
  /** ISO date of the last commit touching it, or null when uncommitted. */
  date: string | null
}

function firstHeading(text: string): string | null {
  const match = text.match(/^#\s+(.+)$/m)
  return match ? match[1]!.trim() : null
}

function walkMarkdown(root: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(root, rel))) {
    const relPath = rel ? `${rel}/${name}` : name
    const abs = join(root, relPath)
    if (statSync(abs).isDirectory()) walkMarkdown(root, relPath, out)
    else if (name.endsWith('.md')) out.push(relPath)
  }
}

/** Every doc in the record (README and decisions excluded), newest first. */
export async function listRecordDocs(dir: string): Promise<RecordDoc[]> {
  const recordRoot = join(dir, RECORD_DIR)
  if (!existsSync(recordRoot)) return []
  const files: string[] = []
  walkMarkdown(dir, RECORD_DIR, files)
  const docs: RecordDoc[] = []
  for (const path of files) {
    if (path === README_FILE || path === DECISIONS_FILE) continue
    const text = readFileSync(join(dir, path), 'utf8')
    const date = await git(dir, ['log', '-1', '--format=%cs', '--', path]).catch(() => '')
    docs.push({ path, title: firstHeading(text) ?? path, date: date || null })
  }
  return docs.sort((a, b) => (b.date ?? '9999').localeCompare(a.date ?? '9999'))
}

/** The last N decisions, oldest first (they read like a log). */
export function recentDecisions(dir: string, limit = RECORD_DECISION_LIMIT): string[] {
  const text = readRecordFile(dir, DECISIONS_FILE) ?? ''
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .slice(-limit)
}

/** `git log` of the repo, short form, for consult answers that cite commits. */
export async function recentCommits(dir: string, limit = RECORD_COMMIT_LIMIT): Promise<string[]> {
  const out = await git(dir, ['log', `-${limit}`, '--format=%h %cs %s']).catch(() => '')
  return out ? out.split('\n') : []
}

/**
 * The prompt's view of the record: what docs exist (by path, so an agent
 * can cite `path@sha`), the latest decisions, and — for consults — recent
 * commits. Empty string when the repo has no record yet.
 */
export async function buildRecordSection(
  dir: string | null,
  opts: { commits?: boolean } = {}
): Promise<string> {
  if (!dir || !existsSync(join(dir, RECORD_DIR))) return ''
  const docs = (await listRecordDocs(dir)).slice(0, RECORD_DOC_LIMIT)
  const decisions = recentDecisions(dir)
  const commits = opts.commits ? await recentCommits(dir) : []
  const parts: string[] = []
  if (docs.length > 0) {
    parts.push(
      `Docs in the record (${RECORD_DIR}/, committed — read one with read_doc by its title):\n` +
        docs.map((d) => `- ${d.path} — "${d.title}"${d.date ? ` (${d.date})` : ''}`).join('\n')
    )
  }
  if (decisions.length > 0) {
    parts.push(`Latest decisions (${DECISIONS_FILE}):\n${decisions.join('\n')}`)
  }
  if (commits.length > 0) {
    parts.push(`Recent commits (cite as path@sha or sha):\n${commits.map((c) => `- ${c}`).join('\n')}`)
  }
  return parts.length > 0
    ? `\n\nTHE RECORD — the repo is the memory. ${parts.join('\n\n')}`
    : ''
}

/** True when `sha` is a commit in this repo (short or long). */
export async function commitExists(dir: string, sha: string): Promise<boolean> {
  return git(dir, ['cat-file', '-e', `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false)
}
