import { useEffect, useState } from 'react'
import type { SharedTask } from '@opencrew/shared'
import { api } from './api'
import { wsClient } from './ws'

/**
 * Shared task lists for every conversation in a channel: REST snapshot
 * merged with live task_state events (each event carries the FULL list for
 * one conversation). Keyed by conversationRootId.
 */
export function useConversationTasks(channelId: string): Map<string, SharedTask[]> {
  const [byRoot, setByRoot] = useState<Map<string, SharedTask[]>>(new Map())

  useEffect(() => {
    setByRoot(new Map())
    let cancelled = false
    api
      .get<SharedTask[]>(`/api/channels/${channelId}/tasks`)
      .then((rows) => {
        if (cancelled) return
        const map = new Map<string, SharedTask[]>()
        for (const row of rows) {
          map.set(row.conversationRootId, [...(map.get(row.conversationRootId) ?? []), row])
        }
        setByRoot(map)
      })
      .catch(() => {
        // Transient — live task_state events still populate the map.
      })
    return () => {
      cancelled = true
    }
  }, [channelId])

  useEffect(() => {
    return wsClient.subscribe((event) => {
      if (event.type !== 'task_state') return
      if (event.tasks.channelId !== channelId) return
      setByRoot((prev) => {
        const next = new Map(prev)
        if (event.tasks.items.length === 0) {
          next.delete(event.tasks.conversationRootId)
        } else {
          next.set(event.tasks.conversationRootId, event.tasks.items)
        }
        return next
      })
    })
  }, [channelId])

  return byRoot
}
