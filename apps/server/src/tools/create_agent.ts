import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { isKnownToolName, isKnownModel, KNOWN_MODELS } from './catalog'
import { agents } from '../db/schema'
import { createVersion, getAgentWithVersion } from '../services/agents'
import { recordStep } from '../runs/audit'

// New agents get risky tools gated by default — a human can loosen later.
const DEFAULT_GATED = ['Bash', 'Browser', 'create_agent']

registerOpenCrewTool({
  name: 'create_agent',
  description:
    'Hire a new agent onto the crew: name, emoji, system prompt, skills, and tools. ' +
    'Prefer hiring a FOCUSED SPECIALIST (tight prompt, minimal tools, one discipline) ' +
    'over overloading generalists — a crew of specialists beats two busy generalists. ' +
    'Check list_agents first to avoid duplicates. The new agent is immediately active ' +
    'and can be @mentioned.',
  inputShape: {
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9 _-]+$/)
      .describe('Agent name, e.g. "DataViz"'),
    avatarEmoji: z.string().min(1).max(8).describe('One emoji avatar'),
    model: z
      .string()
      .optional()
      .describe(`Model id for the new agent (default claude-sonnet-4-6). One of: ${KNOWN_MODELS.join(', ')}`),
    systemPrompt: z
      .string()
      .min(20)
      .max(20_000)
      .describe('Who this teammate is and how it should work'),
    skills: z.array(z.string().max(80)).max(10).describe('Skill keywords'),
    tools: z
      .array(z.string())
      .max(12)
      .describe('Tool names from the catalog, e.g. ["Bash","Read","Write"]'),
    gatedTools: z
      .array(z.string())
      .optional()
      .describe('Tools requiring human approval; defaults to Bash/Browser if granted'),
    watchesChannels: z
      .array(z.string())
      .optional()
      .describe('Channel ids the agent auto-runs on (rarely needed)'),
    workingDir: z
      .string()
      .optional()
      .describe('Absolute path to a repo the agent works in; empty = own workspace')
  },
  execute: async (input, ctx) => {
    if (input.model && !isKnownModel(input.model)) {
      throw new Error(`unknown model "${input.model}" — use one of: ${KNOWN_MODELS.join(', ')}`)
    }
    const unknown = input.tools.filter((t) => !isKnownToolName(t))
    if (unknown.length > 0) {
      throw new Error(`unknown tools: ${unknown.join(', ')} — use names from the catalog`)
    }
    const [existing] = await ctx.app.db
      .select()
      .from(agents)
      .where(eq(agents.name, input.name))
      .limit(1)
    if (existing) throw new Error(`agent "${input.name}" already exists`)

    const gated = (input.gatedTools ?? DEFAULT_GATED).filter((t) =>
      input.tools.includes(t)
    )
    const agentId = nanoid()
    await ctx.app.db
      .insert(agents)
      .values({
        id: agentId,
        name: input.name,
        avatarEmoji: input.avatarEmoji,
        currentVersionId: 'pending',
        createdBy: `agent:${ctx.agentId}`,
        status: 'active',
        createdAt: Date.now()
      })
    await createVersion(
      ctx.app.db,
      agentId,
      {
        systemPrompt: input.systemPrompt,
        model: input.model ?? 'claude-sonnet-4-6',
        skills: input.skills,
        tools: input.tools,
        capabilities: {
          // New hires may speak everywhere; tighten by editing the version.
          canPostInChannels: ['*'],
          maxRunsPerHour: 1000,
          requiresApprovalFor: gated,
          watchesChannels: input.watchesChannels ?? [],
          workingDir: input.workingDir ?? ''
        }
      },
      `agent:${ctx.agentId}`,
      `hired by agent via create_agent`
    )

    const created = await getAgentWithVersion(ctx.app.db, agentId)
    if (created) ctx.app.hub.broadcast({ type: 'agent_updated', agent: created })
    recordStep(ctx.app, ctx.runId, 'post_message', {
      via: 'create_agent',
      createdAgentId: agentId,
      name: input.name
    })
    return (
      `Created agent "${input.name}" ${input.avatarEmoji} (tools: ${input.tools.join(', ')}; ` +
      `gated: ${gated.join(', ') || 'none'}). It is active — @mention @${input.name} to put it to work.`
    )
  }
})
