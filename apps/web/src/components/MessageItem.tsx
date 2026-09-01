import { useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { REACTION_SET, type Message, type SharedTask } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'
import { ApprovalCard } from './ApprovalCard'
import { InlineThread } from './InlineThread'
import { ArtifactCard, ArtifactRow } from './ArtifactCard'
import { TaskChecklist } from './TaskChecklist'
import { ThreadRefCard } from './ThreadRefCard'
import { ShareThreadButton } from './ShareThreadButton'
import { useArtifactById, useArtifactsForRun } from '../lib/useChannelArtifacts'
import { ImageLightbox } from './ImageLightbox'
import { diffAwarePre } from './UnifiedDiff'
import { DocLinkChip } from './DocDrawer'
import { CodeFileChip, looksLikeFilePath } from './CodeFileDrawer'

const MD_PLUGINS = [remarkGfm]

/** Extract the plain-text string from a ReactMarkdown children value. */
function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children))
    return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

/**
 * Build the shared markdown component overrides for a given message.
 * We need agentId to pass to CodeFileChip so relative paths resolve correctly.
 */
function buildMdComponents(agentId?: string): Components {
  return {
    // Links must never navigate the app away — always open in a new tab.
    a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,

    // ```diff fences (pasted diffs, change excerpts) render as a diff view.
    pre: diffAwarePre,

    // Bold text matching a known artifact title → clickable DocLinkChip.
    strong: ({ children }) => {
      const text = childrenToText(children)
      return <DocLinkChip title={text} fallback={<strong>{children}</strong>} />
    },

    // Inline `code` spans that look like file paths → clickable CodeFileChip.
    // Block code fences (node.inline === false) stay as plain <code>.
    code: ({ children, node, ...rest }) => {
      // ReactMarkdown passes inline=false for fenced blocks; inline=true for backtick spans.
      // The `inline` prop isn't always in the type definition so we check the node position.
      const isBlock = node?.position
        ? (node.position.start.line !== node.position.end.line)
        : false
      if (!isBlock) {
        const text = childrenToText(children)
        if (looksLikeFilePath(text)) {
          return <CodeFileChip path={text} agentId={agentId} />
        }
      }
      return <code {...rest}>{children}</code>
    },
  }
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
            className={`rounded-full px-1.5 py-0.5 text-xs transition ${
              mine
                ? 'bg-emerald-950/60 ring-1 ring-emerald-600/50'
                : 'bg-zinc-800/60 hover:bg-zinc-800'
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
  // Build markdown components once per message, keyed to the author's agentId
  // so CodeFileChip can resolve relative paths against the right workspace dir.
  const isAgentMsg = message.authorType === 'agent'
  const mdComponents = buildMdComponents(isAgentMsg ? (message.authorId ?? undefined) : undefined)
  // Docs produced by this message's run render inline right under it.
  const runArtifacts = useArtifactsForRun(message.runId)
  // Explicitly anchored card (review notices) — reachable even when the
  // proposing run never managed to post a reply.
  const anchoredArtifact = useArtifactById(message.refArtifactId)
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
    // Notices that anchor a doc render as ONE compact live row — the row's
    // status comes from the artifact, so it can never contradict reality the
    // way frozen notice text ("awaiting approval" on a committed doc) does.
    if (anchoredArtifact) {
      return (
        <div className="group px-4 py-0.5">
          <ArtifactRow artifact={anchoredArtifact} />
        </div>
      )
    }
    return (
      <div className="group px-4 py-1">
        <div className="text-[11px] text-zinc-500">
          <span className="mr-2 hidden group-hover:inline">{formatTime(message.createdAt)}</span>
          <span className="md-content inline-block align-middle text-zinc-500">
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={mdComponents}>
              {message.content}
            </ReactMarkdown>
          </span>
        </div>
        {message.approvalId && <ApprovalCard approvalId={message.approvalId} />}
        {message.runId && onOpenRun && (
          <button
            onClick={() => onOpenRun(message.runId!)}
            className="invisible mt-1 text-xs text-zinc-500 underline hover:text-zinc-300 group-hover:visible"
          >
            view terminal
          </button>
        )}
      </div>
    )
  }

  const isAgent = message.authorType === 'agent'

  // A run that ended without a text reply leaves an empty placeholder row —
  // that's plumbing, not conversation. Show "thinking…" only while live.
  const isRunActive = message.runStatus === 'running' || message.runStatus === 'queued'
  if (isAgent && !message.content && !isRunActive && runArtifacts.length === 0) {
    return null
  }

  // Approval kickoff (human message anchored to the doc it approved): the
  // mention dispatches the agent, but visually it's a one-line receipt.
  // The content-pattern check also catches kickoffs from before refArtifactId.
  if (
    !isAgent &&
    (message.refArtifactId
      ? message.content.includes('✅')
      : /^@\S+ ✅ Approved/.test(message.content))
  ) {
    return (
      <div className="group px-4 py-1">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>✅</span>
          <span className="md-content min-w-0 [&_p]:truncate">
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={mdComponents}>
              {message.content.replace('✅ ', '')}
            </ReactMarkdown>
          </span>
          <span className="hidden whitespace-nowrap text-zinc-600 group-hover:inline">
            — {message.authorName} · {formatTime(message.createdAt)}
          </span>
        </div>
      </div>
    )
  }
  const threadRootId = message.threadRootId ?? message.id
  // Personal crews: every agent message names the human whose crew it is.
  const owner = isAgent
    ? users.find((u) => u.id === agents.find((a) => a.id === message.authorId)?.createdBy)
    : undefined

  return (
    <div data-msg-id={message.id} className="group animate-fade-in px-4 py-1.5 hover:bg-zinc-900/40">
      {/* Header row — identity is visual (square tile = agent, round = human);
          timestamp/owner/terminal reveal on hover to keep the resting view calm */}
      <div className="flex items-center gap-2">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center ${
            isAgent
              ? 'rounded-md bg-zinc-800/90 text-sm'
              : 'rounded-full bg-zinc-700/70 text-[10px] font-bold text-zinc-200'
          }`}
        >
          {isAgent ? message.authorEmoji : (message.authorName ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span
          className={`font-display text-sm font-semibold ${
            isAgent ? 'text-zinc-200' : 'text-zinc-50'
          }`}
        >
          {message.authorName}
        </span>
        <span className="invisible flex items-baseline gap-2 group-hover:visible">
          {owner && (
            <span className="text-[11px] text-zinc-500" title={`${owner.name}'s crew`}>
              {owner.name}'s crew
            </span>
          )}
          <span className="font-mono text-[11px] tabular-nums text-zinc-500">{formatTime(message.createdAt)}</span>
          {isAgent && message.runId && onOpenRun && (
            <button
              onClick={() => onOpenRun(message.runId!)}
              className="text-xs text-zinc-500 underline hover:text-zinc-300"
            >
              terminal
            </button>
          )}
        </span>
      </div>

      {/* Message content — humans read a notch brighter than agents */}
      <div
        className={`md-content ml-7 text-sm leading-relaxed ${
          isAgent ? 'text-zinc-300' : 'text-zinc-100'
        }`}
      >
        {message.content ? (
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={mdComponents}>
            {message.content}
          </ReactMarkdown>
        ) : (
          <span className="italic text-zinc-500">thinking…</span>
        )}
      </div>

      {/* Docs this reply produced — the doc, not the chat, is the reference.
          One doc gets the full card; a batch renders as compact rows so a
          single message can't wall off the feed with stacked cards. */}
      {runArtifacts.length === 1 && <ArtifactCard artifact={runArtifacts[0]!} />}
      {runArtifacts.length > 1 &&
        runArtifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} />)}

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
              className="group/img relative overflow-hidden rounded-md border border-zinc-700 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
            <>
              <button
                onClick={() => setIsCollapsed((v) => !v)}
                className="text-xs font-medium text-emerald-400/90 hover:underline"
              >
                {isCollapsed ? '▼' : '▲'} {message.replyCount}{' '}
                {message.replyCount === 1 ? 'reply' : 'replies'}
              </button>
              <ShareThreadButton rootId={threadRootId} />
            </>
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
