import { beforeEach, describe, expect, test } from 'vitest'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { channels, tasks, users } from '../db/schema'
import { createTask, dispatchUnblockedTasks, startTask, updateTask } from '../services/tasks'
import { makeTestCtx, type TestCtx } from './helpers'

describe('task DAG', () => {
  let ctx: TestCtx
  let userId: string
  let channelId: string
  const rootId = nanoid()

  beforeEach(async () => {
    ctx = await makeTestCtx()
    userId = nanoid()
    channelId = nanoid()
    await ctx.db.insert(users).values({
      id: userId,
      name: 'Founder',
      email: 'f@test.dev',
      passwordHash: 'x',
      role: 'admin',
      createdAt: Date.now()
    })
    await ctx.db.insert(channels).values({
      id: channelId,
      name: 'general',
      topic: '',
      isPrivate: false,
      createdAt: Date.now()
    })
  })

  const makeTask = (content: string, blockedBy?: string[]) =>
    createTask(ctx, {
      conversationRootId: rootId,
      channelId,
      content,
      priority: 'high',
      createdByType: 'human',
      createdById: userId,
      blockedBy
    })

  test('a blocked task refuses to start', async () => {
    const build = await makeTask('build it')
    const deploy = await makeTask('deploy it', [build.id])
    expect(await startTask(ctx, deploy.id, userId)).toBeNull()
    expect(await startTask(ctx, build.id, userId)).not.toBeNull()
  })

  test('completing the last blocker auto-dispatches the dependent', async () => {
    const build = await makeTask('build it')
    const test_ = await makeTask('test it')
    const deploy = await makeTask('deploy it', [build.id, test_.id])

    await updateTask(ctx, build.id, { status: 'completed' })
    let [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, deploy.id))
    expect(row!.status).toBe('pending') // still one open blocker

    await updateTask(ctx, test_.id, { status: 'completed' })
    ;[row] = await ctx.db.select().from(tasks).where(eq(tasks.id, deploy.id))
    expect(row!.status).toBe('in_progress') // auto-started as its own thread
  })

  test('human-assigned tasks are surfaced, never auto-started', async () => {
    const prep = await makeTask('prep it')
    const sign = await createTask(ctx, {
      conversationRootId: rootId,
      channelId,
      content: 'sign the contract',
      priority: 'high',
      createdByType: 'human',
      createdById: userId,
      assigneeType: 'human',
      blockedBy: [prep.id]
    })
    await updateTask(ctx, prep.id, { status: 'completed' })
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, sign.id))
    expect(row!.status).toBe('pending')
    expect(ctx.broadcasts.some((e) => e.type === 'attention_changed')).toBe(true)
  })

  test('deleting a blocker unblocks dependents too', async () => {
    const flaky = await makeTask('flaky prerequisite')
    const main = await makeTask('main work', [flaky.id])
    await ctx.db.delete(tasks).where(eq(tasks.id, flaky.id))
    await dispatchUnblockedTasks(ctx, flaky.id)
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, main.id))
    expect(row!.status).toBe('in_progress')
  })
})
