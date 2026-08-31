import { useRef, useEffect } from 'react'
import { useMessages } from '../lib/useMessages'
import { useConversationActivity } from '../lib/useAgentActivity'
import { useWorkspace } from '../lib/workspace'
import { MessageItem } from './MessageItem'
import { MessageInput } from './MessageInput'

interface InlineThreadProps {
  channelId: string
  rootId: string
  onOpenRun?: (runId: string) => void
}

/**
 * Inline thread — renders replies directly below the parent message.
 * Always mounted for threads with activity, so new replies (human or a
 * streaming agent) appear live without the user expanding anything.
 */
export function InlineThread({ channelId, rootId, onOpenRun }: InlineThreadProps) {
  const { messages, loading, post } = useMessages(channelId, rootId)
  const { agents } = useWorkspace()
  // Agents live-working THIS conversation — rendered like a typing indicator.
  const workers = useConversationActivity(rootId)
  // The server returns the root message + all replies; skip the root itself.
  const replies = messages.filter((m) => m.id !== rootId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const hasLoadedRef = useRef(false)

  // Follow NEW replies only. On initial load every mounted thread would
  // otherwise call scrollIntoView and fight over the viewport.
  useEffect(() => {
    if (loading) return
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true
      return
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [replies.length, loading])

  return (
    <div className="ml-7 mt-1.5 rounded-lg bg-zinc-900/25">
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

        {/* Live workers — who is on it right now, with their current move */}
        {workers.map(({ agentId, label }) => {
          const agent = agents.find((a) => a.id === agentId)
          if (!agent) return null
          return (
            <div key={agentId} className="flex items-center gap-2 px-4 py-1.5 text-xs">
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-emerald-500/40 bg-zinc-900 text-sm shadow-[0_0_8px_-2px_rgba(52,211,153,0.5)]">
                {agent.avatarEmoji}
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              </span>
              <span className="font-display font-semibold text-zinc-300">{agent.name}</span>
              <span className="min-w-0 truncate italic text-emerald-300/80">{label}</span>
              <span className="cursor-blink text-emerald-400">▊</span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Reply input */}
      <div className="border-t border-zinc-800/40 p-2">
        <MessageInput placeholder="Reply…" onSend={post} />
      </div>
    </div>
  )
}
