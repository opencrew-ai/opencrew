import type { Message } from '@opencrew/shared'
import type { AppContext } from '../context'
import { createMessage, type CreateMessageInput } from './messages'
import { enqueueMentionRuns } from '../runs/enqueue'

/**
 * High-level post: create the message, then trigger runs for any @agent
 * mentions. `depth` is 0 for human posts; agent posts pass their run depth + 1.
 */
export async function postMessage(
  ctx: AppContext,
  input: CreateMessageInput,
  depth = 0
): Promise<Message> {
  const message = await createMessage(ctx, input)
  await enqueueMentionRuns(ctx, message, depth)
  return message
}
