import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Sidebar } from '../components/Sidebar'
import { CloudLinkCard } from '../components/CloudLinkCard'
import { DeviceAccessCard } from '../components/DeviceAccessCard'
import { useWorkspace } from '../lib/workspace'

interface WorkspaceSettings {
  maxMentionDepth: number
}

export function SettingsPage() {
  const { me } = useWorkspace()
  const [loaded, setLoaded] = useState<WorkspaceSettings | null>(null)
  const [maxMentionDepth, setMaxMentionDepth] = useState(4)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopStatus, setStopStatus] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const isAdmin = me.role === 'admin'

  const stopAll = async () => {
    if (!confirm('Stop ALL agents? Live sessions are aborted, queued runs cancelled, pending approvals denied.')) {
      return
    }
    setStopping(true)
    setStopStatus(null)
    try {
      const r = await api.post<{
        cancelledQueued: number
        deniedApprovals: number
        abortedRuns: number
      }>('/api/runs/stop-all')
      setStopStatus(
        `🛑 Stopped: ${r.abortedRuns} live run${r.abortedRuns === 1 ? '' : 's'} aborted, ` +
          `${r.cancelledQueued} queued cancelled, ${r.deniedApprovals} approval${
            r.deniedApprovals === 1 ? '' : 's'
          } denied.`
      )
    } catch (err) {
      setStopStatus(`❌ ${err instanceof Error ? err.message : 'failed'}`)
    } finally {
      setStopping(false)
    }
  }

  useEffect(() => {
    api.get<WorkspaceSettings>('/api/settings').then((s) => {
      setLoaded(s)
      setMaxMentionDepth(s.maxMentionDepth)
    })
  }, [])

  const save = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const updated = await api.post<WorkspaceSettings>('/api/settings', {
        maxMentionDepth
      })
      setLoaded(updated)
      setMaxMentionDepth(updated.maxMentionDepth)
      setStatus('✅ Saved — applies to the next message.')
    } catch (err) {
      setStatus(`❌ ${err instanceof Error ? err.message : 'save failed'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="text-xl font-bold">Workspace settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Crew-wide behavior. Per-agent guardrails (tools, gates, rate limits) live on each
          agent&apos;s page.
        </p>

        {!loaded ? (
          <p className="mt-8 text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="mt-8 max-w-xl rounded-lg border border-zinc-800 p-5">
            <h2 className="font-semibold">Agent collaboration</h2>
            <div className="mt-4">
              <label className="label">Mention chain depth limit</label>
              <p className="mb-2 text-xs text-zinc-500">
                How many agent→agent handoffs a chain may make before stopping (you →
                Captain is 0, Captain → Coder is 1, …). No cap — your call. Each
                agent&apos;s max runs/hour remains the safety valve against loops, and the
                red button below is the kill switch.
              </p>
              <div className="flex items-center gap-3">
                <input
                  className="input w-28"
                  type="number"
                  min={1}
                  value={maxMentionDepth}
                  onChange={(e) => setMaxMentionDepth(Number(e.target.value))}
                  disabled={!isAdmin}
                />
                {isAdmin && (
                  <button className="btn-primary" onClick={() => void save()} disabled={busy}>
                    {busy ? '…' : 'Save'}
                  </button>
                )}
              </div>
              {!isAdmin && (
                <p className="mt-2 text-xs text-zinc-500">Only admins can change settings.</p>
              )}
              {status && <p className="mt-2 text-sm text-zinc-300">{status}</p>}
            </div>
          </div>
        )}

        <CloudLinkCard />

        <DeviceAccessCard />

        {isAdmin && (
          <div className="mt-6 max-w-xl rounded-lg border border-red-900/60 bg-red-950/10 p-5">
            <h2 className="font-semibold text-red-300">Emergency stop</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Immediately aborts every live agent session, cancels everything queued, and
              denies all pending approval cards. Persistent sessions and workspaces are
              untouched — agents respond normally to the next message.
            </p>
            <button
              onClick={() => void stopAll()}
              disabled={stopping}
              className="mt-4 rounded-lg bg-red-600 px-6 py-3 text-sm font-bold text-white shadow-[0_0_30px_-8px_rgba(239,68,68,0.7)] transition hover:bg-red-500 disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : '🛑 STOP ALL AGENTS'}
            </button>
            {stopStatus && <p className="mt-3 text-sm text-zinc-300">{stopStatus}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
