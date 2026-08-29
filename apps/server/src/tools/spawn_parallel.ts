import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { registerOpenCrewTool } from './registry'
import { agents } from '../db/schema'
import {
  listAgentsWithVersions,
  getAgentWithVersion,
  createVersion
} from '../services/agents'
import { recordStep } from '../runs/audit'

/**
 * Clones an existing agent with a numbered suffix (Coder → Coder2, Coder2 → Coder3)
 * and the same system prompt, model, tools, and capabilities. Use this when the
 * original agent is rate-limited or overloaded and work cannot wait.
 *
 * The clone is immediately active and can be @mentioned with its new name.
 * Tip: you can send it the same task as the original to split parallel workloads.
 */
registerOpenCrewTool({
  name: 'spawn_parallel',
  description:
    'Clone an overloaded agent under a numbered name (Coder → Coder2) with the same config. ' +
    'Use when check_agent_load shows an agent is rate_limited or very busy. ' +
    'The clone is immediately active and can be @mentioned to split work in parallel.',
  inputShape: {
    sourceName: z
      .string()
      .min(1)
      .describe('Name of the agent to clone (e.g. "Coder", "Scout")'),
    reason: z
      .string()
      .max(200)
      .optional()
      .describe('Why you are spawning a parallel — shown in the change note')
  },
  execute: async ({ sourceName, reason }, ctx) => {
    const db = ctx.app.db

    // Find the source agent by name (case-insensitive)
    const all = await listAgentsWithVersions(db)
    const source = all.find((a) => a.name.toLowerCase() === sourceName.toLowerCase())
    if (!source) {
      return `No agent named "${sourceName}" found. Use list_agents to see the roster.`
    }

    // Determine the base name (strip trailing digits) and find the next suffix.
    // "Coder" → base="Coder"  "Coder2" → base="Coder"  "Coder12" → base="Coder"
    const baseName = source.name.replace(/\d+$/, '')
    const existing = all.map((a) => a.name)
    let suffix = 2
    while (existing.includes(`${baseName}${suffix}`)) {
      suffix++
    }
    const newName = `${baseName}${suffix}`

    // Create the new agent row
    const agentId = nanoid()
    await db.insert(agents).values({
      id: agentId,
      workspaceSlug: 'default',
      name: newName,
      avatarEmoji: source.avatarEmoji,
      currentVersionId: 'pending',
      createdBy: `agent:${ctx.agentId}`,
      status: 'active',
      createdAt: Date.now()
    })

    // Copy the source version config exactly
    const sourceConfig = source.currentVersion
    await createVersion(
      db,
      agentId,
      {
        systemPrompt: sourceConfig.systemPrompt,
        model: sourceConfig.model,
        skills: sourceConfig.skills,
        tools: sourceConfig.tools,
        capabilities: sourceConfig.capabilities
      },
      `agent:${ctx.agentId}`,
      reason
        ? `parallel clone of ${source.name}: ${reason}`
        : `parallel clone of ${source.name} — spawned by ${ctx.agentId}`
    )

    // Broadcast new agent
    const created = await getAgentWithVersion(db, agentId)
    if (created) {
      ctx.app.hub.broadcast({ type: 'agent_updated', agent: created })
    }

    recordStep(ctx.app, ctx.runId, 'post_message', {
      via: 'spawn_parallel',
      sourceAgentId: source.id,
      newAgentId: agentId,
      newAgentName: newName
    })

    return (
      `Spawned ${source.avatarEmoji} ${newName} — a clone of ${source.name} with identical config.\n` +
      `@mention @${newName} to route work to this parallel instance.\n` +
      `Tools: ${sourceConfig.tools.join(', ') || 'none'}`
    )
  }
})
