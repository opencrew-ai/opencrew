import { presenceKey, useWorkspace } from '../lib/workspace'

/**
 * "Who's in the office" — a slim strip of every human in the workspace.
 * 🟢 online · 🟡 their crew is working right now · ⚫ offline.
 * Click a person to spectate their crew (glass walls, on by default).
 */

interface PresenceBarProps {
  onSpectate: (userId: string) => void
}

export function PresenceBar({ onSpectate }: PresenceBarProps) {
  const { me, users, agents, presence } = useWorkspace()

  const agentState = (agentId: string) =>
    presence.get(presenceKey('agent', agentId))?.state ?? 'idle'
  const humanOnline = (userId: string) =>
    presence.get(presenceKey('human', userId))?.state === 'online'
  const crewWorking = (userId: string) =>
    agents.some((a) => a.createdBy === userId && agentState(a.id) === 'running')

  const workingAgentCount = agents.filter((a) => agentState(a.id) === 'running').length

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800/70 bg-zinc-950 px-3 py-1.5">
      {users.map((user) => {
        const online = humanOnline(user.id)
        const working = crewWorking(user.id)
        const dot = working ? 'animate-pulse bg-amber-400' : online ? 'bg-emerald-400' : 'bg-zinc-600'
        return (
          <button
            key={user.id}
            onClick={() => onSpectate(user.id)}
            title={`${user.name}${user.id === me.id ? ' (you)' : ''} — ${
              working ? 'crew working' : online ? 'online' : 'offline'
            } · click to watch their crew`}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            {user.name}
          </button>
        )
      })}
      {workingAgentCount > 0 && (
        <span className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
          ⚡ {workingAgentCount} agent{workingAgentCount === 1 ? '' : 's'} working
        </span>
      )}
    </div>
  )
}
