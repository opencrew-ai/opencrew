import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 10 * 1024 * 1024
/** Diffs beyond this are truncated in the artifact (the commit is unaffected). */
const DIFF_CHAR_LIMIT = 60_000

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: dir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER
  })
  return stdout
}

/**
 * Stage everything in the agent's working dir and return the staged diff.
 * Non-repos are initialized on the fly — every agent workspace becomes
 * versioned the first time a change is proposed.
 */
export async function captureStagedDiff(
  dir: string
): Promise<{ diff: string; stat: string; patch: string } | { error: string }> {
  if (!existsSync(dir)) return { error: `working directory does not exist: ${dir}` }
  try {
    if (!existsSync(join(dir, '.git'))) {
      await git(dir, ['init'])
    }
    await git(dir, ['add', '-A'])
    // --cached diffs against HEAD when it exists, the empty tree otherwise.
    const stat = (await git(dir, ['diff', '--cached', '--stat'])).trim()
    // The FULL patch is what approval will commit — the display diff below
    // may be truncated, the patch never is.
    const patch = await git(dir, ['diff', '--cached', '--binary'])
    if (!patch.trim()) return { error: 'no changes to propose — the working tree is clean.' }
    let diff = patch
    if (diff.length > DIFF_CHAR_LIMIT) {
      diff = `${diff.slice(0, DIFF_CHAR_LIMIT)}\n… [diff truncated for display — the full change was captured and will be committed intact]`
    }
    return { diff, stat, patch }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** A whole file to commit alongside a patch — record files (docs, decisions). */
export interface CommitFile {
  /** Repo-relative path, e.g. `.opencrew/decisions.md`. */
  path: string
  content: string
}

/** Repo-relative paths only: no absolute paths, no `..` segments. */
function assertRepoRelative(path: string): void {
  if (path.startsWith('/') || path.split('/').some((s) => s === '..' || s === '')) {
    throw new Error(`refusing to commit outside the repo: ${path}`)
  }
}

/**
 * Commit EXACTLY the reviewed patch, using a throwaway index so neither the
 * live index nor the working tree is touched. In a shared working dir the
 * staged state at approval time belongs to whoever staged last — agents,
 * other proposals, humans — so committing "whatever is staged" commits
 * something nobody reviewed (or nothing at all, silently failing). This
 * path is deterministic: the approved artifact IS the commit, or the apply
 * conflicts and the error says so honestly.
 *
 * `files` are whole files written into the same commit AND into the working
 * tree (they are the record — `.opencrew/` — and the human's checkout must
 * show them). An empty patch with files is a plain file commit.
 */
export async function commitPatch(
  dir: string,
  patch: string,
  message: string,
  authorName: string,
  opts: {
    /**
     * The patch was produced in ANOTHER checkout (a worker's environment):
     * also apply it to this directory's working tree and index, so the
     * human's checkout shows the committed files, not a reverse diff.
     */
    applyToWorkingTree?: boolean
    files?: CommitFile[]
  } = {}
): Promise<{ sha: string } | { error: string }> {
  const suffix = Math.random().toString(36).slice(2, 10)
  const gitDir = (await run('git', ['rev-parse', '--git-dir'], { cwd: dir, timeout: GIT_TIMEOUT_MS }))
    .stdout.trim()
  const gitDirAbs = gitDir.startsWith('/') ? gitDir : join(dir, gitDir)
  const tmpIndex = join(gitDirAbs, `opencrew-index-${suffix}`)
  const tmpPatch = join(gitDirAbs, `opencrew-patch-${suffix}`)
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
  const gitEnv = (args: string[]) =>
    run('git', args, { cwd: dir, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
  const files = opts.files ?? []
  for (const file of files) assertRepoRelative(file.path)
  const hasPatch = patch.trim().length > 0

  try {
    const { writeFile, rm, mkdir } = await import('node:fs/promises')
    await writeFile(tmpPatch, patch, 'utf8')
    try {
      if (hasPatch && opts.applyToWorkingTree) {
        // Fail before committing anything if the human's checkout conflicts.
        await git(dir, ['apply', '--check', '--binary', tmpPatch])
        await git(dir, ['apply', '--index', '--binary', tmpPatch])
      }
      const hasHead = await run('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS
      })
        .then(() => true)
        .catch(() => false)

      // Temp index = HEAD's tree (or empty), plus exactly the patch.
      if (hasHead) await gitEnv(['read-tree', 'HEAD'])
      else await gitEnv(['read-tree', '--empty'])
      if (hasPatch) await gitEnv(['apply', '--cached', '--binary', tmpPatch])
      // Record files: into the temp index, the working tree, and the live
      // index, so `git status` stays clean after the commit.
      for (const file of files) {
        const abs = join(dir, file.path)
        await mkdir(join(abs, '..'), { recursive: true })
        await writeFile(abs, file.content, 'utf8')
        const blob = (await git(dir, ['hash-object', '-w', abs])).trim()
        await gitEnv(['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`])
        await git(dir, ['add', '--', file.path])
      }
      const tree = (await gitEnv(['write-tree'])).stdout.trim()

      const commitEnv = {
        ...env,
        GIT_AUTHOR_NAME: authorName,
        GIT_AUTHOR_EMAIL: 'crew@opencrew.local',
        GIT_COMMITTER_NAME: 'OpenCrew',
        GIT_COMMITTER_EMAIL: 'crew@opencrew.local'
      }
      const parentArgs = hasHead ? ['-p', 'HEAD'] : []
      const { stdout: shaLong } = await run(
        'git',
        ['commit-tree', tree, ...parentArgs, '-m', message],
        { cwd: dir, env: commitEnv, timeout: GIT_TIMEOUT_MS }
      )
      const sha = shaLong.trim()
      await git(dir, ['update-ref', 'HEAD', sha])
      return { sha: sha.slice(0, 7) }
    } finally {
      await rm(tmpIndex, { force: true })
      await rm(tmpPatch, { force: true })
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const hint = raw.includes('patch does not apply')
      ? ' — the repo has changed since this diff was reviewed; ask the agent to re-propose.'
      : ''
    return { error: `${raw}${hint}` }
  }
}

/** Commit whole files (no patch): the record's own commits — docs, decisions. */
export async function commitFiles(
  dir: string,
  files: CommitFile[],
  message: string,
  authorName: string
): Promise<{ sha: string } | { error: string }> {
  return commitPatch(dir, '', message, authorName, { files })
}

/**
 * The review thread behind a commit, kept where the commit is: a git note
 * on the `opencrew` ref. `git log --notes=opencrew` shows it; pushing
 * `refs/notes/opencrew` carries it to any clone. Best effort — a note that
 * fails to write never fails an approval.
 */
export async function addReviewNote(dir: string, sha: string, text: string): Promise<boolean> {
  try {
    await run('git', ['notes', '--ref', 'opencrew', 'add', '-f', '-m', text, sha], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER
    })
    return true
  } catch {
    return false
  }
}

/** Commit the staged change; author = the agent, committer = OpenCrew. */
export async function commitStaged(
  dir: string,
  message: string,
  authorName: string
): Promise<{ sha: string } | { error: string }> {
  try {
    await git(dir, [
      '-c',
      `user.name=${authorName}`,
      '-c',
      'user.email=crew@opencrew.local',
      'commit',
      '-m',
      message
    ])
    const sha = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim()
    return { sha }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
