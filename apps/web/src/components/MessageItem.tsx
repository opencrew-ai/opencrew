import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@opencrew/shared'
import { ApprovalCard } from './ApprovalCard'

const MD_PLUGINS = [remarkGfm]

interface MessageItemProps {
  message: Message
  onOpenThread?: (rootId: string) => void
  onOpenRun?: (runId: string) => void
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function MessageItem({ message, onOpenThread, onOpenRun }: MessageItemProps) {
  if (message.authorType === 'system') {
    return (
      <div className="px-4 py-1">
        <div className="text-xs text-zinc-500">
          <span className="mr-2">{formatTime(message.createdAt)}</span>
          <span className="md-content inline-block align-middle text-zinc-400">
            <ReactMarkdown remarkPlugins={MD_PLUGINS}>{message.content}</ReactMarkdown>
          </span>
        </div>
        {message.approvalId && <ApprovalCard approvalId={message.approvalId} />}
        {message.runId && onOpenRun && (
          <button
            onClick={() => onOpenRun(message.runId!)}
            className="mt-1 text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            view terminal
          </button>
        )}
      </div>
    )
  }

  const isAgent = message.authorType === 'agent'
  return (
    <div className="group px-4 py-1.5 hover:bg-zinc-900/40">
      <div className="flex items-baseline gap-2">
        <span className="text-base">{isAgent ? message.authorEmoji : '👤'}</span>
        <span className={`text-sm font-semibold ${isAgent ? 'text-violet-300' : 'text-zinc-100'}`}>
          {message.authorName}
        </span>
        {isAgent && (
          <span className="rounded bg-violet-900/50 px-1 text-[10px] uppercase tracking-wide text-violet-300">
            agent
          </span>
        )}
        <span className="text-xs text-zinc-500">{formatTime(message.createdAt)}</span>
        {isAgent && message.runId && onOpenRun && (
          <button
            onClick={() => onOpenRun(message.runId!)}
            className="invisible text-xs text-zinc-500 underline hover:text-zinc-300 group-hover:visible"
          >
            terminal
          </button>
        )}
      </div>
      <div className="md-content ml-7 text-sm leading-relaxed text-zinc-200">
        {message.content ? (
          <ReactMarkdown remarkPlugins={MD_PLUGINS}>{message.content}</ReactMarkdown>
        ) : (
          <span className="italic text-zinc-500">thinking…</span>
        )}
      </div>
      {message.images && message.images.length > 0 && (
        <div className="ml-7 mt-1.5 flex flex-wrap gap-2">
          {message.images.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noopener noreferrer">
              <img
                src={src}
                alt={`attachment ${i + 1}`}
                className="max-h-60 max-w-xs rounded-md border border-zinc-700 object-cover hover:opacity-90 transition-opacity cursor-zoom-in"
              />
            </a>
          ))}
        </div>
      )}
      <div className="ml-7 mt-0.5 flex items-center gap-3">
        {/* Reply count — always visible when > 0 */}
        {onOpenThread && !!message.replyCount && (
          <button
            onClick={() => onOpenThread(message.threadRootId ?? message.id)}
            className="text-xs font-medium text-sky-400 hover:underline"
          >
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
        {/* "reply in thread" — hover only */}
        {onOpenThread && (
          <button
            onClick={() => onOpenThread(message.threadRootId ?? message.id)}
            className="invisible text-xs text-zinc-500 transition-colors hover:text-zinc-300 group-hover:visible"
          >
            {message.replyCount ? 'open thread' : 'reply in thread'}
          </button>
        )}
      </div>
    </div>
  )
}
