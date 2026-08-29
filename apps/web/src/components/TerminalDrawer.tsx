import { useEffect, useRef, useState } from 'react'
import type { Run, RunStep } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'

/**
 * The live terminal: streams a run's Claude Code session — model turns, tool
 * calls, command output — as it happens. This is where you watch them work.
 */
export function TerminalDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [steps, setSteps] = useState<RunStep[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSteps([])
    setRun(null)
    api
      .get<{ run: Run; steps: RunStep[] }>(`/api/runs/${runId}`)
      .then((data) => {
        setRun(data.run)
        setSteps(data.steps)
      })
      .catch(() => {})
    return wsClient.subscribe((event) => {
      if (event.type === 'run_step' && event.step.runId === runId) {
        setSteps((prev) =>
          prev.some((s) => s.id === event.step.id) ? prev : [...prev, event.step]
        )
      } else if (event.type === 'run_status' && event.runId === runId) {
        setRun((prev) => (prev ? { ...prev, status: event.status } : prev))
      }
    })
  }, [runId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [steps.length])

  return (
    // Desktop: right panel (w-[30rem], inline in flex row)
    // Mobile: fixed bottom sheet (full-width, 60vh, slides up from bottom)
    <div className="
      fixed inset-x-0 bottom-0 z-50 flex h-[60vh] flex-col border-t border-zinc-800 bg-black
      pb-[env(safe-area-inset-bottom)]
      md:relative md:inset-auto md:h-auto md:w-[30rem] md:shrink-0 md:border-l md:border-t-0 md:pb-0
    ">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="flex gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="ml-2 font-mono text-zinc-400">
            run {runId.slice(0, 8)} · {run?.status ?? '…'}
          </span>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {steps.map((step) => (
          <TerminalLine key={step.id} step={step} />
        ))}
        {run && ['queued', 'running', 'awaiting_approval'].includes(run.status) && (
          <div className="mt-1 text-emerald-400">
            ▊<span className="animate-pulse">&nbsp;{run.status}…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function TerminalLine({ step }: { step: RunStep }) {
  const p = step.payload as Record<string, unknown>
  const time = new Date(step.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  switch (step.type) {
    case 'llm_call': {
      const usage = p.usage as { input_tokens?: number; output_tokens?: number } | undefined
      const cost = typeof p.costUsd === 'number' ? ` · $${p.costUsd.toFixed(4)}` : ''
      return (
        <div className="text-zinc-600">
          <span className="text-zinc-700">[{time}]</span> ⚡ {String(p.model ?? 'session')}
          {usage ? ` · ${usage.input_tokens ?? 0}→${usage.output_tokens ?? 0} tok` : ''}
          {cost}
        </div>
      )
    }
    case 'tool_call': {
      const input = p.input as Record<string, unknown> | undefined
      const preview =
        p.tool === 'Bash' && input?.command
          ? String(input.command)
          : JSON.stringify(input ?? {})
      return (
        <div className="mt-1 text-sky-300">
          <span className="text-zinc-700">[{time}]</span>{' '}
          <span className="text-emerald-400">$</span> {String(p.tool)}{' '}
          <span className="break-all text-sky-200/80">
            {preview.length > 300 ? `${preview.slice(0, 300)}…` : preview}
          </span>
        </div>
      )
    }
    case 'tool_result': {
      const content = String(p.content ?? '')
      const isError = Boolean(p.isError)
      return (
        <pre
          className={`ml-4 whitespace-pre-wrap break-all ${
            isError ? 'text-red-400' : 'text-zinc-400'
          }`}
        >
          {content.length > 600 ? `${content.slice(0, 600)}…` : content}
        </pre>
      )
    }
    case 'post_message':
      return (
        <div className="text-violet-300">
          <span className="text-zinc-700">[{time}]</span> ✉ posted message to channel
        </div>
      )
    case 'approval_requested':
      return (
        <div className="text-amber-300">
          <span className="text-zinc-700">[{time}]</span> ⏸ waiting for approval:{' '}
          {String(p.tool)}
        </div>
      )
    case 'approval_resolved':
      return (
        <div className={p.decision === 'approved' ? 'text-emerald-400' : 'text-red-400'}>
          <span className="text-zinc-700">[{time}]</span> ▶{' '}
          {String(p.decision)} by {String(p.resolvedBy)}
        </div>
      )
    default:
      return null
  }
}
