import { useState } from 'react'
import type { Message } from '@opencrew/shared'
import { MessageItem } from './MessageItem'

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
  onOpenThread: (rootId: string) => void
  onOpenRun: (runId: string) => void
}

export function ConversationGroup({ group, onOpenThread, onOpenRun }: ConversationGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const { trigger, responses } = group

  const hiddenCount = Math.max(0, responses.length - COLLAPSE_AT)
  const visibleResponses =
    expanded || hiddenCount === 0 ? responses : responses.slice(0, COLLAPSE_AT)

  // A group with only a human message and no responses doesn't need the box treatment
  if (responses.length === 0) {
    return trigger ? (
      <div className="mx-3 mb-2 overflow-hidden rounded-xl border border-zinc-800/50 bg-zinc-950/20">
        <MessageItem message={trigger} onOpenThread={onOpenThread} onOpenRun={onOpenRun} />
      </div>
    ) : null
  }

  return (
    <div className="mx-3 mb-3 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/30">
      {/* Human trigger message */}
      {trigger && (
        <MessageItem message={trigger} onOpenThread={onOpenThread} onOpenRun={onOpenRun} />
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
          <MessageItem key={m.id} message={m} onOpenThread={onOpenThread} onOpenRun={onOpenRun} />
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
