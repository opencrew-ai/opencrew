import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { presenceKey, useWorkspace } from '../lib/workspace'
import { showAlert, showPrompt } from '../lib/dialogs'
import { useAgentLoad } from '../lib/useAgentLoad'
import { Logo } from './Logo'
import { PresenceDot } from './PresenceDot'
import type { Channel } from '@opencrew/shared'

interface SidebarProps {
  activeChannelId?: string
  /** Mobile only: whether the sidebar overlay is open */
  open?: boolean
  /** Mobile only: called when the user dismisses the overlay */
  onClose?: () => void
}

export function Sidebar({ activeChannelId, open, onClose }: SidebarProps) {
  const { me, channels, agents, users, presence, logout, refreshChannels } = useWorkspace()
  const navigate = useNavigate()
  const agentLoad = useAgentLoad()
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)

  const copyInvite = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setInviteCopied(true)
      setTimeout(() => setInviteCopied(false), 2000)
    } catch {
      // Clipboard unavailable (http origin) — the input stays selectable.
    }
  }
  const isAdmin = me.role === 'admin'
  const panelRef = useRef<HTMLDivElement>(null)

  // Focus trap: when the mobile overlay opens, keep keyboard/screen-reader
  // focus inside the panel (WCAG 2.1 SC 2.1.2 No Keyboard Trap).
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return

    const focusable = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])'
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    first?.focus()

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      if (focusable.length === 0) { e.preventDefault(); return }
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    panel.addEventListener('keydown', trap)
    return () => panel.removeEventListener('keydown', trap)
  }, [open])

  const createChannel = async () => {
    const name = await showPrompt('Channel name (lowercase, dashes):', {
      title: 'New channel',
      placeholder: 'growth-experiments',
      confirmLabel: 'Create'
    })
    if (!name) return
    try {
      const channel = await api.post<Channel>('/api/channels', { name, topic: '' })
      await refreshChannels()
      navigate(`/channels/${channel.id}`)
      onClose?.()
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'failed', { title: 'Channel not created' })
    }
  }

  const createInvite = async () => {
    const { path, relayJoinUrl } = await api.post<{ path: string; relayJoinUrl?: string | null }>(
      '/api/invites'
    )
    // Cloud-linked: hand out the opencrew.run join link — it works from
    // anywhere. The local /invite path only works on this network.
    setInviteUrl(relayJoinUrl ?? `${location.origin}${path}`)
  }

  const renameMe = async () => {
    const name = await showPrompt('Your display name:', {
      title: 'Rename yourself',
      initial: me.name,
      confirmLabel: 'Rename'
    })
    if (!name || name.trim() === me.name) return
    try {
      await api.post('/api/users/me', { name: name.trim() })
    } catch (err) {
      void showAlert(err instanceof Error ? err.message : 'rename failed', { title: 'Rename failed' })
    }
  }

  const stateOf = (type: 'human' | 'agent', id: string) =>
    presence.get(presenceKey(type, id))?.state ?? (type === 'human' ? 'offline' : 'idle')

  const aside = (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-950">
      <div className="flex items-center gap-2.5 border-b border-zinc-800/70 px-4 py-3">
        <Logo className="h-7 w-7" />
        <span className="font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          OpenCrew HQ
        </span>
        <Link
          to="/settings"
          onClick={onClose}
          className="ml-auto text-zinc-500 hover:text-white"
          title="Workspace settings"
        >
          ⚙
        </Link>
        {/* Close button — mobile only */}
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white md:hidden"
            aria-label="Close menu"
          >
            ✕
          </button>
        )}
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
                  onClick={onClose}
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
              <Link to="/agents" onClick={onClose} className="text-zinc-400 hover:text-white" title="Manage agents">
                +
              </Link>
            )}
          </div>
          <div className="mt-1">
            {[...agents]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((a) => {
                const load = agentLoad.get(a.id)
                return (
                  <Link
                    key={a.id}
                    to={`/agents/${a.id}`}
                    onClick={onClose}
                    className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
                    title={
                      load?.status === 'rate_limited'
                        ? `Rate limited — ${load.runsLastHour}/${load.maxRunsPerHour} runs/hr`
                        : load?.status === 'busy'
                          ? `${load.activeRuns} active run${load.activeRuns !== 1 ? 's' : ''}`
                          : undefined
                    }
                  >
                    <PresenceDot state={stateOf('agent', a.id)} />
                    <span>{a.avatarEmoji}</span>
                    <span className={`flex-1 ${a.status === 'paused' ? 'line-through opacity-50' : ''}`}>
                      {a.name}
                    </span>
                    {load?.status === 'rate_limited' && (
                      <span className="text-[10px] text-red-400" title="Rate limited">⛔</span>
                    )}
                    {load?.status === 'busy' && load.activeRuns >= 2 && (
                      <span className="text-[10px] text-amber-400" title={`${load.activeRuns} active runs`}>
                        ×{load.activeRuns}
                      </span>
                    )}
                  </Link>
                )
              })}
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
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  className="min-w-0 flex-1 bg-transparent text-sky-400"
                  value={inviteUrl}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={() => void copyInvite()}
                  className={`shrink-0 rounded border px-2 py-0.5 transition ${
                    inviteCopied
                      ? 'border-emerald-600 text-emerald-400'
                      : 'border-zinc-600 text-zinc-300 hover:border-zinc-400'
                  }`}
                >
                  {inviteCopied ? '✓ copied' : 'copy'}
                </button>
              </div>
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

  // On desktop: render inline as part of the flex row.
  // On mobile: render as a fixed overlay that slides in from the left.
  return (
    <>
      {/* Desktop sidebar — hidden on small screens */}
      <div className="hidden md:contents">
        {aside}
      </div>

      {/* Mobile overlay */}
      <div className="md:hidden">
        {/* Backdrop */}
        {open && (
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />
        )}
        {/* Slide-in panel */}
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col transition-transform duration-300 ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {aside}
        </div>
      </div>
    </>
  )
}
