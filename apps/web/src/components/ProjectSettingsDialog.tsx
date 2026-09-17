import { useState, type FormEvent } from 'react'
import type { Project } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'
import { DirPicker } from './DirPicker'

interface ProjectSettingsDialogProps {
  project: Project
  onClose: () => void
}

/**
 * Everything a project owns that a human sets: name, color, the repo agents
 * work from, and its budgets. Deliberately small — the rest is the crew's.
 */
export function ProjectSettingsDialog({ project, onClose }: ProjectSettingsDialogProps) {
  const { projectColors, refreshProjects } = useWorkspace()
  const [name, setName] = useState(project.name)
  const [color, setColor] = useState(project.color)
  const [workingDir, setWorkingDir] = useState(project.workingDir)
  const [dailyBudgetUsd, setDailyBudgetUsd] = useState(String(project.dailyBudgetUsd || ''))
  const [maxConcurrent, setMaxConcurrent] = useState(project.maxConcurrent)
  const [showDirPicker, setShowDirPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/api/projects/${project.id}`, {
        name: name.trim(),
        color,
        workingDir: workingDir.trim(),
        dailyBudgetUsd: Number(dailyBudgetUsd) || 0,
        maxConcurrent
      })
      await refreshProjects()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${project.name} settings`}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
      >
        <h2 className="font-display text-lg font-semibold text-zinc-100">Project</h2>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </div>
          <div>
            <label className="label">Color</label>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {projectColors.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use color ${c}`}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border-2 transition ${color === c ? 'scale-110 border-white' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <div>
          <label className="label">Repo folder</label>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              placeholder="/Users/you/projects/shop"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
            />
            <button type="button" className="btn-secondary shrink-0" onClick={() => setShowDirPicker((v) => !v)}>
              {showDirPicker ? 'Close' : 'Browse…'}
            </button>
          </div>
          {showDirPicker && (
            <DirPicker
              initialPath={workingDir || undefined}
              onSelect={(path) => {
                setWorkingDir(path)
                setShowDirPicker(false)
              }}
              onClose={() => setShowDirPicker(false)}
            />
          )}
          <p className="mt-1 text-xs text-zinc-500">
            A git repo. Each agent works in its own checkout of it; your checkout only changes
            when you approve a change.
          </p>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="label">Daily budget (USD)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              placeholder="0 = no cap"
              value={dailyBudgetUsd}
              onChange={(e) => setDailyBudgetUsd(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className="label">Agents at once</label>
            <input
              className="input"
              type="number"
              min={1}
              max={64}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          At the budget, this project's agents pause until tomorrow and tell you. The
          concurrency cap keeps one busy product from starving the others.
        </p>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
