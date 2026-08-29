import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { postMessage } from '../services/post'
import { recordStep } from '../runs/audit'

registerOpenCrewTool({
  name: 'post_to_channel',
  description:
    'Post a markdown message to an OpenCrew channel by id. Only channels listed in your capabilities are allowed. ' +
    'Use this for posting results to OTHER channels — your normal reply is posted automatically.',
  inputShape: {
    channelId: z.string().min(1).describe('Target channel id'),
    content: z.string().min(1).max(20_000).describe('Markdown message content')
  },
  execute: async ({ channelId, content }, ctx) => {
    // postMessage → createMessage enforces canPostInChannels for agent
    // authors; a GuardrailViolation surfaces to the session as a tool error.
    const message = await postMessage(
      ctx.app,
      {
        channelId,
        authorType: 'agent',
        authorId: ctx.agentId,
        agentVersionId: ctx.version.id,
        content,
        runId: ctx.runId
      },
      ctx.depth + 1
    )
    recordStep(ctx.app, ctx.runId, 'post_message', {
      messageId: message.id,
      channelId,
      via: 'post_to_channel'
    })
    return `Posted message ${message.id} to channel ${channelId}.`
  }
})
