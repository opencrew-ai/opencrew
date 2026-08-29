import { useEffect, useRef } from 'react'
import type { Channel } from '@opencrew/shared'
import { useMessages } from '../lib/useMessages'
import { ConversationGroup, groupIntoConversations } from './ConversationGroup'
import { MessageInput } from './MessageInput'

interface ChannelViewProps {
  channel: Channel
  onOpenRun: (runId: string) => void
}

export function ChannelView({ channel, onOpenRun }: ChannelViewProps) {
  const { messages, loading, post } = useMessages(channel.id, null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [messages])

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
