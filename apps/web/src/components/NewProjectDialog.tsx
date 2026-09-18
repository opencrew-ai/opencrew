import { useEffect, useState, type FormEvent } from 'react'
import type { Project } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'
import { DirPicker } from './DirPicker'

interface ResumableProject {
  name: string
  slug: string
  workingDir: string
  lastUsedAt: number
}

/**
 * Projects this machine used before the database was reset (reinstall,
 * corruption). Their record is still in the repo; one click brings the
 * project back around it.
 */
function ResumeList({ onCreated }: { onCreated: (project: Project) => void }) {
  const [found, setFound] = useState<ResumableProject[]>([])
  const [busyDir, setBusyDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ projects: ResumableProject[] }>('/api/projects/resumable')
      .then((r) => setFound(r.projects))
      .catch(() => setFound([]))
  }, [])

  if (found.length === 0) return null

  const resume = async (p: ResumableProject) => {
    setBusyDir(p.workingDir)
    setError(null)
    try {
      onCreated(await api.post<Project>('/api/projects', { name: p.name, workingDir: p.workingDir }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not resume')
      setBusyDir(null)
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="font-semibold text-zinc-100">Pick up where you left off</h3>
      <p className="mt-1 text-xs text-zinc-500">
        Projects this machine used before. Everything approved is still in the repo; the crew reads
        it again. Chat history is not kept.
      </p>
      <ul className="mt-3 space-y-2">
        {found.map((p) => (
          <li key={p.workingDir} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-zinc-200">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-zinc-500">{p.workingDir}</div>
            </div>
            <button
              type="button"
              className="btn-primary shrink-0"
              disabled={busyDir !== null}
              onClick={() => void resume(p)}
            >
              {busyDir === p.workingDir ? 'Opening…' : 'Continue'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  )
}

interface NewProjectFormProps {
  onCreated: (project: Project) => void
  onCancel?: () => void
  /** First-run copy: there is nothing else on screen yet. */
  firstRun?: boolean
}

/**
 * Add a project: a name and, optionally, the repo it lives in. The server
 * seeds #general / #customers and a Captain, so the project is usable the
 * moment this closes. Rendered inline on first run, in a dialog after.
 */
export function NewProjectForm({ onCreated, onCancel, firstRun = false }: NewProjectFormProps) {
  const { projects, projectColors } = useWorkspace()
  const [name, setName] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [color, setColor] = useState(
    projectColors[projects.length % Math.max(1, projectColors.length)] ?? '#f59e0b'
  )
  const [showDirPicker, setShowDirPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const project = await api.post<Project>('/api/projects', {
        name: name.trim(),
        workingDir: workingDir.trim(),
        color
      })
      onCreated(project)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-lg space-y-4">
      <div>
        <h2 className={`font-display font-semibold text-zinc-100 ${firstRun ? 'text-2xl' : 'text-lg'}`}>
          {firstRun ? 'What are you building?' : 'New project'}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          {firstRun
            ? 'Name the product. You get a room for it and a Captain who reads everything you type there and puts a crew on it.'
            : 'One product, its own rooms and crew. You get #general, #customers and a Captain who answers there.'}
        </p>
      </div>

      <ResumeList onCreated={onCreated} />

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="label">Name</label>
          <input
            className="input"
            placeholder="e.g. Shop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            maxLength={60}
          />
        </div>
        {!firstRun && (
          <div>
            <label className="label">Color</label>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {projectColors.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Use color ${c}`}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border-2 transition ${
                    color === c ? 'scale-110 border-white' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        <label className="label">Where the code lives (optional)</label>
        <div className="flex gap-2">
          <input
            className="input flex-1 font-mono text-xs"
            placeholder="/Users/you/projects/shop"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
          />
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={() => setShowDirPicker((v) => !v)}
          >
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
          {firstRun
            ? 'Your repo, if you have one — not a git repo yet is fine, we set it up. Agents work in their own copies; every approval is a commit here. Leave empty and OpenCrew keeps a repo for you.'
            : 'Your repo — not a git repo yet is fine, we set it up. Each agent gets its own checkout; every approval is a commit here. Leave empty and OpenCrew keeps a repo for you.'}
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
          {busy ? 'Setting up…' : firstRun ? 'Start' : 'Create project'}
        </button>
      </div>
    </form>
  )
}

interface NewProjectDialogProps {
  onCreated: (project: Project) => void
  onClose: () => void
}

export function NewProjectDialog({ onCreated, onClose }: NewProjectDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="New project"
    >
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <NewProjectForm onCreated={onCreated} onCancel={onClose} />
      </div>
    </div>
  )
}
