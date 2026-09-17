import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { listTemplates } from '../services/templates'
import { spawnWorkers, MAX_ATTEMPTS } from '../services/workers'
import { recordStep } from '../runs/audit'

registerOpenCrewTool({
  name: 'spawn_worker',
  description:
    'Spawn an ephemeral worker from a role template to do ONE task in its own environment ' +
    '(a private checkout of the project repo with its own port). The worker is @mentioned ' +
    'in this thread with the task and reports back here; it retires when the task is done. ' +
    'Pass count 2–3 for a risky code change: each attempt runs in parallel in its own ' +
    'environment, CodeReviewer judges the proposals, and the human sees the winner. ' +
    'Templates: frontend, backend, fullstack, qa, researcher, writer, devops (list_templates ' +
    'is not needed — these are the names).',
  inputShape: {
    template: z.string().min(1).max(40).describe('Template slug, e.g. "frontend"'),
    task: z
      .string()
      .min(10)
      .max(4000)
      .describe('The complete task: goal, constraints, definition of done. The worker has no other context.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_ATTEMPTS)
      .optional()
      .describe('Parallel attempts at the same task (default 1). A judge picks the best.')
  },
  execute: async (input, ctx) => {
    if (!ctx.threadRootId) return 'Tool error: spawn_worker requires a conversation context.'
    const templates = await listTemplates(ctx.app.db)
    const template = templates.find((t) => t.slug === input.template.toLowerCase().trim())
    if (!template) {
      return `Tool error: unknown template "${input.template}". Available: ${templates.map((t) => t.slug).join(', ')}.`
    }
    const result = await spawnWorkers(ctx.app, {
      template,
      task: input.task,
      count: input.count ?? 1,
      channelId: ctx.channelId,
      conversationRootId: ctx.threadRootId,
      spawnedByAgentId: ctx.agentId,
      runId: ctx.runId,
      depth: ctx.depth
    })
    if ('error' in result) return `Tool error: ${result.error}`
    await recordStep(ctx.app, ctx.runId, 'post_message', {
      via: 'spawn_worker',
      template: template.slug,
      workers: result.names,
      attemptGroupId: result.attemptGroupId
    })
    return result.names.length === 1
      ? `Spawned ${template.avatarEmoji} @${result.names[0]} in its own environment — it is working on the task now and will report in this thread.`
      : `Spawned ${result.names.length} parallel attempts (${result.names.map((n) => `@${n}`).join(', ')}), each in its own environment. CodeReviewer will judge their proposals; the human sees the winner.`
  }
})
