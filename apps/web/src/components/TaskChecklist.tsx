import { useEffect, useRef, useState } from 'react'
import type { SharedTask, TaskPriority } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'

interface TaskChecklistProps {
  /** Conversation this list belongs to. */
  rootId: string
  /** Shared tasks, pre-sorted by priority then position. */
  items: SharedTask[]
}

const PRIORITY_CYCLE: Record<TaskPriority, TaskPriority> = {
  high: 'medium',
  medium: 'low',
  low: 'high'
}

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: 'text-red-400',
  medium: 'text-zinc-300',
  low: 'text-zinc-500'
}

// Long plans preview the ACTIVE surface (running + next pending), not the
// whole backlog — the Tasks page owns the full board.
const CHECKLIST_PREVIEW = 6

function visibleSlice(items: SharedTask[]): SharedTask[] {
  if (items.length <= CHECKLIST_PREVIEW + 2) return items
  const active = items.filter((t) => t.status === 'in_progress')
  const pending = items.filter((t) => t.status === 'pending')
  const merged = [...active, ...pending.slice(0, Math.max(0, CHECKLIST_PREVIEW - active.length))]
  return merged.length > 0 ? merged : items.slice(0, CHECKLIST_PREVIEW)
}

/**
 * The conversation's SHARED plan — humans and agents co-edit it. Humans add
 * tasks with a priority, tick/untick, reprioritize, delete, or launch a task
 * as its own action thread; agents mirror it via TodoWrite.
 *
 * Completed tasks fold into a collapsed "✓ N completed" section so the open
 * list reads as what's LEFT — expand it to audit or reopen.
 */
