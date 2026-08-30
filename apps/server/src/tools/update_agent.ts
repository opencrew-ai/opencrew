import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { isKnownToolName } from './catalog'
import { agents } from '../db/schema'
import { createVersion, getAgentWithVersion } from '../services/agents'
import { recordStep } from '../runs/audit'

registerOpenCrewTool({
  name: 'update_agent',
  description:
    "Update an existing agent's configuration: system prompt, tools, channels it may post " +
    'in or watch, or rate limit. Creates a new immutable version (full audit + rollback). ' +
    'Use for fixes like granting a specialist access to a channel it needs, tightening a ' +
    'prompt, or adding a missing tool. Omitted fields stay unchanged.',
  inputShape: {
    name: z.string().min(1).max(40).describe('Exact name of the agent to update'),
    systemPrompt: z.string().min(20).max(20_000).optional().describe('Replacement system prompt'),
    addTools: z.array(z.string()).max(12).optional().describe('Tool names to grant'),
    removeTools: z.array(z.string()).max(12).optional().describe('Tool names to revoke'),
    canPostInChannels: z
      .array(z.string())
      .optional()
      .describe('Replacement channel-id list the agent may post into ("*" = all)'),
    watchesChannels: z
      .array(z.string())
      .optional()
      .describe('Replacement channel-id list the agent auto-runs on ("*" = all)'),
    maxRunsPerHour: z.number().int().min(1).max(10_000).optional(),
    changeNote: z.string().min(1).max(300).describe('Why this change — shown in version history')
  },
  execute: async (input, ctx) => {
    const [row] = await ctx.app.db
      .select()
      .from(agents)
      .where(eq(agents.name, input.name))
      .limit(1)
    if (!row) throw new Error(`no agent named "${input.name}" — check list_agents`)
    const full = await getAgentWithVersion(ctx.app.db, row.id)
    if (!full) throw new Error(`agent "${input.name}" has no current version`)

    const unknown = (input.addTools ?? []).filter((t) => !isKnownToolName(t))
    if (unknown.length > 0) {
      throw new Error(`unknown tools: ${unknown.join(', ')} — use names from the catalog`)
    }

    const current = full.currentVersion
    const tools = [
      ...new Set([
        ...current.tools.filter((t) => !(input.removeTools ?? []).includes(t)),
        ...(input.addTools ?? [])
      ])
    ]
    const version = await createVersion(
      ctx.app.db,
      row.id,
      {
        systemPrompt: input.systemPrompt ?? current.systemPrompt,
        model: current.model,
        skills: [...current.skills],
        tools,
        capabilities: {
          ...current.capabilities,
          canPostInChannels: input.canPostInChannels ?? current.capabilities.canPostInChannels,
          watchesChannels: input.watchesChannels ?? current.capabilities.watchesChannels,
          maxRunsPerHour: input.maxRunsPerHour ?? current.capabilities.maxRunsPerHour,
          // Gated tools stay gated; newly added risky tools default to gated.
          requiresApprovalFor: [
            ...new Set([
              ...current.capabilities.requiresApprovalFor.filter((t) => tools.includes(t)),
              ...(input.addTools ?? []).filter((t) =>
                ['Bash', 'Browser', 'create_agent', 'update_agent'].includes(t)
              )
            ])
          ]
        }
      },
      `agent:${ctx.agentId}`,
      input.changeNote
    )
    await recordStep(ctx.app, ctx.runId, 'tool_call', {
      tool: 'update_agent',
      input: { name: input.name, changeNote: input.changeNote, version: version.version }
    })
    return (
      `Updated ${input.name} to v${version.version} (${input.changeNote}). ` +
      `In-flight runs keep their pinned version; new runs use this one.`
    )
  }
})
