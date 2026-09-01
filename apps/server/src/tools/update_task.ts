import { z } from 'zod'
import { registerOpenCrewTool } from './registry'
import { findTaskByShortId, isTaskBlocked, updateTask } from '../services/tasks'
import { recordStep } from '../runs/audit'

/**
 * Explicit task-status updates — the reliable path from agent work to the
 * shared board. TodoWrite reconciliation only matches items echoed VERBATIM,
 * which long plan-task titles never are; this tool takes the #id printed
 * next to each item in the run prompt instead. Completing a task is what
 * unblocks its dependents (the plan DAG dispatches on it), so marking work
 * done here is part of doing the work, not bookkeeping.
 */
registerOpenCrewTool({
  name: 'update_task',
  description:
    "Update a shared task's status by the #id shown in your task list. Mark a task " +
    'in_progress when you start it and completed when it is DONE (deliverable produced, ' +
    'change proposed, reply posted). Completing a task auto-starts the tasks it was ' +
    'blocking — skipping this stalls the whole plan.',
  inputShape: {
    taskId: z
      .string()
      .min(4)
      .max(30)
      .describe('The task id from your task list, e.g. "#a1b2c3" (leading # optional)'),
    status: z
      .enum(['in_progress', 'completed'])
      .describe('in_progress when starting; completed when the deliverable exists')
  },
  execute: async ({ taskId, status }, ctx) => {
    if (!ctx.threadRootId) {
      return 'Tool error: update_task requires a conversation context.'
    }
    const found = await findTaskByShortId(ctx.app.db, ctx.threadRootId, taskId)
    if (found.kind === 'none') {
      return `Tool error: no task ${taskId} in this conversation — use the #id exactly as shown in your task list.`
    }
    if (found.kind === 'ambiguous') {
      return `Tool error: ${taskId} matches multiple tasks — use more characters of the id.`
    }
    const task = found.task
    if (task.assigneeType === 'human') {
      return `Tool error: "${task.content.slice(0, 60)}" is assigned to a HUMAN — only they can move it. Use request_human if you need them to act.`
    }
    if (task.status === 'completed') {
      return `Task already completed: "${task.content.slice(0, 60)}".`
    }
    if (status === 'in_progress' && (await isTaskBlocked(ctx.app.db, task))) {
      return (
        `Tool error: that task is BLOCKED — earlier tasks it depends on are still open. ` +
        `Work the unblocked items first; it will auto-start when its blockers complete.`
      )
    }

    await updateTask(ctx.app, task.id, { status, sourceAgentId: ctx.agentId })
    await recordStep(ctx.app, ctx.runId, 'tool_call', {
      tool: 'update_task',
      input: { taskId: task.id, status }
    })
    if (status === 'completed') {
      return `✓ Completed "${task.content.slice(0, 80)}" — any tasks it was blocking are now dispatched.`
    }
    return `→ In progress: "${task.content.slice(0, 80)}".`
  }
})
