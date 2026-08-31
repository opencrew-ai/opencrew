/**
 * CodeFileDrawer — right-side slide-in panel for reading local code files inline.
 * CodeFileChip — clickable inline chip for file-path `code` spans in agent messages.
 *
 * Usage: rendered by the ReactMarkdown `code` override in MessageItem so that
 * any `path/like/this.ts` in an agent message becomes a clickable chip that
 * fetches and displays the file from the local filesystem via /api/fs/file.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** File extensions we'll treat as "probably a code file path". */
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cpp|h|hpp|css|scss|sql|sh|bash|zsh|json|yaml|yml|toml|env|md|mdx|txt|prisma|graphql|proto)$/i

/** Matches either an absolute path or a relative path that contains a /. */
const PATH_RE = /^(\/|\.\/)?([\w.-]+\/)+[\w.-]+$/

/**
 * Return true when the string looks like a local file path we can try to load.
 * We check for a recognised extension OR an absolute path that starts with /.
 */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (t.length < 3 || t.length > 512) return false
  // Absolute paths are always worth trying even without an extension
  if (t.startsWith('/') && t.includes('/')) return true
  return CODE_EXTENSIONS.test(t) && PATH_RE.test(t)
}

/** Language hint for the file extension, used in the header chip. */
function langLabel(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const MAP: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
    py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java',
    kt: 'Kotlin', swift: 'Swift', c: 'C', cpp: 'C++', h: 'C header',
    css: 'CSS', scss: 'SCSS', sql: 'SQL', sh: 'Shell', bash: 'Bash',
    zsh: 'Zsh', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
    md: 'Markdown', mdx: 'MDX', prisma: 'Prisma', graphql: 'GraphQL',
  }
  return MAP[ext] ?? ext.toUpperCase()
}

