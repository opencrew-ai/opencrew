import { useEffect, useState } from 'react'
import type { Run, RunStatus } from '@opencrew/shared'
import { api } from '../lib/api'
import { presenceKey, useWorkspace } from '../lib/workspace'

/**
 * Glass walls: watch anyone's crew. Lists the person's agents with live
 * state and their most recent run — active runs open straight into the
 * terminal. Read-only by design (hard wall: watching, not touching).
 */

interface SpectatorPanelProps {
  userId: string
  onOpenRun: (runId: string) => void
  onClose: () => void
}

const ACTIVE: RunStatus[] = ['queued', 'running', 'awaiting_approval']

function runLabel(run: Run): string {
  if (run.status === 'running') return 'running now'
  if (run.status === 'awaiting_approval') return 'waiting for approval'
  if (run.status === 'queued') return 'queued'
  const when = new Date(run.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
  return `last run ${run.status} · ${when}`
}

export function SpectatorPanel({ userId, onOpenRun, onClose }: SpectatorPanelProps) {
  const { me, users, agents, presence } = useWorkspace()
  const [latestRuns, setLatestRuns] = useState<Map<string, Run>>(new Map())

  const user = users.find((u) => u.id === userId)
  const crew = agents.filter((a) => a.createdBy === userId)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const entries = await Promise.all(
        crew.map(async (agent) => {
          try {
            const runs = await api.get<Run[]>(`/api/agents/${agent.id}/runs`)
            return [agent.id, runs[0]] as const
          } catch {
            return [agent.id, undefined] as const
          }
        })
      )
      if (!cancelled) {
        setLatestRuns(new Map(entries.filter((e): e is [string, Run] => Boolean(e[1]))))
      }
    }
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // crew identity is derived from agents+userId; refetch when the roster changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, agents.length])

  if (!user) return null

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <span className="text-sm font-semibold">
          👀 {user.name}
          {user.id === me.id ? ' (you)' : ''}
        </span>
        <span className="text-xs text-zinc-500">· crew</span>
        <button
          onClick={onClose}
          className="ml-auto text-zinc-500 hover:text-white"
          aria-label="Close spectator"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {crew.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-zinc-500">
            No agents on {user.name}&apos;s crew yet.
          </p>
        )}
        {crew.map((agent) => {
          const state = presence.get(presenceKey('agent', agent.id))?.state ?? 'idle'
          const latest = latestRuns.get(agent.id)
          const isActive = latest && ACTIVE.includes(latest.status)
          return (
            <div key={agent.id} className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-2.5">
              <div className="flex items-center gap-2 text-sm">
                <span>{agent.avatarEmoji}</span>
                <span className="font-medium">{agent.name}</span>
                <span
                  className={`ml-auto h-1.5 w-1.5 rounded-full ${
                    state === 'running' ? 'animate-pulse bg-amber-400' : 'bg-zinc-600'
                  }`}
                />
              </div>
              {latest ? (
                <button
                  onClick={() => onOpenRun(latest.id)}
                  className={`mt-1.5 w-full rounded-md px-2 py-1 text-left text-[11px] transition ${
                    isActive
                      ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                      : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                  }`}
                >
                  {isActive ? '▶ ' : ''}
                  {runLabel(latest)} — watch terminal
                </button>
              ) : (
                <p className="mt-1.5 px-2 text-[11px] text-zinc-600">no runs yet</p>
              )}
            </div>
          )
        })}
      </div>
      <p className="border-t border-zinc-800 px-4 py-2 text-[10px] uppercase tracking-widest text-zinc-600">
        spectating · read-only
      </p>
    </aside>
  )
}
