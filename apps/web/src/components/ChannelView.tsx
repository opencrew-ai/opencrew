import { useEffect, useRef } from 'react'
import type { Channel } from '@opencrew/shared'
import { useMessages } from '../lib/useMessages'
import { ConversationGroup, groupIntoConversations } from './ConversationGroup'
import { MessageInput } from './MessageInput'

interface ChannelViewProps {
  channel: Channel
  onOpenRun: (runId: string) => void
  targetThreadId?: string
  onThreadFocused?: () => void
}

export function ChannelView({ channel, onOpenRun, targetThreadId, onThreadFocused }: ChannelViewProps) {
  const { messages, loading, post } = useMessages(channel.id, null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef<string | undefined>(undefined)

  // Scroll to bottom on new messages (unless we have a target thread to focus)
  useEffect(() => {
    if (!targetThreadId) bottomRef.current?.scrollIntoView()
  }, [messages, targetThreadId])

  // When a targetThreadId is set, scroll to and flash-highlight that message
  useEffect(() => {
    if (!targetThreadId || loading || focusedRef.current === targetThreadId) return
    const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(targetThreadId)}"]`)
    if (!el) return
    focusedRef.current = targetThreadId
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'ring-offset-zinc-950', 'rounded-md')
    setTimeout(() => {
      el.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'ring-offset-zinc-950', 'rounded-md')
      onThreadFocused?.()
    }, 2000)
  }, [targetThreadId, loading, onThreadFocused])

  const groups = groupIntoConversations(messages)

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="font-bold"># {channel.name}</h2>
        {channel.topic && <p className="text-xs text-zinc-500">{channel.topic}</p>}
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {loading && <p className="px-4 text-sm text-zinc-500">Loading…</p>}
        {!loading && messages.length === 0 && (
          <div className="px-4 py-8 text-sm text-zinc-500">
            <p className="text-2xl">👋</p>
            <p className="mt-2">
              This is the start of <b>#{channel.name}</b>. @mention an agent to put the crew
              to work.
            </p>
          </div>
        )}
        {groups.map((group, i) => (
          <ConversationGroup
            key={group.trigger?.id ?? `group-${i}`}
            group={group}
            channelId={channel.id}
            onOpenRun={onOpenRun}
            targetThreadId={targetThreadId}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-800 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <MessageInput placeholder={`Message #${channel.name}`} onSend={post} />
      </div>
    </div>
  )
}
