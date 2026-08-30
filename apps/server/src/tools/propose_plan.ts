import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { proposePlan } from '../services/artifacts'

registerOpenCrewTool({
  name: 'propose_plan',
  description:
    'Propose a plan as a durable DOCUMENT artifact for this conversation, with a structured ' +
    'task list. The plan waits for human approval — committing it puts the tasks on the shared ' +
    'board. Use this INSTEAD of pasting plans into chat; your chat reply should be a 1-2 line ' +
    'summary pointing to the doc by title.',
  inputShape: {
    title: z.string().min(1).max(120).describe('Short document title, stable across revisions'),
    folder: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Folder path in the workspace artifacts tree, e.g. "plans", "marketing/launch", ' +
          '"engineering/design-docs". Defaults to "plans". Reuse existing folders when sensible.'
      ),
    content: z
      .string()
      .min(1)
      .max(50_000)
      .describe('The full plan as a markdown document — this is the reference doc'),
    tasks: z
      .array(
        z.object({
          content: z.string().min(1).max(500).describe('One concrete, actionable task'),
          priority: z.enum(['high', 'medium', 'low']).describe('Execution priority')
        })
      )
      .min(1)
      .max(30)
      .describe('The actionable tasks this plan breaks down into, in execution order')
  },
  execute: async ({ title, folder, content, tasks }, ctx) => {
    if (!ctx.threadRootId) {
      return 'Tool error: propose_plan requires a conversation context.'
    }
    const artifact = await proposePlan(ctx.app, {
      conversationRootId: ctx.threadRootId,
      channelId: ctx.channelId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      title,
      folder,
      content,
      tasks
    })
    return (
      `Plan "${artifact.title}" saved as document v${artifact.version} with ` +
      `${tasks.length} tasks — it is now awaiting human approval on the conversation card. ` +
      `Do NOT start executing the plan's tasks yet, and do NOT paste the plan into chat. ` +
      `Reply with a 1-2 sentence summary that refers the team to the doc "${artifact.title}".`
    )
  }
})
