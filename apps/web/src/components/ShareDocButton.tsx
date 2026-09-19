import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { showConfirm } from '../lib/dialogs'

interface DocShareState {
  url: string
  allowedEmails: string[] | null
  updatedAt: number
}

interface ShareDocButtonProps {
  artifactId: string
  /** Only an approved doc can be shared. */
  enabled: boolean
}

/**
 * Share an approved doc over the internet: a page on opencrew.run for anyone
 * with the link, or only for the people whose emails you list (they sign in
 * at opencrew.run). The page is a copy as of now; Update refreshes it.
 */
export function ShareDocButton({ artifactId, enabled }: ShareDocButtonProps) {
  const [open, setOpen] = useState(false)
  const [share, setShare] = useState<DocShareState | null>(null)
  const [mode, setMode] = useState<'anyone' | 'emails'>('anyone')
  const [emails, setEmails] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setShare(null)
    api
      .get<DocShareState | null>(`/api/artifacts/${artifactId}/share`)
      .then((s) => {
        setShare(s)
        if (s?.allowedEmails) {
          setMode('emails')
          setEmails(s.allowedEmails.join(', '))
        }
      })
      .catch(() => {})
  }, [artifactId])

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      const list = mode === 'emails' ? emails.split(/[\s,;]+/).filter(Boolean) : []
      if (mode === 'emails' && list.length === 0) {
        setError('Add at least one email, or share with anyone who has the link.')
        return
      }
      setShare(await api.post<DocShareState>(`/api/artifacts/${artifactId}/share`, { emails: list }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sharing failed — try again.')
    } finally {
      setBusy(false)
    }
  }

  const unshare = async () => {
    const ok = await showConfirm('Take the page down? The link stops working right away.', {
      title: 'Stop sharing',
      confirmLabel: 'Stop sharing',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await api.delete(`/api/artifacts/${artifactId}/share`)
      setShare(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not take it down — try again.')
    } finally {
      setBusy(false)
    }
  }

  const copy = () => {
    if (!share) return
    void navigator.clipboard.writeText(share.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (!enabled) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={share ? 'Shared on opencrew.run' : 'Share this doc over the internet'}
        className={`rounded border px-2 py-0.5 text-xs transition ${
          share
            ? 'border-emerald-700 text-emerald-300 hover:border-emerald-500'
            : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white'
        }`}
      >
        {share ? '🔗 Shared' : 'Share'}
      </button>

      {open && (
        <div
          className="absolute right-0 top-7 z-30 w-80 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-left shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-bold">Share this doc</h4>
            <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-white">
              ✕
            </button>
          </div>

          <label className="flex cursor-pointer items-start gap-2 py-1 text-sm">
            <input type="radio" checked={mode === 'anyone'} onChange={() => setMode('anyone')} className="mt-1" />
            <span>
              Anyone with the link
              <span className="block text-xs text-zinc-500">No sign-in needed. Good for posting.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 py-1 text-sm">
            <input type="radio" checked={mode === 'emails'} onChange={() => setMode('emails')} className="mt-1" />
            <span>
              Only these people
              <span className="block text-xs text-zinc-500">They sign in at opencrew.run with this email.</span>
            </span>
          </label>
          {mode === 'emails' && (
            <textarea
              className="input mt-1 h-16 w-full font-mono text-xs"
              placeholder="ana@company.com, sam@company.com"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
            />
          )}

          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

          {share && (
            <div className="mt-3 flex items-center gap-2">
              <input
                readOnly
                value={share.url}
                onClick={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-emerald-300"
              />
              <button onClick={copy} className="rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-zinc-500">
                {copied ? '✓' : 'copy'}
              </button>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <button onClick={() => void publish()} disabled={busy} className="btn-primary text-xs">
              {busy ? '…' : share ? 'Update' : 'Share'}
            </button>
            {share && (
              <button onClick={() => void unshare()} disabled={busy} className="text-xs text-zinc-500 hover:text-red-400">
                Stop sharing
              </button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-zinc-600">
            A copy as of now; Update refreshes it. Needs the crew linked to opencrew.run.
          </p>
        </div>
      )}
    </div>
  )
}
