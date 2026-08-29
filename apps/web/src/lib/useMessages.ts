import { useCallback, useEffect, useState } from 'react'
import type { Message } from '@opencrew/shared'
import { api } from './api'
import { wsClient } from './ws'

/**
 * Live message list for a channel's main view (thread === null) or a thread
 * panel (thread === root message id). Merges REST history with WS events.
 */
export function useMessages(channelId: string | undefined, thread: string | null) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!channelId) return
    setLoading(true)
    setMessages([])
    const url = thread
      ? `/api/channels/${channelId}/messages?thread=${thread}`
      : `/api/channels/${channelId}/messages`
    api
      .get<Message[]>(url)
      .then(setMessages)
      .finally(() => setLoading(false))
  }, [channelId, thread])

  useEffect(() => {
    if (!channelId) return
    const inScope = (m: Message) => {
      if (m.channelId !== channelId) return false
      return thread ? m.threadRootId === thread || m.id === thread : m.threadRootId === null
    }
    return wsClient.subscribe((event) => {
      if (event.type === 'message_created') {
        const m = event.message
        if (inScope(m)) {
          setMessages((prev) =>
            prev.some((x) => x.id === m.id) ? prev : [...prev, { ...m, replyCount: 0 }]
          )
        }
        // A reply landed in some thread — bump the root's reply count.
        if (!thread && m.channelId === channelId && m.threadRootId) {
          setMessages((prev) =>
            prev.map((x) =>
              x.id === m.threadRootId ? { ...x, replyCount: (x.replyCount ?? 0) + 1 } : x
            )
          )
        }
      } else if (event.type === 'message_updated') {
        const m = event.message
        setMessages((prev) =>
          prev.map((x) => (x.id === m.id ? { ...m, replyCount: x.replyCount } : x))
        )
      } else if (event.type === 'message_stream') {
        if (event.channelId !== channelId) return
        setMessages((prev) =>
          prev.map((x) => (x.id === event.messageId ? { ...x, content: event.content } : x))
        )
      } else if (event.type === 'run_status') {
        // Keep status pills live — update runStatus on any message tied to this run
        setMessages((prev) =>
          prev.map((x) => (x.runId === event.runId ? { ...x, runStatus: event.status } : x))
        )
      }
    })
  }, [channelId, thread])

  const post = useCallback(
    async (content: string, images: string[] = []) => {
      if (!channelId) return
      await api.post<Message>(`/api/channels/${channelId}/messages`, {
        content,
        images,
        threadRootId: thread ?? undefined
      })
    },
    [channelId, thread]
  )

  return { messages, loading, post }
}
