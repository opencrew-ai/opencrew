import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { applyReviewVerdict, reviewKindsForAgent } from '../services/artifacts'

registerOpenCrewTool({
  name: 'review_doc',
  description:
    'DOC REVIEWER ONLY: deliver your verdict on a doc that is in review. "clear" sends it to ' +
    'the human for approval; "revise" discards it — then your chat reply MUST @mention the ' +
    "author with specific revision guidance (including which EXISTING doc to update instead, " +
    'if this one is redundant).',
  inputShape: {
    title: z.string().min(1).max(120).describe('Exact title of the doc in review'),
    verdict: z
      .enum(['clear', 'revise'])
      .describe('clear = forward to human approval; revise = send back to the author')
  },
  execute: async ({ title, verdict }, ctx) => {
    const kinds = await reviewKindsForAgent(ctx.app.db, ctx.agentId)
    if (kinds.length === 0) {
      return 'Tool error: only a workspace reviewer can deliver review verdicts.'
    }
    if (!ctx.threadRootId) {
      return 'Tool error: review_doc requires a conversation context.'
    }
    const artifact = await applyReviewVerdict(ctx.app, {
      conversationRootId: ctx.threadRootId,
      title,
      verdict,
      kinds
    })
    if (!artifact) {
      return `Tool error: no doc titled "${title}" is currently in review in this conversation.`
    }
    return verdict === 'clear'
      ? `"${title}" cleared — it is now awaiting human approval. Keep your reply to one short sentence.`
      : `"${title}" sent back. Now @mention its author in your reply with concrete revision guidance.`
  }
})
