/**
 * Per-turn phase timing. One instance per attempt; every phase boundary in
 * the executor calls `mark()`, and the summary lands in the run's result step
 * (`timings`) plus one console line — so "why was that slow?" is answerable
 * from the terminal panel or the server log without a profiler.
 */

export type TurnPhase =
  /** Prompt assembled (DB reads: transcript, tasks, docs, system prompt). */
  | 'prompt_built'
  /** Claude Code process up, MCP servers connected (SDK `init` message). */
  | 'session_init'
  /** First model response arrived. */
  | 'first_llm'
  /** SDK `result` message: the session's work is complete. */
  | 'result'
  /** Reply posted, mentions fanned out, run row closed. */
  | 'finalized'

export interface TurnTimings {
  /** Task creation → attempt start (fabric scheduling + serialization). */
  queueMs: number
  /** Attempt start → prompt ready. */
  promptMs: number
  /** Prompt ready → session init (Claude Code startup). */
  initMs: number
  /** Session init → first model response (includes prompt-cache creation). */
  firstLlmMs: number
  /** Session init → result (the model's actual work). */
  sessionMs: number
  /** Attempt start → finalized. */
  totalMs: number
}

export class TurnTimer {
  private readonly marks = new Map<TurnPhase, number>()

  constructor(
    private readonly queuedAt: number,
    private readonly startedAt: number = Date.now()
  ) {}

  /** Record a phase boundary; only the first mark per phase counts. */
  mark(phase: TurnPhase, at: number = Date.now()): void {
    if (!this.marks.has(phase)) this.marks.set(phase, at)
  }

  has(phase: TurnPhase): boolean {
    return this.marks.has(phase)
  }

  summary(now: number = Date.now()): TurnTimings {
    const at = (phase: TurnPhase, fallback: number): number => this.marks.get(phase) ?? fallback
    const promptAt = at('prompt_built', this.startedAt)
    const initAt = at('session_init', promptAt)
    const firstLlmAt = at('first_llm', initAt)
    const resultAt = at('result', now)
    const finalizedAt = at('finalized', now)
    return {
      queueMs: Math.max(0, this.startedAt - this.queuedAt),
      promptMs: promptAt - this.startedAt,
      initMs: initAt - promptAt,
      firstLlmMs: firstLlmAt - initAt,
      sessionMs: resultAt - initAt,
      totalMs: finalizedAt - this.startedAt
    }
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/** One-line, human-scannable summary for the server log. */
export function formatTurnTimings(
  label: string,
  t: TurnTimings,
  extra: { turns?: number; cacheCreate?: number; cacheRead?: number; costUsd?: number } = {}
): string {
  const parts = [
    `queue ${secs(t.queueMs)}`,
    `prompt ${secs(t.promptMs)}`,
    `init ${secs(t.initMs)}`,
    `first-llm ${secs(t.firstLlmMs)}`,
    `session ${secs(t.sessionMs)}`,
    `total ${secs(t.totalMs)}`
  ]
  if (extra.turns !== undefined) parts.push(`${extra.turns} turns`)
  if (extra.cacheCreate !== undefined || extra.cacheRead !== undefined) {
    const k = (n: number | undefined) => `${Math.round((n ?? 0) / 1000)}k`
    parts.push(`cache +${k(extra.cacheCreate)}/=${k(extra.cacheRead)}`)
  }
  if (extra.costUsd !== undefined) parts.push(`$${extra.costUsd.toFixed(3)}`)
  return `⏱ ${label} · ${parts.join(' · ')}`
}
