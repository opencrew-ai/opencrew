import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DataDirLockedError, acquireDataDirLock, lockPathFor } from '../db/lock'

describe('PGlite data dir lock', () => {
  let root: string
  let dataDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opencrew-lock-'))
    dataDir = join(root, 'opencrew.pgdata')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('writes this pid and removes it on release', () => {
    const release = acquireDataDirLock(dataDir)
    expect(readFileSync(lockPathFor(dataDir), 'utf8').trim()).toBe(String(process.pid))
    release()
    expect(() => readFileSync(lockPathFor(dataDir))).toThrow()
  })

  it('refuses when a live process holds the lock', () => {
    // Our own pid is certainly alive; pretend a different server wrote it.
    writeFileSync(lockPathFor(dataDir), `${process.pid}\n`)
    expect(() => acquireDataDirLock(dataDir, process.pid + 100_000)).toThrow(DataDirLockedError)
  })

  it('takes over a lock left by a dead process', () => {
    writeFileSync(lockPathFor(dataDir), '999999999\n')
    const release = acquireDataDirLock(dataDir)
    expect(readFileSync(lockPathFor(dataDir), 'utf8').trim()).toBe(String(process.pid))
    release()
  })

  it('release never deletes a lock another process took over', () => {
    const release = acquireDataDirLock(dataDir)
    writeFileSync(lockPathFor(dataDir), '424242\n')
    release()
    expect(readFileSync(lockPathFor(dataDir), 'utf8').trim()).toBe('424242')
  })
})
