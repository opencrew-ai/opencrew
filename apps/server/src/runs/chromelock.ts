/**
 * The human has ONE Chrome. Claude-in-Chrome drives it through a single
 * extension, so two agents clicking at once would fight over the same tabs.
 * Instead of leasing the browser for a whole run (which serialized every
 * Chrome-capable worker end to end), a run holds it only for the duration of
 * each Chrome tool call: acquired in the PreToolUse hook, released after the
 * call. All runs live in this process, so an in-memory lock is the truth.
 */
const POLL_MS = 250

export class ChromeLock {
  private holder: string | null = null

  /** Who holds Chrome right now (a run id), or null. */
  get heldBy(): string | null {
    return this.holder
  }

  /**
   * Wait up to `timeoutMs` for Chrome. Re-entrant for the holder. Returns
   * false on timeout so the caller can deny the call with a retry hint
   * instead of hanging the session.
   */
  async acquire(runId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.holder === null || this.holder === runId) {
        this.holder = runId
        return true
      }
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  /** Release if `runId` is the holder; a no-op otherwise. */
  release(runId: string): void {
    if (this.holder === runId) this.holder = null
  }
}

export const chromeLock = new ChromeLock()
