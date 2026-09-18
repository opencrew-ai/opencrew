import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { presenceKey, useWorkspace } from '../lib/workspace'
import { showAlert, showPrompt } from '../lib/dialogs'
import { useAgentLoad } from '../lib/useAgentLoad'
import { useAgentActivity, useLiveChannels } from '../lib/useAgentActivity'
import { useAttention } from '../lib/useAttention'
import { AttentionModal } from './AttentionModal'
import { NewProjectDialog } from './NewProjectDialog'
import type { AgentWithVersion, AttentionItem, Project } from '@opencrew/shared'
import { Logo } from './Logo'
import { FolderIcon, GearIcon, TasksIcon, TodayIcon } from './Icons'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { PresenceDot } from './PresenceDot'
import type { Channel } from '@opencrew/shared'

/** Colored dot that marks everything belonging to a project; HQ has none. */
function ProjectDot({ project, className = '' }: { project: Project | null; className?: string }) {
  if (!project) return null
  return (
    <span
      aria-hidden="true"
      title={project.name}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`}
      style={{ backgroundColor: project.color }}
    />
  )
}

interface TodayStats {
  runs: number
  costUsd: number
}

const STATS_REFRESH_DEBOUNCE_MS = 3000

/** Today's crew economics — refreshed when runs reach a terminal state. */
function useTodayStats(): TodayStats | null {
  const [stats, setStats] = useState<TodayStats | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const load = () => {
      api
        .get<{ today?: TodayStats }>('/api/stats')
        .then((data) => setStats(data.today ?? null))
        .catch(() => {})
    }
    load()
    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type !== 'run_status') return
      if (event.status !== 'done' && event.status !== 'failed') return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(load, STATS_REFRESH_DEBOUNCE_MS)
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return stats
}

interface SidebarProps {
  activeChannelId?: string
  /** Mobile only: whether the sidebar overlay is open */
  open?: boolean
  /** Mobile only: called when the user dismisses the overlay */
  onClose?: () => void
}

export function Sidebar({ activeChannelId, open, onClose }: SidebarProps) {
  const {
    me,
    channels,
    agents,
    projects,
    users,
    presence,
    projectOfChannel,
    logout,
    refreshChannels,
    refreshProjects
  } = useWorkspace()
  const navigate = useNavigate()
  const [showNewProject, setShowNewProject] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const agentLoad = useAgentLoad()
  const agentActivity = useAgentActivity()
  const attention = useAttention()
  const todayStats = useTodayStats()
  const liveChannels = useLiveChannels()
  const [activeAttention, setActiveAttention] = useState<AttentionItem | null>(null)
  // Transient undo affordance after dismissing/clearing inbox items.
  const [showUndoClear, setShowUndoClear] = useState(false)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const offerUndo = () => {
    setShowUndoClear(true)
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setShowUndoClear(false), 8000)
  }
  const dismissItem = (item: AttentionItem) => {
    void api
      .post('/api/attention/dismiss', { kind: item.kind, refId: item.refId })
      .then(offerUndo)
      .catch(() => {})
  }
  const clearAll = () => {
    void api.post('/api/attention/clear', {}).then(offerUndo).catch(() => {})
  }
  const undoClear = () => {
    setShowUndoClear(false)
    void api.post('/api/attention/restore', {}).catch(() => {})
  }
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

  const createChannel = async (project: Project | null) => {
    const name = await showPrompt('Channel name (lowercase, dashes):', {
      title: project ? `New channel in ${project.name}` : 'New HQ channel',
      placeholder: 'growth-experiments',
      confirmLabel: 'Create'
    })
    if (!name) return
    try {
      const channel = await api.post<Channel>('/api/channels', {
        name,
        topic: '',
        projectId: project?.id ?? null
      })
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

  // Rooms and crews grouped by project. HQ first (the room that spans every
  // project), then projects in creation order. Each group shows how many of
  // its rooms have agents working and how many items wait on the human.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const needsYouByChannel = new Map<string, number>()
  for (const item of attention) {
    needsYouByChannel.set(item.channelId, (needsYouByChannel.get(item.channelId) ?? 0) + 1)
  }
  const groupFor = (project: Project | null) => {
    const groupChannels = channels
      .filter((c) => (c.projectId ?? null) === (project?.id ?? null))
      .sort(byName)
    return {
      key: project?.id ?? 'hq',
      label: project?.name ?? 'HQ',
      project,
      channels: groupChannels,
      working: groupChannels.filter((c) => liveChannels.has(c.id)).length,
      needsYou: groupChannels.reduce((n, c) => n + (needsYouByChannel.get(c.id) ?? 0), 0)
    }
  }
  // Needs You, by project: items sorted HQ-first then project order, with a
  // tiny header where the project changes (only when more than one is
  // represented). The first 8 items show; the rest are a count.
  const projectIndex = new Map<string | null, number>([[null, 0], ...projects.map((p, i) => [p.id, i + 1] as [string, number])])
  const attentionSorted = [...attention].sort(
    (a, b) =>
      (projectIndex.get(projectOfChannel(a.channelId)?.id ?? null) ?? 99) -
        (projectIndex.get(projectOfChannel(b.channelId)?.id ?? null) ?? 99) || b.createdAt - a.createdAt
  )
  const representedProjects = new Set(attentionSorted.map((i) => projectOfChannel(i.channelId)?.id ?? null))
  const needsYouRows: ({ type: 'header'; project: Project | null; key: string } | { type: 'item'; item: AttentionItem })[] = []
  let lastProject: string | null | undefined
  for (const item of attentionSorted.slice(0, 8)) {
    const project = projectOfChannel(item.channelId)
    const key = project?.id ?? null
    if (representedProjects.size > 1 && key !== lastProject) {
      needsYouRows.push({ type: 'header', project, key: `h-${key ?? 'hq'}` })
      lastProject = key
    }
    needsYouRows.push({ type: 'item', item })
  }

  const channelGroups = [groupFor(null), ...projects.map(groupFor)].filter(
    (g) => g.channels.length > 0 || g.project !== null
  )
  // The crew list is the STANDING crew — the names you address. Workers
  // come and go inside their task threads; retired agents stay in history.
  const agentGroups = [null, ...projects]
    .map((project) => ({
      key: project?.id ?? 'hq',
      label: project?.name ?? 'HQ',
      project,
      agents: agents
        .filter((a) => (a.projectId ?? null) === (project?.id ?? null))
        .filter((a) => a.kind !== 'worker' && a.status !== 'retired')
        .sort(byName)
    }))
    .filter((g) => g.agents.length > 0)

  const aside = (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-950">
      <div className="flex items-center gap-2.5 border-b border-zinc-800/70 px-4 py-3">
        <Logo className="h-7 w-7 shrink-0" />
        <span className="min-w-0 truncate font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          OpenCrew HQ
        </span>
        {/* Icon only: the name keeps the width. The gear is a real gear now. */}
        <Link
          to="/settings"
          onClick={onClose}
          className="ml-auto shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white"
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon className="h-4 w-4" />
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
        <Link
          to="/today"
          onClick={onClose}
          className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          <TodayIcon className="text-zinc-500" />
          <span>Today</span>
        </Link>
        <Link
          to="/artifacts"
          onClick={onClose}
          className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          <FolderIcon className="text-zinc-500" />
          <span>Artifacts</span>
        </Link>
        <Link
          to="/tasks"
          onClick={onClose}
          className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          <TasksIcon className="text-zinc-500" />
          <span>Tasks</span>
        </Link>

        {/* Needs-You inbox — everything waiting on a human, newest first */}
        <section>
          <div
            className={`flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide ${
              attention.length > 0 ? 'text-amber-400/90' : 'text-zinc-500'
            }`}
          >
            <span>Needs you</span>
            {attention.length > 0 && (
              <span className="flex items-center gap-1.5">
                <button
                  onClick={clearAll}
                  title="Clear all — hides these for you; each item still resolves through its own flow"
                  className="text-[10px] font-normal normal-case tracking-normal text-zinc-500 transition hover:text-zinc-300"
                >
                  clear
                </button>
                <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-300">
                  {attention.length}
                </span>
              </span>
            )}
          </div>
          {showUndoClear && (
            <button
              onClick={undoClear}
              className="mt-1 flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left text-[11px] text-zinc-500 transition hover:text-zinc-300"
            >
              <span className="text-emerald-600">✓</span> cleared ·{' '}
              <span className="underline underline-offset-2">undo</span>
            </button>
          )}
          {attention.length === 0 ? (
            !showUndoClear && (
              <p className="mt-1 px-2 text-xs text-zinc-600">
                All clear — nothing waiting on you.
              </p>
            )
          ) : (
            <div className="mt-1">
              {needsYouRows.map((row) => {
                if (row.type === 'header') {
                  return (
                    <div
                      key={row.key}
                      className="mt-1.5 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 first:mt-0"
                    >
                      <ProjectDot project={row.project} />
                      {row.project?.name ?? 'HQ'}
                    </div>
                  )
                }
                const item = row.item
                const icon =
                  item.kind === 'doc_review'
                    ? '📄'
                    : item.kind === 'tool_approval'
                      ? '🔐'
                      : item.kind === 'task'
                        ? '☑'
                        : '✋'
                return (
                  // Click = the item opens as a self-sufficient modal (full
                  // ask + context + action). The thread is inside the modal,
                  // for when more context is genuinely needed. Hover ✕ =
                  // "not now" — hides it for you without deciding it.
                  <div
                    key={`${item.kind}-${item.refId}`}
                    className="group/need relative flex w-full items-start gap-1.5 rounded px-2 py-1 hover:bg-zinc-800/60"
                  >
                    <button
                      onClick={() => setActiveAttention(item)}
                      className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                    >
                      <span className="mt-px text-xs">{icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-zinc-200">
                          {item.priority === 'high' && (
                            <span className="mr-1 text-red-400">‼</span>
                          )}
                          {item.title}
                        </span>
                        {item.agentName && (
                          <span className="block truncate text-[10px] text-zinc-500">
                            {item.agentEmoji} {item.agentName}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      onClick={() => dismissItem(item)}
                      title="Dismiss — not now (hides it for you)"
                      aria-label={`Dismiss: ${item.title}`}
                      className="invisible mt-px shrink-0 rounded px-1 text-xs text-zinc-600 transition hover:text-zinc-300 group-hover/need:visible"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
              {attention.length > 8 && (
                <p className="px-2 text-[10px] text-zinc-600">+{attention.length - 8} more</p>
              )}
            </div>
          )}
        </section>

        {/* Rooms, grouped by project. HQ is the one room that spans them all. */}
        {channelGroups.map((group) => (
          <section key={group.key}>
            <div className="flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <span className="flex min-w-0 items-center gap-1.5">
                <ProjectDot project={group.project} />
                {group.project && isAdmin ? (
                  <button
                    onClick={() => setEditingProject(group.project)}
                    className="truncate text-left uppercase hover:text-zinc-200"
                    title={`${group.label} settings${group.project.workingDir ? ` · ${group.project.workingDir}` : ''}`}
                  >
                    {group.label}
                  </button>
                ) : (
                  <span className="truncate">{group.label}</span>
                )}
                {group.working > 0 && (
                  <span
                    title={`${group.working} room${group.working === 1 ? '' : 's'} with agents working`}
                    className="rounded-full bg-emerald-500/15 px-1.5 font-mono text-[10px] normal-case tracking-normal text-emerald-300"
                  >
                    {group.working}
                  </span>
                )}
                {group.needsYou > 0 && (
                  <span
                    title={`${group.needsYou} waiting on you`}
                    className="rounded-full bg-amber-500/20 px-1.5 font-mono text-[10px] normal-case tracking-normal text-amber-300"
                  >
                    {group.needsYou}
                  </span>
                )}
              </span>
              <button
                onClick={() => void createChannel(group.project)}
                className="text-zinc-400 hover:text-white"
                title={group.project ? `New channel in ${group.label}` : 'New HQ channel'}
              >
                +
              </button>
            </div>
            <nav className="mt-1">
              {group.channels.map((c) => (
                <Link
                  key={c.id}
                  to={`/channels/${c.id}`}
                  onClick={onClose}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
                    c.id === activeChannelId
                      ? 'bg-emerald-500/15 font-medium text-emerald-100'
                      : 'text-zinc-300 hover:bg-zinc-800/80'
                  }`}
                >
                  <span># {c.name}</span>
                  {liveChannels.has(c.id) && (
                    <span
                      title="Agents working here now"
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
                    />
                  )}
                </Link>
              ))}
            </nav>
          </section>
        ))}
        {isAdmin && (
          <button
            onClick={() => setShowNewProject(true)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-zinc-500 transition hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            <span className="text-base leading-none">+</span> New project
          </button>
        )}

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
            {agentGroups.map((group) => (
              <div key={group.key}>
                {agentGroups.length > 1 && (
                  <div className="mt-2 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 first:mt-0">
                    <ProjectDot project={group.project} />
                    <span className="truncate">{group.label}</span>
                  </div>
                )}
                {group.agents.map((a) => renderAgent(a))}
              </div>
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
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  className="min-w-0 flex-1 bg-transparent font-mono text-emerald-300"
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

      {/* Today's crew economics — the honest counter nobody else shows */}
      {todayStats && todayStats.runs > 0 && (
        <div
          className="border-t border-zinc-800/60 px-4 py-1.5 font-mono text-[11px] tabular-nums text-zinc-500"
          title="Runs and actual model spend today (≈ — resumed sessions can overlap)"
        >
          {todayStats.runs} run{todayStats.runs === 1 ? '' : 's'} today
          {todayStats.costUsd > 0 && ` · ≈$${todayStats.costUsd.toFixed(2)}`}
        </div>
      )}

      {/* Through opencrew.run: the way back to "Your crews" lives here, in
          the sidebar, instead of floating over it. */}
      {me.viaRelay && (
        <a
          href="/portal/workspaces"
          className="flex items-center gap-2 border-t border-zinc-800/60 px-4 py-2 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-white"
          title="Your crews on opencrew.run"
        >
          ⇄ Switch crew
        </a>
      )}

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

  // The old inline agent row, kept verbatim as a render helper so grouping
  // by project doesn't change how an agent looks.
  function renderAgent(a: AgentWithVersion) {
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
                    <span className={`min-w-0 flex-1 ${a.status === 'paused' ? 'line-through opacity-50' : ''}`}>
                      <span className="block truncate">{a.name}</span>
                      {agentActivity.get(a.id) && (
                        <span className="block truncate text-[10px] italic text-amber-400/90">
                          {agentActivity.get(a.id)}
                        </span>
                      )}
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
  }

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

      {/* Needs-You item detail — self-sufficient modal, rendered via portal */}
      {activeAttention && (
        <AttentionModal item={activeAttention} onClose={() => setActiveAttention(null)} />
      )}

      {editingProject && (
        <ProjectSettingsDialog project={editingProject} onClose={() => setEditingProject(null)} />
      )}

      {showNewProject && (
        <NewProjectDialog
          onClose={() => setShowNewProject(false)}
          onCreated={async (project) => {
            setShowNewProject(false)
            await Promise.all([refreshProjects(), refreshChannels()])
            const general = (await api.get<Channel[]>('/api/channels')).find(
              (c) => c.projectId === project.id && c.name === 'general'
            )
            navigate(general ? `/channels/${general.id}` : '/channels')
            onClose?.()
          }}
        />
      )}
    </>
  )
}
