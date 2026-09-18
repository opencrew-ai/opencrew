import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One process per PGlite data dir. PGlite is single-process: a second server
 * opening the same directory (the installer re-run on new ports, a stray
 * `pnpm start`) corrupts it silently. PGlite's own postmaster.pid carries a
 * fake pid, so we keep our own lock next to the data dir.
 */
export class DataDirLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly holderPid: number
  ) {
    super(
      `Another OpenCrew server (pid ${holderPid}) is already using ${dataDir}. ` +
        `Use that one, or stop it first — two servers on one data dir corrupt it.`
    )
    this.name = 'DataDirLockedError'
  }
}

export function lockPathFor(dataDir: string): string {
  return `${dataDir}.lock`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: exists but not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null
  const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Claim `dataDir` for this process. Throws DataDirLockedError when a live
 * process holds it; a lock left by a dead process is taken over. Returns the
 * release function (also run on exit and on SIGINT/SIGTERM).
 */
export function acquireDataDirLock(dataDir: string, pid: number = process.pid): () => void {
  const lockPath = lockPathFor(dataDir)
  const holder = readHolder(lockPath)
  if (holder !== null && holder !== pid && isAlive(holder)) {
    throw new DataDirLockedError(dataDir, holder)
  }
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, `${pid}\n`)

  const release = (): void => {
    if (readHolder(lockPath) !== pid) return
    try {
      unlinkSync(lockPath)
    } catch {
      // Already gone — nothing to release.
    }
  }
  // Ctrl-C and normal exit both clear it; a crash leaves a dead pid, which
  // the next start takes over.
  process.once('exit', release)
  return release
}
