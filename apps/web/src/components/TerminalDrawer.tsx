import { useEffect, useMemo, useRef, useState } from 'react'
import type { Run, RunStep } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'

/**
 * The run panel: watch an agent work. Default is a readable activity
 * timeline; "raw" flips to the full session log (every payload, token
 * counts, errors) for people who want the actual terminal.
 */
export function TerminalDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [steps, setSteps] = useState<RunStep[]>([])
  const [mode, setMode] = useState<'activity' | 'raw'>('activity')
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

  // Honest economics of the run, summed from session telemetry.
  const totals = useMemo(() => {
    let costUsd = 0
    let outTokens = 0
    for (const step of steps) {
      const p = step.payload as Record<string, unknown>
      if (step.type !== 'llm_call') continue
      if (typeof p.costUsd === 'number') costUsd += p.costUsd
      const usage = p.usage as { output_tokens?: number } | undefined
      if (usage?.output_tokens) outTokens += usage.output_tokens
    }
    return { costUsd, outTokens }
  }, [steps])

  const isLive = run ? ['queued', 'running', 'awaiting_approval'].includes(run.status) : false

  return (
    // Desktop: right panel. Mobile: bottom sheet.
    <div className="
      fixed inset-x-0 bottom-0 z-50 flex h-[60vh] flex-col border-t border-zinc-800 bg-black
      pb-[env(safe-area-inset-bottom)]
      md:relative md:inset-auto md:h-auto md:w-[30rem] md:shrink-0 md:border-l md:border-t-0 md:pb-0
    ">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
        <span
          className={`h-2 w-2 rounded-full ${
            isLive ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600'
          }`}
        />
        <span className="font-medium text-zinc-300">
          {isLive ? 'Working' : run?.status === 'done' ? 'Done' : (run?.status ?? '…')}
        </span>
        {totals.costUsd > 0 && (
          <span className="text-xs text-zinc-500" title="Actual model spend for this run">
            ${totals.costUsd.toFixed(3)} · {totals.outTokens.toLocaleString()} tok
          </span>
        )}
        <span className="flex-1" />
        <div className="flex rounded-md border border-zinc-800 text-[11px]">
          {(['activity', 'raw'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 capitalize ${
                mode === m ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="ml-1 text-zinc-500 hover:text-white">
          ✕
        </button>
      </div>
      <div
        className={`flex-1 overflow-y-auto p-3 text-xs leading-relaxed ${
          mode === 'raw' ? 'font-mono' : ''
        }`}
      >
        {steps.map((step) =>
          mode === 'raw' ? (
            <RawLine key={step.id} step={step} />
          ) : (
            <ActivityLine key={step.id} step={step} />
          )
        )}
        {isLive && (
          <div className="mt-1 font-mono text-emerald-400">
            ▊<span className="animate-pulse">&nbsp;{run!.status}…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Activity view — what the agent did, in plain language
// ---------------------------------------------------------------------------

function toolSummary(tool: string, input: Record<string, unknown> | undefined): string | null {
  switch (tool) {
    case 'Bash':
      return input?.command ? `ran \`${String(input.command)}\`` : 'ran a command'
    case 'Read':
      return input?.file_path ? `read ${shortPath(String(input.file_path))}` : 'read a file'
    case 'Write':
      return input?.file_path ? `wrote ${shortPath(String(input.file_path))}` : 'wrote a file'
    case 'Edit':
      return input?.file_path ? `edited ${shortPath(String(input.file_path))}` : 'edited a file'
    case 'WebFetch':
      return input?.url ? `fetched ${String(input.url)}` : 'fetched a page'
    case 'WebSearch':
      return input?.query ? `searched "${String(input.query)}"` : 'searched the web'
    case 'Grep':
    case 'Glob':
      return 'searched the workspace'
    case 'TodoWrite':
      return 'updated the task list'
    case 'ToolSearch':
      return 'looked up a tool'
    default: {
      // OpenCrew tools arrive bare or mcp__-prefixed depending on the step.
      const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
      if (name === 'propose_plan')
        return `proposed a doc${input?.title ? `: "${String(input.title)}"` : ''}`
      if (name === 'update_doc') return `updated doc${input?.title ? ` "${String(input.title)}"` : ''}`
      if (name === 'read_doc') return `read doc${input?.title ? ` "${String(input.title)}"` : ''}`
      if (name === 'post_to_channel') return 'posted to a channel'
      if (name === 'propose_change') return 'proposed a code change'
      if (name === 'review_doc') return 'delivered a review verdict'
      if (name === 'request_human') return 'asked for your input'
      if (name === 'list_agents') return 'checked the crew roster'
      if (name === 'create_agent') return 'drafted a new hire'
      return name.replace(/_/g, ' ')
    }
  }
}

function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

function stepTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ActivityLine({ step }: { step: RunStep }) {
  const p = step.payload as Record<string, unknown>
  switch (step.type) {
    case 'tool_call': {
      const summary = toolSummary(String(p.tool), p.input as Record<string, unknown> | undefined)
      if (!summary) return null
      return (
        <div className="flex gap-2 py-0.5 text-zinc-300">
          <span className="text-zinc-600">{stepTime(step.createdAt)}</span>
          <span className="min-w-0 break-words">{summary}</span>
        </div>
      )
    }
    case 'tool_result': {
      // Activity view shows only real failures — internal tool plumbing
      // errors the session self-corrects are raw-view material.
      const content = String(p.content ?? '')
      if (!p.isError || content.includes('tool_use_error')) return null
      return (
        <div className="ml-12 py-0.5 text-red-400">
          ⚠ {content.length > 160 ? `${content.slice(0, 160)}…` : content}
        </div>
      )
    }
    case 'post_message':
      return (
        <div className="flex gap-2 py-0.5 text-violet-300">
          <span className="text-zinc-600">{stepTime(step.createdAt)}</span>
          <span>replied in the conversation</span>
        </div>
      )
    case 'approval_requested':
      return (
        <div className="flex gap-2 py-0.5 text-amber-300">
          <span className="text-zinc-600">{stepTime(step.createdAt)}</span>
          <span>⏸ waiting for approval: {String(p.tool)}</span>
        </div>
      )
    case 'approval_resolved':
      return (
        <div
          className={`flex gap-2 py-0.5 ${
            p.decision === 'approved' ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          <span className="text-zinc-600">{stepTime(step.createdAt)}</span>
          <span>
            {String(p.decision)} by {String(p.resolvedBy)}
          </span>
        </div>
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Raw view — the full session log, nothing hidden
// ---------------------------------------------------------------------------

function RawLine({ step }: { step: RunStep }) {
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
