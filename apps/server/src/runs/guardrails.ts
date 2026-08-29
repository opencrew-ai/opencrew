import { eq } from 'drizzle-orm'
import type { AgentVersion } from '@opencrew/shared'
import type { DB } from '../db'
import { approvals } from '../db/schema'

export class ToolForbiddenError extends Error {}
export class ApprovalRequiredError extends Error {}

export function isToolGated(version: AgentVersion, toolName: string): boolean {
  return version.capabilities.requiresApprovalFor.includes(toolName)
}

export type ToolUseVerdict = 'allow' | 'deny' | 'needs_approval'

/**
 * GUARDRAIL decision for a tool call (friendly tool names). Runs inside the
 * session's canUseTool permission callback — the executor-level choke point
 * every tool call passes through:
 *  - tools outside the version's tool list are denied
 *  - gated tools must pause for human approval
 */
export function evaluateToolUse(version: AgentVersion, toolName: string): ToolUseVerdict {
  if (!version.tools.includes(toolName)) return 'deny'
  return isToolGated(version, toolName) ? 'needs_approval' : 'allow'
}

/**
 * Re-verification after an approval resolves: a gated tool may only proceed
 * when an APPROVED approvals row exists for this run + tool. Throws otherwise
 * — an in-memory "approved" signal alone is never trusted.
 */
export function assertToolInvocationAllowed(
  db: DB,
  version: AgentVersion,
  runId: string,
  toolName: string,
  approvalId?: string
): void {
  if (!version.tools.includes(toolName)) {
    throw new ToolForbiddenError(
      `tool "${toolName}" is not in this agent version's tool list`
    )
  }
  if (!isToolGated(version, toolName)) return

  if (!approvalId) {
    throw new ApprovalRequiredError(`tool "${toolName}" requires human approval`)
  }
  const approval = db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .get()
  if (
    !approval ||
    approval.runId !== runId ||
    approval.toolName !== toolName ||
    approval.status !== 'approved'
  ) {
    throw new ApprovalRequiredError(
      `tool "${toolName}" has no approved approval for this invocation`
    )
  }
}
