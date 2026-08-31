/**
 * DocDrawer — right-side slide-in panel for reading workspace docs inline.
 * DocLinkChip — clickable inline link (with 400ms hover popover) that opens the drawer.
 *
 * Usage: rendered by the ReactMarkdown `strong` override in MessageItem so that
 * any **Bold Title** in an agent message that matches a known artifact opens the drawer.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Artifact } from '@opencrew/shared'
import { ArtifactsByIdContext } from '../lib/useChannelArtifacts'
import { DocIcon, TasksIcon } from './Icons'

const MD_PLUGINS = [remarkGfm]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function relativeTime(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Strip the leading H1/H2/H3 that repeats the doc title so the popover excerpt is useful. */
function docExcerpt(content: string): string {
  return content
    .replace(/^#{1,3}\s+.*\n?/, '')
    .replace(/^\s+/, '')
    .slice(0, 120)
}

function ArtifactIcon({ kind, className }: { kind: Artifact['kind']; className?: string }) {
  if (kind === 'plan') return <TasksIcon className={className} />
  return <DocIcon className={className} />
}

/** Find an artifact whose title matches the given string (normalized). */
function useArtifactByTitle(title: string): Artifact | undefined {
  const byId = useContext(ArtifactsByIdContext)
  const norm = normalizeTitle(title)
  for (const artifact of byId.values()) {
    if (normalizeTitle(artifact.title) === norm) return artifact
  }
  return undefined
}

// ─── DocDrawer ────────────────────────────────────────────────────────────────

interface DocDrawerProps {
  artifact: Artifact
  /** The element that triggered the drawer — focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>
  onClose: () => void
}

/**
 * Right-side drawer (480px desktop / full-screen mobile) rendering the full
 * doc content. Overlays chat with a backdrop-blur scrim. Focus-trapped; Escape
 * and scrim click close it.
 */
export function DocDrawer({ artifact, triggerRef, onClose }: DocDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null)

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Simple focus trap: keep Tab inside the drawer
      if (e.key === 'Tab' && drawerRef.current) {
        const focusable = Array.from(
          drawerRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('disabled'))
        if (focusable.length === 0) return
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    // Move focus into the drawer on open
    const closeBtn = drawerRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    closeBtn?.focus()
    return () => {
      document.removeEventListener('keydown', handleKey)
      // Return focus to the triggering element on close
      const trigger = triggerRef?.current
      if (trigger && typeof trigger.focus === 'function') trigger.focus()
    }
  }, [handleKey, triggerRef])

  return createPortal(
    <>
      {/* Scrim — backdrop-blur on the chat side */}
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={artifact.title}
        className="fixed right-0 top-0 z-50 flex h-full w-[480px] max-w-full flex-col
          border-l border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50
          animate-slide-in-right outline-none"
      >
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <ArtifactIcon kind={artifact.kind} className="shrink-0 text-indigo-400" />
            <span className="truncate text-sm font-semibold text-white">{artifact.title}</span>
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-3">
            <span className="text-xs text-zinc-500">
              v{artifact.version} · {relativeTime(artifact.createdAt)}
            </span>
            <button
              aria-label="Close"
              onClick={onClose}
              className="rounded-full p-1 text-zinc-500 transition-colors hover:text-white
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500
                focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="h-4 w-4"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </header>

        {/* Scrollable doc body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="md-content text-sm leading-relaxed text-zinc-300">
            <ReactMarkdown remarkPlugins={MD_PLUGINS}>{artifact.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}

// ─── DocLinkChip ──────────────────────────────────────────────────────────────

interface DocLinkChipProps {
  /** The raw text inside the bold/strong node. */
  title: string
  /** Rendered if no artifact title matches — preserves normal bold formatting. */
  fallback: ReactNode
}

/**
 * Inline clickable link chip for doc/plan titles inside agent messages.
 * Renders a 400ms-delay hover popover with an excerpt and "Open →" button;
 * clicking either opens the DocDrawer.
 *
 * Falls back silently to `fallback` (a normal `<strong>`) when the title
 * doesn't match any known artifact — so every **bold** phrase isn't styled
 * unless it's a real doc.
 */
export function DocLinkChip({ title, fallback }: DocLinkChipProps) {
  const artifact = useArtifactByTitle(title)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [popoverVisible, setPopoverVisible] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLAnchorElement>(null)

  // No matching artifact → render plain bold, no overhead
  if (!artifact) return <strong>{fallback}</strong>

  const excerpt = docExcerpt(artifact.content)

  const startHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setPopoverVisible(true), 400)
  }
  const endHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setPopoverVisible(false)
  }
  const openDrawer = () => {
    setPopoverVisible(false)
    setDrawerOpen(true)
  }

  return (
    <>
      {/* Relative wrapper so the popover can be positioned above the chip */}
      <span className="relative inline-block">
        <a
          ref={triggerRef}
          role="button"
          tabIndex={0}
          onClick={openDrawer}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openDrawer()
            }
          }}
          onMouseEnter={startHover}
          onMouseLeave={endHover}
          className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium
            text-indigo-400 underline underline-offset-2 decoration-indigo-400/40
            transition-colors duration-150
            hover:text-indigo-300 hover:decoration-indigo-300
            focus-visible:rounded focus-visible:outline-none
            focus-visible:ring-2 focus-visible:ring-indigo-500
            focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        >
          <ArtifactIcon kind={artifact.kind} className="text-current" />
          {title}
        </a>

        {/* Hover popover — appears after 400ms, dismissed on mouse-leave */}
        {popoverVisible && !drawerOpen && (
          <div
            onMouseEnter={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current)
            }}
            onMouseLeave={endHover}
            className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border
              border-zinc-700 bg-zinc-900 p-4 shadow-xl shadow-black/40 animate-fade-in"
          >
            {/* Meta row */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <ArtifactIcon kind={artifact.kind} className="text-indigo-400" />
                <span className="text-xs font-medium capitalize text-zinc-200">
                  {artifact.kind}
                </span>
              </div>
              <span className="text-xs text-zinc-500">
                v{artifact.version} · {relativeTime(artifact.createdAt)}
              </span>
            </div>

            {/* Title */}
            <p className="mb-2 text-xs font-semibold leading-snug text-white">
              {artifact.title}
            </p>

            {/* Excerpt */}
            {excerpt && (
              <p className="mb-3 text-xs leading-relaxed text-zinc-400">
                "{excerpt}
                {artifact.content.length > 120 ? '…' : ''}"
              </p>
            )}

            {/* Open button — min 44×44 touch target via padding trick */}
            <button
              onClick={openDrawer}
              className="min-h-[44px] min-w-[44px] -mb-1 -ml-1 rounded px-1 py-1 text-xs
                font-medium text-indigo-400 transition-colors hover:text-indigo-300"
            >
              Open →
            </button>
          </div>
        )}
      </span>

      {drawerOpen && (
        <DocDrawer
          artifact={artifact}
          triggerRef={triggerRef as RefObject<HTMLElement | null>}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  )
}
