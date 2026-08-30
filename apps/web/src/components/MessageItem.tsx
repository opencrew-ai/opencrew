import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { REACTION_SET, type Message, type SharedTask } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'
import { ApprovalCard } from './ApprovalCard'
import { InlineThread } from './InlineThread'
import { ArtifactCard } from './ArtifactCard'
import { TaskChecklist } from './TaskChecklist'
import { ThreadRefCard } from './ThreadRefCard'
import { useArtifactsForRun } from '../lib/useChannelArtifacts'
import { ImageLightbox } from './ImageLightbox'

const MD_PLUGINS = [remarkGfm]

// Links must never navigate the app away — always open in a new tab.
const MD_COMPONENTS: Components = {
  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />
}

/** Reaction chips + hover picker. Constrained set, one toggle per emoji. */
function Reactions({ message }: { message: Message }) {
  const { me } = useWorkspace()
  const [pickerOpen, setPickerOpen] = useState(false)
  const groups = message.reactions ?? []

  const toggle = (emoji: string) => {
    setPickerOpen(false)
    void api.post(`/api/messages/${message.id}/reactions`, { emoji }).catch(() => {
      // WS reaction_updated never arrives on failure — chips stay as they were
    })
  }

  return (
    <div className="ml-7 mt-1 flex items-center gap-1">
      {groups.map((group) => {
        const mine = group.userIds.includes(me.id)
        return (
          <button
            key={group.emoji}
            onClick={() => toggle(group.emoji)}
            title={mine ? 'Remove reaction' : 'React'}
            className={`rounded-full border px-1.5 py-0.5 text-xs transition ${
              mine
                ? 'border-sky-600/60 bg-sky-950/50'
                : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-600'
            }`}
          >
            {group.emoji} <span className="text-[10px] text-zinc-400">{group.userIds.length}</span>
          </button>
        )
      })}
      <div className="relative">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className={`rounded-full border border-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500 transition hover:border-zinc-600 hover:text-zinc-300 ${
            groups.length === 0 ? 'invisible group-hover:visible' : ''
          }`}
          title="Add reaction"
        >
          +
        </button>
        {pickerOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-1 flex gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl">
            {REACTION_SET.map((emoji) => (
              <button
                key={emoji}
                onClick={() => toggle(emoji)}
                className="rounded px-1 text-base transition hover:bg-zinc-700"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface MessageItemProps {
  message: Message
  /**
   * When provided, reply counts and "reply" buttons are shown and clicking
   * them expands an inline thread. Omit for messages already inside a thread
   * (prevents infinite nesting).
   */
  channelId?: string
  onOpenRun?: (runId: string) => void
  /** When true the inline thread opens automatically (e.g. deep-linked from a ThreadRefCard). */
  autoOpenThread?: boolean
  /** Shared task list for the conversation this message roots. */
  tasksList?: SharedTask[]
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function MessageItem({
  message,
  channelId,
  onOpenRun,
  autoOpenThread,
  tasksList
}: MessageItemProps) {
  const { agents, users } = useWorkspace()
  // Docs produced by this message's run render inline right under it.
  const runArtifacts = useArtifactsForRun(message.runId)
  // Threads with activity are ALWAYS visible by default — collapsing is the
  // user's explicit opt-out, never the initial state. Agent work streams into
  // threads, so hiding them by default hides the payload.
  const [isCollapsed, setIsCollapsed] = useState(false)
  // For messages with no replies yet: "reply ↓" opens the empty thread + composer.
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // Auto-open the inline thread when deep-linked from a ThreadRefCard
  useEffect(() => {
    if (autoOpenThread && channelId) {
      setIsCollapsed(false)
      setIsComposerOpen(true)
    }
  }, [autoOpenThread, channelId])

  if (message.authorType === 'system') {
    return (
      <div className="px-4 py-1">
        <div className="text-xs text-zinc-500">
          <span className="mr-2">{formatTime(message.createdAt)}</span>
          <span className="md-content inline-block align-middle text-zinc-400">
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
              {message.content}
            </ReactMarkdown>
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
  const threadRootId = message.threadRootId ?? message.id
  // Personal crews: every agent message names the human whose crew it is.
  const owner = isAgent
    ? users.find((u) => u.id === agents.find((a) => a.id === message.authorId)?.createdBy)
    : undefined

  return (
    <div data-msg-id={message.id} className="group animate-fade-in px-4 py-1.5 hover:bg-zinc-900/40">
      {/* Header row */}
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
        {owner && (
          <span className="text-[11px] text-zinc-500" title={`${owner.name}'s crew`}>
            · {owner.name}
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

      {/* Message content */}
      <div className="md-content ml-7 text-sm leading-relaxed text-zinc-200">
        {message.content ? (
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
            {message.content}
          </ReactMarkdown>
        ) : (
          <span className="italic text-zinc-500">thinking…</span>
        )}
      </div>

      {/* Docs this reply produced — the doc, not the chat, is the reference */}
      {runArtifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}

      {/* Thread citation card */}
      {message.refThreadId && message.refChannelId && (
        <div className="ml-7 mt-1">
          <ThreadRefCard
            refThreadId={message.refThreadId}
            refChannelId={message.refChannelId}
            onOpenRun={onOpenRun}
          />
        </div>
      )}

      {/* Attached images — click opens lightbox */}
      {message.images && message.images.length > 0 && (
        <div className="ml-7 mt-1.5 flex flex-wrap gap-2">
          {message.images.map((src, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setLightboxSrc(src)}
              className="group/img relative overflow-hidden rounded-md border border-zinc-700 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-label={`View attachment ${i + 1}`}
            >
              <img
                src={src}
                alt={`attachment ${i + 1}`}
                className="max-h-60 max-w-xs cursor-zoom-in object-cover"
              />
              {/* Zoom hint overlay */}
              <span className="absolute inset-0 flex items-end justify-end bg-black/0 p-1.5 opacity-0 transition-all group-hover/img:bg-black/20 group-hover/img:opacity-100">
                <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  click to expand
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc}
          alt="Attachment"
          onClose={() => setLightboxSrc(null)}
        />
      )}

      {/* Emoji reactions */}
      <Reactions message={message} />

      {/* Shared plan — appears once the conversation actually has tasks
          (committed from a plan doc, added by a human, or via TodoWrite) */}
      {tasksList && tasksList.length > 0 && (
        <TaskChecklist rootId={message.id} items={tasksList} />
      )}

      {/* Thread actions — only shown when channelId is provided */}
      {channelId && (
        <div className="ml-7 mt-0.5 flex items-center gap-3">
          {message.replyCount ? (
            // Active thread: replies are visible by default, this collapses/restores
            <button
              onClick={() => setIsCollapsed((v) => !v)}
              className="text-xs font-medium text-sky-400 hover:underline"
            >
              {isCollapsed ? '▼' : '▲'} {message.replyCount}{' '}
              {message.replyCount === 1 ? 'reply' : 'replies'}
            </button>
          ) : (
            // No thread yet: offer to start one
            <button
              onClick={() => setIsComposerOpen((v) => !v)}
              className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              {isComposerOpen ? 'cancel ↑' : 'reply ↓'}
            </button>
          )}
        </div>
      )}

      {/* Inline thread — always visible when it has activity (unless the user
          collapsed it), or when the user is starting a new one */}
      {channelId && !isCollapsed && (!!message.replyCount || isComposerOpen) && (
        <InlineThread channelId={channelId} rootId={threadRootId} onOpenRun={onOpenRun} />
      )}
    </div>
  )
}
