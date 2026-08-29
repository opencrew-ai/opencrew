import { useEffect, useRef } from 'react'
import { useMessages } from '../lib/useMessages'
import { MessageItem } from './MessageItem'
import { MessageInput } from './MessageInput'

interface ThreadPanelProps {
  channelId: string
  rootId: string
  onClose: () => void
  onOpenRun: (runId: string) => void
}

export function ThreadPanel({ channelId, rootId, onClose, onOpenRun }: ThreadPanelProps) {
  const { messages, loading, post } = useMessages(channelId, rootId)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [messages])

  return (
    <div className="flex w-96 shrink-0 flex-col border-l border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h3 className="text-sm font-bold">Thread</h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-white">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {loading && <p className="px-4 text-sm text-zinc-500">Loading…</p>}
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} onOpenRun={onOpenRun} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-800 p-3">
        <MessageInput placeholder="Reply in thread" onSend={post} />
      </div>
    </div>
  )
}
