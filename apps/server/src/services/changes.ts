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
): Promise<{ diff: string; stat: string } | { error: string }> {
  if (!existsSync(dir)) return { error: `working directory does not exist: ${dir}` }
  try {
    if (!existsSync(join(dir, '.git'))) {
      await git(dir, ['init'])
    }
    await git(dir, ['add', '-A'])
    // --cached diffs against HEAD when it exists, the empty tree otherwise.
    const stat = (await git(dir, ['diff', '--cached', '--stat'])).trim()
    let diff = await git(dir, ['diff', '--cached'])
    if (!diff.trim()) return { error: 'no changes to propose — the working tree is clean.' }
    if (diff.length > DIFF_CHAR_LIMIT) {
      diff = `${diff.slice(0, DIFF_CHAR_LIMIT)}\n… [diff truncated for display — the full change is staged and will be committed intact]`
    }
    return { diff, stat }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
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
