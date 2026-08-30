import { useEffect, useState } from 'react'
import type { AttentionItem } from '@opencrew/shared'
import { api } from './api'
import { wsClient } from './ws'

/**
 * The Needs-You inbox: everything waiting on a human. Refetches on any
 * event that can change it (explicit requests, doc reviews, tool approvals).
 */
export function useAttention(): AttentionItem[] {
  const [items, setItems] = useState<AttentionItem[]>([])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      api
        .get<AttentionItem[]>('/api/attention')
        .then(setItems)
        .catch(() => {})
    }
    load()
    const unsubscribe = wsClient.subscribe((event) => {
      if (
        event.type !== 'attention_changed' &&
        event.type !== 'artifact_state' &&
        event.type !== 'approval_updated' &&
        event.type !== 'task_state'
      ) {
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 300)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return items
}
