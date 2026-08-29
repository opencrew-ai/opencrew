import { useEffect, useState } from 'react'
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

  const channel = channels.find((c) => c.id === channelId)

  useEffect(() => {
    if (!channel && channels.length > 0) {
      navigate(`/channels/${channels[0]!.id}`, { replace: true })
    }
  }, [channel, channels, navigate])

  // Close panels when switching channels.
  useEffect(() => {
    setThreadRootId(null)
  }, [channelId])

  if (!channel) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="grid flex-1 place-items-center text-zinc-500">No channels yet.</div>
      </div>
    )
  }

  return (
    <div className="flex h-screen">
      <Sidebar activeChannelId={channel.id} />
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
  )
}
