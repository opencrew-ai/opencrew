/**
 * Claude usage/session-limit detection. Hitting the subscription's limit is
 * an ACCOUNT-wide, time-bound condition — not a task failure: retrying
 * burns attempts to learn the same thing, and every agent hits it at once.
 * The fabric responds by deferring work until the stated reset.
 */

const LIMIT_PATTERN = /(session|usage|rate)[ -]?limit/i
const RESET_PATTERN = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i

const MIN_DEFER_MS = 5 * 60_000
const MAX_DEFER_MS = 6 * 60 * 60_000
const FALLBACK_DEFER_MS = 10 * 60_000

export interface UsageLimit {
  /** When to try again (unix ms), clamped to [5m, 6h] from now. */
  notBefore: number
  /** Human-readable resume time for notices. */
  resumeLabel: string
}

/**
 * Returns the deferral when the error is a usage/session limit, null
 * otherwise. The reset time ("resets 11:10am (America/Los_Angeles)") is
 * parsed against the SERVER's local clock — the machine running the crew is
 * the machine whose Claude login hit the limit, so their zones match. An
 * unparseable reset falls back to a 10-minute probe: if the limit still
 * holds, the next attempt re-defers — cheap, self-correcting.
 */
export function detectUsageLimit(error: string, now = Date.now()): UsageLimit | null {
  if (!LIMIT_PATTERN.test(error)) return null

  let notBefore = now + FALLBACK_DEFER_MS
  const match = error.match(RESET_PATTERN)
  if (match) {
    let hour = Number(match[1]) % 12
    if (match[3]!.toLowerCase() === 'pm') hour += 12
    const minute = Number(match[2] ?? 0)
    const reset = new Date(now)
    reset.setHours(hour, minute, 0, 0)
    // A reset time already past today means tomorrow.
    if (reset.getTime() <= now + 60_000) reset.setDate(reset.getDate() + 1)
    notBefore = reset.getTime()
  }
  notBefore = Math.min(Math.max(notBefore, now + MIN_DEFER_MS), now + MAX_DEFER_MS)

  const resumeLabel = new Date(notBefore).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
  return { notBefore, resumeLabel }
}
