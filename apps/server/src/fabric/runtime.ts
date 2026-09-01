import type { DB } from '../db'
import {
  claimNextTask,
  completeFabricTask,
  cancelLeasedFabricTask,
  failAttempt,
  failLeasedFabricTask,
  parkFabricTask,
  reapExpiredLeases,
  reapForeignLeases,
  renewLease,
  type FabricTask
} from './store'

/**
 * Fabric runtime — the in-process worker pool + controllers (see /DESIGN.md).
 * Level-triggered: a wake() is only a latency optimization; the periodic
 * resync re-evaluates everything from the store, so missed wake-ups can never
 * lose work and restart recovery is just the reaper's first pass.
 */

const RESYNC_MS = 15_000
const LEASE_MS = 60_000
const HEARTBEAT_MS = 15_000
const STALL_NOTICE_MS = 10 * 60_000
const STALL_KILL_MS = 30 * 60_000

export type AttemptOutcome =
  | { outcome: 'done' }
  | { outcome: 'parked'; pause: Record<string, unknown> }
  | { outcome: 'cancelled' }
  /** Unrecoverable (bad config, missing rows) — fail WITHOUT retries. */
  | { outcome: 'fatal'; error: string }
  | { outcome: 'error'; error: string }

export interface AttemptHandle {
  taskId: string
  attempt: number
  abort: AbortController
  /** Why the runtime aborted this attempt, if it did. */
  abortReason: string | null
  /** Record session activity — feeds the stall detector. */
  beat: () => void
  /** Track in-flight tool calls: a long build is activity, not a stall. */
  toolStarted: () => void
  toolFinished: () => void
}

export type AttemptExecutor = (task: FabricTask, handle: AttemptHandle) => Promise<AttemptOutcome>

export interface FabricHooks {
  /** An attempt errored within budget — the task went back to ready. */
  onRedelivered?: (task: FabricTask, reason: string, nextAttempt: number) => Promise<void>
  /** The budget is spent — the task is dead-lettered. */
  onDead?: (task: FabricTask, reason: string) => Promise<void>
  /** A leased task has been event-silent past the notice threshold. */
  onStallNotice?: (task: FabricTask, minutes: number) => Promise<void>
}

interface ActiveAttempt {
  task: FabricTask
  handle: AttemptHandle
  lastEventAt: number
  toolsInFlight: number
  stallFlagged: boolean
  heartbeat: ReturnType<typeof setInterval>
}

export interface FabricConfig {
  capacity: number
  interactiveReserve: number
  workerId: string
}

export class FabricRuntime {
  private executors = new Map<string, AttemptExecutor>()
  private active = new Map<string, ActiveAttempt>()
  private hooks: FabricHooks = {}
  private resync: ReturnType<typeof setInterval> | null = null
  private pumping = false
  private pumpQueued = false
  private stopped = false

  constructor(
    private db: DB,
    private config: FabricConfig
  ) {}

  registerExecutor(kind: string, executor: AttemptExecutor): void {
    this.executors.set(kind, executor)
  }

  setHooks(hooks: FabricHooks): void {
    this.hooks = hooks
  }

