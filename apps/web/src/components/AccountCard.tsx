import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useWorkspace } from '../lib/workspace'

/**
 * Change your own password. Hidden behind the relay — there, identity comes
 * from the opencrew.run portal session, not a local password.
 */
export function AccountCard() {
  const { me } = useWorkspace()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  if (document.cookie.includes('ocr_via_relay=1')) return null

  const save = async () => {
    if (newPassword !== confirm) {
      setStatus('New passwords do not match.')
      return
    }
    setIsSaving(true)
    setStatus(null)
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword })
      setStatus('Password updated.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirm('')
    } catch (error: unknown) {
      setStatus(error instanceof ApiError ? error.message : 'Something went wrong — try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const inputClass =
    'w-full rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none'

  return (
    <div className="mt-6 max-w-xl rounded-lg border border-zinc-800 p-5">
      <h2 className="font-semibold">Account</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Signed in as <span className="text-zinc-300">{me.name}</span> ({me.email}). Change your
        password below.
      </p>
      <div className="mt-4 space-y-2">
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className={inputClass}
        />
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password (min 8 characters)"
          autoComplete="new-password"
          className={inputClass}
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm new password"
          autoComplete="new-password"
          className={inputClass}
        />
      </div>
      <button
        onClick={() => void save()}
        disabled={isSaving || !currentPassword || newPassword.length < 8}
        className="mt-3 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 disabled:opacity-40"
      >
        Update password
      </button>
      {status && <p className="mt-2 text-sm text-zinc-300">{status}</p>}
    </div>
  )
}
