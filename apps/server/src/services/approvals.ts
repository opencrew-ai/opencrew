import { and, eq } from 'drizzle-orm'
import type { Approval } from '@opencrew/shared'
import type { AppContext } from '../context'
import { approvals, runs } from '../db/schema'
import { getFabricTask, unparkFabricTask } from '../fabric/store'
import { recordStep } from '../runs/audit'

export function toApproval(row: typeof approvals.$inferSelect): Approval {
  return {
    id: row.id,
    runId: row.runId,
    toolName: row.toolName,
    toolInput: JSON.parse(row.toolInput),
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt
  }
}

/**
 * Resolve an approval card. The run's fabric task is PARKED (needs_human) —
 * nothing is blocked in memory, so approvals survive restarts. Resolving
 * unparks the task with the decision: the next attempt resumes the session
 * carrying either a one-shot grant (approved) or the denial as context.
 */
export async function resolveApproval(
  ctx: AppContext,
  approvalId: string,
  decision: 'approved' | 'denied',
  resolvedBy: string
): Promise<Approval> {
  const [row] = await ctx.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1)
  if (!row) throw new Error('approval not found')
  if (row.status !== 'pending') throw new Error('approval already resolved')

  // Approving into a dead run is a no-op that LOOKS like consent — refuse
  // it honestly. Covers the race where a human clicks just after the run
  // ended (or was cancelled by stop_agent / stop-all).
  if (decision === 'approved') {
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, row.runId)).limit(1)
    if (run && ['done', 'failed', 'cancelled'].includes(run.status)) {
      await ctx.db
        .update(approvals)
        .set({ status: 'denied', resolvedBy: 'system:run-ended', resolvedAt: Date.now() })
        .where(eq(approvals.id, approvalId))
      const [stale] = await ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .limit(1)
      ctx.hub.broadcast({ type: 'approval_updated', approval: toApproval(stale!) })
      throw new Error('that run already ended — nothing is waiting on this approval')
    }
  }

  await ctx.db
    .update(approvals)
    .set({ status: decision, resolvedBy, resolvedAt: Date.now() })
    .where(eq(approvals.id, approvalId))
  await recordStep(ctx, row.runId, 'approval_resolved', {
    approvalId,
    tool: row.toolName,
    decision,
    resolvedBy
  })

  const [updated] = await ctx.db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1)
  ctx.hub.broadcast({ type: 'approval_updated', approval: toApproval(updated!) })

  // Unpark the waiting task — the decision travels in the payload.
  const task = await getFabricTask(ctx.db, row.runId)
  if (task?.state === 'needs_human' && task.pause?.approvalId === approvalId) {
    const resumed = await unparkFabricTask(ctx.db, row.runId, {
      approvalId,
      decision,
      toolName: row.toolName
    })
    if (resumed) {
      const [run] = await ctx.db.select().from(runs).where(eq(runs.id, row.runId)).limit(1)
      if (run) {
        await ctx.db.update(runs).set({ status: 'queued' }).where(eq(runs.id, row.runId))
        ctx.hub.broadcast({
          type: 'run_status',
          runId: row.runId,
          agentId: run.agentId,
          status: 'queued'
        })
      }
      ctx.fabric.wake()
    }
  }
  return toApproval(updated!)
}

/**
 * Deny every still-pending approval on a run. Used when a run reaches a
 * terminal state: an approval must never outlive its run — an orphaned
 * "waiting for an admin" card would approve into nothing.
 */
export async function denyPendingApprovalsForRun(
  ctx: AppContext,
  runId: string,
  resolvedBy: string
): Promise<void> {
  const pending = await ctx.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
  for (const approval of pending) {
    try {
      await resolveApproval(ctx, approval.id, 'denied', resolvedBy)
    } catch {
      // Resolved in a race — fine.
    }
  }
}
