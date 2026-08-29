import { and, eq } from 'drizzle-orm'
import type { AgentVersion } from '@opencrew/shared'
import type { DB } from '../db'
import { approvalRules, approvals } from '../db/schema'

export class ToolForbiddenError extends Error {}
export class ApprovalRequiredError extends Error {}

export function isToolGated(version: AgentVersion, toolName: string): boolean {
  return version.capabilities.requiresApprovalFor.includes(toolName)
}

export type ToolUseVerdict = 'allow' | 'deny' | 'needs_approval'

/**
 * Harness meta-tools that are always allowed: ToolSearch only loads tool
 * SCHEMAS (needed for deferred MCP tools like the browser); invoking the
 * loaded tools still passes through the allowlist + approval gate.
 */
const ALWAYS_ALLOWED_META = ['ToolSearch']

/**
 * GUARDRAIL decision for a tool call (friendly tool names). Runs inside the
 * session's canUseTool permission callback — the executor-level choke point
 * every tool call passes through:
 *  - tools outside the version's tool list are denied
 *  - gated tools must pause for human approval
 */
export function evaluateToolUse(version: AgentVersion, toolName: string): ToolUseVerdict {
  if (ALWAYS_ALLOWED_META.includes(toolName)) return 'allow'
  if (!version.tools.includes(toolName)) return 'deny'
  return isToolGated(version, toolName) ? 'needs_approval' : 'allow'
}

/**
 * Standing admin consent for (agent, tool). When present, a gated call is
 * auto-approved: the approvals row and audit steps are still written, only
 * the human click is skipped. Revocable any time from the agent page.
 */
export function findAutoApproveRule(
  db: DB,
  agentId: string,
  toolName: string
): { id: string; createdBy: string } | null {
  const rule = db
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.toolName, toolName)))
    .get()
  return rule ? { id: rule.id, createdBy: rule.createdBy } : null
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