export function TaskChecklist({ rootId, items }: TaskChecklistProps) {
  const { me, agents } = useWorkspace()
  const canEdit = me.role !== 'guest'
  const total = items.length
  const done = items.filter((i) => i.status === 'completed').length
  const allDone = total > 0 && done === total
  // Empty plans start collapsed (just the affordance row); active plans open.
  const [isOpen, setIsOpen] = useState(total > 0 && !allDone)
  const [hasUserToggled, setHasUserToggled] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // Completed tasks fold away by default — the plan reads as what's left.
  const [showCompleted, setShowCompleted] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftPriority, setDraftPriority] = useState<TaskPriority>('medium')

  // Auto-open when the first tasks appear (agent started planning live),
  // unless the user explicitly collapsed the block.
  const prevTotalRef = useRef(total)
  useEffect(() => {
    if (!hasUserToggled && prevTotalRef.current === 0 && total > 0) setIsOpen(true)
    prevTotalRef.current = total
  }, [total, hasUserToggled])

  // Rendered only for conversations that already have tasks.
  if (total === 0) return null

  const openItems = items.filter((t) => t.status !== 'completed')
  const completedItems = items.filter((t) => t.status === 'completed')
  const openIds = new Set(openItems.map((t) => t.id))

  const addTask = async () => {
    const content = draft.trim()
    if (!content) return
    setDraft('')
    await api
      .post(`/api/conversations/${rootId}/tasks`, { content, priority: draftPriority })
      .catch(() => {
        // task_state never arrives on failure — list simply stays put
      })
  }

  const patch = (taskId: string, body: Record<string, string>) =>
    api.patch(`/api/tasks/${taskId}`, body).catch(() => {})

  const remove = (taskId: string) => api.delete(`/api/tasks/${taskId}`).catch(() => {})

  const start = (taskId: string, agentId?: string) =>
    api.post(`/api/tasks/${taskId}/start`, agentId ? { agentId } : {}).catch(() => {})

  const renderTask = (task: SharedTask) => {
    const agent = task.sourceAgentId
      ? agents.find((a) => a.id === task.sourceAgentId)
      : undefined
    const isBlocked =
      task.status === 'pending' && !!task.blockedBy?.some((id) => openIds.has(id))
    return (
      <li key={task.id} className="group/task flex items-start gap-2 py-0.5 text-xs">
        {/* Status toggle */}
        <button
          disabled={!canEdit}
          onClick={() =>
            void patch(task.id, {
              status: task.status === 'completed' ? 'pending' : 'completed'
            })
          }
          title={task.status === 'completed' ? 'Reopen' : 'Mark done'}
          className="mt-px"
        >
          {task.status === 'completed' && <span className="text-emerald-500">✓</span>}
          {task.status === 'in_progress' && (
            <span className="animate-pulse text-emerald-400">▸</span>
          )}
          {task.status === 'pending' && <span className="text-zinc-600">○</span>}
        </button>

        {/* Priority — click cycles high → medium → low */}
        <button
          disabled={!canEdit}
          onClick={() => void patch(task.id, { priority: PRIORITY_CYCLE[task.priority] })}
          title={`Priority: ${task.priority} (click to change)`}
          className={`mt-px font-semibold uppercase ${PRIORITY_STYLE[task.priority]}`}
        >
          {task.priority === 'high' ? '‼' : task.priority === 'medium' ? '•' : '·'}
        </button>

        <span
          className={`min-w-0 flex-1 ${
            task.status === 'completed'
              ? 'text-zinc-500 line-through'
              : task.status === 'in_progress'
                ? 'text-zinc-200'
                : 'text-zinc-400'
          }`}
        >
          {task.status === 'in_progress' && task.activeForm ? task.activeForm : task.content}
          {task.scheduledFor && task.status === 'pending' && (
            <span
              className="ml-1 text-[10px] text-zinc-500"
              title="Scheduled — fires automatically"
            >
              🕐{' '}
              {new Date(task.scheduledFor).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          )}
          {task.assigneeType === 'human' && (
            <span
              className="ml-1 text-amber-400/80"
              title="Assigned to a human — in your Needs-You inbox"
            >
              👤
            </span>
          )}
          {agent && (
            <span className="ml-1 text-zinc-600" title={`${agent.name} is on it`}>
              {agent.avatarEmoji}
            </span>
          )}
          {isBlocked && (
            <span
              className="ml-1.5 rounded bg-zinc-800 px-1 py-px font-mono text-[9px] text-zinc-500"
              title="Starts automatically when its earlier tasks complete"
            >
              blocked
            </span>
          )}
        </span>

        {/* Hover actions */}
        {canEdit && (
          <span className="invisible flex shrink-0 gap-1.5 group-hover/task:visible">
            {task.status === 'pending' && !isBlocked && (
              <button
                onClick={() => void start(task.id)}
                title="Start as its own thread — the crew picks it up"
                className="text-zinc-500 hover:text-emerald-400"
              >
                ▶
              </button>
            )}
            <button
              onClick={() => void remove(task.id)}
              title="Delete task"
              className="text-zinc-600 hover:text-red-400"
            >
              ×
            </button>
          </span>
        )}
      </li>
    )
  }

  return (
    <div className="ml-7 mt-1.5 rounded-lg bg-zinc-900/40 text-sm">
      <button
        onClick={() => {
          setHasUserToggled(true)
          setIsOpen((v) => !v)
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <span className="font-semibold uppercase tracking-wide">Plan</span>
        <span className={`font-mono tabular-nums ${allDone ? 'text-emerald-500' : 'text-zinc-500'}`}>
          {done}/{total} done
        </span>
        {/* Fixed-width rail — a full-bleed bar on a wide screen reads as a
            divider, not a meter. Scale hints size: more tasks, longer rail. */}
        <span
          className="h-1 overflow-hidden rounded-full bg-zinc-800"
          style={{ width: `${Math.min(160, 40 + total * 12)}px` }}
        >
          <span
            className={`block h-full rounded-full transition-all ${
              allDone ? 'bg-emerald-600' : 'bg-emerald-600/70'
            }`}
            style={{ width: `${(done / total) * 100}%` }}
          />
        </span>
        {allDone && <span className="text-[11px] text-emerald-500">✓ complete</span>}
        <span className="ml-auto">{isOpen ? '▾' : '▸'}</span>
      </button>

      {isOpen && (
        <div className="border-t border-zinc-800/50 px-3 py-1.5">
          <ul>{(showAll ? openItems : visibleSlice(openItems)).map(renderTask)}</ul>

          {!showAll && openItems.length > CHECKLIST_PREVIEW + 2 && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full py-1 text-center text-[11px] text-zinc-500 transition hover:text-zinc-300"
            >
              ▾ show all {openItems.length} open (
              {openItems.length - visibleSlice(openItems).length} more)
            </button>
          )}

          {/* Completed tasks — collapsed by default so the plan reads as
              what's left. Expand to audit or reopen. */}
          {done > 0 && (
            <div className={openItems.length > 0 ? 'mt-1 border-t border-zinc-800/40 pt-1' : ''}>
              <button
                onClick={() => setShowCompleted((v) => !v)}
                className="flex w-full items-center gap-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:text-zinc-300"
              >
                <span>{showCompleted ? '▾' : '▸'}</span>
                <span className="text-emerald-600">✓</span>
                <span className="font-mono tabular-nums">{done}</span>
                <span>completed</span>
              </button>
              {showCompleted && <ul>{completedItems.map(renderTask)}</ul>}
            </div>
          )}

          {/* Add a task */}
          {canEdit && (
            <div className="mt-1 flex items-center gap-1.5 border-t border-zinc-800/40 pt-1.5">
              <select
                value={draftPriority}
                onChange={(e) => setDraftPriority(e.target.value as TaskPriority)}
                className="rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-400"
                title="Priority"
              >
                <option value="high">‼ high</option>
                <option value="medium">• med</option>
                <option value="low">· low</option>
              </select>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addTask()
                }}
                placeholder="Add a task…"
                className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
              <button
                onClick={() => void addTask()}
                disabled={!draft.trim()}
                className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
              >
                add
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
