import { useState, type ComponentProps, type ReactElement } from 'react'

/**
 * UnifiedDiff — renders a raw `git diff` as a real diff view: one card per
 * file with an add/remove tally, hunk separators, line-number gutters parsed
 * from the @@ headers, and emerald/red line tinting.
 *
 * Wired in via the markdown `pre` override (diffAwarePre): any ```diff fence
 * — change proposals from propose_change, diffs agents paste in chat —
 * renders through here instead of as a plain <pre>.
 */

type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

interface DiffLine {
  kind: LineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

interface DiffFile {
  path: string
  adds: number
  dels: number
  lines: DiffLine[]
}

const FILE_HEADER = /^diff --git a\/.* b\/(.*)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function isMetaLine(line: string): boolean {
  return (
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('Binary files')
  )
}

function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of text.replace(/\n$/, '').split('\n')) {
    const header = line.match(FILE_HEADER)
    if (header) {
      file = { path: header[1]!, adds: 0, dels: 0, lines: [] }
      files.push(file)
      continue
    }
    // Diffs pasted without a `diff --git` preamble still get a card.
    if (!file) {
      file = { path: '', adds: 0, dels: 0, lines: [] }
      files.push(file)
    }
    const hunk = line.match(HUNK_HEADER)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      file.lines.push({ kind: 'hunk', text: line, oldNo: null, newNo: null })
    } else if (isMetaLine(line)) {
      file.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
    } else if (line.startsWith('+')) {
      file.adds++
      file.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    } else if (line.startsWith('-')) {
      file.dels++
      file.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line
      file.lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}

const LINE_CLASS: Record<LineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-100',
  del: 'bg-red-500/10 text-red-200',
  ctx: 'text-zinc-500',
  hunk: 'bg-zinc-900/80 text-zinc-500',
  meta: 'text-zinc-600'
}

const MARKER: Record<LineKind, { char: string; className: string }> = {
  add: { char: '+', className: 'text-emerald-400' },
  del: { char: '-', className: 'text-red-400' },
  ctx: { char: ' ', className: '' },
  hunk: { char: '', className: '' },
  meta: { char: '', className: '' }
}

// Big files preview-collapse so a 1,000-line diff doesn't wall the feed.
const COLLAPSE_OVER = 50
const PREVIEW_LINES = 24

export function UnifiedDiff({ text }: { text: string }) {
  const files = parseDiff(text)
  if (files.length === 0) return null
  return (
    <div className="not-prose my-2 space-y-3">
      {files.map((file, fi) => (
        <DiffFileCard key={fi} file={file} />
      ))}
    </div>
  )
}

function DiffFileCard({ file }: { file: DiffFile }) {
  // --- / +++ / index rows are noise; the header bar already names the file.
  const lines = file.lines.filter((line) => line.kind !== 'meta')
  const collapsible = lines.length > COLLAPSE_OVER
  const [expanded, setExpanded] = useState(!collapsible)
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES)
  const hidden = lines.length - visible.length

  return (
    <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">
          {file.path || 'diff'}
        </span>
        {file.adds > 0 && (
          <span className="text-emerald-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
            +{file.adds}
          </span>
        )}
        {file.dels > 0 && (
          <span className="text-red-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
            −{file.dels}
          </span>
        )}
        {collapsible && expanded && (
          <button
            onClick={() => setExpanded(false)}
            className="text-zinc-500 transition hover:text-zinc-300"
          >
            collapse
          </button>
        )}
      </div>
      {/* Plain grid, deliberately NOT a <table> — prose/markdown stylesheets
          style tables (row borders, cell padding) and wreck the diff. Lines
          never wrap; long code scrolls horizontally like every diff viewer. */}
      <div className="overflow-x-auto">
        <div className="w-max min-w-full font-mono text-xs leading-5">
          {visible.map((line, li) =>
            line.kind === 'hunk' ? (
              <div
                key={li}
                className={`select-none px-3 py-0.5 text-[11px] ${LINE_CLASS.hunk}`}
              >
                {line.text}
              </div>
            ) : (
              <div key={li} className={`flex ${LINE_CLASS[line.kind]}`}>
                <span
                  className="w-10 shrink-0 select-none pr-2 text-right text-[10px] leading-5 text-zinc-600"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {line.oldNo ?? ''}
                </span>
                <span
                  className="w-10 shrink-0 select-none border-r border-zinc-800/60 pr-2 text-right text-[10px] leading-5 text-zinc-600"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {line.newNo ?? ''}
                </span>
                <span
                  className={`w-6 shrink-0 select-none text-center ${MARKER[line.kind].className}`}
                >
                  {MARKER[line.kind].char}
                </span>
                <span className="whitespace-pre pr-4">{line.text || ' '}</span>
              </div>
            )
          )}
        </div>
      </div>
      {!expanded && hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="block w-full border-t border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-center font-mono text-xs text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
        >
          ▾ show {hidden.toLocaleString()} more lines
        </button>
      )}
    </div>
  )
}

/** Extract the raw text of a ```fenced block from a markdown <pre> child. */
function fencedBlock(children: unknown): { language: string; text: string } | null {
  const child = children as ReactElement<{ className?: string; children?: unknown }> | undefined
  const className = child?.props?.className ?? ''
  const match = /language-(\w+)/.exec(className)
  if (!match) return null
  const inner = child?.props?.children
  return { language: match[1]!, text: typeof inner === 'string' ? inner : String(inner ?? '') }
}

/**
 * Markdown `pre` override: ```diff fences render as a UnifiedDiff, everything
 * else stays a normal <pre>. Overriding `pre` (not `code`) keeps the diff's
 * block markup out of an actual <pre> element.
 */
export function diffAwarePre(props: ComponentProps<'pre'>) {
  const fence = fencedBlock(props.children)
  if (fence?.language === 'diff') return <UnifiedDiff text={fence.text} />
  return <pre {...props} />
}
