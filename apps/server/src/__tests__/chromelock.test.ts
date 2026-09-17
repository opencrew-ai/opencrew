import { describe, expect, it } from 'vitest'
import { ChromeLock } from '../runs/chromelock'

describe('ChromeLock', () => {
  it('is exclusive across runs and re-entrant for the holder', async () => {
    const lock = new ChromeLock()
    expect(await lock.acquire('run-a', 100)).toBe(true)
    expect(await lock.acquire('run-a', 100)).toBe(true)
    expect(lock.heldBy).toBe('run-a')
    expect(await lock.acquire('run-b', 300)).toBe(false)
  })

  it('hands over to a waiter once the holder releases', async () => {
    const lock = new ChromeLock()
    await lock.acquire('run-a', 100)
    const waiter = lock.acquire('run-b', 2000)
    setTimeout(() => lock.release('run-a'), 300)
    expect(await waiter).toBe(true)
    expect(lock.heldBy).toBe('run-b')
  })

  it('ignores a release from a run that does not hold it', async () => {
    const lock = new ChromeLock()
    await lock.acquire('run-a', 100)
    lock.release('run-b')
    expect(lock.heldBy).toBe('run-a')
  })
})
