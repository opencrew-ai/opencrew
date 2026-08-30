import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { proposePlan } from '../services/artifacts'
import { captureStagedDiff } from '../services/changes'
import { env } from '../env'

/** Same resolution as the executor: configured absolute dir, else workspace. */
function workingDirFor(agentId: string, configured: string | undefined): string {
  const dir = configured?.trim()
  if (dir && dir.startsWith('/') && existsSync(dir)) return dir
  return join(env.workspacesDir, agentId)
}

registerOpenCrewTool({
  name: 'propose_change',
  description:
    'Propose your code changes for review and commit. Captures the full diff of your working ' +
    'directory as a CHANGE artifact: CodeReviewer reviews it, then a human approves — and the ' +
    'approval performs the git commit. NEVER run git commit yourself; this is the only path ' +
    'to committing. Call it when a focused, coherent change is ready.',
  inputShape: {
    title: z
      .string()
      .min(1)
      .max(120)
      .describe('Commit-message style title, e.g. "fix: dedupe reply counts on reconnect"'),
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe('What changed and why — what the reviewer should pay attention to')
  },
  execute: async ({ title, summary }, ctx) => {
    if (!ctx.threadRootId) {
      return 'Tool error: propose_change requires a conversation context.'
    }
    const dir = workingDirFor(ctx.agentId, ctx.version.capabilities.workingDir)
    const captured = await captureStagedDiff(dir)
    if ('error' in captured) return `Tool error: ${captured.error}`

    const content =
      `${summary}\n\n**Files:**\n\`\`\`\n${captured.stat}\n\`\`\`\n\n` +
      `\`\`\`diff\n${captured.diff}\n\`\`\``
    const artifact = await proposePlan(ctx.app, {
      conversationRootId: ctx.threadRootId,
      channelId: ctx.channelId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      title,
      content,
      tasks: [],
      kind: 'change',
      folder: 'changes',
      sourceDir: dir
    })
    return (
      `Change "${artifact.title}" captured as v${artifact.version} — CodeReviewer will look ` +
      `first, then a human approves (the approval performs the commit). Do NOT commit or ` +
      `re-edit these files until the verdict; reply with a 1-2 sentence summary pointing to ` +
      `the change by title.`
    )
  }
})
