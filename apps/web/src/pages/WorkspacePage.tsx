import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Sidebar } from '../components/Sidebar'
import { ChannelView } from '../components/ChannelView'
import { TerminalDrawer } from '../components/TerminalDrawer'
import { PresenceBar } from '../components/PresenceBar'
import { SpectatorPanel } from '../components/SpectatorPanel'
import { useWorkspace } from '../lib/workspace'

export function WorkspacePage() {
  const { channels } = useWorkspace()
  const { channelId } = useParams<{ channelId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const targetThreadId = searchParams.get('thread') ?? undefined
  const targetArtifactId = searchParams.get('artifact') ?? undefined
  const [runId, setRunId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [spectateUserId, setSpectateUserId] = useState<string | null>(null)

  const channel = channels.find((c) => c.id === channelId)

  useEffect(() => {
    if (!channel && channels.length > 0) {
      navigate(`/channels/${channels[0]!.id}`, { replace: true })
    }
  }, [channel, channels, navigate])

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

  if (!channel) {
    return (
      <div className="flex h-dvh">
        <Sidebar />
        <div className="grid flex-1 place-items-center text-zinc-500">No channels yet.</div>
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
            className="text-amber-400 text-sm"
            aria-label="Close terminal"
          >
            ⚡ close
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
