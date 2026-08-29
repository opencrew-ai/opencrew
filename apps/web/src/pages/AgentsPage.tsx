import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AgentWithVersion } from '@opencrew/shared'
import { api } from '../lib/api'
import { Sidebar } from '../components/Sidebar'
import { AgentForm } from '../components/AgentForm'
import { useWorkspace } from '../lib/workspace'

export function AgentsPage() {
  const { me, agents, refreshAgents } = useWorkspace()
  const navigate = useNavigate()
  const [adding, setAdding] = useState(false)
  const isAdmin = me.role === 'admin'

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">The Crew</h1>
          {isAdmin && (
            <button className="btn-primary" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : '+ Add agent'}
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Agents are teammates: give one a prompt, skills, and tools — it runs on Claude Code
          under the hood.
        </p>

        {adding && (
          <div className="mt-6 rounded-lg border border-zinc-800 p-5">
            <h2 className="mb-4 font-semibold">New agent</h2>
            <AgentForm
              mode="create"
              onSubmit={async (data) => {
                const agent = await api.post<AgentWithVersion>('/api/agents', data)
                await refreshAgents()
                navigate(`/agents/${agent.id}`)
              }}
            />
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <Link
              key={a.id}
              to={`/agents/${a.id}`}
              className="rounded-lg border border-zinc-800 p-4 hover:border-zinc-600"
            >
              <div className="flex items-center gap-3">
                <span className="text-3xl">{a.avatarEmoji}</span>
                <div>
                  <div className="font-semibold">
                    {a.name}
                    {a.status === 'paused' && (
                      <span className="ml-2 rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">
                        paused
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">
                    v{a.currentVersion.version} · {a.currentVersion.model}
                  </div>
                </div>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-zinc-400">
                {a.currentVersion.systemPrompt}
              </p>
              <div className="mt-3 flex flex-wrap gap-1">
                {a.currentVersion.skills.map((s) => (
                  <span key={s} className="rounded bg-violet-900/40 px-1.5 py-0.5 text-xs text-violet-300">
                    {s}
                  </span>
                ))}
                {a.currentVersion.tools.map((t) => (
                  <code key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                    {t}
                  </code>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
