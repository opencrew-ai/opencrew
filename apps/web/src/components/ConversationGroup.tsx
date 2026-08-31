import { useEffect, useRef, useState } from 'react'
import type { Message, RunStatus, SharedTask } from '@opencrew/shared'
import { MessageItem } from './MessageItem'

// ---------------------------------------------------------------------------
// Status pill — derived from run statuses across all agent responses
// ---------------------------------------------------------------------------

export type GroupStatus = 'not_started' | 'in_progress' | 'waiting' | 'done' | 'failed'

export function deriveGroupStatus(responses: Message[]): GroupStatus {
  const statuses = responses.map((m) => m.runStatus).filter(Boolean) as RunStatus[]
  if (statuses.length === 0) return 'not_started'
  if (statuses.some((s) => s === 'awaiting_approval')) return 'waiting'
  if (statuses.some((s) => s === 'running' || s === 'queued')) return 'in_progress'
  if (statuses.some((s) => s === 'failed')) return 'failed'
  return 'done'
}

/**
 * The pill is also the manual control: click marks the conversation done,
 * click again reopens it. Active runs (waiting/running) can't be overridden —
 * truth beats labels while agents are working.
 */
interface StatusPillProps {
  status: GroupStatus
  onToggleDone?: (done: boolean) => void
}

export function StatusPill({ status, onToggleDone }: StatusPillProps) {
  const canToggle =
    onToggleDone !== undefined && status !== 'waiting' && status !== 'in_progress'
  const pill = renderPill(status)
  if (!canToggle) return pill
  return (
    <button
      onClick={() => onToggleDone(status !== 'done')}
      title={status === 'done' ? 'Reopen' : 'Mark done'}
      className="cursor-pointer rounded transition-opacity hover:opacity-70"
    >
      {pill}
    </button>
  )
}

