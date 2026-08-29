import type { DB } from './db'
import type { Hub } from './hub'
import type { RunQueue } from './runs/queue'

export type ApprovalDecision = 'approved' | 'denied'

export interface AppContext {
  db: DB
  hub: Hub
  queue: RunQueue
  /**
   * In-memory waiters for pending approvals: a run's Claude Code session
   * blocks inside canUseTool until an admin resolves the approval, which
   * calls the registered resolver. Lost on restart (runs are failed at boot).
   */
  approvalWaiters: Map<string, (decision: ApprovalDecision) => void>
  /** AbortControllers for in-flight runs, keyed by runId. */
  activeRuns: Map<string, AbortController>
  /**
   * Per-agent execution chains for agents with the Browser tool: a Chrome
   * profile supports one instance at a time, so browser runs serialize.
   */
  agentLocks: Map<string, Promise<void>>
}
