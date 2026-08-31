import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Artifact, AttentionItem, SharedTask, TaskPriority } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { Sidebar } from '../components/Sidebar'
import { AttentionModal } from '../components/AttentionModal'
import { useWorkspace } from '../lib/workspace'

const REFRESH_DEBOUNCE_MS = 400
const DAY_MS = 24 * 60 * 60 * 1000

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }
const PRIORITY_GLYPH: Record<TaskPriority, string> = { high: '‼', medium: '•', low: '·' }
const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: 'text-red-400',
  medium: 'text-zinc-300',
  low: 'text-zinc-500'
}

type AssigneeFilter = 'all' | 'human' | 'agent'
type View = 'list' | 'calendar'

/** Local datetime-local value ↔ unix ms. */
function toInputValue(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Quiet relative date — "Sep 7", not a form control. */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function taskToAttentionItem(task: SharedTask): AttentionItem {
  return {
    kind: 'task',
    refId: task.id,
    title: task.content,
    channelId: task.channelId,
    conversationRootId: task.conversationRootId,
    agentId: task.sourceAgentId,
    priority: task.priority,
    position: task.position,
    createdAt: task.updatedAt
  }
}

export function TasksPage() {
  const { agents, channels } = useWorkspace()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<SharedTask[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('list')
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all')
  const [showDone, setShowDone] = useState(false)
  const [openItem, setOpenItem] = useState<AttentionItem | null>(null)
  const [monthStart, setMonthStart] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const load = () => {
      api
        .get<SharedTask[]>('/api/tasks')
        .then(setTasks)
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    load()
    // Plan docs name the task groups — best-effort, groups fall back to channels.
    api
      .get<Artifact[]>('/api/artifacts')
      .then(setArtifacts)
      .catch(() => {})
    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type !== 'task_state') return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(load, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const visible = useMemo(() => {
    return tasks
      .filter((t) => (showDone ? true : t.status !== 'completed'))
      .filter((t) => assigneeFilter === 'all' || t.assigneeType === assigneeFilter)
      .sort(
        (a, b) =>
          (a.scheduledFor ?? Infinity) - (b.scheduledFor ?? Infinity) ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.position - b.position
      )
  }, [tasks, showDone, assigneeFilter])

  // Group the flat list by the conversation (= plan) each task belongs to,
  // so the page answers "is the crew on track?" per initiative instead of
  // presenting a wall of interchangeable rows.
  const groups = useMemo(() => {
    const titleByRoot = new Map<string, string>()
    for (const artifact of artifacts) {
      if (artifact.status === 'discarded') continue
      // Prefer plan docs; first (newest-listed) wins.
      if (!titleByRoot.has(artifact.conversationRootId) || artifact.kind === 'plan') {
        titleByRoot.set(artifact.conversationRootId, artifact.title)
      }
    }
    const byRoot = new Map<string, SharedTask[]>()
    for (const task of visible) {
      byRoot.set(task.conversationRootId, [...(byRoot.get(task.conversationRootId) ?? []), task])
    }
    return [...byRoot.entries()]
      .map(([rootId, rows]) => {
        const all = tasks.filter((t) => t.conversationRootId === rootId)
        const done = all.filter((t) => t.status === 'completed').length
        const running = all.filter((t) => t.status === 'in_progress').length
        const channel = channels.find((c) => c.id === rows[0]!.channelId)
        return {
          rootId,
          rows,
          done,
          total: all.length,
          running,
          channelId: rows[0]!.channelId,
          title:
            titleByRoot.get(rootId) ??
            (channel ? `#${channel.name} — ad-hoc tasks` : 'Ad-hoc tasks'),
          nextAt: Math.min(...rows.map((t) => t.scheduledFor ?? Infinity))
        }
      })
      .sort((a, b) => b.running - a.running || a.nextAt - b.nextAt)
  }, [visible, tasks, artifacts, channels])

  const setSchedule = (task: SharedTask, value: string) => {
    const ms = value ? new Date(value).getTime() : null
    void api.patch(`/api/tasks/${task.id}`, { scheduledFor: ms }).catch(() => {})
  }

  // Hand the task to the crew NOW: it becomes its own action thread.
  const askAgent = async (task: SharedTask) => {
    try {
      const result = await api.post<{ channelId: string; rootId: string }>(
        `/api/tasks/${task.id}/start`
      )
      navigate(`/channels/${result.channelId}?thread=${result.rootId}`)
    } catch {
      // task may no longer be pending — the list refetches via task_state
    }
  }

  const agentOf = (task: SharedTask) =>
    task.sourceAgentId ? agents.find((a) => a.id === task.sourceAgentId) : undefined

  // ---- calendar model ----
  const gridDays = useMemo(() => {
    const first = new Date(monthStart)
    const gridStart = new Date(first)
    gridStart.setDate(1 - first.getDay()) // back to Sunday
    return Array.from({ length: 42 }, (_, i) => {
      const day = new Date(gridStart)
      day.setDate(gridStart.getDate() + i)
      const dayStart = day.getTime()
      return {
        date: day,
        inMonth: day.getMonth() === monthStart.getMonth(),
        tasks: visible.filter(
          (t) => t.scheduledFor && t.scheduledFor >= dayStart && t.scheduledFor < dayStart + DAY_MS
        )
      }
    })
  }, [monthStart, visible])

  const monthLabel = monthStart.toLocaleDateString([], { month: 'long', year: 'numeric' })
  const shiftMonth = (delta: number) =>
    setMonthStart((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">Tasks</h1>
          <div className="flex rounded-lg border border-zinc-800 text-xs">
            {(['list', 'calendar'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 capitalize ${
                  view === v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <div className="flex items-center gap-1.5 text-xs">
            {(['all', 'human', 'agent'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setAssigneeFilter(f)}
                className={`rounded-full border px-2.5 py-0.5 ${
                  assigneeFilter === f
                    ? 'border-zinc-400 bg-zinc-100 font-semibold text-zinc-900'
                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {f === 'all' ? 'All' : f === 'human' ? '👤 Mine' : '🤖 Agents'}
              </button>
            ))}
            <label className="ml-2 flex items-center gap-1 text-zinc-500">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />
              done
            </label>
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Every task across the workspace. Scheduled agent tasks fire automatically at their
          time; scheduled human tasks land in Needs You when due.
        </p>

        {loading && <p className="mt-6 text-sm text-zinc-500">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="mt-6 text-sm text-zinc-500">No tasks match this filter.</p>
        )}

        {/* ---- List view: grouped by plan/conversation ---- */}
        {view === 'list' && !loading && visible.length > 0 && (
          <div className="mt-5 max-w-4xl space-y-5">
            {groups.map((group) => (
              <div
                key={group.rootId}
                className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/30"
              >
                {/* Group header: title + progress at a glance */}
                <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800/50 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
                    {group.title}
                  </span>
                  {group.running > 0 && (
                    <span className="animate-pulse text-xs text-emerald-400">
                      ▸ {group.running} running
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-emerald-500/80 transition-all"
                        style={{ width: `${group.total ? (group.done / group.total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="font-mono text-xs tabular-nums text-zinc-500">
                      {group.done}/{group.total}
                    </span>
                  </div>
                </div>

                {/* Rows — controls stay quiet until you hover a row */}
                <div className="divide-y divide-zinc-800/30">
                  {group.rows.map((task) => {
                    const agent = agentOf(task)
                    const overdue =
                      task.scheduledFor &&
                      task.scheduledFor < Date.now() &&
                      task.status === 'pending'
                    return (
                      <div
                        key={task.id}
                        className="group/row flex items-center gap-3 px-4 py-1.5 text-sm hover:bg-zinc-900/40"
                      >
                        <span className={`font-semibold ${PRIORITY_STYLE[task.priority]}`}>
                          {PRIORITY_GLYPH[task.priority]}
                        </span>
                        <span title={task.assigneeType === 'human' ? 'Yours' : 'Agent task'}>
                          {task.assigneeType === 'human' ? '👤' : (agent?.avatarEmoji ?? '🤖')}
                        </span>
                        <button
                          onClick={() => setOpenItem(taskToAttentionItem(task))}
                          className={`min-w-0 flex-1 truncate text-left hover:underline ${
                            task.status === 'completed'
                              ? 'text-zinc-500 line-through'
                              : 'text-zinc-300'
                          }`}
                        >
                          {task.content}
                        </button>
                        {task.status === 'in_progress' && (
                          <span className="animate-pulse text-xs text-emerald-400">▸ running</span>
                        )}
                        {task.scheduledFor ? (
                          <span
                            className={`font-mono text-[11px] tabular-nums group-hover/row:hidden ${
                              overdue ? 'text-red-400' : 'text-zinc-500'
                            }`}
                          >
                            {overdue ? 'overdue · ' : ''}
                            {shortDate(task.scheduledFor)}
                          </span>
                        ) : null}
                        <span className="hidden items-center gap-2 group-hover/row:flex">
                          {task.status === 'pending' && (
                            <button
                              onClick={() => void askAgent(task)}
                              title="Ask an agent to do this now — starts its own thread"
                              className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 transition hover:border-emerald-600/60 hover:text-emerald-300"
                            >
                              ▶ ask agent
                            </button>
                          )}
                          <input
                            type="datetime-local"
                            value={toInputValue(task.scheduledFor)}
                            onChange={(e) => setSchedule(task, e.target.value)}
                            className="rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 text-xs text-zinc-400"
                            title="Schedule — agent tasks fire at this time"
                          />
                          <button
                            onClick={() =>
                              void api
                                .patch(`/api/tasks/${task.id}`, {
                                  status:
                                    task.status === 'completed' ? 'pending' : 'completed'
                                })
                                .catch(() => {})
                            }
                            title={task.status === 'completed' ? 'Reopen' : 'Mark done'}
                            className={`text-sm ${
                              task.status === 'completed'
                                ? 'text-emerald-500 hover:text-zinc-400'
                                : 'text-zinc-600 hover:text-emerald-400'
                            }`}
                          >
                            ✓
                          </button>
                          <button
                            onClick={() =>
                              void api.delete(`/api/tasks/${task.id}`).catch(() => {})
                            }
                            title="Remove task — completed or not needed"
                            className="text-sm text-zinc-600 hover:text-red-400"
                          >
                            ×
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ---- Calendar view ---- */}
        {view === 'calendar' && !loading && (
          <div className="mt-5 max-w-5xl">
            <div className="flex items-center gap-3 text-sm">
              <button onClick={() => shiftMonth(-1)} className="text-zinc-500 hover:text-zinc-200">
                ←
              </button>
              <span className="w-44 text-center font-semibold">{monthLabel}</span>
              <button onClick={() => shiftMonth(1)} className="text-zinc-500 hover:text-zinc-200">
                →
              </button>
            </div>
            <div className="mt-3 grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="bg-zinc-950 px-2 py-1 text-[10px] uppercase text-zinc-500">
                  {d}
                </div>
              ))}
              {gridDays.map(({ date, inMonth, tasks: dayTasks }) => (
                <div
                  key={date.toDateString()}
                  className={`min-h-24 bg-zinc-950 p-1.5 ${inMonth ? '' : 'opacity-40'}`}
                >
                  <p className="text-[10px] text-zinc-600">{date.getDate()}</p>
                  {dayTasks.slice(0, 3).map((task) => (
                    <button
                      key={task.id}
                      onClick={() => setOpenItem(taskToAttentionItem(task))}
                      className={`mt-0.5 block w-full truncate rounded px-1 py-0.5 text-left text-[10px] ${
                        task.assigneeType === 'human'
                          ? 'bg-amber-900/40 text-amber-200'
                          : 'bg-emerald-900/40 text-emerald-200'
                      } ${task.status === 'completed' ? 'line-through opacity-50' : ''}`}
                      title={task.content}
                    >
                      {task.assigneeType === 'human' ? '👤 ' : ''}
                      {task.content}
                    </button>
                  ))}
                  {dayTasks.length > 3 && (
                    <p className="text-[9px] text-zinc-600">+{dayTasks.length - 3} more</p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-600">
              <span className="text-amber-300">■</span> yours ·{' '}
              <span className="text-emerald-300">■</span> agents — unscheduled tasks appear only in
              the list view.
            </p>
          </div>
        )}
      </div>

      {openItem && <AttentionModal item={openItem} onClose={() => setOpenItem(null)} />}
    </div>
  )
}
