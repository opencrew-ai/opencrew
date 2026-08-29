import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { presenceKey, useWorkspace } from '../lib/workspace'
import { PresenceDot } from './PresenceDot'
import type { Channel } from '@opencrew/shared'

export function Sidebar({ activeChannelId }: { activeChannelId?: string }) {
  const { me, channels, agents, users, presence, logout, refreshChannels } = useWorkspace()
  const navigate = useNavigate()
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const isAdmin = me.role === 'admin'

  const createChannel = async () => {
    const name = prompt('Channel name (lowercase, dashes):')
    if (!name) return
    try {
      const channel = await api.post<Channel>('/api/channels', { name, topic: '' })
      await refreshChannels()
      navigate(`/channels/${channel.id}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'failed')
    }
  }

  const createInvite = async () => {
    const { path } = await api.post<{ path: string }>('/api/invites')
    setInviteUrl(`${location.origin}${path}`)
  }

  const renameMe = async () => {
    const name = prompt('Your display name:', me.name)
    if (!name || name.trim() === me.name) return
    try {
      await api.post('/api/users/me', { name: name.trim() })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'rename failed')
    }
  }

  const stateOf = (type: 'human' | 'agent', id: string) =>
    presence.get(presenceKey(type, id))?.state ?? (type === 'human' ? 'offline' : 'idle')

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-950/60">
      <div className="flex items-center gap-2.5 border-b border-zinc-800/70 px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-base">
          ⚓
        </span>
        <span className="font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          OpenCrew HQ
        </span>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-2 py-4">
        <section>
          <div className="flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            <span>Channels</span>
            <button onClick={createChannel} className="text-zinc-400 hover:text-white" title="New channel">
              +
            </button>
          </div>
          <nav className="mt-1">
            {[...channels]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <Link
                  key={c.id}
                  to={`/channels/${c.id}`}
                  className={`block rounded-md px-2 py-1 text-sm ${
                    c.id === activeChannelId
                      ? 'bg-emerald-500/15 font-medium text-emerald-100'
                      : 'text-zinc-300 hover:bg-zinc-800/80'
                  }`}
                >
                  # {c.name}
                </Link>
              ))}
          </nav>
        </section>

        <section>
          <div className="flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            <span>Agents</span>
            {isAdmin && (
              <Link to="/agents" className="text-zinc-400 hover:text-white" title="Manage agents">
                +
              </Link>
            )}
          </div>
          <div className="mt-1">
            {[...agents]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((a) => (
                <Link
                  key={a.id}
                  to={`/agents/${a.id}`}
                  className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  <PresenceDot state={stateOf('agent', a.id)} />
                  <span>{a.avatarEmoji}</span>
                  <span className={a.status === 'paused' ? 'line-through opacity-50' : ''}>
                    {a.name}
                  </span>
                </Link>
              ))}
            {agents.length === 0 && (
              <p className="px-2 text-xs text-zinc-600">No agents yet.</p>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            <span>Humans</span>
            {isAdmin && (
              <button onClick={createInvite} className="text-zinc-400 hover:text-white" title="Invite">
                +
              </button>
            )}
          </div>
          <div className="mt-1">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-2 px-2 py-1 text-sm text-zinc-300">
                <PresenceDot state={stateOf('human', u.id)} />
                <span>{u.name}</span>
                {u.id === me.id && <span className="text-xs text-zinc-500">(you)</span>}
              </div>
            ))}
          </div>
          {inviteUrl && (
            <div className="mx-2 mt-2 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs">
              <p className="mb-1 text-zinc-400">Share this invite link:</p>
              <input
                readOnly
                className="w-full bg-transparent text-sky-400"
                value={inviteUrl}
                onFocus={(e) => e.target.select()}
              />
            </div>
          )}
        </section>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3 text-sm">
        <div className="flex items-center justify-between">
          <button
            onClick={() => void renameMe()}
            className="text-zinc-300 hover:text-white"
            title="Click to change your display name"
          >
            {me.name} <span className="text-xs text-zinc-600">✎</span>
          </button>
          <button onClick={() => void logout()} className="text-xs text-zinc-500 hover:text-white">
            Sign out
          </button>
        </div>
      </div>
    </aside>
  )
}
