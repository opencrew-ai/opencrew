import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { proposePlan } from '../services/artifacts'

registerOpenCrewTool({
  name: 'propose_plan',
  description:
    'Propose a durable DOCUMENT artifact for this conversation: a plan (with its task list), ' +
    'or any substantial deliverable — a draft post, spec, report, or writeup. The doc waits ' +
    'for human approval; for plans, committing puts the tasks on the shared board. Use this ' +
    'INSTEAD of pasting long content into chat; your chat reply should be a 1-2 line summary ' +
    'pointing to the doc by title.',
  inputShape: {
    title: z.string().min(1).max(120).describe('Short document title, stable across revisions'),
    folder: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Folder path in the workspace artifacts tree, e.g. "plans", "marketing/launch", ' +
          '"engineering/design-docs". Defaults to "plans". Reuse existing folders when sensible.'
      ),
    content: z
      .string()
      .min(1)
      .max(50_000)
      .describe('The full plan as a markdown document — this is the reference doc'),
    tasks: z
      .array(
        z.object({
          content: z.string().min(1).max(500).describe('One concrete, actionable task'),
          priority: z.enum(['high', 'medium', 'low']).describe('Execution priority'),
          assignee: z
            .enum(['agent', 'human'])
            .optional()
            .describe(
              '"human" for steps only a person can do (their accounts, payments, external ' +
                'sign-offs) — these land in the human\'s Needs-You inbox. Default: agent.'
            ),
          scheduledFor: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              'ISO datetime when this step should happen. Agent steps auto-fire at that ' +
                'time; human steps become due in the inbox then. Omit for "as soon as possible".'
            ),
          dependsOn: z
            .array(z.number().int().min(1))
            .max(20)
            .optional()
            .describe(
              '1-based indexes of EARLIER tasks in this list that must complete first ' +
                '(e.g. task 4 with dependsOn [2,3]). Blocked tasks start automatically ' +
                'the moment their last dependency completes — sequence real pipelines ' +
                '(build → test → deploy) instead of relying on delegation timing. ' +
                'Only earlier indexes are valid; later or self references are ignored.'
            )
        })
      )
      .max(30)
      .optional()
      .describe(
        'For PLANS: the actionable tasks, in execution order. Omit for deliverable docs ' +
          '(drafts, specs, reports) that have no tasks.'
      )
  },
  execute: async ({ title, folder, content, tasks }, ctx) => {
    if (!ctx.threadRootId) {
      return 'Tool error: propose_plan requires a conversation context.'
    }
    const taskDrafts = tasks ?? []
    const artifact = await proposePlan(ctx.app, {
      conversationRootId: ctx.threadRootId,
      channelId: ctx.channelId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      title,
      folder,
      content,
      tasks: taskDrafts
    })
    return (
      `Doc "${artifact.title}" saved as v${artifact.version}` +
      (taskDrafts.length > 0 ? ` with ${taskDrafts.length} tasks` : '') +
      ` — it is now awaiting human approval on the conversation card. ` +
      `Do NOT start executing its tasks yet, and do NOT paste the content into chat. ` +
      `Reply with a 1-2 sentence summary that refers the team to the doc "${artifact.title}".`
    )
  }
})
