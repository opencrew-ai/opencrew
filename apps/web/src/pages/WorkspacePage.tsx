import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Sidebar } from '../components/Sidebar'
import { ChannelView } from '../components/ChannelView'
import { ThreadPanel } from '../components/ThreadPanel'
import { TerminalDrawer } from '../components/TerminalDrawer'
import { useWorkspace } from '../lib/workspace'

export function WorkspacePage() {
  const { channels } = useWorkspace()
  const { channelId } = useParams<{ channelId: string }>()
  const navigate = useNavigate()
  const [threadRootId, setThreadRootId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const channel = channels.find((c) => c.id === channelId)

  useEffect(() => {
    if (!channel && channels.length > 0) {
      navigate(`/channels/${channels[0]!.id}`, { replace: true })
    }
  }, [channel, channels, navigate])

  // Close panels when switching channels.
  useEffect(() => {
    setThreadRootId(null)
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
      <div className="flex h-screen">
        <Sidebar />
        <div className="grid flex-1 place-items-center text-zinc-500">No channels yet.</div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col md:flex-row">
      {/* Mobile top bar — hidden on desktop */}
      <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-2 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="text-xl text-zinc-400 hover:text-white"
          aria-label="Open menu"
        >
          ☰
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
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <ChannelView
          channel={channel}
          onOpenThread={setThreadRootId}
          onOpenRun={setRunId}
        />
        {threadRootId && (
          <ThreadPanel
            channelId={channel.id}
            rootId={threadRootId}
            onClose={() => setThreadRootId(null)}
            onOpenRun={setRunId}
          />
        )}
        {runId && <TerminalDrawer runId={runId} onClose={() => setRunId(null)} />}
      </div>
    </div>
  )
}
