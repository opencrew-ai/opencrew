import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { listAgentsWithVersions } from '../services/agents'

registerOpenCrewTool({
  name: 'list_agents',
  description:
    'List every agent on the crew with its skills, tools, status, and watched channels — use this before delegating or creating a new agent.',
  inputShape: {
    // Zod requires at least an empty shape; no inputs needed.
    _: z.string().optional().describe('unused')
  },
  execute: async (_input, ctx) => {
    const roster = listAgentsWithVersions(ctx.app.db).map((a) => ({
      name: a.name,
      emoji: a.avatarEmoji,
      status: a.status,
      skills: a.currentVersion.skills,
      tools: a.currentVersion.tools,
      gatedTools: a.currentVersion.capabilities.requiresApprovalFor,
      watchesChannels: a.currentVersion.capabilities.watchesChannels ?? [],
      workingDir: a.currentVersion.capabilities.workingDir || null,
      promptSummary: a.currentVersion.systemPrompt.slice(0, 200)
    }))
    return JSON.stringify(roster, null, 2)
  }
})