/** Shorten a long path for display: keep the last 3 segments. */
function shortPath(path: string): string {
  const parts = path.replace(/^\/+/, '').split('/')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

// ─── File icon ────────────────────────────────────────────────────────────────

function FileIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-[15px] w-[15px] shrink-0 ${className}`}
    >
      <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
      <path d="M9 2v3.2h3.3" />
      <path d="M6 8.5h4.5M6 11h4.5" />
    </svg>
  )
}

// ─── CodeFileDrawer ───────────────────────────────────────────────────────────

interface CodeFileDrawerProps {
  /** Absolute or relative file path to load. */
  filePath: string
  /**
   * Agent ID to resolve relative paths against the agent's workspace dir.
   * Omit when filePath is absolute.
   */
  agentId?: string
  /** The element that triggered the drawer — focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>
  onClose: () => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ok'; content: string; resolvedPath: string }
  | { status: 'error'; message: string }

/**
 * Right-side drawer (480px desktop / full-width mobile) showing the raw
 * content of a local file fetched from the server. Same visual style and
 * a11y contract as DocDrawer.
 */
export function CodeFileDrawer({ filePath, agentId, triggerRef, onClose }: CodeFileDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  // Fetch the file content on mount
  useEffect(() => {
    setState({ status: 'loading' })
    const params = new URLSearchParams({ path: filePath })
    if (agentId) params.set('agentId', agentId)
    api
      .get<{ path: string; content: string }>(`/api/fs/file?${params}`)
      .then((data) => setState({ status: 'ok', content: data.content, resolvedPath: data.path }))
      .catch((err: unknown) =>
        setState({ status: 'error', message: err instanceof Error ? err.message : 'failed to load' })
      )
  }, [filePath, agentId])

  // Keyboard handling: Escape closes, Tab stays trapped inside
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && drawerRef.current) {
        const focusable = Array.from(
          drawerRef.current.querySelectorAll<HTMLElement>(
            'button, [href], [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('disabled'))
        if (focusable.length === 0) return
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    // Move focus to the close button on open
    const closeBtn = drawerRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    closeBtn?.focus()
    return () => {
      document.removeEventListener('keydown', handleKey)
      triggerRef?.current?.focus()
    }
  }, [handleKey, triggerRef])

  const displayPath =
    state.status === 'ok' ? shortPath(state.resolvedPath) : shortPath(filePath)
  const lang = langLabel(filePath)
  const lineCount = state.status === 'ok' ? state.content.split('\n').length : 0

  return createPortal(
    <>
      {/* Scrim */}
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
        aria-label={`File: ${filePath}`}
        className="fixed right-0 top-0 z-50 flex h-full w-[480px] max-w-full flex-col
          border-l border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50
          animate-slide-in-right outline-none"
      >
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <FileIcon className="shrink-0 text-emerald-400" />
            <span className="truncate font-mono text-xs text-zinc-200" title={filePath}>
              {displayPath}
            </span>
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {lang}
            </span>
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-3">
            {state.status === 'ok' && (
              <span className="text-xs text-zinc-600">{lineCount} lines</span>
            )}
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

        {/* File body */}
        <div className="flex-1 overflow-y-auto">
          {state.status === 'loading' && (
            <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
              loading…
            </div>
          )}
          {state.status === 'error' && (
            <div className="px-5 py-6">
              <p className="text-xs text-red-400">{state.message}</p>
              <p className="mt-1 font-mono text-[10px] text-zinc-600">{filePath}</p>
            </div>
          )}
          {state.status === 'ok' && (
            <pre className="m-0 overflow-x-auto p-5 text-xs leading-relaxed text-zinc-300">
              {/* Line numbers + content */}
              <code>
                {state.content.split('\n').map((line, i) => (
                  <div key={i} className="flex gap-3">
                    <span
                      className="select-none text-right tabular-nums text-zinc-600"
                      style={{ minWidth: `${String(lineCount).length}ch` }}
                    >
                      {i + 1}
                    </span>
                    <span>{line}</span>
                  </div>
                ))}
              </code>
            </pre>
          )}
        </div>
      </div>
    </>,
    document.body
  )
}

// ─── CodeFileChip ─────────────────────────────────────────────────────────────

interface CodeFileChipProps {
  /** The raw text inside the inline-code span. */
  path: string
  /**
   * Agent ID of the message author — forwarded to the file API so relative
   * paths resolve against the agent's workspace directory.
   */
  agentId?: string
}

/**
 * Inline clickable chip for file paths inside agent messages.
 * Shows a 400ms-delay hover popover with the first few lines;
 * clicking opens CodeFileDrawer.
 *
 * Renders a plain `<code>` when the path can't be loaded (graceful fallback).
 */
export function CodeFileChip({ path, agentId }: CodeFileChipProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLElement>(null)

  const startHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      setPopoverVisible(true)
      // Lazy-load the first 8 lines for the preview
      if (preview === null) {
        const params = new URLSearchParams({ path })
        if (agentId) params.set('agentId', agentId)
        api
          .get<{ content: string }>(`/api/fs/file?${params}`)
          .then((d) => setPreview(d.content.split('\n').slice(0, 8).join('\n')))
          .catch(() => setPreview(''))
      }
    }, 400)
  }

  const endHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setPopoverVisible(false)
  }

  const openDrawer = () => {
    setPopoverVisible(false)
    setDrawerOpen(true)
  }

  const lang = langLabel(path)

  return (
    <>
      <span className="relative inline-block">
        {/* The chip itself */}
        <code
          ref={triggerRef as React.RefObject<HTMLElement>}
          role="button"
          tabIndex={0}
          onClick={openDrawer}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer() }
          }}
          onMouseEnter={startHover}
          onMouseLeave={endHover}
          className="inline-flex cursor-pointer items-center gap-1 rounded bg-zinc-800/60 px-1.5
            py-0.5 font-mono text-[13px] text-emerald-400 ring-1 ring-zinc-700/60
            transition-colors hover:bg-zinc-800 hover:text-emerald-300 hover:ring-zinc-600
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500
            focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950"
        >
          <FileIcon className="text-current opacity-70" />
          {shortPath(path)}
        </code>

        {/* Hover popover */}
        {popoverVisible && !drawerOpen && (
          <div
            onMouseEnter={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }}
            onMouseLeave={endHover}
            className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-xl border
              border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40 animate-fade-in overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
              <span className="truncate font-mono text-[11px] text-zinc-300" title={path}>
                {shortPath(path)}
              </span>
              <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">
                {lang}
              </span>
            </div>

            {/* Preview */}
            <div className="px-3 py-2">
              {preview === null ? (
                <span className="text-xs text-zinc-500">loading…</span>
              ) : preview === '' ? (
                <span className="text-xs text-zinc-500">preview unavailable</span>
              ) : (
                <pre className="overflow-hidden text-[11px] leading-relaxed text-zinc-400">
                  <code>{preview}</code>
                </pre>
              )}
            </div>

            {/* Open button */}
            <div className="border-t border-zinc-800 px-3 py-2">
              <button
                onClick={openDrawer}
                className="min-h-[44px] min-w-[44px] -m-1 rounded px-1 py-1 text-xs
                  font-medium text-emerald-400 transition-colors hover:text-emerald-300"
              >
                Open →
              </button>
            </div>
          </div>
        )}
      </span>

      {drawerOpen && (
        <CodeFileDrawer
          filePath={path}
          agentId={agentId}
          triggerRef={triggerRef as RefObject<HTMLElement | null>}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  )
}
