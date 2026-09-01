import { useEffect, useRef } from 'react'
import type { Message, RunStatus, SharedTask } from '@opencrew/shared'
import { MessageItem } from './MessageItem'
import { UnreadDot } from './UnreadDot'
import { CheckCheckIcon, CollapseIcon, ExpandIcon } from './Icons'
import { useThreadReadState } from '../lib/useThreadReadState'

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
  const { trigger, responses } = group
  const groupRef = useRef<HTMLDivElement>(null)

  // Freeze defaultCollapsed at mount — a live conversation finishing mid-read
  // must never snap shut on the reader; only conversations already done when
  // the channel loaded start collapsed. Same pattern as the old useRef guard.
  const initialCollapsedRef = useRef(defaultCollapsed)

  // Thread read/collapse state — hook manages localStorage + server persistence.
  const { isCollapsed, isRead, hasNewActivity, collapse, expand, markAsRead } =
    useThreadReadState({
      channelId,
      rootId: trigger?.id ?? '',
      initialUnread: isUnread,
      initialCollapsed: initialCollapsedRef.current,
    })

  const isCardCollapsed = isCollapsed

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
        className={[
          'group relative mx-3 mb-2 overflow-hidden rounded-xl border transition-opacity',
          'bg-zinc-950/20 opacity-60 hover:opacity-100',
          isRead ? 'border-zinc-800/30' : 'border-zinc-800/40',
        ].join(' ')}
        role="article"
        aria-expanded={false}
        aria-label={trigger.content?.slice(0, 80) ?? 'Conversation'}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).matches('input,textarea,button,select')) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            expand()
          }
          if (e.key === 'r' || e.key === 'R') markAsRead()
        }}
      >
        {/* Top-right: unread dot + read pill + status pill + hover action strip */}
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1.5">
          {hasNewActivity && <UnreadDot animate />}
          {isRead && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800/60 px-2 py-0.5 text-xs text-zinc-500">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-emerald-600">
                <path d="M1.5 6.5l2.5 2.5 6.5-6" />
              </svg>
              read
            </span>
          )}
          {/* Hover action strip */}
          <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100">
            <button
              onClick={expand}
              title="Expand (Enter)"
              aria-label="Expand conversation"
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <ExpandIcon />
            </button>
            {!isRead && (
              <button
                onClick={markAsRead}
                title="Mark as read (R)"
                aria-label="Mark as read"
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              >
                <CheckCheckIcon />
              </button>
            )}
          </div>
          <StatusPill status={groupStatus} onToggleDone={toggleDone} />
        </div>
        <MessageItem message={trigger} onOpenRun={onOpenRun} />
        <button
          onClick={expand}
          className="px-4 pb-2 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <ExpandIcon className="mr-1 inline-block" />
          {hiddenTotal} hidden {hiddenTotal === 1 ? 'message' : 'messages'}
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
      role="article"
      aria-expanded={true}
      aria-label={trigger?.content?.slice(0, 80) ?? 'Conversation'}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches('input,textarea,button,select')) return
        if (e.key === 'c' || e.key === 'C') collapse()
        if (e.key === 'r' || e.key === 'R') markAsRead()
      }}
      className={[
        'group relative mx-3 mb-3 overflow-hidden rounded-xl border bg-zinc-950/30',
        'transition-colors focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-emerald-500 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950',
        // Live conversations breathe: phosphor frame + faint wash while agents
        // work; amber frame while waiting on a human; red edge on failure.
        groupStatus === 'in_progress'
          ? 'card-live border-emerald-500/30 bg-emerald-500/[0.03]'
          : groupStatus === 'waiting'
            ? 'border-amber-500/30'
            : groupStatus === 'failed'
              ? 'border-red-500/20'
              : hasNewActivity
                ? 'border-emerald-500/40'
                : 'border-zinc-800/60',
      ].join(' ')}
    >
      {/* Top-right: unread dot + hover action strip + status pill */}
      {trigger && (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1.5">
          {hasNewActivity && <UnreadDot animate />}

          {/* Hover-reveal action strip — keyboard equivalents in tooltip */}
          <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              onClick={collapse}
              title="Collapse (C)"
              aria-label="Collapse conversation"
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <CollapseIcon />
            </button>
            <button
              onClick={markAsRead}
              title="Mark as read (R)"
              aria-label="Mark conversation as read"
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <CheckCheckIcon />
            </button>
          </div>

          <StatusPill status={groupStatus} onToggleDone={toggleDone} />
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
