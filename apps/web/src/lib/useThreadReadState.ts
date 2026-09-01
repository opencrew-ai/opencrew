import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { wsClient } from './ws'

// ---------------------------------------------------------------------------
// localStorage helpers — collapse state is cosmetic, lives client-side only
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oc_collapsed_threads'

function getCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveCollapsedSet(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // Ignore quota / privacy errors
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseThreadReadStateOptions {
  channelId: string
  /** The root message id of this thread/conversation. Pass '' to disable. */
  rootId: string
  /** Whether the thread arrives with unread activity (from parent / server). */
  initialUnread?: boolean
  /** Whether the thread should start collapsed (e.g. done conversations). */
  initialCollapsed?: boolean
}

export interface ThreadReadState {
  /** Thread content is hidden; only the summary row is shown. */
  isCollapsed: boolean
  /** User has marked this thread as read (server-persisted). */
  isRead: boolean
  /**
   * True when there is activity the user has not acknowledged.
   * Combines initialUnread + any new WS replies that arrived post-mount.
   */
  hasNewActivity: boolean
  collapse: () => void
  expand: () => void
  /**
   * Mark as read: optimistic server write + collapses the thread.
   * Reverts the local isRead flag if the API call fails.
   */
  markAsRead: () => void
}

export function useThreadReadState({
  channelId,
  rootId,
  initialUnread = false,
  initialCollapsed = false,
}: UseThreadReadStateOptions): ThreadReadState {
  const disabled = rootId === ''

  // Collapse state: initialise from localStorage (user's previous choice) or
  // the parent's defaultCollapsed hint (server-derived: done conversations).
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (disabled) return false
    return getCollapsedSet().has(rootId) || initialCollapsed
  })

  // Server-persisted read state. Starts false; set true on markAsRead success.
  const [isRead, setIsRead] = useState(false)

  // Tracks whether new WS replies arrived after mount so we can re-light the
  // unread dot even on a thread that was previously collapsed/read.
  const [newActivitySinceMount, setNewActivitySinceMount] = useState(false)

  // Listen for new replies on this thread — resurface collapsed/read threads.
  useEffect(() => {
    if (disabled) return
    return wsClient.subscribe((event) => {
      if (event.type !== 'message_created') return
      const m = event.message
      if (m.channelId !== channelId) return
      if (m.threadRootId !== rootId && m.id !== rootId) return

      // New activity: remove from collapsed set, reset read flag, re-light dot.
      setNewActivitySinceMount(true)
      setIsRead(false)
      setIsCollapsed(false)
      const set = getCollapsedSet()
      if (set.has(rootId)) {
        set.delete(rootId)
        saveCollapsedSet(set)
      }
    })
  }, [channelId, disabled, rootId])

  const collapse = useCallback(() => {
    if (disabled) return
    setIsCollapsed(true)
    const set = getCollapsedSet()
    set.add(rootId)
    saveCollapsedSet(set)
  }, [disabled, rootId])

  const expand = useCallback(() => {
    if (disabled) return
    setIsCollapsed(false)
    setNewActivitySinceMount(false)
    const set = getCollapsedSet()
    set.delete(rootId)
    saveCollapsedSet(set)
  }, [disabled, rootId])

  const markAsRead = useCallback(() => {
    if (disabled) return
    // Optimistic: collapse + mark read immediately.
    setIsRead(true)
    setNewActivitySinceMount(false)
    setIsCollapsed(true)
    const set = getCollapsedSet()
    set.add(rootId)
    saveCollapsedSet(set)

    // Server write — fire and forget; revert on failure.
    void api
      .post(`/api/channels/${channelId}/threads/${rootId}/read`)
      .catch(() => {
        setIsRead(false)
      })
  }, [channelId, disabled, rootId])

  const hasNewActivity = !isRead && (initialUnread || newActivitySinceMount)

  return { isCollapsed, isRead, hasNewActivity, collapse, expand, markAsRead }
}
