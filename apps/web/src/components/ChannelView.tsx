import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const NEAR_BOTTOM_THRESHOLD_PX = 120
// How many px from the bottom counts as "reading history" (not near bottom)
const SCROLLED_UP_THRESHOLD_PX = 300
import type { Artifact, Channel } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useMessages } from '../lib/useMessages'
import { useConversationTasks } from '../lib/useConversationTasks'
import {
  ArtifactsByIdContext,
  ArtifactsByRunContext,
  useChannelArtifacts
} from '../lib/useChannelArtifacts'
import { ArtifactDocModal } from './ArtifactCard'
import {
  ConversationGroup,
  deriveGroupStatus,
  groupIntoConversations,
  type GroupStatus,
  type MessageGroup
} from './ConversationGroup'
import { MessageInput } from './MessageInput'

// ---------------------------------------------------------------------------
// Conversation filters — status chips + time range, inline in the channel.
// Default (All · All time) keeps the familiar chronological feed untouched.
// ---------------------------------------------------------------------------

type StatusFilter = 'all' | GroupStatus
type RangeFilter = 'today' | '7d' | 'all'

const DAY_MS = 24 * 60 * 60 * 1000

const STATUS_CHIPS: { key: GroupStatus; label: string; activeClass: string }[] = [
  { key: 'waiting', label: '⏸ Waiting', activeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/50' },
  { key: 'in_progress', label: '● Running', activeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/50' },
  { key: 'not_started', label: '○ Not started', activeClass: 'bg-zinc-700/60 text-zinc-200 border-zinc-500' },
  { key: 'failed', label: '✗ Failed', activeClass: 'bg-red-500/20 text-red-300 border-red-500/50' },
  { key: 'done', label: '✓ Done', activeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50' }
]

const RANGE_CHIPS: { key: RangeFilter; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7d' },
  { key: 'all', label: 'All' }
]

// Only these interrupt at rest — they're the ones that need a human.
const ATTENTION_CHIPS = [
  {
    key: 'waiting' as GroupStatus,
    label: '⏸ waiting',
    activeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
    idleClass: 'text-amber-400/80'
  },
  {
    key: 'failed' as GroupStatus,
    label: '✗ failed',
    activeClass: 'bg-red-500/20 text-red-300 border-red-500/50',
    idleClass: 'text-red-400/80'
  }
]

function filterSummary(status: StatusFilter, range: RangeFilter): string {
  const chip = STATUS_CHIPS.find((c) => c.key === status)
  const parts = [
    ...(chip ? [chip.label] : []),
    ...(range !== 'all' ? [RANGE_CHIPS.find((c) => c.key === range)!.label] : [])
  ]
  return parts.length > 0 ? parts.join(' · ') : 'Filter'
}

function rangeStart(range: RangeFilter): number {
  if (range === 'all') return 0
  const now = new Date()
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return now.getTime() - 7 * DAY_MS
}

function lastActivityOf(group: MessageGroup): number {
  const last = group.responses[group.responses.length - 1]
  return last?.createdAt ?? group.trigger?.createdAt ?? 0
}

const STATUS_RANK: Record<GroupStatus, number> = {
  waiting: 4,
  in_progress: 3,
  failed: 2,
  done: 1,
  not_started: 0
}

/**
 * Merge the message-derived status with the server's run aggregation, which
 * also sees thread activity and runs that haven't posted yet. Active states
 * always win; a human's manual "done" closes anything quiet.
 */
function mergeStatus(
  local: GroupStatus,
  server: GroupStatus | undefined,
  manuallyDone: boolean
): GroupStatus {
  const base = server && STATUS_RANK[server] > STATUS_RANK[local] ? server : local
  if (base === 'waiting' || base === 'in_progress') return base
  return manuallyDone ? 'done' : base
}

/** Server-side per-conversation statuses, refreshed when runs change. */
function useWorkStatuses(): Map<string, GroupStatus> {
  const [statuses, setStatuses] = useState<Map<string, GroupStatus>>(new Map())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const items = await api.get<{ rootId: string; status: GroupStatus }[]>('/api/work')
        setStatuses(new Map(items.map((item) => [item.rootId, item.status])))
      } catch {
        // transient — next run event retries
      }
    }
    void load()
    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type !== 'run_status' && event.type !== 'thread_status') return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(), 600)
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return statuses
}

