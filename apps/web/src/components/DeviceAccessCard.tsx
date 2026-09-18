import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { QrCode } from './QrCode'
import { useWorkspace } from '../lib/workspace'

interface NetworkInfo {
  lanIps: string[]
  tunnel: { url: string; startedAt: number } | null
}

/**
 * Access from other devices: LAN URLs + QR for the same network, and a
 * one-button public tunnel for everywhere else. Sign in on the other device
 * with the same account — auth is the boundary.
 */
export function DeviceAccessCard() {
  const { me } = useWorkspace()
  const [info, setInfo] = useState<NetworkInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isAdmin = me.role === 'admin'

  const refresh = () => api.get<NetworkInfo>('/api/network').then(setInfo).catch(() => {})

  useEffect(() => {
    void refresh()
  }, [])

  const lanUrl = info?.lanIps[0]
    ? `http://${info.lanIps[0]}:${location.port || '5173'}`
    : null

  const toggleTunnel = async () => {
    setBusy(true)
    setError(null)
    try {
      if (info?.tunnel) {
        await api.post('/api/tunnel/stop')
      } else {
        await api.post('/api/tunnel/start')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 max-w-xl rounded-lg border border-zinc-800 p-5">
      <h2 className="font-semibold">📱 Same Wi-Fi</h2>
      <p className="mt-1 text-sm text-zinc-400">
        A phone or tablet on this network can open the crew directly. Scan, sign in with the
        same account, and use &ldquo;Add to Home Screen&rdquo; for the app feel. From anywhere
        else, link to opencrew.run above.
      </p>

      <div className="mt-4">
        {lanUrl ? (
          <div className="space-y-2">
            <QrCode value={lanUrl} />
            <code className="block break-all font-mono text-xs text-emerald-300">{lanUrl}</code>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">No LAN address detected.</p>
        )}
      </div>

      {/* The tunnel is for people who'd rather not use opencrew.run at all. */}
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
          Advanced: your own public tunnel instead of opencrew.run
        </summary>
        <div className="mt-3">
          {info?.tunnel ? (
            <div className="space-y-2">
              <QrCode value={info.tunnel.url} />
              <a
                href={info.tunnel.url}
                target="_blank"
                rel="noreferrer"
                className="block break-all font-mono text-xs text-emerald-400 underline"
              >
                {info.tunnel.url}
              </a>
              {isAdmin && (
                <button className="btn-danger px-3 py-1.5 text-xs" onClick={() => void toggleTunnel()} disabled={busy}>
                  {busy ? '…' : 'Stop public access'}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">
                Starts a secure Cloudflare tunnel to this machine (HTTPS, WebSockets). The URL is
                unguessable but public — your password is the lock. Stop it when done.
              </p>
              {isAdmin && (
                <button className="btn-primary" onClick={() => void toggleTunnel()} disabled={busy}>
                  {busy ? 'Starting…' : 'Enable remote access'}
                </button>
              )}
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
      </details>
    </div>
  )
}
