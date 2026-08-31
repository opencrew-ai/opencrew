import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { showConfirm } from '../lib/dialogs'

interface ShareState {
  url: string
  updatedAt: number
}

interface ShareThreadButtonProps {
  rootId: string
}

/**
 * Publish this thread as a public page (opencrew.run/t/…) and hand the user
 * ready-made X / LinkedIn share intents. Snapshot semantics: the page shows
 * the thread as of the last "share" click — Update refreshes it.
 */
export function ShareThreadButton({ rootId }: ShareThreadButtonProps) {
  const [share, setShare] = useState<ShareState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setShare(null)
    setOpen(false)
    setError(null)
    api
      .get<ShareState | null>(`/api/threads/${rootId}/share`)
      .then(setShare)
      .catch(() => {})
  }, [rootId])

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.post<ShareState>(`/api/threads/${rootId}/share`)
      setShare(next)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sharing failed — try again.')
    } finally {
      setBusy(false)
    }
  }

  const unshare = async () => {
    const confirmed = await showConfirm(
      'Take the public page down? Anyone with the link will lose access.',
      { danger: true, confirmLabel: 'Unshare' }
    )
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      await api.delete(`/api/threads/${rootId}/share`)
      setShare(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unshare failed — try again.')
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    if (!share) return
    void navigator.clipboard.writeText(share.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const openDialog = () => {
    setOpen(true)
    setError(null)
    if (!share) void publish()
  }

  const shareText = 'My AI agent crew at work — a real thread from our OpenCrew HQ:'
  const xUrl = share
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(share.url)}`
    : '#'
  const linkedInUrl = share
    ? `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(share.url)}`
    : '#'

  return (
    <div className="relative">
      <button
        onClick={openDialog}
        title="Share this thread publicly"
        className={`text-xs font-medium transition ${share ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-500 hover:text-white'}`}
      >
        {share ? '🔗 Shared' : 'Share'}
      </button>

      {open && (
        <div className="absolute left-0 top-7 z-30 w-80 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold">Share thread publicly</h4>
            <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-white">
              ✕
            </button>
          </div>

          {busy && <p className="text-sm text-zinc-400">Publishing…</p>}
          {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

          {share && !busy && (
            <>
              <p className="mb-2 text-xs text-zinc-400">
                Anyone with this link sees a snapshot of the thread as of now — later replies
                stay private until you hit Update.
              </p>
              <div className="mb-3 flex items-center gap-2">
                <input
                  readOnly
                  value={share.url}
                  onClick={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-sky-300"
                />
                <button
                  onClick={copy}
                  className="rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
                >
                  {copied ? '✓' : 'copy'}
                </button>
              </div>
              <div className="mb-3 flex gap-2">
                <a
                  href={xUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 rounded-lg bg-zinc-100 px-3 py-1.5 text-center text-xs font-bold text-zinc-900 hover:bg-white"
                >
                  Post on X
                </a>
                <a
                  href={linkedInUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-center text-xs font-semibold text-zinc-200 hover:border-zinc-500"
                >
                  LinkedIn
                </a>
              </div>
              <div className="flex items-center justify-between text-xs">
                <button
                  onClick={() => void publish()}
                  className="text-zinc-400 transition hover:text-white"
                >
                  ↻ Update snapshot
                </button>
                <button onClick={() => void unshare()} className="text-red-400 hover:text-red-300">
                  Unshare
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
