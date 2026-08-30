import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { updateCommittedDoc } from '../services/artifacts'

registerOpenCrewTool({
  name: 'update_doc',
  description:
    'Update a COMMITTED doc in this conversation with the latest state of the work: tick off ' +
    'completed items, record outcomes/results, add links. Pass the FULL revised markdown ' +
    '(it replaces the previous version). Docs still awaiting approval cannot be updated — ' +
    'revise those with propose_plan instead.',
  inputShape: {
    title: z.string().min(1).max(120).describe('Exact title of the existing doc'),
    content: z
      .string()
      .min(1)
      .max(50_000)
      .describe('The full revised markdown document, reflecting current progress')
  },
  execute: async ({ title, content }, ctx) => {
    if (!ctx.threadRootId) {
      return 'Tool error: update_doc requires a conversation context.'
    }
    const result = await updateCommittedDoc(ctx.app, {
      conversationRootId: ctx.threadRootId,
      title,
      content,
      agentId: ctx.agentId,
      runId: ctx.runId
    })
    if ('error' in result) return `Tool error: ${result.error}`
    return `Doc "${title}" updated to v${result.artifact.version}. No need to repeat its content in chat.`
  }
})