interface ChannelViewProps {
  channel: Channel
  onOpenRun: (runId: string) => void
  targetThreadId?: string
  /** Deep link from the Needs-You inbox: open this artifact's review modal. */
  targetArtifactId?: string
  onThreadFocused?: () => void
}

export function ChannelView({
  channel,
  onOpenRun,
  targetThreadId,
  targetArtifactId,
  onThreadFocused
}: ChannelViewProps) {
  const { messages, loading, post } = useMessages(channel.id, null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef<string | undefined>(undefined)
  // Track whether the user is near the bottom — true by default so the initial
  // load + fresh channel switches scroll to the latest message as expected.
  const isNearBottomRef = useRef(true)
  // Set when the user sends a message: their own post always scrolls to the
  // bottom, no matter how far up they were reading.
  const forceScrollRef = useRef(false)
  // Mirror of targetThreadId for the pin-to-bottom observer.
  const targetThreadRef = useRef(targetThreadId)
  targetThreadRef.current = targetThreadId
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>('all')
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  // New-message pill: count of messages that arrived while user was scrolled up
  const [unreadCount, setUnreadCount] = useState(0)
  const prevMsgCountRef = useRef(0)
  // Tracks which group trigger IDs the user has scrolled into view
  const [seenGroupIds, setSeenGroupIds] = useState<Set<string>>(new Set())

  // Keep isNearBottomRef in sync with the user's scroll position.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isNearBottomRef.current = distFromBottom < NEAR_BOTTOM_THRESHOLD_PX
    // Clear unread pill once user scrolls back near bottom
    if (distFromBottom < SCROLLED_UP_THRESHOLD_PX) {
      setUnreadCount(0)
    }
  }, [])

  // Filters reset when switching channels — each channel starts unfiltered and
  // scrolled to the bottom.
  useEffect(() => {
    setStatusFilter('all')
    setRangeFilter('all')
    setUnreadCount(0)
    setSeenGroupIds(new Set())
    prevMsgCountRef.current = 0
    isNearBottomRef.current = true
  }, [channel.id])

  // Auto-scroll to bottom ONLY when a genuinely new message arrives AND the
  // user is already near the bottom. Streaming updates, run_status events, and
  // reactions all mutate the `messages` array reference without changing its
  // length — using messages.length as the dep means those high-frequency events
  // never steal the viewport from a user who's scrolled up to read history.
  useEffect(() => {
    if (targetThreadId) return
    const newCount = messages.length
    const prevCount = prevMsgCountRef.current
    const arrivedCount = Math.max(0, newCount - prevCount)
    prevMsgCountRef.current = newCount

    // Decide from the position BEFORE this message rendered (isNearBottomRef is
    // maintained by scroll events) — measuring after the render lets a tall new
    // message push the user past the threshold and skip the scroll.
    if (forceScrollRef.current || isNearBottomRef.current) {
      forceScrollRef.current = false
      bottomRef.current?.scrollIntoView()
      isNearBottomRef.current = true
      setUnreadCount(0)
      return
    }
    // User is scrolled up reading — increment the unread pill instead of scrolling
    if (arrivedCount > 0) {
      setUnreadCount((n) => n + arrivedCount)
    }
    // Not following: re-sync the ref against the grown content.
    handleScroll()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, targetThreadId])

  // Callback for ConversationGroup to mark itself as seen
  const markGroupSeen = useCallback((groupId: string) => {
    setSeenGroupIds((prev) => {
      if (prev.has(groupId)) return prev
      const next = new Set(prev)
      next.add(groupId)
      return next
    })
  }, [])

  // Pin-to-bottom: while the user is near the bottom, ANY content growth keeps
  // the view pinned there. This is what actually makes auto-scroll reliable:
  // streaming agent text, inline threads finishing their fetch, and images
  // loading all grow the feed WITHOUT changing messages.length, so the
  // length-based effect above never sees them.
  useEffect(() => {
    const el = scrollContainerRef.current
    const content = contentRef.current
    if (!el || !content) return
    const observer = new ResizeObserver(() => {
      // A deep-linked thread is being centered — don't fight that scroll.
      if (targetThreadRef.current) return
      if (isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [channel.id])

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
  const workStatuses = useWorkStatuses()
  const conversationTasks = useConversationTasks(channel.id)
  const channelArtifacts = useChannelArtifacts(channel.id)
  // Regroup by producing run so doc cards render under the announcing reply.
  const { artifactsByRun, artifactsById } = useMemo(() => {
    const byRun = new Map<string, Artifact[]>()
    const byId = new Map<string, Artifact>()
    for (const list of channelArtifacts.values()) {
      for (const artifact of list) {
        byRun.set(artifact.runId, [...(byRun.get(artifact.runId) ?? []), artifact])
        byId.set(artifact.id, artifact)
      }
    }
    return { artifactsByRun: byRun, artifactsById: byId }
  }, [channelArtifacts])

  // Needs-You deep link: ?artifact=<id> opens the review modal directly —
  // copied to local state so URL cleanup doesn't close it under the user.
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  useEffect(() => {
    if (targetArtifactId) setOpenArtifactId(targetArtifactId)
  }, [targetArtifactId])
  const openArtifact = openArtifactId ? artifactsById.get(openArtifactId) : undefined

  const handleSend = useCallback(
    async (content: string, images?: string[]) => {
      forceScrollRef.current = true
      await post(content, images)
      // The message lands via WS; scroll now and let the flag catch the render.
      bottomRef.current?.scrollIntoView()
    },
    [post]
  )

  const toggleDone = useCallback(async (rootId: string, done: boolean) => {
    try {
      await api.post(`/api/messages/${rootId}/status`, { done })
    } catch {
      // WS thread_status never arrives on failure — pill simply stays put
    }
  }, [])

  // Status + last-activity per group, computed once per render pass.
  const annotated = useMemo(
    () =>
      groups.map((group) => ({
        group,
        status: mergeStatus(
          deriveGroupStatus(group.responses),
          group.trigger ? workStatuses.get(group.trigger.id) : undefined,
          group.trigger?.manualStatus === 'done'
        ),
        lastActivityAt: lastActivityOf(group)
      })),
    [groups, workStatuses]
  )

  const counts = useMemo(() => {
    const start = rangeStart(rangeFilter)
    const map = new Map<GroupStatus, number>()
    for (const entry of annotated) {
      if (entry.lastActivityAt < start) continue
      map.set(entry.status, (map.get(entry.status) ?? 0) + 1)
    }
    return map
  }, [annotated, rangeFilter])

  const isFiltered = statusFilter !== 'all' || rangeFilter !== 'all'
  const visible = useMemo(() => {
    if (!isFiltered) return annotated
    const start = rangeStart(rangeFilter)
    return annotated.filter(
      (entry) =>
        entry.lastActivityAt >= start &&
        (statusFilter === 'all' || entry.status === statusFilter)
    )
  }, [annotated, isFiltered, statusFilter, rangeFilter])

  return (
    <ArtifactsByRunContext.Provider value={artifactsByRun}>
    <ArtifactsByIdContext.Provider value={artifactsById}>
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="font-bold"># {channel.name}</h2>
        {channel.topic && <p className="text-xs text-zinc-500">{channel.topic}</p>}
      </div>

      {/* Conversation filters — attention chips (waiting/failed) surface only
          when nonzero; everything else lives behind one Filter menu. */}
      {!loading && groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/50 px-4 py-1 text-xs">
          {ATTENTION_CHIPS.map((chip) => {
            const count = counts.get(chip.key) ?? 0
            if (count === 0 && statusFilter !== chip.key) return null
            const active = statusFilter === chip.key
            return (
              <button
                key={chip.key}
                onClick={() => setStatusFilter(active ? 'all' : chip.key)}
                className={`rounded-full border px-2.5 py-0.5 transition ${
                  active ? chip.activeClass : `border-transparent ${chip.idleClass} hover:brightness-125`
                }`}
              >
                {chip.label} {count}
              </button>
            )
          })}
          <span className="flex-1" />
          {(statusFilter !== 'all' || rangeFilter !== 'all') && (
            <button
              onClick={() => {
                setStatusFilter('all')
                setRangeFilter('all')
                setIsFilterOpen(false)
              }}
              className="text-zinc-500 hover:text-zinc-300"
            >
              clear ×
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setIsFilterOpen((v) => !v)}
              className={`rounded border px-2 py-0.5 transition ${
                statusFilter !== 'all' || rangeFilter !== 'all'
                  ? 'border-zinc-600 text-zinc-200'
                  : 'border-transparent text-zinc-600 hover:text-zinc-300'
              }`}
            >
              {filterSummary(statusFilter, rangeFilter)} ▾
            </button>
            {isFilterOpen && (
              <div className="absolute right-0 top-6 z-30 w-44 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
                <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                  Status
                </p>
                {(['all', ...STATUS_CHIPS.map((c) => c.key)] as StatusFilter[]).map((key) => {
                  const chip = STATUS_CHIPS.find((c) => c.key === key)
                  const count = key === 'all' ? groups.length : (counts.get(key) ?? 0)
                  if (key !== 'all' && count === 0) return null
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setStatusFilter(key)
                        setIsFilterOpen(false)
                      }}
                      className={`flex w-full items-center justify-between rounded px-1.5 py-1 text-left ${
                        statusFilter === key
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-800/60'
                      }`}
                    >
                      <span>{chip ? chip.label : 'All'}</span>
                      <span className="text-zinc-600">{count}</span>
                    </button>
                  )
                })}
                <p className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wide text-zinc-600">
                  Time
                </p>
                <div className="flex gap-1 px-1">
                  {RANGE_CHIPS.map((chip) => (
                    <button
                      key={chip.key}
                      onClick={() => setRangeFilter(chip.key)}
                      className={`flex-1 rounded px-1.5 py-0.5 ${
                        rangeFilter === chip.key
                          ? 'bg-zinc-800 font-medium text-zinc-100'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* "New messages" jump pill — only appears when user is scrolled up */}
      {unreadCount > 0 && (
        <div className="relative z-20">
          <button
            onClick={() => {
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
              setUnreadCount(0)
            }}
            className="absolute left-1/2 top-2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-lg transition-opacity hover:bg-indigo-500 animate-fade-in"
          >
            ↓ {unreadCount} new {unreadCount === 1 ? 'message' : 'messages'}
          </button>
        </div>
      )}

      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto py-2">
        <div ref={contentRef}>
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
        {!loading && messages.length > 0 && visible.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">
            <p>No conversations match this filter.</p>
            <button
              onClick={() => {
                setStatusFilter('all')
                setRangeFilter('all')
              }}
              className="mt-2 text-zinc-300 underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          </div>
        )}
        {visible.map((entry, i) => {
          const groupId = entry.group.trigger?.id ?? `group-${i}`
          const isUnread = !seenGroupIds.has(groupId) && entry.group.responses.length > 0
          return (
            <ConversationGroup
              key={groupId}
              group={entry.group}
              channelId={channel.id}
              onOpenRun={onOpenRun}
              targetThreadId={targetThreadId}
              status={entry.status}
              onToggleDone={(rootId, done) => void toggleDone(rootId, done)}
              isUnread={isUnread}
              onSeen={() => markGroupSeen(groupId)}
              defaultCollapsed={entry.status === 'done' && i < visible.length - 1}
              tasksList={
                entry.group.trigger
                  ? (conversationTasks.get(entry.group.trigger.id) ?? [])
                  : undefined
              }
            />
          )
        })}
        <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t border-zinc-800 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <MessageInput placeholder={`Message #${channel.name}`} onSend={handleSend} />
      </div>

      {/* Needs-You deep link lands directly in the review modal */}
      {openArtifact && (
        <ArtifactDocModal artifact={openArtifact} onClose={() => setOpenArtifactId(null)} />
      )}
    </div>
    </ArtifactsByIdContext.Provider>
    </ArtifactsByRunContext.Provider>
  )
}
