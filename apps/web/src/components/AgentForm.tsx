import { useEffect, useState, type FormEvent } from 'react'
import type { AgentVersionConfig } from '@opencrew/shared'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'

interface ToolCatalogEntry {
  name: string
  description: string
  kind: 'builtin' | 'opencrew'
}

interface AgentFormProps {
  mode: 'create' | 'edit'
  initial?: {
    name: string
    avatarEmoji: string
    config: AgentVersionConfig
  }
  onSubmit: (data: {
    name: string
    avatarEmoji: string
    config: AgentVersionConfig
    changeNote: string
  }) => Promise<void>
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export function AgentForm({ mode, initial, onSubmit }: AgentFormProps) {
  const { channels } = useWorkspace()
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([])
  const [name, setName] = useState(initial?.name ?? '')
  const [avatarEmoji, setAvatarEmoji] = useState(initial?.avatarEmoji ?? '🤖')
  const [systemPrompt, setSystemPrompt] = useState(initial?.config.systemPrompt ?? '')
  const [model, setModel] = useState(initial?.config.model ?? DEFAULT_MODEL)
  const [skills, setSkills] = useState((initial?.config.skills ?? []).join(', '))
  const [tools, setTools] = useState<string[]>(initial?.config.tools ?? [])
  const [gated, setGated] = useState<string[]>(
    initial?.config.capabilities.requiresApprovalFor ?? []
  )
  const [postChannels, setPostChannels] = useState<string[]>(
    initial?.config.capabilities.canPostInChannels ?? channels.map((c) => c.id)
  )
  const [maxRunsPerHour, setMaxRunsPerHour] = useState(
    initial?.config.capabilities.maxRunsPerHour ?? 20
  )
  const [changeNote, setChangeNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<ToolCatalogEntry[]>('/api/tools').then(setCatalog).catch(() => {})
  }, [])

  const toggle = (list: string[], set: (v: string[]) => void, value: string) => {
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value])
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        name,
        avatarEmoji,
        config: {
          systemPrompt,
          model,
          skills: skills
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          tools,
          capabilities: {
            canPostInChannels: postChannels,
            maxRunsPerHour,
            requiresApprovalFor: gated.filter((g) => tools.includes(g))
          }
        },
        changeNote: changeNote || (mode === 'create' ? 'initial version' : 'config update')
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5">
      <div className="flex gap-3">
        <div className="w-20">
          <label className="label">Emoji</label>
          <input className="input text-center" value={avatarEmoji} onChange={(e) => setAvatarEmoji(e.target.value)} />
        </div>
        <div className="flex-1">
          <label className="label">Name</label>
          <input
            className="input"
            placeholder="e.g. Scout"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={mode === 'edit'}
            required
          />
        </div>
        <div className="w-56">
          <label className="label">Model</label>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label">System prompt — who is this teammate?</label>
        <textarea
          className="input min-h-32 font-mono text-xs"
          placeholder="You are Scout, the crew researcher…"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="label">Skills (comma-separated)</label>
        <input
          className="input"
          placeholder="research, summarization"
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
        />
      </div>

      <div>
        <label className="label">Tools & approval gates</label>
        <div className="mt-1 space-y-1 rounded-md border border-zinc-800 p-3">
          {catalog.map((tool) => (
            <div key={tool.name} className="flex items-center gap-3 text-sm">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={tools.includes(tool.name)}
                  onChange={() => toggle(tools, setTools, tool.name)}
                />
                <code className="text-xs">{tool.name}</code>
                <span className="text-xs text-zinc-500">{tool.description}</span>
              </label>
              {tools.includes(tool.name) && (
                <label className="flex items-center gap-1 text-xs text-amber-300">
                  <input
                    type="checkbox"
                    checked={gated.includes(tool.name)}
                    onChange={() => toggle(gated, setGated, tool.name)}
                  />
                  requires approval
                </label>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-6">
        <div className="flex-1">
          <label className="label">Can post in channels</label>
          <div className="mt-1 space-y-1">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={postChannels.includes(c.id)}
                  onChange={() => toggle(postChannels, setPostChannels, c.id)}
                />
                # {c.name}
              </label>
            ))}
          </div>
        </div>
        <div className="w-44">
          <label className="label">Max runs / hour</label>
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            value={maxRunsPerHour}
            onChange={(e) => setMaxRunsPerHour(Number(e.target.value))}
          />
        </div>
      </div>

      {mode === 'edit' && (
        <div>
          <label className="label">Change note</label>
          <input
            className="input"
            placeholder="What changed and why?"
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            required
          />
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button className="btn-primary" disabled={busy}>
        {busy ? '…' : mode === 'create' ? 'Add to crew' : 'Save as new version'}
      </button>
    </form>
  )
}
