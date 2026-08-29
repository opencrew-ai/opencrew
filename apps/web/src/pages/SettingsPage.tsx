import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Sidebar } from '../components/Sidebar'
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
  const isAdmin = me.role === 'admin'

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
                Captain is 0, Captain → Coder is 1, …). Higher = livelier crews; each
                agent&apos;s max runs/hour remains the hard safety valve against loops.
              </p>
              <div className="flex items-center gap-3">
                <input
                  className="input w-28"
                  type="number"
                  min={1}
                  max={20}
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
      </div>
    </div>
  )
}
