import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Channel, Message } from '@opencrew/shared'
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
  const navigate = useNavigate()
  const [messages, setMessages] = useState<Message[]>([])
  const [channelName, setChannelName] = useState<string>(refChannelId)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchedRef = useRef(false)

  function goToThread(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation() // prevent double-fire from outer div + inner <a> bubbling
    navigate(`/channels/${refChannelId}?thread=${encodeURIComponent(refThreadId)}`)
  }

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    setLoading(true)
    setError(null)

    // Fetch thread messages and channel list in parallel
    Promise.all([
      api.get<Message[]>(
        `/api/search/thread?rootId=${encodeURIComponent(refThreadId)}&channelId=${encodeURIComponent(refChannelId)}`
      ),
      api.get<Channel[]>('/api/channels')
    ])
      .then(([msgs, channels]) => {
        setMessages(msgs)
        const ch = channels.find((c) => c.id === refChannelId)
        if (ch) setChannelName(ch.name)
      })
      .catch(() => setError('Could not load thread.'))
      .finally(() => setLoading(false))
  }, [refThreadId, refChannelId])

  const root = messages.find((m) => m.id === refThreadId) ?? messages[0]
  const replies = messages.filter((m) => m.id !== refThreadId)
  const PREVIEW_COUNT = 2
  const hidden = Math.max(0, replies.length - PREVIEW_COUNT)
  const visible = expanded ? replies : replies.slice(0, PREVIEW_COUNT)

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-950/60 text-sm">
      {/* Header bar — clicking anywhere on it navigates to the thread */}
      <div
        className="flex cursor-pointer items-center justify-between border-b border-zinc-700/40 bg-zinc-900/40 px-3 py-1.5 transition-colors hover:bg-zinc-800/40"
        onClick={goToThread}
        title="Open original thread"
      >
        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <span>📎</span>
          <span className="font-medium">#{channelName}</span>
          {root && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">{formatDate(root.createdAt)}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">
                {messages.length} message{messages.length !== 1 ? 's' : ''}
              </span>
            </>
          )}
        </div>
        <a
          href={`/channels/${refChannelId}?thread=${encodeURIComponent(refThreadId)}`}
          onClick={goToThread}
          className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
          title="Open original thread"
        >
          Go to thread →
        </a>
      </div>

      {/* Body */}
      <div className="divide-y divide-zinc-800/40">
        {loading && (
          <div className="animate-pulse px-3 py-3 text-xs text-zinc-500">Loading thread…</div>
        )}
        {error && <div className="px-3 py-3 text-xs text-red-400">{error}</div>}

        {/* Root / trigger message */}
        {root && !loading && (
          <div className="px-3 py-2">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span>{root.authorType === 'agent' ? root.authorEmoji : '👤'}</span>
              <span
                className={`font-semibold ${root.authorType === 'agent' ? 'text-zinc-300' : 'text-zinc-100'}`}
              >
                {root.authorName}
              </span>
              <span className="text-zinc-600">{formatTime(root.createdAt)}</span>
            </div>
            <p className="mt-0.5 leading-snug text-zinc-300">
              {root.content.length > 400 ? root.content.slice(0, 400) + '…' : root.content}
            </p>
          </div>
        )}

        {/* Reply previews */}
        {!loading &&
          visible.map((m) => (
            <div key={m.id} className="ml-3 border-l-2 border-zinc-700/50 px-3 py-1.5 pl-4">
              <div className="flex items-baseline gap-1.5 text-xs">
                <span>{m.authorType === 'agent' ? m.authorEmoji : '👤'}</span>
                <span
                  className={`font-semibold ${m.authorType === 'agent' ? 'text-zinc-300' : 'text-zinc-100'}`}
                >
                  {m.authorName}
                </span>
                <span className="text-zinc-600">{formatTime(m.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-xs leading-snug text-zinc-400">
                {m.content.length > 250 ? m.content.slice(0, 250) + '…' : m.content}
              </p>
            </div>
          ))}

        {/* Expand / collapse toggle */}
        {!loading && !error && replies.length > 0 && (
          <div className="px-3 py-1.5">
            {hidden > 0 && !expanded ? (
              <button
                onClick={() => setExpanded(true)}
                className="text-xs text-zinc-400 transition-colors hover:text-zinc-200"
              >
                + {hidden} more {hidden === 1 ? 'reply' : 'replies'} ↓
              </button>
            ) : expanded && hidden > 0 ? (
              <button
                onClick={() => setExpanded(false)}
                className="text-xs text-zinc-600 transition-colors hover:text-zinc-300"
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
