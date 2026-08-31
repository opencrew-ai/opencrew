import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { presenceKey, useWorkspace } from '../lib/workspace'
import { useAgentActivity } from '../lib/useAgentActivity'
import { showConfirm } from '../lib/dialogs'

const LABEL_MAX = 44
const NAMED_ROWS = 3

/**
 * Floating crew activity pill — visible on every page, but only while agents
 * are actually working. Shows who is running and carries the emergency stop,
 * so the kill switch is always one click away exactly when it matters.
 */
export function CrewActivityBar() {
  const { me, agents, presence } = useWorkspace()
  const activity = useAgentActivity()
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

  // The theater of parallel work: each agent gets a row with a live
  // present-tense verb ("wiring badge flag") pulled from its TodoWrite /
  // tool activity. Overflow collapses into a count.
  const namedRows = runningAgents.slice(0, NAMED_ROWS)
  const overflow = runningAgents.length - namedRows.length

  return (
    <div className="fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl border border-zinc-700/80 bg-zinc-950/95 px-4 py-2.5 shadow-[0_8px_40px_-8px_rgba(0,0,0,0.9)] backdrop-blur">
      {notice ? (
        <span className="text-sm text-zinc-200">{notice}</span>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 space-y-1">
            {namedRows.map((a) => {
              const rawLabel = activity.get(a.id)
              const label = rawLabel
                ? rawLabel.length > LABEL_MAX
                  ? `${rawLabel.slice(0, LABEL_MAX).trimEnd()}…`
                  : rawLabel
                : 'working'
              return (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-amber-500/40 bg-zinc-900 text-sm">
                    {a.avatarEmoji}
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                  </span>
                  <span className="font-medium text-zinc-200">{a.name}</span>
                  <span className="truncate italic text-zinc-500">{label}</span>
                </div>
              )
            })}
            {overflow > 0 && (
              <div className="pl-8 text-[11px] text-zinc-500">
                +{overflow} more agent{overflow === 1 ? '' : 's'} working
              </div>
            )}
          </div>
          {isAdmin && (
            <button
              onClick={() => void stopAll()}
              disabled={stopping}
              title="Emergency stop — abort all agent runs"
              className="shrink-0 rounded-full bg-red-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_0_20px_-4px_rgba(239,68,68,0.8)] transition hover:bg-red-500 disabled:opacity-50"
            >
              {stopping ? '…' : '🛑 STOP'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
