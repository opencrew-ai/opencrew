import type { PresenceEntry } from '@opencrew/shared'
import type { AppContext } from '../context'
import { agents, users } from '../db/schema'

export async function computePresence(ctx: AppContext): Promise<PresenceEntry[]> {
  const online = new Set(ctx.hub.onlineUserIds())
  const runningAgents = ctx.queue.activeAgentIds()

  const [humanRows, agentRows] = await Promise.all([
    ctx.db.select({ id: users.id }).from(users),
    ctx.db.select({ id: agents.id }).from(agents)
  ])

  const humanEntries: PresenceEntry[] = humanRows.map((u) => ({
    memberType: 'human' as const,
    memberId: u.id,
    state: online.has(u.id) ? ('online' as const) : ('offline' as const)
  }))

  const agentEntries: PresenceEntry[] = agentRows.map((a) => ({
    memberType: 'agent' as const,
    memberId: a.id,
    state: runningAgents.has(a.id) ? ('running' as const) : ('idle' as const)
  }))

  return [...humanEntries, ...agentEntries]
}

export function broadcastPresence(ctx: AppContext): void {
  // Fire-and-forget: presence updates are best-effort and non-critical.
  void computePresence(ctx).then((entries) => {
    ctx.hub.broadcast({ type: 'presence', entries })
  })
}
