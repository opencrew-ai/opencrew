import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Artifact, ArtifactComment } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useWorkspace } from '../lib/workspace'
import { DiffIcon, DocIcon } from './Icons'

function KindIcon({ kind, className }: { kind: Artifact['kind']; className?: string }) {
  return kind === 'change' ? (
    <DiffIcon className={className} />
  ) : (
    <DocIcon className={className} />
  )
}

const MD_PLUGINS = [remarkGfm]
const MD_COMPONENTS: Components = {
  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />
}

const QUOTE_PREVIEW = 120

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find the selected (rendered) text inside the raw markdown source. Rendered
 * text loses formatting characters, so fall back to a tolerant match that
 * lets markdown punctuation appear between words.
 */
function locateSelection(raw: string, selected: string): [number, number] | null {
  const direct = raw.indexOf(selected)
  if (direct !== -1) return [direct, direct + selected.length]
  const tokens = selected.split(/\s+/).filter(Boolean).map(escapeRegExp)
  if (tokens.length === 0) return null
  const match = new RegExp(tokens.join('[\\s*_`#>\\-|]+')).exec(raw)
  return match ? [match.index, match.index + match[0].length] : null
}

function relativeTime(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Docs almost always open with an H1 repeating their own title — the card
 * chrome already shows it, so drop that line (and a leading status-metadata
 * blockquote) from previews to kill the triple-title effect.
 */
function stripLeadingTitle(content: string, title: string): string {
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  const heading = /^#{1,3}\s+(.*)$/.exec(lines[i] ?? '')
  if (heading && similarTitle(heading[1]!, title)) i++
  return lines.slice(i).join('\n').trimStart()
}

function similarTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const na = norm(a)
  const nb = norm(b)
  return na.includes(nb) || nb.includes(na)
}

function StatusBadge({ status }: { status: Artifact['status'] }) {
  if (status === 'review') {
    return (
      <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] lowercase tracking-wide text-zinc-300">
        in review
      </span>
    )
  }
  if (status === 'proposed') {
    return (
      <span className="rounded bg-amber-900/60 px-1.5 py-0.5 font-mono text-[10px] lowercase tracking-wide text-amber-300">
        awaiting approval
      </span>
    )
  }
  return (
    <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 font-mono text-[10px] lowercase tracking-wide text-emerald-300">
      ✓ committed
    </span>
  )
}

// ---------------------------------------------------------------------------
// Review modal — read the doc, comment on selections, approve/reject/revise
// ---------------------------------------------------------------------------

interface DocModalProps {
  artifact: Artifact
  onClose: () => void
}

