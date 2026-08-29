import { useRef, useEffect } from 'react'
import { useMessages } from '../lib/useMessages'
import { MessageItem } from './MessageItem'
import { MessageInput } from './MessageInput'

interface InlineThreadProps {
  channelId: string
  rootId: string
  onOpenRun?: (runId: string) => void
}

/**
 * Inline thread — renders replies directly below the parent message.
 * Replaces the side ThreadPanel; everything stays in the main stream.
 */
export function InlineThread({ channelId, rootId, onOpenRun }: InlineThreadProps) {
  const { messages, loading, post } = useMessages(channelId, rootId)
  // The server returns the root message + all replies; skip the root itself.
  const replies = messages.filter((m) => m.id !== rootId)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [replies.length])

  return (
    <div className="ml-7 mt-1.5 rounded-lg border border-zinc-800/50 bg-zinc-950/40">
      {/* Replies */}
      <div className="border-l-2 border-emerald-800/30 pl-1">
        {loading && (
          <p className="px-3 py-2 text-xs text-zinc-500">Loading replies…</p>
        )}
        {!loading && replies.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-600">No replies yet — be the first.</p>
        )}
        {replies.map((m) => (
          // No channelId passed → nested replies don't show their own inline thread
          // (avoids infinite nesting)
          <MessageItem key={m.id} message={m} onOpenRun={onOpenRun} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Reply input */}
      <div className="border-t border-zinc-800/40 p-2">
        <MessageInput placeholder="Reply…" onSend={post} />
      </div>
    </div>
  )
}
