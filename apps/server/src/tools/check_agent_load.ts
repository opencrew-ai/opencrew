import { z } from 'zod'
import { and, gte, inArray, eq } from 'drizzle-orm'
import { registerOpenCrewTool } from './registry'
import { agents, runs } from '../db/schema'
import { listAgentsWithVersions, getAgentWithVersion } from '../services/agents'

/**
 * Returns the load status of one or all active agents, so Captain (and other
 * orchestrators) can decide whether to delegate to an existing agent or spawn
 * a parallel clone via spawn_parallel.
 *
 * Load statuses:
 *   idle          — no active runs, within hourly rate limit
 *   busy          — currently executing ≥1 run, but under rate limit
 *   rate_limited  — hit maxRunsPerHour; new runs will be rejected
 *   paused        — agent is administratively paused
 */
registerOpenCrewTool({
  name: 'check_agent_load',
  description:
    'Check whether an agent (or all agents) is idle, busy, or rate-limited before delegating. ' +
    "Call this before @mentioning an agent so you don't queue work onto an overloaded specialist. " +
    'If the target is rate_limited or very busy, use spawn_parallel to create a numbered clone ' +
    'and split the work across both.',
  inputShape: {
    agentName: z
      .string()
      .optional()
      .describe('Agent name to check. Omit to get status for ALL active agents.')
  },
  execute: async ({ agentName }, ctx) => {
    const db = ctx.app.db
    const oneHourAgo = Date.now() - 60 * 60 * 1000

    // Fetch agents to check
    let agentList = await listAgentsWithVersions(db)
    if (agentName) {
      agentList = agentList.filter(
        (a) => a.name.toLowerCase() === agentName.toLowerCase()
      )
      if (agentList.length === 0) {
        return `No agent named "${agentName}" found.`
      }
    } else {
      agentList = agentList.filter((a) => a.status === 'active')
    }

    // DB: active runs per agent
    const activeRows = await db
      .select({ agentId: runs.agentId, status: runs.status })
      .from(runs)
      .where(inArray(runs.status, ['queued', 'running', 'awaiting_approval']))

    const activeByAgent = new Map<string, number>()
    for (const r of activeRows) {
      activeByAgent.set(r.agentId, (activeByAgent.get(r.agentId) ?? 0) + 1)
    }

    // DB: runs in the last hour per agent (rate limit denominator)
    const recentRows = await db
      .select({ agentId: runs.agentId })
      .from(runs)
      .where(gte(runs.createdAt, oneHourAgo))

    const recentByAgent = new Map<string, number>()
    for (const r of recentRows) {
      recentByAgent.set(r.agentId, (recentByAgent.get(r.agentId) ?? 0) + 1)
    }

    const lines = agentList.map((a) => {
      const activeRuns = activeByAgent.get(a.id) ?? 0
      const runsLastHour = recentByAgent.get(a.id) ?? 0
      const max = a.currentVersion.capabilities.maxRunsPerHour
      let status: string
      let advice = ''
      if (a.status === 'paused') {
        status = 'paused'
        advice = '⚠️  Paused — unpause in agent settings before delegating.'
      } else if (runsLastHour >= max) {
        status = 'rate_limited'
        advice = `⛔ Hit ${max}/hr limit. Use spawn_parallel to create ${a.name}2 and delegate there.`
      } else if (activeRuns >= 2) {
        status = 'busy'
        advice = `⚡ ${activeRuns} active runs. Consider spawn_parallel if task is urgent.`
      } else if (activeRuns === 1) {
        status = 'busy'
        advice = '✅ One run in flight — can still accept new work.'
      } else {
        status = 'idle'
        advice = '✅ Ready — safe to delegate.'
      }
      return (
        `${a.avatarEmoji} ${a.name}: ${status.toUpperCase()}\n` +
        `   Active: ${activeRuns}  |  Last hour: ${runsLastHour}/${max}\n` +
        `   ${advice}`
      )
    })

    return lines.join('\n\n')
  }
})
