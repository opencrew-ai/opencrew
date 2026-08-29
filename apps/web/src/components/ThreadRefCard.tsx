import { useEffect, useState } from 'react'
import type { Message } from '@opencrew/shared'
import { api } from '../lib/api'

interface ThreadRefCardProps {
  refThreadId: string
  refChannelId: string
  onOpenRun?: (runId: string) => void
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ThreadRefCard({ refThreadId, refChannelId }: ThreadRefCardProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api
      .get<Message[]>(
        `/api/search/thread?rootId=${encodeURIComponent(refThreadId)}&channelId=${encodeURIComponent(refChannelId)}`
      )
      .then(setMessages)
      .catch(() => setError('Could not load thread.'))
      .finally(() => setLoading(false))
  }, [refThreadId, refChannelId])

  const root = messages.find((m) => m.id === refThreadId) ?? messages[0]
  const replies = messages.filter((m) => m.id !== refThreadId)
  const PREVIEW_COUNT = 2
  const hidden = Math.max(0, replies.length - PREVIEW_COUNT)
  const visible = expanded ? replies : replies.slice(0, PREVIEW_COUNT)

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-indigo-700/40 bg-zinc-950/60 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-indigo-700/30 bg-indigo-950/30 px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs text-indigo-300">
          <span>📎</span>
          <span className="font-medium">#{refChannelId}</span>
          {root && (
            <>
              <span className="text-indigo-500">·</span>
              <span className="text-indigo-400">{formatDate(root.createdAt)}</span>
              <span className="text-indigo-500">·</span>
              <span className="text-indigo-400">{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
            </>
          )}
        </div>
        <a
          href={`?channel=${refChannelId}`}
          className="text-xs text-indigo-400 transition-colors hover:text-indigo-200"
          title="Go to original thread"
        >
          Go to thread →
        </a>
      </div>

      {/* Body */}
      <div className="divide-y divide-zinc-800/40">
        {loading && (
          <div className="px-3 py-3 text-xs text-zinc-500 animate-pulse">Loading thread…</div>
        )}
        {error && (
          <div className="px-3 py-3 text-xs text-red-400">{error}</div>
        )}

        {/* Root message */}
        {root && (
          <div className="px-3 py-2">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span>{root.authorType === 'agent' ? root.authorEmoji : '👤'}</span>
              <span className={`font-semibold ${root.authorType === 'agent' ? 'text-violet-300' : 'text-zinc-100'}`}>
                {root.authorName}
              </span>
              <span className="text-zinc-600">{formatTime(root.createdAt)}</span>
            </div>
            <p className="mt-0.5 text-zinc-300 leading-snug">
              {root.content.length > 400 ? root.content.slice(0, 400) + '…' : root.content}
            </p>
          </div>
        )}

        {/* Reply preview */}
        {visible.map((m) => (
          <div key={m.id} className="px-3 py-1.5 pl-6 border-l-2 border-indigo-800/50 ml-3">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span>{m.authorType === 'agent' ? m.authorEmoji : '👤'}</span>
              <span className={`font-semibold ${m.authorType === 'agent' ? 'text-violet-300' : 'text-zinc-100'}`}>
                {m.authorName}
              </span>
              <span className="text-zinc-600">{formatTime(m.createdAt)}</span>
            </div>
            <p className="mt-0.5 text-zinc-400 leading-snug text-xs">
              {m.content.length > 250 ? m.content.slice(0, 250) + '…' : m.content}
            </p>
          </div>
        ))}

        {/* Expand / collapse */}
        {!loading && !error && replies.length > 0 && (
          <div className="px-3 py-1.5">
            {hidden > 0 && !expanded ? (
              <button
                onClick={() => setExpanded(true)}
                className="text-xs text-indigo-400 hover:text-indigo-200 transition-colors"
              >
                + {hidden} more {hidden === 1 ? 'reply' : 'replies'} ↓
              </button>
            ) : expanded && hidden > 0 ? (
              <button
                onClick={() => setExpanded(false)}
                className="text-xs text-indigo-500 hover:text-indigo-300 transition-colors"
              >
                collapse ↑
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
