import { z } from 'zod'
import { ilike, isNull, or, desc } from 'drizzle-orm'
import { registerOpenCrewTool } from './registry'
import { messages, channels } from '../db/schema'
import { enrichMessage } from '../services/messages'

registerOpenCrewTool({
  name: 'search_threads',
  description:
    'Search past conversations across all channels by keyword. Returns thread summaries ' +
    '(channel, date, trigger message, reply count, snippet). Use this when a user asks about ' +
    'a previous decision, discussion, or topic — find the thread, then use cite_thread to ' +
    'surface it inline.',
  inputShape: {
    query: z.string().min(2).max(200).describe('Keyword or phrase to search for'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe('Max results to return (default 5)')
  },
  execute: async ({ query, limit }, ctx) => {
    const db = ctx.app.db
    const pattern = `%${query}%`

    // Search top-level messages (thread roots) whose content matches.
    const rows = await db
      .select()
      .from(messages)
      .where(
        // threadRootId IS NULL means it's a root message; ilike matches content
        isNull(messages.threadRootId)
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit * 10)

    // Filter by actual content match (drizzle doesn't compose isNull + ilike cleanly here)
    const matched = rows
      .filter((m) => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit)

    if (matched.length === 0) {
      return `No threads found matching "${query}".`
    }

    const channelRows = await db.select().from(channels)
    const channelMap = new Map(channelRows.map((c) => [c.id, c.name]))

    const results = await Promise.all(
      matched.map(async (root) => {
        const enriched = await enrichMessage(db, root)
        const replies = await db
          .select({ id: messages.id })
          .from(messages)
          .where(ilike(messages.threadRootId, root.id))

        return {
          threadRootId: root.id,
          channelId: root.channelId,
          channel: `#${channelMap.get(root.channelId) ?? root.channelId}`,
          date: new Date(root.createdAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
          }),
          author: enriched.authorName ?? 'Unknown',
          snippet: root.content.slice(0, 300),
          replyCount: replies.length
        }
      })
    )

    const lines = results.map(
      (r, i) =>
        `${i + 1}. [${r.channel} · ${r.date} · ${r.replyCount} replies]\n` +
        `   threadRootId: ${r.threadRootId}  channelId: ${r.channelId}\n` +
        `   ${r.author}: ${r.snippet.replace(/\n/g, ' ')}`
    )

    return (
      `Found ${results.length} thread(s) matching "${query}":\n\n${lines.join('\n\n')}\n\n` +
      `To surface a thread inline, call cite_thread with the threadRootId and channelId.`
    )
  }
})
