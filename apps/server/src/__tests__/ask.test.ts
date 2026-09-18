import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { seedIfEmpty } from '../db/seed'
import { channels, fabricTasks, messages, runs } from '../db/schema'
import { awaitRunReply } from '../runs/await'
import { askCaptain, ensureConsultChannel, extractCitations } from '../services/ask'
import { CHIEF_OF_STAFF_SETTING, channelsVisibleTo, createProject } from '../services/projects'
import { getRawSetting } from '../services/settings'
import { makeTestCtx, seedUser } from './helpers'

const asker = (id: string) => ({ id, name: 'Tester' })

describe('ask the workspace', () => {
  it('a consult is a private line: never a room, and it admits exactly one run for the Captain', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await createProject(ctx, { name: 'Shop', createdBy: userId })
    const before = ctx.enqueued.length

    const admitted = await askCaptain(ctx, { projectId: project.id, user: asker(userId), question: 'what shipped?' })
    if ('error' in admitted) throw new Error(admitted.error)
    expect(ctx.enqueued.length).toBe(before + 1)

    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, admitted.runId))
    expect(run?.triggerType).toBe('ask')
    expect(run?.projectId).toBe(project.id)
    const [task] = await ctx.db.select().from(fabricTasks).where(eq(fabricTasks.id, admitted.runId))
    expect(task?.lane).toBe('interactive')

    const [line] = await ctx.db.select().from(channels).where(eq(channels.id, admitted.channelId))
    expect(line?.kind).toBe('consult')
    expect(line?.isPrivate).toBe(true)
    const visible = await channelsVisibleTo(ctx.db, project.id, true)
    expect(visible.some((c) => c.id === admitted.channelId)).toBe(false)
    // Same person, same project: the same line every time.
    const again = await ensureConsultChannel(ctx.db, project.id, asker(userId))
    expect(again.id).toBe(admitted.channelId)
  })

  it('a follow-up with threadId continues the same conversation', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await createProject(ctx, { name: 'Shop', createdBy: userId })
    const first = await askCaptain(ctx, { projectId: project.id, user: asker(userId), question: 'status?' })
    if ('error' in first) throw new Error(first.error)
    const second = await askCaptain(ctx, {
      projectId: project.id,
      user: asker(userId),
      question: 'and why?',
      threadId: first.threadId
    })
    if ('error' in second) throw new Error(second.error)
    expect(second.threadId).toBe(first.threadId)
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.threadRootId, first.threadId))
    expect(msg?.content).toBe('and why?')
  })

  it('HQ questions go to the Chief of Staff', async () => {
    const ctx = await makeTestCtx()
    await seedIfEmpty(ctx.db)
    const userId = await seedUser(ctx.db)
    const admitted = await askCaptain(ctx, { projectId: null, user: asker(userId), question: 'what needs me?' })
    if ('error' in admitted) throw new Error(admitted.error)
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, admitted.runId))
    expect(run?.agentId).toBe(await getRawSetting(ctx.db, CHIEF_OF_STAFF_SETTING))
  })

  it('awaits the answer and keeps only citations that resolve in the repo', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await createProject(ctx, { name: 'Shop', createdBy: userId })
    const admitted = await askCaptain(ctx, { projectId: project.id, user: asker(userId), question: 'why?' })
    if ('error' in admitted) throw new Error(admitted.error)

    const pending = await awaitRunReply(ctx, admitted.runId, 0)
    expect(pending.status).toBe('running')

    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: project.workingDir, encoding: 'utf8' }).trim()
    const answer = `We started the record in ${sha} (see .opencrew/README.md@${sha}); nothing about pricing yet. Not real: deadbeef1.`
    await ctx.db.insert(messages).values({
      id: nanoid(),
      channelId: admitted.channelId,
      threadRootId: admitted.threadId,
      authorType: 'agent',
      authorId: 'captain',
      content: answer,
      runId: admitted.runId,
      createdAt: Date.now()
    })
    await ctx.db.update(runs).set({ status: 'done' }).where(eq(runs.id, admitted.runId))

    const done = await awaitRunReply(ctx, admitted.runId, 1000)
    expect(done.status).toBe('done')
    expect(done.answer).toBe(answer)
    const citations = await extractCitations(project.workingDir, answer)
    expect(citations.map((c) => c.ref).sort()).toEqual([`.opencrew/README.md@${sha}`, sha].sort())
    expect(citations.find((c) => c.kind === 'file')?.path).toBe('.opencrew/README.md')
  })
})
