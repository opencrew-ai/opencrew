import { useState } from 'react'
import type { Message, RunStatus } from '@opencrew/shared'
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

export function StatusPill({ status }: { status: GroupStatus }) {
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
      <span className="flex items-center gap-1 text-xs text-amber-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        In progress
      </span>
    )
  }
  if (status === 'waiting') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        ⏸ Waiting
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
  let current: MessageGroup | null = null

  for (const msg of messages) {
    if (msg.authorType === 'human') {
      // Each human message starts a fresh conversation
      current = { trigger: msg, responses: [] }
      groups.push(current)
    } else {
      if (!current) {
        // Edge case: agent or system message before any human message
        current = { trigger: null, responses: [] }
        groups.push(current)
      }
      current.responses.push(msg)
    }
  }

  return groups
}

// ---------------------------------------------------------------------------
// ConversationGroup component
// ---------------------------------------------------------------------------

const COLLAPSE_AT = 3 // show first N responses, collapse the rest

interface ConversationGroupProps {
  group: MessageGroup
  channelId: string
  onOpenRun: (runId: string) => void
  targetThreadId?: string
}

export function ConversationGroup({ group, channelId, onOpenRun, targetThreadId }: ConversationGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const { trigger, responses } = group

  const hiddenCount = Math.max(0, responses.length - COLLAPSE_AT)
  const visibleResponses =
    expanded || hiddenCount === 0 ? responses : responses.slice(0, COLLAPSE_AT)
  const groupStatus = deriveGroupStatus(responses)

  // A group with only a human message and no responses: minimal card with "Not started" pill
  if (responses.length === 0) {
    return trigger ? (
      <div className="relative mx-3 mb-2 overflow-hidden rounded-xl border border-zinc-800/50 bg-zinc-950/20">
        <div className="pointer-events-none absolute right-3 top-2 z-10">
          <StatusPill status={groupStatus} />
        </div>
        <MessageItem
          message={trigger}
          channelId={channelId}
          onOpenRun={onOpenRun}
          autoOpenThread={targetThreadId === trigger.id}
        />
      </div>
    ) : null
  }

  return (
    <div className="relative mx-3 mb-3 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/30">
      {/* Status pill — top-right corner, floated over the trigger message header */}
      {trigger && (
        <div className="pointer-events-none absolute right-3 top-2 z-10">
          <StatusPill status={groupStatus} />
        </div>
      )}

      {/* Human trigger message */}
      {trigger && (
        <MessageItem
          message={trigger}
          channelId={channelId}
          onOpenRun={onOpenRun}
          autoOpenThread={targetThreadId === trigger.id}
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
        {visibleResponses.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            channelId={channelId}
            onOpenRun={onOpenRun}
            autoOpenThread={targetThreadId === m.id}
          />
        ))}

        {/* Collapse toggle */}
        {hiddenCount > 0 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="px-4 pb-2.5 pt-0.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            + {hiddenCount} more {hiddenCount === 1 ? 'response' : 'responses'} ↓
          </button>
        )}
        {expanded && hiddenCount > 0 && (
          <button
            onClick={() => setExpanded(false)}
            className="px-4 pb-2.5 pt-0.5 text-xs text-zinc-600 transition-colors hover:text-zinc-400"
          >
            collapse ↑
          </button>
        )}
      </div>
    </div>
  )
}
