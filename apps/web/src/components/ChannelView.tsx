import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Channel } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useMessages } from '../lib/useMessages'
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
  onThreadFocused?: () => void
}

export function ChannelView({ channel, onOpenRun, targetThreadId, onThreadFocused }: ChannelViewProps) {
  const { messages, loading, post } = useMessages(channel.id, null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef<string | undefined>(undefined)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>('all')

  // Filters reset when switching channels — each channel starts unfiltered.
  useEffect(() => {
    setStatusFilter('all')
    setRangeFilter('all')
  }, [channel.id])

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
  const workStatuses = useWorkStatuses()

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
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="font-bold"># {channel.name}</h2>
        {channel.topic && <p className="text-xs text-zinc-500">{channel.topic}</p>}
      </div>

      {/* Conversation filters — chips only appear for statuses present */}
      {!loading && groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/50 px-4 py-1.5 text-xs">
          <button
            onClick={() => setStatusFilter('all')}
            className={`rounded-full border px-2.5 py-0.5 transition ${
              statusFilter === 'all'
                ? 'border-zinc-400 bg-zinc-100 font-semibold text-zinc-900'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            All {rangeFilter === 'all' ? groups.length : [...counts.values()].reduce((a, b) => a + b, 0)}
          </button>
          {STATUS_CHIPS.map((chip) => {
            const count = counts.get(chip.key) ?? 0
            if (count === 0 && statusFilter !== chip.key) return null
            const active = statusFilter === chip.key
            return (
              <button
                key={chip.key}
                onClick={() => setStatusFilter(active ? 'all' : chip.key)}
                className={`rounded-full border px-2.5 py-0.5 transition ${
                  active ? chip.activeClass : 'border-transparent text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {chip.label} {count}
              </button>
            )
          })}
          <span className="mx-1 h-4 w-px bg-zinc-800" />
          {RANGE_CHIPS.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setRangeFilter(chip.key)}
              className={`rounded px-2 py-0.5 transition ${
                rangeFilter === chip.key
                  ? 'bg-zinc-800 font-medium text-zinc-100'
                  : 'text-zinc-600 hover:text-zinc-300'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

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
        {visible.map((entry, i) => (
          <ConversationGroup
            key={entry.group.trigger?.id ?? `group-${i}`}
            group={entry.group}
            channelId={channel.id}
            onOpenRun={onOpenRun}
            targetThreadId={targetThreadId}
            status={entry.status}
            onToggleDone={(rootId, done) => void toggleDone(rootId, done)}
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
