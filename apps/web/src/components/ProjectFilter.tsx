import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@opencrew/shared'
import { useWorkspace } from '../lib/workspace'

/**
 * One project filter shared by every cross-project surface (Artifacts,
 * Tasks, Needs You). 'all' groups by project with a header per project;
 * a project id shows only that project; 'hq' shows HQ-level items.
 * Remembered per browser so switching pages keeps the same lens.
 */
export type ProjectScope = 'all' | 'hq' | string

const STORAGE_KEY = 'opencrew.projectScope'

function readStored(): ProjectScope {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'all'
  } catch {
    return 'all'
  }
}

export function useProjectScope(): [ProjectScope, (scope: ProjectScope) => void] {
  const { projects } = useWorkspace()
  const [scope, setScopeState] = useState<ProjectScope>(readStored)
  // A remembered project that no longer exists falls back to all.
  useEffect(() => {
    if (scope !== 'all' && scope !== 'hq' && !projects.some((p) => p.id === scope)) {
      setScopeState('all')
    }
  }, [scope, projects])
  const setScope = useCallback((next: ProjectScope) => {
    setScopeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // storage unavailable — the choice just doesn't persist
    }
  }, [])
  return [scope, setScope]
}

/** Does an item in this channel fall inside the scope? */
export function inScope(scope: ProjectScope, projectId: string | null): boolean {
  if (scope === 'all') return true
  if (scope === 'hq') return projectId === null
  return projectId === scope
}

/** Sections to render under 'all': HQ first, then projects in creation order. */
export function projectSections(projects: Project[]): { key: string; label: string; project: Project | null }[] {
  return [
    { key: 'hq', label: 'HQ', project: null },
    ...projects.map((p) => ({ key: p.id, label: p.name, project: p }))
  ]
}

export function ProjectDot({ project, className = '' }: { project: Project | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${project ? '' : 'border border-zinc-600'} ${className}`}
      style={project ? { backgroundColor: project.color } : undefined}
    />
  )
}

interface ProjectFilterProps {
  scope: ProjectScope
  onChange: (scope: ProjectScope) => void
  /** Optional counts per key ('hq' | project id) shown on the chips. */
  counts?: Record<string, number>
}

/** Chip row: All · HQ · each project. Hidden when there is only one project and nothing at HQ. */
export function ProjectFilter({ scope, onChange, counts }: ProjectFilterProps) {
  const { projects } = useWorkspace()
  const sections = projectSections(projects)
  if (projects.length <= 1 && !(counts?.hq ?? 0)) return null
  const chip = (key: ProjectScope, label: string, project: Project | null | undefined) => {
    const active = scope === key
    const n = key === 'all' ? undefined : counts?.[key]
    return (
      <button
        key={key}
        onClick={() => onChange(key)}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
          active
            ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
            : 'border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
        }`}
      >
        {project !== undefined && <ProjectDot project={project} />}
        {label}
        {n !== undefined && n > 0 && <span className="font-mono text-[10px] text-zinc-500">{n}</span>}
      </button>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chip('all', 'All', undefined)}
      {sections.map((s) => chip(s.key, s.label, s.project))}
    </div>
  )
}
