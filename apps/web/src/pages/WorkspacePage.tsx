import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Channel } from '@opencrew/shared'
import { api } from '../lib/api'
import { NewProjectForm } from '../components/NewProjectDialog'
import { Logo } from '../components/Logo'
import { Sidebar } from '../components/Sidebar'
import { ChannelView } from '../components/ChannelView'
import { TerminalDrawer } from '../components/TerminalDrawer'
import { PresenceBar } from '../components/PresenceBar'
import { SpectatorPanel } from '../components/SpectatorPanel'
import { useWorkspace } from '../lib/workspace'

export function WorkspacePage() {
  const { me, channels, projects, refreshProjects, refreshChannels } = useWorkspace()
  const { channelId } = useParams<{ channelId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const targetThreadId = searchParams.get('thread') ?? undefined
  const targetArtifactId = searchParams.get('artifact') ?? undefined
  const [runId, setRunId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [spectateUserId, setSpectateUserId] = useState<string | null>(null)

  const channel = channels.find((c) => c.id === channelId)

  // Landing room: the first project's #general (where the work is), then
  // HQ's #hq, then whatever exists.
  useEffect(() => {
    if (channel || channels.length === 0 || projects.length === 0) return
    const firstProject = projects[0]
    const home =
      channels.find((c) => c.projectId === firstProject?.id && c.name === 'general') ??
      channels.find((c) => c.projectId === null && c.name === 'hq') ??
      channels[0]!
    navigate(`/channels/${home.id}`, { replace: true })
  }, [channel, channels, projects, navigate])

  // Close sidebar when switching channels.
  useEffect(() => {
    setSidebarOpen(false)
  }, [channelId])

  // Close sidebar on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  // First run: no project yet. No sidebar, no chrome — one question, then
  // the person lands in their project's room with Captain talking.
  if (projects.length === 0) {
    return (
      <div className="bg-stage grid min-h-dvh place-items-center px-6 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3">
            <Logo className="h-9 w-9" />
            <span className="font-display text-lg font-semibold text-zinc-100">OpenCrew</span>
          </div>
          <NewProjectForm
            firstRun
            onCreated={async (project) => {
              await Promise.all([refreshProjects(), refreshChannels()])
              const rooms = await api.get<Channel[]>('/api/channels')
              const general = rooms.find((c) => c.projectId === project.id && c.name === 'general')
              navigate(general ? `/channels/${general.id}` : '/channels', { replace: true })
            }}
          />
          <p className="mt-10 text-xs text-zinc-600">
            Signed in as {me.name} on this machine. Agents run as your own Claude Code sessions.
          </p>
        </div>
      </div>
    )
  }

  if (!channel) {
    return (
      <div className="flex h-dvh">
        <Sidebar />
        <div className="grid flex-1 place-items-center text-zinc-500">No rooms yet.</div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      {/* Mobile top bar — hidden on desktop */}
      <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-2 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-white"
          aria-label="Open menu"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="2" y="5" width="16" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="9.25" width="16" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="13.5" width="16" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
        </button>
        <span className="flex-1 font-semibold text-zinc-200"># {channel.name}</span>
        {runId && (
          <button
            onClick={() => setRunId(null)}
            className="text-sm text-zinc-400 hover:text-zinc-200"
            aria-label="Close terminal"
          >
            ✕ close
          </button>
        )}
      </header>

      <Sidebar
        activeChannelId={channel.id}
        open={sidebarOpen}
        onClose={closeSidebar}
      />

      {/* Main content area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PresenceBar onSpectate={(userId) => setSpectateUserId(userId)} />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <ChannelView
            channel={channel}
            onOpenRun={setRunId}
            targetThreadId={targetThreadId}
            targetArtifactId={targetArtifactId}
            onThreadFocused={() => setSearchParams({}, { replace: true })}
          />
          {spectateUserId && !runId && (
            <SpectatorPanel
              userId={spectateUserId}
              onOpenRun={setRunId}
              onClose={() => setSpectateUserId(null)}
            />
          )}
          {runId && <TerminalDrawer runId={runId} onClose={() => setRunId(null)} />}
        </div>
      </div>
    </div>
  )
}
