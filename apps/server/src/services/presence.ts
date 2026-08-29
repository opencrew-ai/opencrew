import type { PresenceEntry } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, users } from '../db/schema'

export function computePresence(ctx: AppContext): PresenceEntry[] {
  const online = new Set(ctx.hub.onlineUserIds())
  const runningAgents = ctx.queue.activeAgentIds()

  const humanEntries: PresenceEntry[] = ctx.db
    .select({ id: users.id })
    .from(users)
    .all()
    .map((u) => ({
      memberType: 'human' as const,
      memberId: u.id,
      state: online.has(u.id) ? ('online' as const) : ('offline' as const)
    }))

  const agentEntries: PresenceEntry[] = ctx.db
    .select({ id: agents.id })
    .from(agents)
    .all()
    .map((a) => ({
      memberType: 'agent' as const,
      memberId: a.id,
      state: runningAgents.has(a.id) ? ('running' as const) : ('idle' as const)
    }))

  return [...humanEntries, ...agentEntries]
}

export function broadcastPresence(ctx: AppContext): void {
  ctx.hub.broadcast({ type: 'presence', entries: computePresence(ctx) })
}
