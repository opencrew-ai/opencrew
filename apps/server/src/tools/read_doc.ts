import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { findDocByTitle, listComments } from '../services/artifacts'

registerOpenCrewTool({
  name: 'read_doc',
  description:
    'Read a workspace doc by exact title. Committed docs are the workspace source of truth — ' +
    'read the relevant doc BEFORE deciding or answering on its topic. Returns the full ' +
    'markdown plus any review comments.',
  inputShape: {
    title: z.string().min(1).max(120).describe('Exact title of the doc to read')
  },
  execute: async ({ title }, ctx) => {
    const artifact = await findDocByTitle(ctx.app.db, title, ctx.threadRootId)
    if (!artifact) {
      return `Tool error: no doc titled "${title}" found. Check the docs list in your context for exact titles.`
    }
    const comments = await listComments(ctx.app.db, artifact.id)
    const commentBlock =
      comments.length > 0
        ? `\n\nReview comments:\n${comments
            .map(
              (c) =>
                `- ${c.authorName ?? 'a human'}${c.quote ? ` [on: "${c.quote.slice(0, 100)}"]` : ''}: ${c.body}`
            )
            .join('\n')}`
        : ''
    return (
      `# ${artifact.title} (v${artifact.version}, ${artifact.status}, folder: ${artifact.folder})\n\n` +
      artifact.content +
      commentBlock
    )
  }
})
