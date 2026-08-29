import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { AgentVersion, AgentWithVersion, Run, VersionDiff } from '@opencrew/shared'
import { api } from '../lib/api'
import { Sidebar } from '../components/Sidebar'
import { AgentForm } from '../components/AgentForm'
import { DiffView } from '../components/DiffView'
import { TerminalDrawer } from '../components/TerminalDrawer'
import { useWorkspace } from '../lib/workspace'

type Tab = 'config' | 'versions' | 'runs'

export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const { me, refreshAgents } = useWorkspace()
  const [agent, setAgent] = useState<AgentWithVersion | null>(null)
  const [versions, setVersions] = useState<AgentVersion[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [tab, setTab] = useState<Tab>('config')
  const [diffFrom, setDiffFrom] = useState<string>('')
  const [diffTo, setDiffTo] = useState<string>('')
  const [diff, setDiff] = useState<VersionDiff | null>(null)
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const isAdmin = me.role === 'admin'

  const reload = useCallback(async () => {
    if (!agentId) return
    const [a, v, r] = await Promise.all([
      api.get<AgentWithVersion>(`/api/agents/${agentId}`),
      api.get<AgentVersion[]>(`/api/agents/${agentId}/versions`),
      api.get<Run[]>(`/api/agents/${agentId}/runs`)
    ])
    setAgent(a)
    setVersions(v)
    setRuns(r)
    await refreshAgents()
  }, [agentId, refreshAgents])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!agentId || !diffFrom || !diffTo || diffFrom === diffTo) {
      setDiff(null)
      return
    }
    api
      .get<VersionDiff>(`/api/agents/${agentId}/diff?from=${diffFrom}&to=${diffTo}`)
      .then(setDiff)
      .catch(() => setDiff(null))
  }, [agentId, diffFrom, diffTo])

  if (!agent) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <div className="grid flex-1 place-items-center text-zinc-500">Loading…</div>
      </div>
    )
  }

  const togglePause = async () => {
    await api.post(`/api/agents/${agent.id}/status`, {
      status: agent.status === 'active' ? 'paused' : 'active'
    })
    await reload()
  }

  const rollback = async (version: AgentVersion) => {
    if (!confirm(`Roll back to v${version.version}? This creates a new version.`)) return
    await api.post(`/api/agents/${agent.id}/rollback`, { versionId: version.id })
    await reload()
    setTab('versions')
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center gap-4">
          <span className="text-4xl">{agent.avatarEmoji}</span>
          <div className="flex-1">
            <h1 className="text-xl font-bold">
              {agent.name}
              <span className="ml-2 text-sm font-normal text-zinc-500">
                v{agent.currentVersion.version} · {agent.currentVersion.model} ·{' '}
                {agent.status}
              </span>
            </h1>
            <p className="text-sm text-zinc-500">
              {agent.currentVersion.skills.join(' · ') || 'no skills listed'}
            </p>
          </div>
          {isAdmin && (
            <button className="btn-secondary" onClick={() => void togglePause()}>
              {agent.status === 'active' ? '⏸ Pause' : '▶ Activate'}
            </button>
          )}
        </div>

        <div className="mt-6 flex gap-1 border-b border-zinc-800">
          {(['config', 'versions', 'runs'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm capitalize ${
                tab === t
                  ? 'border-b-2 border-sky-500 font-semibold text-white'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'config' && (
          <div className="mt-6">
            {isAdmin ? (
              <>
                <p className="mb-4 text-sm text-zinc-500">
                  Saving creates <b>v{agent.currentVersion.version + 1}</b> — versions are
                  immutable, nothing is ever overwritten.
                </p>
                <AgentForm
                  key={agent.currentVersionId}
                  mode="edit"
                  initial={{
                    name: agent.name,
                    avatarEmoji: agent.avatarEmoji,
                    config: agent.currentVersion
                  }}
                  onSubmit={async (data) => {
                    await api.post(`/api/agents/${agent.id}/versions`, {
                      config: data.config,
                      changeNote: data.changeNote
                    })
                    await reload()
                    setTab('versions')
                  }}
                />
              </>
            ) : (
              <pre className="whitespace-pre-wrap rounded-md border border-zinc-800 p-4 text-sm text-zinc-300">
                {agent.currentVersion.systemPrompt}
              </pre>
            )}
          </div>
        )}

        {tab === 'versions' && (
          <div className="mt-6 space-y-6">
            <div>
              <h3 className="label">Compare versions</h3>
              <div className="flex items-center gap-2 text-sm">
                <select className="input w-40" value={diffFrom} onChange={(e) => setDiffFrom(e.target.value)}>
                  <option value="">from…</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-500">→</span>
                <select className="input w-40" value={diffTo} onChange={(e) => setDiffTo(e.target.value)}>
                  <option value="">to…</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                    </option>
                  ))}
                </select>
              </div>
              {diff && (
                <div className="mt-4 rounded-lg border border-zinc-800 p-4">
                  <DiffView diff={diff} />
                </div>
              )}
            </div>

            <div className="space-y-2">
              {[...versions].reverse().map((v) => (
                <div
                  key={v.id}
                  className={`flex items-center gap-3 rounded-md border p-3 text-sm ${
                    v.id === agent.currentVersionId
                      ? 'border-sky-800 bg-sky-950/20'
                      : 'border-zinc-800'
                  }`}
                >
                  <span className="font-mono font-semibold">v{v.version}</span>
                  <span className="flex-1 text-zinc-400">{v.changeNote}</span>
                  <span className="text-xs text-zinc-500">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                  {v.id === agent.currentVersionId ? (
                    <span className="rounded bg-sky-900/60 px-2 py-0.5 text-xs">current</span>
                  ) : (
                    isAdmin && (
                      <button
                        className="text-xs text-sky-400 hover:underline"
                        onClick={() => void rollback(v)}
                      >
                        roll back
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'runs' && (
          <div className="mt-6 space-y-2">
            {runs.length === 0 && <p className="text-sm text-zinc-500">No runs yet.</p>}
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setOpenRunId(r.id)}
                className="flex w-full items-center gap-3 rounded-md border border-zinc-800 p-3 text-left text-sm hover:border-zinc-600"
              >
                <StatusBadge status={r.status} />
                <span className="font-mono text-xs text-zinc-500">{r.id.slice(0, 8)}</span>
                <span className="flex-1 text-xs text-zinc-500">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                {r.error && <span className="text-xs text-red-400">{r.error}</span>}
                <span className="text-xs text-zinc-500">open terminal →</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {openRunId && <TerminalDrawer runId={openRunId} onClose={() => setOpenRunId(null)} />}
    </div>
  )
}

function StatusBadge({ status }: { status: Run['status'] }) {
  const styles: Record<Run['status'], string> = {
    queued: 'bg-zinc-800 text-zinc-300',
    running: 'bg-amber-900/60 text-amber-300',
    awaiting_approval: 'bg-amber-900/60 text-amber-200',
    done: 'bg-emerald-900/50 text-emerald-300',
    failed: 'bg-red-900/50 text-red-300',
    cancelled: 'bg-zinc-800 text-zinc-400'
  }
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${styles[status]}`}>{status}</span>
  )
}
