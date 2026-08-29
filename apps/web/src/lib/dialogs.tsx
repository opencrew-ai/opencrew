import { useEffect, useRef, useState } from 'react'

/**
 * Custom in-app replacements for window.alert / confirm / prompt.
 * Imperative API (callers live in event handlers), promise-based results:
 *
 *   await showAlert('Something failed')
 *   if (await showConfirm('Stop all agents?', { danger: true })) { … }
 *   const name = await showPrompt('Channel name:')   // null = cancelled
 *
 * <DialogHost /> must be mounted once (App does it).
 */

interface DialogOptions {
  title?: string
  confirmLabel?: string
  /** Styles the confirm button red for destructive actions. */
  danger?: boolean
  /** Prompt only. */
  initial?: string
  placeholder?: string
}

type DialogRequest =
  | { kind: 'alert'; message: string; options: DialogOptions; resolve: (v: void) => void }
  | { kind: 'confirm'; message: string; options: DialogOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; message: string; options: DialogOptions; resolve: (v: string | null) => void }

let listener: ((req: DialogRequest | null) => void) | null = null
const queue: DialogRequest[] = []

function enqueue(req: DialogRequest): void {
  queue.push(req)
  if (queue.length === 1) listener?.(req)
}

function advance(): void {
  queue.shift()
  listener?.(queue[0] ?? null)
}

export function showAlert(message: string, options: DialogOptions = {}): Promise<void> {
  return new Promise((resolve) => enqueue({ kind: 'alert', message, options, resolve }))
}

export function showConfirm(message: string, options: DialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: 'confirm', message, options, resolve }))
}

export function showPrompt(message: string, options: DialogOptions = {}): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'prompt', message, options, resolve }))
}

export function DialogHost() {
  const [current, setCurrent] = useState<DialogRequest | null>(null)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    listener = (req) => {
      setCurrent(req)
      setValue(req?.kind === 'prompt' ? (req.options.initial ?? '') : '')
    }
    if (queue[0]) listener(queue[0])
    return () => {
      listener = null
    }
  }, [])

  useEffect(() => {
    if (!current) return
    const target = current.kind === 'prompt' ? inputRef.current : confirmRef.current
    target?.focus()
    if (current.kind === 'prompt') inputRef.current?.select()
  }, [current])

  if (!current) return null

  const settle = (result: 'confirm' | 'cancel') => {
    if (current.kind === 'alert') current.resolve()
    else if (current.kind === 'confirm') current.resolve(result === 'confirm')
    else current.resolve(result === 'confirm' ? value : null)
    advance()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') settle('cancel')
    if (e.key === 'Enter') settle('confirm')
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={() => settle('cancel')}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {current.options.title && (
          <h2 className="mb-1 text-sm font-semibold text-zinc-100">{current.options.title}</h2>
        )}
        <p className="text-sm leading-relaxed text-zinc-300">{current.message}</p>
        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={current.options.placeholder}
            className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          {current.kind !== 'alert' && (
            <button
              onClick={() => settle('cancel')}
              className="rounded-lg px-3.5 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
            >
              Cancel
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={() => settle('confirm')}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition ${
              current.options.danger
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
            }`}
          >
            {current.options.confirmLabel ?? (current.kind === 'alert' ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
