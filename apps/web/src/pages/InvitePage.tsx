import { useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../lib/api'

export function InvitePage({ onAuthed }: { onAuthed: () => void }) {
  const { token } = useParams<{ token: string }>()
  const [valid, setValid] = useState<boolean | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get(`/api/invites/${token}`)
      .then(() => setValid(true))
      .catch(() => setValid(false))
  }, [token])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await api.post('/api/auth/signup', { name, email, password, inviteToken: token })
      onAuthed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    }
  }

  if (valid === null) {
    return <div className="grid h-screen place-items-center text-zinc-500">Checking invite…</div>
  }
  if (!valid) {
    return (
      <div className="grid h-screen place-items-center text-zinc-400">
        This invite link is invalid or expired.
      </div>
    )
  }

  return (
    <div className="grid h-screen place-items-center bg-zinc-950">
      <form onSubmit={submit} className="w-80 space-y-4">
        <div className="text-center">
          <div className="text-4xl">⚓</div>
          <h1 className="mt-2 text-xl font-bold">Join the crew</h1>
          <p className="mt-1 text-sm text-zinc-400">You've been invited to OpenCrew.</p>
        </div>
        <input
          className="input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
          placeholder="Password (8+ chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn-primary w-full">Join workspace</button>
      </form>
    </div>
  )
}
