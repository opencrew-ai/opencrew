import { useEffect, useState } from 'react'
import type { Approval } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useWorkspace } from '../lib/workspace'
import { showAlert } from '../lib/dialogs'

/**
 * The yellow guardrail card: a gated tool call paused this run. Admins
 * approve or deny; everyone watches the state change live.
 */
export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const { me, users, agents } = useWorkspace()
  const [approval, setApproval] = useState<Approval | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => {
    setLoadFailed(false)
    api
      .get<Approval>(`/api/approvals/${approvalId}`)
      .then(setApproval)
      .catch(() => setLoadFailed(true))
  }

  useEffect(() => {
    load()
    return wsClient.subscribe((event) => {
      if (event.type === 'approval_updated' && event.approval.id === approvalId) {
        setApproval(event.approval)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalId])

  // The card must never silently vanish — a gated run is waiting on it.
  if (!approval) {
    if (!loadFailed) return null
    return (
      <div className="mt-1 max-w-xl rounded-md border border-zinc-700 bg-zinc-900/40 p-2 text-xs text-zinc-400">
        Couldn't load this approval —{' '}
        <button onClick={load} className="underline hover:text-zinc-200">
          retry
        </button>
      </div>
    )
  }

  const resolverLabel = (() => {
    if (!approval.resolvedBy) return null
    if (approval.resolvedBy === 'system:run-ended') return 'run ended before a decision'
    if (approval.resolvedBy.startsWith('agent:')) {
      const agent = agents.find((a) => a.id === approval.resolvedBy!.slice(6))
      return agent ? `by ${agent.avatarEmoji} ${agent.name}` : 'by an agent'
    }
    const user = users.find((u) => u.id === approval.resolvedBy)
    return user ? `by ${user.name}` : 'by an admin'
  })()

  const resolve = async (decision: 'approved' | 'denied', always = false) => {
    setBusy(true)
    try {
      await api.post(`/api/approvals/${approvalId}/resolve`, { decision, always })
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'failed', { title: 'Approval failed' })
    } finally {
      setBusy(false)
    }
  }

  const border =
    approval.status === 'pending'
      ? 'border-amber-500/60 bg-amber-950/30'
      : approval.status === 'approved'
        ? 'border-emerald-600/50 bg-emerald-950/20'
        : 'border-red-700/50 bg-red-950/20'

  return (
    <div className={`mt-1 max-w-xl rounded-md border p-3 text-sm ${border}`}>
      <div className="flex flex-wrap items-center gap-2 font-medium">
        {approval.status === 'pending' && <span>🟡 Approval required</span>}
        {approval.status === 'approved' && <span>✅ Approved</span>}
        {approval.status === 'denied' && <span>⛔ Denied</span>}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{approval.toolName}</code>
        {approval.status !== 'pending' && resolverLabel && (
          <span className="font-normal text-xs text-zinc-500">
            {resolverLabel}
            {approval.resolvedAt
              ? ` · ${new Date(approval.resolvedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : ''}
          </span>
        )}
      </div>
      <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-900/80 p-2 text-xs text-zinc-300">
        {JSON.stringify(approval.toolInput, null, 2)}
      </pre>
      {approval.status === 'pending' && me.role === 'admin' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void resolve('approved')}>
            Approve
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            title="Approve and auto-approve this tool for this agent from now on (revocable on the agent page)"
            onClick={() => void resolve('approved', true)}
          >
            Approve + always allow
          </button>
          <button className="btn-danger" disabled={busy} onClick={() => void resolve('denied')}>
            Deny
          </button>
        </div>
      )}
      {approval.status === 'pending' && me.role !== 'admin' && (
        <p className="mt-2 text-xs text-zinc-500">Waiting for an admin…</p>
      )}
    </div>
  )
}