/** Self-contained doc review modal — usable from the feed and the Artifacts tab. */
export function ArtifactDocModal({ artifact, onClose }: DocModalProps) {
  const { me, agents } = useWorkspace()
  // Human edits create new versions in place — track the live doc locally.
  const [doc, setDoc] = useState(artifact)
  const canReview = me.role !== 'guest'
  const canAct = me.role !== 'guest' && doc.status === 'proposed'
  const agent = agents.find((a) => a.id === doc.createdByAgentId)
  const agentLabel = agent ? `${agent.avatarEmoji} ${agent.name}` : undefined
  const [isActing, setIsActing] = useState(false)

  const onAct = async (action: 'commit' | 'discard') => {
    setIsActing(true)
    try {
      await api.post(`/api/artifacts/${doc.id}/${action}`)
      onClose()
    } catch {
      // artifact_state never arrives on failure — modal stays open
    } finally {
      setIsActing(false)
    }
  }
  const docRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [comments, setComments] = useState<ArtifactComment[]>([])
  // Floating selection popover — anchored at the selected text, Medium-style.
  const [popover, setPopover] = useState<{
    x: number
    top: number
    bottom: number
    quote: string
    mode: 'actions' | 'comment'
  } | null>(null)
  const [popoverDraft, setPopoverDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [isRevising, setIsRevising] = useState(false)
  const [feedbackDraft, setFeedbackDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [isSavingEdit, setIsSavingEdit] = useState(false)

  /** Enter edit mode; when entered from a selection, pre-select it in the source. */
  const startEdit = (quote?: string | null) => {
    setEditDraft(doc.content)
    setIsEditing(true)
    setPopover(null)
    requestAnimationFrame(() => {
      const area = editRef.current
      if (!area) return
      area.focus()
      const range = quote ? locateSelection(doc.content, quote) : null
      if (range) {
        area.setSelectionRange(range[0], range[1])
        // Rough scroll: place the selection about a third down the viewport.
        const before = doc.content.slice(0, range[0]).split('\n').length
        const total = doc.content.split('\n').length
        area.scrollTop = Math.max(0, (before / total) * area.scrollHeight - area.clientHeight / 3)
      }
    })
  }

  const saveEdit = async () => {
    const content = editDraft.trim()
    if (!content || content === doc.content) {
      setIsEditing(false)
      return
    }
    setIsSavingEdit(true)
    try {
      const next = await api.post<Artifact>(`/api/artifacts/${doc.id}/edit`, { content })
      setDoc(next)
      setIsEditing(false)
    } catch {
      // keep the draft — the user can retry or copy their text out
    } finally {
      setIsSavingEdit(false)
    }
  }

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prev
    }
  }, [handleKey])

  // Load existing comments; live-merge new ones. Merging (not replacing)
  // keeps earlier-version comments visible after an in-place edit bumps doc.id.
  useEffect(() => {
    api
      .get<ArtifactComment[]>(`/api/artifacts/${doc.id}/comments`)
      .then((loaded) =>
        setComments((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...loaded.filter((c) => !seen.has(c.id))]
        })
      )
      .catch(() => {})
    return wsClient.subscribe((event) => {
      if (event.type !== 'artifact_comment') return
      if (event.comment.artifactId !== doc.id) return
      setComments((prev) =>
        prev.some((c) => c.id === event.comment.id) ? prev : [...prev, event.comment]
      )
    })
  }, [doc.id])

  // Select text in the doc → a floating popover appears at the selection
  // with the actions (comment / edit) right where the user is looking.
  const captureSelection = () => {
    if (!canReview) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      setPopover(null)
      return
    }
    const text = selection.toString().trim()
    if (!text || !docRef.current) return
    if (!docRef.current.contains(selection.anchorNode)) return
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    setPopoverDraft('')
    setPopover({
      x: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
      quote: text.slice(0, 1000),
      mode: 'actions'
    })
  }

  // Click anywhere outside the popover dismisses it.
  const dismissPopover = (e: ReactMouseEvent) => {
    if (popover && !popoverRef.current?.contains(e.target as Node)) setPopover(null)
  }

  const postComment = async () => {
    const body = commentDraft.trim()
    if (!body) return
    setCommentDraft('')
    await api.post(`/api/artifacts/${doc.id}/comments`, { body }).catch(() => {})
  }

  const postSelectionComment = async () => {
    if (!popover) return
    const body = popoverDraft.trim()
    if (!body) return
    const { quote } = popover
    setPopover(null)
    setPopoverDraft('')
    await api.post(`/api/artifacts/${doc.id}/comments`, { body, quote }).catch(() => {})
  }

  const sendFeedback = async () => {
    const feedback = feedbackDraft.trim()
    if (!feedback) return
    setIsSending(true)
    try {
      await api.post(`/api/artifacts/${doc.id}/request-changes`, { feedback })
      onClose()
    } catch {
      // stays open — user can retry
    } finally {
      setIsSending(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={dismissPopover}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"
      >
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
          <KindIcon kind={doc.kind} className="text-zinc-500" />
          <h2 className="min-w-0 flex-1 truncate font-bold text-zinc-100">{doc.title}</h2>
          <span className="font-mono text-xs tabular-nums text-zinc-500">v{doc.version}</span>
          <StatusBadge status={doc.status} />
          {canReview && !isEditing && (
            <button
              onClick={() => startEdit()}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
              title="Edit the doc text directly"
            >
              ✏️ Edit
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-2 rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        {isEditing ? (
          <div className="flex flex-1 flex-col overflow-hidden px-6 py-4">
            <p className="mb-2 text-[11px] text-zinc-600">
              Editing the markdown source — saving creates v{doc.version + 1} in place.
            </p>
            <textarea
              ref={editRef}
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              spellCheck={false}
              className="min-h-[50vh] flex-1 resize-none rounded border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-xs leading-relaxed text-zinc-200 focus:border-zinc-600 focus:outline-none"
            />
          </div>
        ) : (
        <div
          className="flex-1 overflow-y-auto px-6 py-4"
          onScroll={() => {
            // The popover is viewport-anchored; scrolling detaches it from
            // the text, so let it go rather than float wrong.
            if (popover?.mode === 'actions') setPopover(null)
          }}
        >
          {canReview && (
            <p className="mb-2 text-[11px] text-zinc-600">
              Tip: select any text in the doc to comment on it — or edit it in place.
            </p>
          )}
          <div
            ref={docRef}
            onMouseUp={captureSelection}
            className="md-content text-sm leading-relaxed text-zinc-300"
          >
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
              {stripLeadingTitle(doc.content, doc.title)}
            </ReactMarkdown>
          </div>

          {doc.tasks.length > 0 && (
            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Tasks on approval
              </p>
              <ul className="mt-1">
                {doc.tasks.map((task, i) => (
                  <li key={i} className="flex items-start gap-2 py-0.5 text-sm text-zinc-400">
                    <span
                      className={
                        task.priority === 'high'
                          ? 'text-red-400'
                          : task.priority === 'medium'
                            ? 'text-zinc-300'
                            : 'text-zinc-500'
                      }
                    >
                      {task.priority === 'high' ? '‼' : task.priority === 'medium' ? '•' : '·'}
                    </span>
                    <span>{task.content}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Review comments */}
          {comments.length > 0 && (
            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Comments ({comments.length})
              </p>
              <ul className="mt-1 space-y-2">
                {comments.map((comment) => (
                  <li key={comment.id} className="rounded-lg bg-zinc-900/60 px-3 py-2 text-sm">
                    <p className="text-xs text-zinc-500">
                      <span className="font-medium text-zinc-300">
                        {comment.authorName ?? 'someone'}
                      </span>{' '}
                      · {relativeTime(comment.createdAt)}
                    </p>
                    {comment.quote && (
                      <p className="mt-1 border-l-2 border-amber-600/60 pl-2 text-xs italic text-zinc-500">
                        “{comment.quote.slice(0, QUOTE_PREVIEW)}
                        {comment.quote.length > QUOTE_PREVIEW ? '…' : ''}”
                      </p>
                    )}
                    <p className="mt-1 text-zinc-200">{comment.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        )}

        {/* General comment composer — selection-anchored comments live in the
            floating popover at the selection instead */}
        {canReview && !isEditing && (
          <div className="border-t border-zinc-800 px-5 py-2">
            <div className="flex items-center gap-2">
              <input
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void postComment()
                }}
                placeholder="Add a comment…"
                className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
              <button
                onClick={() => void postComment()}
                disabled={!commentDraft.trim()}
                className="text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              >
                Post
              </button>
            </div>
          </div>
        )}

        {/* Footer: reject / request changes / approve */}
        <div className="border-t border-zinc-800 px-5 py-3">
          {isEditing ? (
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setIsEditing(false)}
                disabled={isSavingEdit}
                className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveEdit()}
                disabled={isSavingEdit || !editDraft.trim()}
                className="rounded border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-1 text-xs font-medium text-emerald-300 transition hover:bg-emerald-800/50 disabled:opacity-40"
              >
                {isSavingEdit ? 'Saving…' : `✓ Save as v${doc.version + 1}`}
              </button>
            </div>
          ) : isRevising ? (
            <div className="flex items-start gap-2">
              <textarea
                value={feedbackDraft}
                onChange={(e) => setFeedbackDraft(e.target.value)}
                placeholder="What should change? This goes straight to the agent, along with all comments above…"
                rows={2}
                className="min-w-0 flex-1 resize-none rounded border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
              <button
                onClick={() => setIsRevising(false)}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={() => void sendFeedback()}
                disabled={isSending || !feedbackDraft.trim()}
                className="rounded border border-zinc-600 bg-zinc-800/60 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700/60 disabled:opacity-40"
              >
                Send for revision
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              {agentLabel && <span>{agentLabel}</span>}
              <span>
                {doc.tasks.length} task{doc.tasks.length === 1 ? '' : 's'}
              </span>
              <span className="flex-1" />
              {canAct && (
                <>
                  <button
                    onClick={() => void onAct('discard')}
                    disabled={isActing}
                    className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-400 transition hover:border-red-500/60 hover:text-red-300 disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => setIsRevising(true)}
                    className="rounded border border-zinc-600 px-2.5 py-1 text-zinc-300 transition hover:bg-zinc-800/60"
                  >
                    ✏ Request changes
                  </button>
                  <button
                    onClick={() => void onAct('commit')}
                    disabled={isActing}
                    className="rounded border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-1 font-medium text-emerald-300 transition hover:bg-emerald-800/50 disabled:opacity-40"
                  >
                    {doc.kind === 'change' ? '✓ Approve & commit' : '✓ Approve plan'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Selection popover — floats at the selected text */}
      {popover && !isEditing && (
        <div
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[10000] rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-2xl"
          style={{
            left: Math.min(Math.max(popover.x, 170), window.innerWidth - 170),
            ...(popover.top > 130
              ? { top: popover.top - 8, transform: 'translate(-50%, -100%)' }
              : { top: popover.bottom + 8, transform: 'translateX(-50%)' })
          }}
        >
          {popover.mode === 'actions' ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPopover({ ...popover, mode: 'comment' })}
                className="rounded px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800"
              >
                💬 Comment
              </button>
              <span className="h-4 w-px bg-zinc-700" />
              <button
                onClick={() => startEdit(popover.quote)}
                className="rounded px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800"
              >
                ✏️ Edit
              </button>
            </div>
          ) : (
            <div className="flex w-72 items-center gap-1.5 p-1">
              <input
                autoFocus
                value={popoverDraft}
                onChange={(e) => setPopoverDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void postSelectionComment()
                  if (e.key === 'Escape') setPopover(null)
                }}
                placeholder="Comment on the selection…"
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
              <button
                onClick={() => void postSelectionComment()}
                disabled={!popoverDraft.trim()}
                className="rounded bg-zinc-100 px-2 py-1 text-xs font-bold text-zinc-900 transition hover:bg-white disabled:opacity-40"
              >
                Post
              </button>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// Compact row — one line, opens the modal. Used for review notices, approval
// rows, and messages that ship several docs at once (a stack of full cards
// would drown the feed).
// ---------------------------------------------------------------------------

export function ArtifactRow({ artifact }: { artifact: Artifact }) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="ml-7 mt-1 flex w-fit max-w-full items-center gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-1 text-xs transition hover:border-zinc-600"
      >
        <KindIcon kind={artifact.kind} className="text-zinc-500" />
        <span className="min-w-0 truncate font-medium text-zinc-200">{artifact.title}</span>
        <span className="font-mono text-[10px] tabular-nums text-zinc-600">v{artifact.version}</span>
        <StatusBadge status={artifact.status} />
      </button>
      {isModalOpen && (
        <ArtifactDocModal artifact={artifact} onClose={() => setIsModalOpen(false)} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Inline card — compact preview + expand + open-modal
// ---------------------------------------------------------------------------

interface ArtifactCardProps {
  artifact: Artifact
}

/**
 * Compact document card: title, status, a few clamped preview lines with a
 * fade, ▾ expand in place, and "Open doc" for the review modal (comments on
 * selections, approve / reject / request changes).
 */
export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const { me, agents } = useWorkspace()
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isActing, setIsActing] = useState(false)
  const canAct = me.role !== 'guest' && artifact.status === 'proposed'
  const agent = agents.find((a) => a.id === artifact.createdByAgentId)
  const agentLabel = agent ? `${agent.avatarEmoji} ${agent.name}` : undefined

  const act = async (action: 'commit' | 'discard') => {
    setIsActing(true)
    try {
      await api.post(`/api/artifacts/${artifact.id}/${action}`)
      setIsModalOpen(false)
    } catch {
      // artifact_state never arrives on failure — card stays as it was
    } finally {
      setIsActing(false)
    }
  }

  return (
    <div
      className={`ml-7 mr-4 mt-1.5 overflow-hidden rounded-lg border text-sm ${
        artifact.status === 'proposed'
          ? 'border-amber-700/50 bg-amber-950/10'
          : 'border-zinc-800/60 bg-zinc-900/30'
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <KindIcon kind={artifact.kind} className="text-zinc-500" />
        <button
          onClick={() => setIsModalOpen(true)}
          className="min-w-0 flex-1 truncate text-left font-semibold text-zinc-100 hover:underline"
          title="Open doc"
        >
          {artifact.title}
        </button>
        <span className="font-mono text-[10px] tabular-nums text-zinc-500">v{artifact.version}</span>
        <StatusBadge status={artifact.status} />
        {agentLabel && <span className="text-xs text-zinc-500">{agentLabel}</span>}
        <span className="text-xs text-zinc-500">
          {artifact.tasks.length} task{artifact.tasks.length === 1 ? '' : 's'}
        </span>
        {canAct && (
          <button
            onClick={() => void act('commit')}
            disabled={isActing}
            className="rounded border border-emerald-700/60 bg-emerald-900/40 px-2 py-0.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-800/50 disabled:opacity-40"
          >
            {artifact.kind === 'change' ? '✓ Approve & commit' : '✓ Approve plan'}
          </button>
        )}
        <button
          onClick={() => setIsModalOpen(true)}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          Open doc
        </button>
      </div>

      {/* Preview: clamped with fade; click opens the modal. Expanded: full
          doc inline, selectable text. */}
      <div
        onClick={isExpanded ? undefined : () => setIsModalOpen(true)}
        className={`relative border-t border-zinc-800/40 px-4 py-2 ${
          isExpanded ? '' : 'cursor-pointer'
        }`}
        title={isExpanded ? undefined : 'Open doc'}
      >
        <div
          className={`md-content text-xs leading-relaxed text-zinc-400 ${
            isExpanded ? '' : 'max-h-24 overflow-hidden'
          }`}
        >
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>
            {stripLeadingTitle(artifact.content, artifact.title)}
          </ReactMarkdown>
        </div>
        {!isExpanded && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-zinc-950 to-transparent" />
        )}
      </div>

      {/* Inline expand/collapse — grows the doc in place, no modal needed */}
      <button
        onClick={() => setIsExpanded((v) => !v)}
        className="block w-full border-t border-zinc-800/30 py-1 text-center text-xs text-zinc-500 transition-colors hover:text-zinc-200"
      >
        {isExpanded ? '▴ collapse' : '▾ expand'}
      </button>

      {isModalOpen && (
        <ArtifactDocModal artifact={artifact} onClose={() => setIsModalOpen(false)} />
      )}
    </div>
  )
}
