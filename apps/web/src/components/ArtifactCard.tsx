import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Artifact, ArtifactComment } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useWorkspace } from '../lib/workspace'

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

function StatusBadge({ status }: { status: Artifact['status'] }) {
  if (status === 'review') {
    return (
      <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-300">
        📚 in review
      </span>
    )
  }
  if (status === 'proposed') {
    return (
      <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
        awaiting approval
      </span>
    )
  }
  return (
    <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
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
  const [comments, setComments] = useState<ArtifactComment[]>([])
  const [pendingQuote, setPendingQuote] = useState<string | null>(null)
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
    setPendingQuote(null)
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

  // Select text in the doc → the comment composer opens anchored to it.
  const captureSelection = () => {
    if (!canReview) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const text = selection.toString().trim()
    if (!text || !docRef.current) return
    if (!docRef.current.contains(selection.anchorNode)) return
    setPendingQuote(text.slice(0, 1000))
  }

  const postComment = async () => {
    const body = commentDraft.trim()
    if (!body) return
    setCommentDraft('')
    const quote = pendingQuote ?? undefined
    setPendingQuote(null)
    await api
      .post(`/api/artifacts/${doc.id}/comments`, { body, quote })
      .catch(() => {})
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
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"
      >
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
          <span>{doc.kind === 'change' ? '🧩' : '📄'}</span>
          <h2 className="min-w-0 flex-1 truncate font-bold text-zinc-100">{doc.title}</h2>
          <span className="text-xs text-zinc-500">v{doc.version}</span>
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
        <div className="flex-1 overflow-y-auto px-6 py-4">
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
              {doc.content}
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
                            ? 'text-sky-400'
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

        {/* Comment composer — appears when text is selected (or write a
            general comment any time) */}
        {canReview && !isEditing && (
          <div className="border-t border-zinc-800 px-5 py-2">
            {pendingQuote && (
              <p className="mb-1 flex items-start gap-2 text-xs text-zinc-500">
                <span className="mt-px">💬 on:</span>
                <span className="min-w-0 flex-1 truncate border-l-2 border-amber-600/60 pl-2 italic">
                  “{pendingQuote.slice(0, QUOTE_PREVIEW)}
                  {pendingQuote.length > QUOTE_PREVIEW ? '…' : ''}”
                </span>
                <button
                  onClick={() => startEdit(pendingQuote)}
                  className="whitespace-nowrap rounded border border-zinc-700 px-1.5 py-px text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                  title="Rewrite this text yourself"
                >
                  ✏️ Edit this text
                </button>
                <button
                  onClick={() => setPendingQuote(null)}
                  className="text-zinc-600 hover:text-zinc-300"
                  title="Drop selection"
                >
                  ×
                </button>
              </p>
            )}
            <div className="flex items-center gap-2">
              <input
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void postComment()
                }}
                placeholder={pendingQuote ? 'Comment on the selection…' : 'Add a comment…'}
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
                className="rounded border border-sky-700/60 bg-sky-900/40 px-2.5 py-1 text-xs font-medium text-sky-300 transition hover:bg-sky-800/50 disabled:opacity-40"
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
                    className="rounded border border-sky-700/60 px-2.5 py-1 text-sky-300 transition hover:bg-sky-900/40"
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
    </div>,
    document.body
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
        <span>{artifact.kind === 'change' ? '🧩' : '📄'}</span>
        <button
          onClick={() => setIsModalOpen(true)}
          className="min-w-0 flex-1 truncate text-left font-semibold text-zinc-100 hover:underline"
          title="Open doc"
        >
          {artifact.title}
        </button>
        <span className="text-[10px] text-zinc-500">v{artifact.version}</span>
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
            {artifact.content}
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
