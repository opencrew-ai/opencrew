import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project, ProjectToday } from '@opencrew/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'
import { useWorkspace } from '../lib/workspace'
import { Sidebar } from '../components/Sidebar'
import { ProjectSettingsDialog } from '../components/ProjectSettingsDialog'
import { GearIcon } from '../components/Icons'

const REFRESH_DEBOUNCE_MS = 1500

/**
 * Today — every project on one screen: shipped, in flight, waiting on you,
 * spend. The second surface after Needs You; nothing here needs reading
 * twice.
 */
export function TodayPage() {
  const { me, projects, channels } = useWorkspace()
  const [rows, setRows] = useState<ProjectToday[]>([])
  const [editing, setEditing] = useState<Project | null>(null)
  const isAdmin = me.role === 'admin'

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      api
        .get<ProjectToday[]>('/api/today')
        .then(setRows)
        .catch(() => {})
    }
    load()
    const unsubscribe = wsClient.subscribe((event) => {
      if (
        event.type !== 'run_status' &&
        event.type !== 'artifact_state' &&
        event.type !== 'attention_changed' &&
        event.type !== 'project_updated' &&
        event.type !== 'project_created'
      ) {
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])

  const generalOf = (projectId: string | null) =>
    channels.find((c) => (c.projectId ?? null) === projectId && c.name === (projectId ? 'general' : 'hq'))

  const cards = [
    { project: null as Project | null, today: rows.find((r) => r.projectId === null) },
    ...projects.map((project) => ({ project, today: rows.find((r) => r.projectId === project.id) }))
  ]

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="bg-stage flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          <h1 className="font-display text-xl font-semibold text-zinc-100">Today</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>

          <div className="mt-6 space-y-3">
            {cards.map(({ project, today }) => {
              const room = generalOf(project?.id ?? null)
              const busy = (today?.inFlight.runs ?? 0) > 0
              return (
                <section
                  key={project?.id ?? 'hq'}
                  className="rounded-xl border border-zinc-800/80 bg-surface px-5 py-4"
                >
                  <div className="flex items-center gap-3">
                    {project ? (
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: project.color }} />
                    ) : (
                      <span className="h-2.5 w-2.5 rounded-full border border-zinc-600" />
                    )}
                    <Link
                      to={room ? `/channels/${room.id}` : '/channels'}
                      className="font-display text-base font-semibold text-zinc-100 hover:underline"
                    >
                      {project?.name ?? 'HQ'}
                    </Link>
                    {busy && (
                      <span className="rounded-full bg-emerald-500/15 px-2 font-mono text-[11px] text-emerald-300">
                        {today!.inFlight.runs} working
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-3">
                      {project?.workingDir && (
                        <span className="hidden truncate font-mono text-[11px] text-zinc-600 sm:inline" title={project.workingDir}>
                          {project.workingDir.split('/').slice(-2).join('/')}
                        </span>
                      )}
                      {project && isAdmin && (
                        <button
                          onClick={() => setEditing(project)}
                          className="text-zinc-600 hover:text-zinc-200"
                          title="Project settings"
                          aria-label={`${project.name} settings`}
                        >
                          <GearIcon />
                        </button>
                      )}
                    </span>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                    <Stat label="Shipped" value={`${today?.shipped.changes ?? 0} changes · ${today?.shipped.docs ?? 0} docs`} />
                    <Stat
                      label="In flight"
                      value={`${today?.inFlight.runs ?? 0} turns · ${today?.inFlight.workers ?? 0} workers`}
                    />
                    <Stat
                      label="Needs you"
                      value={String(today?.needsYou ?? 0)}
                      tone={(today?.needsYou ?? 0) > 0 ? 'amber' : undefined}
                    />
                    <Stat
                      label="Spend"
                      value={
                        today
                          ? `$${today.spendUsd.toFixed(2)}${today.budgetUsd > 0 ? ` / $${today.budgetUsd.toFixed(0)}` : ''}`
                          : '—'
                      }
                      tone={today && today.budgetUsd > 0 && today.spendUsd >= today.budgetUsd ? 'red' : undefined}
                    />
                  </dl>
                </section>
              )
            })}
          </div>
        </div>
      </div>
      {editing && <ProjectSettingsDialog project={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'red' }) {
  const color = tone === 'amber' ? 'text-amber-300' : tone === 'red' ? 'text-red-400' : 'text-zinc-200'
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`font-mono text-sm tabular-nums ${color}`}>{value}</dd>
    </div>
  )
}
