import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { docText, findDocByTitle, listComments } from '../services/artifacts'

registerOpenCrewTool({
  name: 'read_doc',
  description:
    'Read a doc by exact title. Committed docs are files in the repo\'s .opencrew/ folder — ' +
    'the record, the source of truth — so read the relevant doc BEFORE deciding or answering ' +
    'on its topic. Returns the full markdown plus any review comments.',
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
    const where = artifact.path ? `, file: ${artifact.path}${artifact.sha ? `@${artifact.sha}` : ''}` : ''
    return (
      `# ${artifact.title} (v${artifact.version}, ${artifact.status}${where})\n\n` +
      (await docText(ctx.app.db, artifact)) +
      commentBlock
    )
  }
})
