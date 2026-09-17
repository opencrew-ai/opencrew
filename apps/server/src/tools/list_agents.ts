import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { getAgentWithVersion } from '../services/agents'
import { agentsVisibleInChannel } from '../services/projects'

registerOpenCrewTool({
  name: 'list_agents',
  description:
    'List every agent on THIS project\'s crew (plus HQ-level services) with its skills, tools, status, and watched channels — use this before delegating or creating a new agent.',
  inputShape: {
    // Zod requires at least an empty shape; no inputs needed.
    _: z.string().optional().describe('unused')
  },
  execute: async (_input, ctx) => {
    // PROJECT BOUNDARY: the roster is the channel's project + HQ, never other projects.
    const visible = await agentsVisibleInChannel(ctx.app.db, ctx.channelId)
    const full = await Promise.all(visible.map((a) => getAgentWithVersion(ctx.app.db, a.id)))
    const roster = full.filter((a) => a !== null).map((a) => ({
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