  /** Begin the resync loop and dispatch whatever is already ready. */
  start(): void {
    this.resync = setInterval(() => {
      void this.resyncPass().catch(() => {
        // The control loop must never take the server down; next tick retries.
      })
    }, RESYNC_MS)
    this.resync.unref()
    // Instant boot recovery: leases from a previous process are dead — see
    // reapForeignLeases. Work interrupted by a restart resumes right away.
    void (async () => {
      const reaped = await reapForeignLeases(this.db, this.config.workerId)
      for (const { task, disposition } of reaped) {
        if (disposition === 'retry') {
          await this.hooks.onRedelivered?.(task, 'server restarted', task.attempts + 1)
        } else {
          await this.hooks.onDead?.(task, 'server restarted')
        }
      }
    })().catch(() => {}).finally(() => this.wake())
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.resync) clearInterval(this.resync)
    this.abortAll('runtime stopping')
  }

  /** Edge-trigger: something changed, try to dispatch now. */
  wake(): void {
    if (this.pumping) {
      this.pumpQueued = true
      return
    }
    void this.pump().catch(() => {
      // Level-triggered: the resync pass will converge regardless.
    })
  }

  activeTaskIds(): string[] {
    return [...this.active.keys()]
  }

  activeAgentIds(): Set<string> {
    const ids = new Set<string>()
    for (const attempt of this.active.values()) {
      const agentId = attempt.task.payload.agentId
      if (typeof agentId === 'string') ids.add(agentId)
    }
    return ids
  }

  /** Abort a specific in-flight attempt (admin stop, stall kill). */
  abortTask(taskId: string, reason: string): boolean {
    const attempt = this.active.get(taskId)
    if (!attempt) return false
    attempt.handle.abortReason = reason
    attempt.handle.abort.abort()
    return true
  }

  abortAll(reason: string): number {
    let count = 0
    for (const taskId of [...this.active.keys()]) {
      if (this.abortTask(taskId, reason)) count++
    }
    return count
  }

  abortForAgent(agentId: string, reason: string): number {
    let count = 0
    for (const attempt of this.active.values()) {
      if (attempt.task.payload.agentId === agentId) {
        if (this.abortTask(attempt.task.id, reason)) count++
      }
    }
    return count
  }

  /**
   * The scheduler: claim eligible tasks until capacity or eligibility runs
   * out. Single-flight — concurrent wakes coalesce into one extra pass.
   */
  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const task = await claimNextTask(this.db, {
          workerId: this.config.workerId,
          capacity: this.config.capacity,
          interactiveReserve: this.config.interactiveReserve,
          leaseMs: LEASE_MS
        })
        if (!task) break
        this.launch(task)
      }
    } finally {
      this.pumping = false
      if (this.pumpQueued) {
        this.pumpQueued = false
        this.wake()
      }
    }
  }

  private launch(task: FabricTask): void {
    const executor = this.executors.get(task.kind)
    const handle: AttemptHandle = {
      taskId: task.id,
      attempt: task.attempts,
      abort: new AbortController(),
      abortReason: null,
      beat: () => {
        const active = this.active.get(task.id)
        if (active) {
          active.lastEventAt = Date.now()
          active.stallFlagged = false
        }
      },
      toolStarted: () => {
        const active = this.active.get(task.id)
        if (active) active.toolsInFlight++
      },
      toolFinished: () => {
        const active = this.active.get(task.id)
        if (active) active.toolsInFlight = Math.max(0, active.toolsInFlight - 1)
      }
    }
    const heartbeat = setInterval(() => {
      // Process liveness — and a tool in flight counts as session activity.
      const active = this.active.get(task.id)
      void renewLease(this.db, task.id, LEASE_MS, {
        beat: (active?.toolsInFlight ?? 0) > 0
      }).catch(() => {})
    }, HEARTBEAT_MS)
    heartbeat.unref()
    this.active.set(task.id, {
      task,
      handle,
      lastEventAt: Date.now(),
      toolsInFlight: 0,
      stallFlagged: false,
      heartbeat
    })

    void (async () => {
      let result: AttemptOutcome
      try {
        result = executor
          ? await executor(task, handle)
          : { outcome: 'error', error: `no executor registered for kind "${task.kind}"` }
      } catch (err) {
        result = { outcome: 'error', error: err instanceof Error ? err.message : String(err) }
      }
      await this.settle(task, handle, result)
    })().finally(() => {
      clearInterval(heartbeat)
      this.active.delete(task.id)
      this.wake()
    })
  }

  private async settle(
    task: FabricTask,
    handle: AttemptHandle,
    result: AttemptOutcome
  ): Promise<void> {
    try {
      if (result.outcome === 'done') {
        await completeFabricTask(this.db, task.id)
      } else if (result.outcome === 'parked') {
        await parkFabricTask(this.db, task.id, result.pause)
      } else if (result.outcome === 'cancelled') {
        await cancelLeasedFabricTask(this.db, task.id)
      } else if (result.outcome === 'fatal') {
        // The executor already reported the failure user-visibly.
        await failLeasedFabricTask(this.db, task.id)
      } else {
        const reason = handle.abortReason ?? result.error
        const disposition = await failAttempt(this.db, task.id)
        if (disposition === 'retry') {
          await this.hooks.onRedelivered?.(task, reason, task.attempts + 1)
        } else if (disposition === 'dead') {
          await this.hooks.onDead?.(task, reason)
        }
      }
    } catch (err) {
      console.error(`fabric: settling task ${task.id} failed:`, err)
    }
  }

  /**
   * Level-triggered convergence: reap dead-process leases, run the stall
   * detector over live attempts, then dispatch. Restart recovery is simply
   * this pass finding the previous process's expired leases.
   */
  private async resyncPass(): Promise<void> {
    const skip = new Set(this.active.keys())
    const reaped = await reapExpiredLeases(this.db, skip)
    for (const { task, disposition } of reaped) {
      if (disposition === 'retry') {
        await this.hooks.onRedelivered?.(task, 'worker lost (lease expired)', task.attempts + 1)
      } else {
        await this.hooks.onDead?.(task, 'worker lost (lease expired)')
      }
    }

    const now = Date.now()
    for (const attempt of this.active.values()) {
      if (attempt.toolsInFlight > 0) continue
      const silence = now - attempt.lastEventAt
      if (silence >= STALL_KILL_MS) {
        this.abortTask(attempt.task.id, `stalled: no session activity for ${Math.round(silence / 60_000)}m`)
      } else if (silence >= STALL_NOTICE_MS && !attempt.stallFlagged) {
        attempt.stallFlagged = true
        await this.hooks.onStallNotice?.(attempt.task, Math.round(silence / 60_000))
      }
    }

    this.wake()
  }
}
