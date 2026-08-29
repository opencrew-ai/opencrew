import { useEffect, useState } from 'react'
import type { Approval } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useWorkspace } from '../lib/workspace'

/**
 * The yellow guardrail card: a gated tool call paused this run. Admins
 * approve or deny; everyone watches the state change live.
 */
export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const { me } = useWorkspace()
  const [approval, setApproval] = useState<Approval | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<Approval>(`/api/approvals/${approvalId}`).then(setApproval).catch(() => {})
    return wsClient.subscribe((event) => {
      if (event.type === 'approval_updated' && event.approval.id === approvalId) {
        setApproval(event.approval)
      }
    })
  }, [approvalId])

  if (!approval) return null

  const resolve = async (decision: 'approved' | 'denied') => {
    setBusy(true)
    try {
      await api.post(`/api/approvals/${approvalId}/resolve`, { decision })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'failed')
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
      <div className="flex items-center gap-2 font-medium">
        {approval.status === 'pending' && <span>🟡 Approval required</span>}
        {approval.status === 'approved' && <span>✅ Approved</span>}
        {approval.status === 'denied' && <span>⛔ Denied</span>}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{approval.toolName}</code>
      </div>
      <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-900/80 p-2 text-xs text-zinc-300">
        {JSON.stringify(approval.toolInput, null, 2)}
      </pre>
      {approval.status === 'pending' && me.role === 'admin' && (
        <div className="mt-2 flex gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void resolve('approved')}>
            Approve
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