function renderPill(status: GroupStatus) {
  if (status === 'not_started') {
    return (
      <span className="flex items-center gap-1 text-xs text-zinc-600">
        <span className="h-1.5 w-1.5 rounded-full border border-zinc-600" />
        Not started
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
        In progress
      </span>
    )
  }
  if (status === 'waiting') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Waiting
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex items-center gap-1 text-xs text-red-400">
        <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
        ✗ Failed
      </span>
    )
  }
  // done
  return (
    <span className="flex items-center gap-1 text-xs text-emerald-500">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      ✓ Done
    </span>
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageGroup {
  /** The human message that started this conversation. null = agent messages
   *  at the top of the feed before any human has spoken (edge case). */
  trigger: Message | null
  /** All agent + system messages that belong to this conversation. */
  responses: Message[]
}

// ---------------------------------------------------------------------------
// Pure grouping function — no side effects, easy to unit-test
// ---------------------------------------------------------------------------

export function groupIntoConversations(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  const byRoot = new Map<string, MessageGroup>()
  let current: MessageGroup | null = null

  for (const msg of messages) {
    if (msg.authorType === 'human') {
      // Each human message starts a fresh conversation
      current = { trigger: msg, responses: [] }
      groups.push(current)
      byRoot.set(msg.id, current)
      continue
    }

    // A run-produced message belongs to the conversation of the human message
    // that triggered its run — NOT to whichever human message is newest when
    // it arrives. Position is only a fallback for messages with no run link.
    let home = msg.conversationRootId ? byRoot.get(msg.conversationRootId) : undefined
    if (!home && msg.conversationRootId) {
      // Root is older than the loaded page — give the run its own group
      // rather than misfiling it under an unrelated conversation.
      home = { trigger: null, responses: [] }
      byRoot.set(msg.conversationRootId, home)
      groups.push(home)
    }
    if (!home) {
      if (!current) {
        // Edge case: agent or system message before any human message
        current = { trigger: null, responses: [] }
        groups.push(current)
      }
      home = current
    }
    home.responses.push(msg)
  }

  return groups
}

// ---------------------------------------------------------------------------
// ConversationGroup component
// ---------------------------------------------------------------------------

interface ConversationGroupProps {
  group: MessageGroup
  channelId: string
  onOpenRun: (runId: string) => void
  targetThreadId?: string
  /** Override the message-derived status (e.g. server-side run aggregation). */
  status?: GroupStatus
  /** When set, the pill is clickable: mark the conversation done / reopen. */
  onToggleDone?: (rootId: string, done: boolean) => void
  /** True when this group has new activity the user hasn't scrolled past yet. */
  isUnread?: boolean
  /** Called once when the group becomes visible in the viewport. */
  onSeen?: () => void
  /** Finished conversations start collapsed to a single card. */
  defaultCollapsed?: boolean
  /** Shared task list for this conversation. */
  tasksList?: SharedTask[]
}

export function ConversationGroup({
  group,
  channelId,
  onOpenRun,
  targetThreadId,
  status,
  onToggleDone,
  isUnread = false,
  onSeen,
  defaultCollapsed = false,
  tasksList
}: ConversationGroupProps) {
  // null = no manual choice yet. The default is FROZEN at mount: a live
  // conversation finishing mid-read must never snap shut on the reader —
  // only conversations that were already done when the channel loaded
  // start collapsed.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const initialCollapsedRef = useRef(defaultCollapsed)
  const { trigger, responses } = group
  const groupRef = useRef<HTMLDivElement>(null)
  const isCardCollapsed = userCollapsed ?? initialCollapsedRef.current

  // Fire onSeen once when the group enters the viewport
  useEffect(() => {
    if (!onSeen || !isUnread) return
    const el = groupRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onSeen()
          observer.disconnect()
        }
      },
      { threshold: 0.2 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [isUnread, onSeen])

  const groupStatus = status ?? deriveGroupStatus(responses)
  const toggleDone =
    trigger && onToggleDone ? (done: boolean) => onToggleDone(trigger.id, done) : undefined

  // Deep links always win over collapse — the linked message must be visible.
  const containsTarget =
    !!targetThreadId &&
    (trigger?.id === targetThreadId || responses.some((m) => m.id === targetThreadId))

  // Collapsed card: trigger only (no thread UI), plus a row to expand.
  const hiddenTotal = responses.length + (trigger?.replyCount ?? 0)
  if (isCardCollapsed && !containsTarget && trigger && hiddenTotal > 0) {
    return (
      <div
        ref={groupRef}
        className="relative mx-3 mb-2 overflow-hidden rounded-xl border border-zinc-800/40 bg-zinc-950/20"
      >
        <div className="absolute right-3 top-2 z-10">
          <StatusPill status={groupStatus} onToggleDone={toggleDone} />
        </div>
        <MessageItem message={trigger} onOpenRun={onOpenRun} />
        <button
          onClick={() => setUserCollapsed(false)}
          className="px-4 pb-2 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          ▼ {hiddenTotal} hidden {hiddenTotal === 1 ? 'message' : 'messages'}
        </button>
      </div>
    )
  }

  // A group with only a human message and no responses: minimal card with "Not started" pill
  if (responses.length === 0) {
    return trigger ? (
      <div ref={groupRef} className="relative mx-3 mb-2 overflow-hidden rounded-xl border border-zinc-800/50 bg-zinc-950/20">
        <div className="absolute right-3 top-2 z-10">
          <StatusPill status={groupStatus} onToggleDone={toggleDone} />
        </div>
        <MessageItem
          message={trigger}
          channelId={channelId}
          onOpenRun={onOpenRun}
          autoOpenThread={targetThreadId === trigger.id}
          tasksList={tasksList}
        />
      </div>
    ) : null
  }

  return (
    <div
      ref={groupRef}
      className={[
        'relative mx-3 mb-3 overflow-hidden rounded-xl border bg-zinc-950/30 transition-colors',
        // Live conversations breathe: phosphor frame + faint wash while agents
        // work; amber frame while waiting on a human; red edge on failure.
        groupStatus === 'in_progress'
          ? 'card-live border-emerald-500/30 bg-emerald-500/[0.03]'
          : groupStatus === 'waiting'
            ? 'border-amber-500/30'
            : groupStatus === 'failed'
              ? 'border-red-500/20'
              : isUnread
                ? 'border-emerald-500/40'
                : 'border-zinc-800/60',
      ].join(' ')}
    >
      {/* Status pill + unread dot — top-right corner */}
      {trigger && (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-2">
          {isUnread && (
            <span
              title="New activity"
              className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]"
            />
          )}
          <StatusPill status={groupStatus} onToggleDone={toggleDone} />
          {groupStatus === 'done' && hiddenTotal > 0 && (
            <button
              onClick={() => setUserCollapsed(true)}
              title="Collapse conversation"
              className="text-xs text-zinc-600 transition-colors hover:text-zinc-300"
            >
              ▲
            </button>
          )}
        </div>
      )}

      {/* Human trigger message */}
      {trigger && (
        <MessageItem
          message={trigger}
          channelId={channelId}
          onOpenRun={onOpenRun}
          autoOpenThread={targetThreadId === trigger.id}
          tasksList={tasksList}
        />
      )}

      {/* Agent / system responses — indented with left rule */}
      <div
        className={[
          'border-t border-zinc-800/40',
          trigger ? 'ml-4 border-l border-zinc-700/40 sm:ml-6' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {responses.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            channelId={channelId}
            onOpenRun={onOpenRun}
            autoOpenThread={targetThreadId === m.id}
          />
        ))}
      </div>
    </div>
  )
}
