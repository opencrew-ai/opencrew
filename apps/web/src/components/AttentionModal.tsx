import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { Artifact, AttentionItem, Message } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'
import { ApprovalCard } from './ApprovalCard'
import { ArtifactDocModal } from './ArtifactCard'

const CONTEXT_CLAMP = 400

interface AttentionModalProps {
  item: AttentionItem
  onClose: () => void
}

/**
 * Self-sufficient view of one Needs-You item: the full ask, who filed it,
 * the originating request as context, and the action right here. The thread
 * is one click away for MORE context — never a prerequisite.
 */
export function AttentionModal({ item, onClose }: AttentionModalProps) {
  const navigate = useNavigate()
  const { me, channels } = useWorkspace()
  const [rootMessage, setRootMessage] = useState<Message | null>(null)
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [conversationDocs, setConversationDocs] = useState<Artifact[]>([])
  const [openDoc, setOpenDoc] = useState<Artifact | null>(null)
  const [isActing, setIsActing] = useState(false)
  const canAct = me.role !== 'guest'
  const channelName = channels.find((c) => c.id === item.channelId)?.name

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // Context: the conversation's originating human message.
  useEffect(() => {
    api
      .get<Message[]>(
        `/api/channels/${item.channelId}/messages?thread=${item.conversationRootId}`
      )
      .then((messages) => {
        setRootMessage(messages.find((m) => m.id === item.conversationRootId) ?? null)
      })
      .catch(() => {})
  }, [item.channelId, item.conversationRootId])

  // Docs of this conversation — requests usually reference one; link them.
  useEffect(() => {
    if (item.kind === 'doc_review') return
    api
      .get<Artifact[]>(`/api/channels/${item.channelId}/artifacts`)
      .then((all) => {
        const latest = new Map<string, Artifact>()
        for (const doc of all) {
          if (doc.status === 'discarded') continue
          if (doc.conversationRootId !== item.conversationRootId) continue
          const prior = latest.get(doc.title)
          if (!prior || doc.version > prior.version) latest.set(doc.title, doc)
        }
        setConversationDocs([...latest.values()])
      })
      .catch(() => {})
  }, [item.kind, item.channelId, item.conversationRootId])

  // Doc reviews open the full review modal instead.
  useEffect(() => {
    if (item.kind !== 'doc_review') return
    api
      .get<Artifact>(`/api/artifacts/${item.refId}`)
      .then(setArtifact)
      .catch(() => {})
  }, [item.kind, item.refId])

  if (item.kind === 'doc_review') {
    if (!artifact) return null
    return <ArtifactDocModal artifact={artifact} onClose={onClose} />
  }

  const openThread = () => {
    onClose()
    navigate(`/channels/${item.channelId}?thread=${item.conversationRootId}`)
  }

  // Delegate this task to the crew: it becomes its own action thread.
  const askAgent = async () => {
    setIsActing(true)
    try {
      const result = await api.post<{ channelId: string; rootId: string }>(
        `/api/tasks/${item.refId}/start`
      )
      onClose()
      navigate(`/channels/${result.channelId}?thread=${result.rootId}`)
    } catch {
      // task may no longer be pending
    } finally {
      setIsActing(false)
    }
  }

  const markDone = async () => {
    setIsActing(true)
    try {
      if (item.kind === 'task') {
        await api.patch(`/api/tasks/${item.refId}`, { status: 'completed' })
      } else if (item.kind === 'request') {
        await api.post(`/api/attention/${item.refId}/resolve`)
      }
      onClose()
    } catch {
      // item stays — user can retry
    } finally {
      setIsActing(false)
    }
  }

  const heading =
    item.kind === 'task'
      ? '☑ Task for you'
      : item.kind === 'tool_approval'
        ? '🔐 Tool approval'
        : '✋ An agent needs you'

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-zinc-100">{heading}</h2>
          {channelName && <span className="text-xs text-zinc-500">#{channelName}</span>}
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-zinc-100">{item.title}</p>
          {item.agentName && (
            <p className="mt-1.5 text-xs text-zinc-500">
              filed by {item.agentEmoji} {item.agentName}
            </p>
          )}

          {item.kind === 'tool_approval' && (
            <div className="mt-3">
              <ApprovalCard approvalId={item.refId} />
            </div>
          )}

          {conversationDocs.length > 0 && (
            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Referenced docs
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {conversationDocs.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => setOpenDoc(doc)}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:border-zinc-500"
                    title="Open doc"
                  >
                    {doc.kind === 'change' ? '🧩' : '📄'}
                    <span className="max-w-[260px] truncate">{doc.title}</span>
                    <span className="text-[10px] text-zinc-500">v{doc.version}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {rootMessage && (
            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Context — the original ask
              </p>
              <p className="mt-1 border-l-2 border-zinc-700 pl-2 text-xs italic leading-relaxed text-zinc-400">
                {rootMessage.authorName}: {rootMessage.content.slice(0, CONTEXT_CLAMP)}
                {rootMessage.content.length > CONTEXT_CLAMP ? '…' : ''}
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3 text-xs">
          <span className="flex-1" />
          <button
            onClick={openThread}
            className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-400 transition hover:text-zinc-200"
          >
            open thread →
          </button>
          {canAct && item.kind === 'task' && (
            <button
              onClick={() => void askAgent()}
              disabled={isActing}
              title="Hand this to the crew — starts its own thread"
              className="rounded border border-sky-700/60 px-2.5 py-1 text-sky-300 transition hover:bg-sky-900/40 disabled:opacity-40"
            >
              ▶ ask agent
            </button>
          )}
          {canAct && (item.kind === 'task' || item.kind === 'request') && (
            <button
              onClick={() => void markDone()}
              disabled={isActing}
              className="rounded border border-emerald-700/60 bg-emerald-900/40 px-2.5 py-1 font-medium text-emerald-300 transition hover:bg-emerald-800/50 disabled:opacity-40"
            >
              ✓ Mark done
            </button>
          )}
        </div>
      </div>

      {/* Referenced doc opened from within the item (portals above this modal) */}
      {openDoc && <ArtifactDocModal artifact={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>,
    document.body
  )
}
