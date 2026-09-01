import { and, eq } from 'drizzle-orm'
import type { AgentVersion } from '@opencrew/shared'
import type { DB } from '../db'
import { approvalRules, approvals } from '../db/schema'
import { ALWAYS_AVAILABLE_TOOLS } from '../tools/registry'

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
 * The ALWAYS_AVAILABLE_TOOLS (task board + doc lifecycle) are safe by
 * construction — see tools/registry.ts.
 */
const ALWAYS_ALLOWED_META = ['ToolSearch', ...ALWAYS_AVAILABLE_TOOLS]

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
export async function findAutoApproveRule(
  db: DB,
  agentId: string,
  toolName: string
): Promise<{ id: string; createdBy: string } | null> {
  const [rule] = await db
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.toolName, toolName)))
    .limit(1)
  return rule ? { id: rule.id, createdBy: rule.createdBy } : null
}

/**
 * Key-order-insensitive JSON so a grant matches the resumed model's re-issued
 * call even when the SDK serializes the input object's keys differently.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * One-shot grant lookup for a resumed attempt: an APPROVED, unconsumed
 * approval on this run whose tool AND exact input match the call being made.
 * A call with different input gets no grant — it goes through a fresh
 * approval cycle instead of silently widening the consent.
 */
export async function findConsumableGrant(
  db: DB,
  runId: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<{ id: string } | null> {
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.runId, runId),
        eq(approvals.toolName, toolName),
        eq(approvals.status, 'approved')
      )
    )
  const wanted = canonicalJson(input)
  for (const row of rows) {
    if (row.consumedAt !== null) continue
    try {
      if (canonicalJson(JSON.parse(row.toolInput)) === wanted) return { id: row.id }
    } catch {
      // Unparseable stored input can never match.
    }
  }
  return null
}

/** Stamp a grant used — each approval lets exactly one call through. */
export async function consumeGrant(db: DB, approvalId: string): Promise<void> {
  await db
    .update(approvals)
    .set({ consumedAt: Date.now() })
    .where(eq(approvals.id, approvalId))
}

/**
 * Re-verification after an approval resolves: a gated tool may only proceed
 * when an APPROVED approvals row exists for this run + tool. Throws otherwise
 * — an in-memory "approved" signal alone is never trusted.
 */
export async function assertToolInvocationAllowed(
  db: DB,
  version: AgentVersion,
  runId: string,
  toolName: string,
  approvalId?: string
): Promise<void> {
  if (!version.tools.includes(toolName)) {
    throw new ToolForbiddenError(`tool "${toolName}" is not in this agent version's tool list`)
  }
  if (!isToolGated(version, toolName)) return

  if (!approvalId) {
    throw new ApprovalRequiredError(`tool "${toolName}" requires human approval`)
  }
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1)
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
