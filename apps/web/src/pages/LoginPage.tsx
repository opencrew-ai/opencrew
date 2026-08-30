import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { Logo } from '../components/Logo'

interface LoginPageProps {
  isBootstrap: boolean
  onAuthed: () => void
}

export function LoginPage({ isBootstrap, onAuthed }: LoginPageProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Served through the opencrew.run relay: the local password form is a dead
  // end (accounts live at opencrew.run) — send them to the portal instead.
  if (document.cookie.includes('ocr_via_relay=1')) {
    window.location.href = '/portal/login'
    return (
      <div className="bg-stage grid h-screen place-items-center text-sm text-zinc-400">
        Redirecting to opencrew.run sign-in…
      </div>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (isBootstrap) {
        await api.post('/api/auth/signup', { name, email, password })
      } else {
        await api.post('/api/auth/login', { email, password })
      }
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-stage grid h-screen place-items-center">
      <form onSubmit={submit} className="w-80 space-y-4">
        <div className="text-center">
          <Logo className="mx-auto h-14 w-14" />
          <h1 className="mt-3 text-2xl font-bold">OpenCrew</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {isBootstrap
              ? 'Create your workspace — you will be the admin.'
              : 'Sign in to your crew.'}
          </p>
        </div>
        {isBootstrap && (
          <input
            className="input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          className="input"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="input"
          type="password"
          placeholder={isBootstrap ? 'Password (8+ chars)' : 'Password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? '…' : isBootstrap ? 'Create workspace' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
