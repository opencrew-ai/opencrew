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

/**
 * Commit EXACTLY the reviewed patch, using a throwaway index so neither the
 * live index nor the working tree is touched. In a shared working dir the
 * staged state at approval time belongs to whoever staged last — agents,
 * other proposals, humans — so committing "whatever is staged" commits
 * something nobody reviewed (or nothing at all, silently failing). This
 * path is deterministic: the approved artifact IS the commit, or the apply
 * conflicts and the error says so honestly.
 */
export async function commitPatch(
  dir: string,
  patch: string,
  message: string,
  authorName: string
): Promise<{ sha: string } | { error: string }> {
  const suffix = Math.random().toString(36).slice(2, 10)
  const tmpIndex = join(dir, '.git', `opencrew-index-${suffix}`)
  const tmpPatch = join(dir, '.git', `opencrew-patch-${suffix}`)
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
  const gitEnv = (args: string[]) =>
    run('git', args, { cwd: dir, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })

  try {
    const { writeFile, rm } = await import('node:fs/promises')
    await writeFile(tmpPatch, patch, 'utf8')
    try {
      const hasHead = await run('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS
      })
        .then(() => true)
        .catch(() => false)

      // Temp index = HEAD's tree (or empty), plus exactly the patch.
      if (hasHead) await gitEnv(['read-tree', 'HEAD'])
      else await gitEnv(['read-tree', '--empty'])
      await gitEnv(['apply', '--cached', '--binary', tmpPatch])
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
