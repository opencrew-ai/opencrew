import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { createAttentionRequest } from '../services/attention'

registerOpenCrewTool({
  name: 'request_human',
  description:
    'Ask a human for something you cannot do yourself: a review, a decision, credentials, or a ' +
    'manual step (posting to an external site, a payment, an account action). The ask lands in ' +
    "the workspace's Needs-You inbox, deep-linked to this conversation. Use this INSTEAD of " +
    'burying the ask in chat text. Keep the request crisp and self-contained.',
  inputShape: {
    request: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'One clear sentence: what you need the human to do, e.g. ' +
          '"Post the Show HN draft (see doc) — needs your HN account" or ' +
          '"Review the pricing tiers in the doc and pick option A or B"'
      )
  },
  execute: async ({ request }, ctx) => {
    if (!ctx.threadRootId) {
      return 'Tool error: request_human requires a conversation context.'
    }
    await createAttentionRequest(ctx.app, {
      conversationRootId: ctx.threadRootId,
      channelId: ctx.channelId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      request
    })
    return (
      'The human has been notified in their Needs-You inbox and will find this conversation ' +
      'for context. Do not repeat the ask in chat — continue with other work or wrap up your reply.'
    )
  }
})
