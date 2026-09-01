import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { tasks } from '../db/schema'
import { createTask, findTaskByShortId, taskShortId } from '../services/tasks'
import { listOpenCrewTools } from '../tools'
import { makeTestCtx, seedAgent, seedChannel, seedUser, type TestCtx } from './helpers'
import type { ToolRunContext } from '../tools'

const ROOT = 'conv-root-1'

async function setup(): Promise<{ ctx: TestCtx; toolCtx: ToolRunContext }> {
  const ctx = await makeTestCtx()
  const userId = await seedUser(ctx.db)
  const channelId = await seedChannel(ctx.db)
  const { agentId, versionId } = await seedAgent(ctx.db, userId)
  const { getVersion } = await import('../services/agents')
  const version = (await getVersion(ctx.db, versionId))!
  return {
    ctx,
    toolCtx: {
      app: ctx,
      runId: 'run-1',
      agentId,
      version,
      channelId,
      threadRootId: ROOT,
      depth: 0
    }
  }
}

function tool(name: string) {
  return listOpenCrewTools().find((t) => t.name === name)!
}

describe('update_task', () => {
  test('completes a task by short id and dispatches its dependents', async () => {
    const { ctx, toolCtx } = await setup()
    const first = await createTask(ctx, {
      conversationRootId: ROOT,
      channelId: toolCtx.channelId,
      content: 'Build AgentRunDrawer shell with a very long title nobody echoes verbatim',
      priority: 'high',
      createdByType: 'agent',
      createdById: toolCtx.agentId
    })
    await createTask(ctx, {
      conversationRootId: ROOT,
      channelId: toolCtx.channelId,
      content: 'Build ProgressRail',
      priority: 'medium',
      createdByType: 'agent',
      createdById: toolCtx.agentId,
      blockedBy: [first.id]
    })

    const started = await tool('update_task').execute(
      { taskId: taskShortId(first.id), status: 'in_progress' },
      toolCtx
    )
    expect(started).toContain('In progress')

    const completed = await tool('update_task').execute(
      { taskId: taskShortId(first.id), status: 'completed' },
      toolCtx
    )
    expect(completed).toContain('Completed')
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, first.id))
    expect(row!.status).toBe('completed')
    expect(row!.sourceAgentId).toBe(toolCtx.agentId)
  })

  test('refuses human-assigned tasks and blocked starts', async () => {
    const { ctx, toolCtx } = await setup()
    const humanTask = await createTask(ctx, {
      conversationRootId: ROOT,
      channelId: toolCtx.channelId,
      content: 'Human reviews the launch copy',
      priority: 'high',
      createdByType: 'human',
      createdById: 'user-1',
      assigneeType: 'human'
    })
    const blocker = await createTask(ctx, {
      conversationRootId: ROOT,
      channelId: toolCtx.channelId,
      content: 'Blocker task',
      priority: 'high',
      createdByType: 'agent',
      createdById: toolCtx.agentId
    })
    const dependent = await createTask(ctx, {
      conversationRootId: ROOT,
      channelId: toolCtx.channelId,
      content: 'Dependent task',
      priority: 'medium',
      createdByType: 'agent',
      createdById: toolCtx.agentId,
      blockedBy: [blocker.id]
    })

    expect(
      await tool('update_task').execute(
        { taskId: taskShortId(humanTask.id), status: 'completed' },
        toolCtx
      )
    ).toContain('assigned to a HUMAN')
    expect(
      await tool('update_task').execute(
        { taskId: taskShortId(dependent.id), status: 'in_progress' },
        toolCtx
      )
    ).toContain('BLOCKED')
  })

  test('short-id lookup: unknown and ambiguous are errors, never guesses', async () => {
    const { ctx } = await setup()
    expect((await findTaskByShortId(ctx.db, ROOT, '#zzzzzz')).kind).toBe('none')
    // Same-prefix collision → ambiguous.
    const now = Date.now()
    for (const id of ['prefix-aaa', 'prefix-bbb']) {
      await ctx.db.insert(tasks).values({
        id,
        workspaceSlug: 'default',
        conversationRootId: ROOT,
        channelId: 'chan',
        content: id,
        status: 'pending',
        priority: 'low',
        createdByType: 'agent',
        createdById: 'a',
        assigneeType: 'agent',
        position: 1,
        createdAt: now,
        updatedAt: now
      })
    }
    expect((await findTaskByShortId(ctx.db, ROOT, '#prefix')).kind).toBe('ambiguous')
    expect((await findTaskByShortId(ctx.db, ROOT, 'prefix-aaa')).kind).toBe('one')
  })
})
