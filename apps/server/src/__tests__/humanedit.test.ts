import { beforeEach, describe, expect, test } from 'vitest'
import { nanoid } from 'nanoid'
import { artifacts } from '../db/schema'
import { humanEditDoc } from '../services/artifacts'
import { makeTestCtx, type TestCtx } from './helpers'

describe('human in-place doc edit', () => {
  let ctx: TestCtx
  let artifactId: string
  const rootId = nanoid()

  beforeEach(async () => {
    ctx = await makeTestCtx()
    artifactId = nanoid()
    await ctx.db.insert(artifacts).values({
      id: artifactId,
      conversationRootId: rootId,
      channelId: nanoid(),
      runId: nanoid(),
      kind: 'plan',
      folder: 'plans',
      title: 'UX Vision',
      content: '# Vision\nOld sentence here.',
      tasks: JSON.stringify([{ content: 'ship it', priority: 'high' }]),
      status: 'proposed',
      version: 1,
      createdByAgentId: nanoid(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  })

  test('creates the next version in place, preserving status and tasks', async () => {
    const edited = await humanEditDoc(ctx, artifactId, '# Vision\nNew sentence here.')
    expect(edited).not.toBeNull()
    expect(edited!.version).toBe(2)
    expect(edited!.status).toBe('proposed')
    expect(edited!.content).toContain('New sentence')
    expect(edited!.tasks).toHaveLength(1)
    expect(edited!.id).not.toBe(artifactId)
    // Live clients hear about it.
    expect(
      ctx.broadcasts.some(
        (e) => e.type === 'artifact_state' && e.artifact.version === 2
      )
    ).toBe(true)
  })

  test('editing twice keeps incrementing from the latest version', async () => {
    const v2 = await humanEditDoc(ctx, artifactId, 'v2 content')
    const v3 = await humanEditDoc(ctx, v2!.id, 'v3 content')
    expect(v3!.version).toBe(3)
  })

  test('refuses to edit a missing or discarded doc', async () => {
    expect(await humanEditDoc(ctx, 'nope', 'x')).toBeNull()
  })
})
