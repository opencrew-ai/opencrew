import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { QrCode } from './QrCode'
import { useWorkspace } from '../lib/workspace'

interface CloudStatus {
  linked: boolean
  connected: boolean
  slug: string | null
  relayUrl: string
  pendingApproveUrl: string | null
}

/**
 * Link this instance to an opencrew.run profile: chat with the crew from
 * anywhere by signing in at opencrew.run — no tunnels, no changing URLs.
 */
export function CloudLinkCard() {
  const { me } = useWorkspace()
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [approveUrl, setApproveUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isAdmin = me.role === 'admin'

  const refresh = () =>
    api.get<CloudStatus>('/api/cloudlink/status').then((s) => {
      setStatus(s)
      if (s.linked) setApproveUrl(null)
      else if (s.pendingApproveUrl) setApproveUrl(s.pendingApproveUrl)
    })

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [])

  const startLink = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ approveUrl: string; code: string }>('/api/cloudlink/start', {
        instanceName: 'OpenCrew HQ'
      })
      setApproveUrl(r.approveUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    if (!confirm('Unlink from opencrew.run? Remote access via your profile stops immediately.')) return
    await api.post('/api/cloudlink/unlink')
    setApproveUrl(null)
    await refresh()
  }

  return (
    <div className="mt-6 max-w-xl rounded-lg border border-emerald-900/50 bg-emerald-950/10 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        🌐 opencrew.run
        {status?.linked && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
              status.connected
                ? 'bg-emerald-900/60 text-emerald-300'
                : 'bg-amber-900/60 text-amber-300'
            }`}
          >
            {status.connected ? 'connected' : 'reconnecting…'}
          </span>
        )}
      </h2>

      {status?.linked ? (
        <div className="mt-2 space-y-2 text-sm text-zinc-400">
          <p>
            This crew is linked to your profile as{' '}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-emerald-300">
              {status.slug}
            </code>
            . Chat from any device: sign in at{' '}
            <a href={status.relayUrl} target="_blank" rel="noreferrer" className="text-emerald-400 underline">
              {status.relayUrl.replace(/^https?:\/\//, '')}
            </a>
            .
          </p>
          {isAdmin && (
            <button className="btn-danger px-3 py-1.5 text-xs" onClick={() => void unlink()}>
              Unlink
            </button>
          )}
        </div>
      ) : approveUrl ? (
        <div className="mt-2 space-y-3">
          <p className="text-sm text-zinc-400">
            Open this link (or scan it) and approve on your opencrew.run profile — this page
            updates automatically once linked.
          </p>
          <QrCode value={approveUrl} />
          <a
            href={approveUrl}
            target="_blank"
            rel="noreferrer"
            className="block break-all font-mono text-xs text-emerald-400 underline"
          >
            {approveUrl}
          </a>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-sm text-zinc-400">
            Link this crew to your opencrew.run profile and chat with your agents from any
            device — sign in once, no tunnels, no changing URLs.
          </p>
          {isAdmin && (
            <button className="btn-primary" onClick={() => void startLink()} disabled={busy}>
              {busy ? '…' : 'Link to opencrew.run'}
            </button>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  )
}
