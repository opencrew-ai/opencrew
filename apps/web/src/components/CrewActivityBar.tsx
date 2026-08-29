import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { presenceKey, useWorkspace } from '../lib/workspace'
import { showConfirm } from '../lib/dialogs'

/**
 * Floating crew activity pill — visible on every page, but only while agents
 * are actually working. Shows who is running and carries the emergency stop,
 * so the kill switch is always one click away exactly when it matters.
 */
export function CrewActivityBar() {
  const { me, agents, presence } = useWorkspace()
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const isAdmin = me.role === 'admin'

  const runningAgents = useMemo(
    () =>
      agents.filter(
        (a) => presence.get(presenceKey('agent', a.id))?.state === 'running'
      ),
    [agents, presence]
  )

  if (runningAgents.length === 0 && !notice) return null

  const stopAll = async () => {
    const ok = await showConfirm(
      `Stop ${runningAgents.length} working agent${runningAgents.length === 1 ? '' : 's'}? Live sessions abort, queued runs cancel, pending approvals are denied.`,
      { title: 'Stop all agents', confirmLabel: 'Stop all', danger: true }
    )
    if (!ok) return
    setStopping(true)
    try {
      const r = await api.post<{
        cancelledQueued: number
        deniedApprovals: number
        abortedRuns: number
      }>('/api/runs/stop-all')
      setNotice(`🛑 Stopped ${r.abortedRuns + r.cancelledQueued} runs`)
      setTimeout(() => setNotice(null), 4000)
    } catch (err) {
      setNotice(`❌ ${err instanceof Error ? err.message : 'failed'}`)
      setTimeout(() => setNotice(null), 4000)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-full border border-zinc-700/80 bg-zinc-950/95 py-2 pl-4 pr-2 shadow-[0_8px_40px_-8px_rgba(0,0,0,0.9)] backdrop-blur">
      {notice ? (
        <span className="pr-2 text-sm text-zinc-200">{notice}</span>
      ) : (
        <>
          <span className="flex items-center gap-1.5 text-sm text-zinc-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            working
          </span>
          <span className="flex items-center gap-1">
            {runningAgents.slice(0, 5).map((a) => (
              <span
                key={a.id}
                title={a.name}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-amber-500/40 bg-zinc-900 text-sm"
              >
                {a.avatarEmoji}
              </span>
            ))}
            {runningAgents.length > 5 && (
              <span className="text-xs text-zinc-500">+{runningAgents.length - 5}</span>
            )}
          </span>
          {isAdmin && (
            <button
              onClick={() => void stopAll()}
              disabled={stopping}
              title="Emergency stop — abort all agent runs"
              className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-bold text-white shadow-[0_0_20px_-4px_rgba(239,68,68,0.8)] transition hover:bg-red-500 disabled:opacity-50"
            >
              {stopping ? '…' : '🛑 STOP'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
