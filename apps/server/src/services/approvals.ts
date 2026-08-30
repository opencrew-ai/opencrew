import { eq } from 'drizzle-orm'
import type { Approval } from '@opencrew/shared'
import type { AppContext } from '../context'
import { approvals } from '../db/schema'
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
 * Resolve an approval card. The run's Claude Code session is blocked inside
 * its permission callback waiting on this — resolving wakes it up. Approved →
 * the executor re-verifies this row in the DB before letting the tool run.
 * Denied → the executor aborts the run.
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

  const waiter = ctx.approvalWaiters.get(approvalId)
  if (waiter) {
    waiter(decision)
  }
  // No waiter means the run died (e.g. restart) — the row update alone is
  // correct; boot cleanup already failed the run.
  return toApproval(updated!)
}
