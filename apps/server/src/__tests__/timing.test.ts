import { describe, expect, it } from 'vitest'
import { formatTurnTimings, TurnTimer } from '../runs/timing'

describe('TurnTimer', () => {
  it('attributes wall time to phases by mark order', () => {
    const timer = new TurnTimer(1_000, 1_500)
    const t = (ms: number) => 1_500 + ms
    timer.mark('prompt_built', t(50))
    timer.mark('session_init', t(1_250))
    timer.mark('first_llm', t(4_250))
    timer.mark('result', t(30_000))
    timer.mark('finalized', t(30_400))

    expect(timer.summary(t(99_999))).toEqual({
      queueMs: 500,
      promptMs: 50,
      initMs: 1_200,
      firstLlmMs: 3_000,
      sessionMs: 28_750,
      totalMs: 30_400
    })
  })

  it('only the first mark per phase counts', () => {
    const timer = new TurnTimer(0, 0)
    timer.mark('first_llm', 5)
    const first = timer.summary(10)
    timer.mark('first_llm', 9)
    expect(timer.summary(10)).toEqual(first)
    expect(timer.has('first_llm')).toBe(true)
    expect(timer.has('result')).toBe(false)
  })

  it('never reports negative queue time for a task started before its clock', () => {
    const timer = new TurnTimer(2_000, 1_000)
    expect(timer.summary(1_000).queueMs).toBe(0)
  })
})

describe('formatTurnTimings', () => {
  it('prints one scannable line with optional session stats', () => {
    const line = formatTurnTimings(
      'Scout #abc123',
      { queueMs: 12, promptMs: 48, initMs: 1_200, firstLlmMs: 3_100, sessionMs: 9_300, totalMs: 10_700 },
      { turns: 3, cacheCreate: 10_233, cacheRead: 5_619, costUsd: 0.0792 }
    )
    expect(line).toBe(
      '⏱ Scout #abc123 · queue 0.0s · prompt 0.0s · init 1.2s · first-llm 3.1s · ' +
        'session 9.3s · total 10.7s · 3 turns · cache +10k/=6k · $0.079'
    )
  })
})
