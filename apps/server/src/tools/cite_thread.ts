import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { createMessage } from '../services/messages'
import { recordStep } from '../runs/audit'

registerOpenCrewTool({
  name: 'cite_thread',
  description:
    'Surface a past thread as an inline reference card in the current channel. ' +
    'The card shows the original conversation expandable in-place — the user can read it ' +
    'without leaving the current context. Use after search_threads to pin the relevant ' +
    'result. Optionally add a brief comment explaining why this thread is relevant.',
  inputShape: {
    threadRootId: z.string().min(1).describe('ID of the thread root message to cite'),
    channelId: z.string().min(1).describe('Channel that contains the cited thread'),
    comment: z
      .string()
      .max(500)
      .optional()
      .describe('Short note explaining why this thread is relevant (shown above the card)')
  },
  execute: async ({ threadRootId, channelId, comment }, ctx) => {
    const content = comment?.trim()
      ? comment.trim()
      : `📎 Relevant thread from #${channelId}:`

    const message = await createMessage(ctx.app, {
      channelId: ctx.channelId,
      threadRootId: ctx.threadRootId,
      authorType: 'agent',
      authorId: ctx.agentId,
      agentVersionId: ctx.version.id,
      content,
      runId: ctx.runId,
      refThreadId: threadRootId,
      refChannelId: channelId
    })

    recordStep(ctx.app, ctx.runId, 'post_message', {
      messageId: message.id,
      via: 'cite_thread',
      refThreadId: threadRootId,
      refChannelId: channelId
    })

    return `Cited thread ${threadRootId} — reference card posted as message ${message.id}.`
  }
})
