import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { channels, messages } from '../db/schema'
import { env } from '../env'
import { addComment, buildDocsPromptSection, commitPlan, discardPlan, proposePlan } from '../services/artifacts'
import { captureStagedDiff } from '../services/changes'
import { createMessage } from '../services/messages'
import { createProject } from '../services/projects'
import { DECISIONS_FILE, RECORD_DIR, ensureRepo } from '../services/record'
import { listOpenCrewTools } from '../tools'
import { makeTestCtx, seedAgent, seedUser, type TestCtx } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A project, its #general, and a proposing agent — the shape every record test needs. */
async function projectWithAsk(ctx: TestCtx, userId: string, workingDir?: string) {
  const project = await createProject(ctx, { name: 'Shop', workingDir, createdBy: userId })
  const [general] = await ctx.db
    .select()
    .from(channels)
    .where(eq(channels.projectId, project.id))
    .then((rows) => rows.filter((c) => c.name === 'general'))
  const root = await createMessage(ctx, {
    channelId: general!.id,
    authorType: 'human',
    authorId: userId,
    content: 'plan the launch'
  })
  const { agentId } = await seedAgent(ctx.db, userId, { name: 'Writer', tools: [] })
  return { project, general: general!, root, agentId }
}

describe('every project has a repo', () => {
  it('a project started without a folder gets a repo with the record committed', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const project = await createProject(ctx, { name: 'Notes only', createdBy: userId })
    expect(project.workingDir.startsWith(env.reposDir)).toBe(true)
    expect(existsSync(join(project.workingDir, RECORD_DIR, 'README.md'))).toBe(true)
    expect(git(project.workingDir, 'log', '--oneline')).toContain('Start the record')
    expect(git(project.workingDir, 'status', '--porcelain')).toBe('')
  })

  it('a folder that is not a repo yet gets git init, committing only .opencrew/', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const dir = mkdtempSync(join(tmpdir(), 'oc-plain-'))
    scratch.push(dir)
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
    const project = await createProject(ctx, { name: 'Existing', workingDir: dir, createdBy: userId })
    expect(project.workingDir).toBe(dir)
    expect(git(dir, 'ls-files')).toBe(`${RECORD_DIR}/README.md`)
    // The Captain says so, in the room, so the human knows what happened.
    const [welcome] = await ctx.db.select().from(messages).where(eq(messages.authorType, 'agent'))
    expect(welcome?.content).toContain('git init')
  })

  it('a folder inside another repo is refused, unless that repo is the home directory', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'oc-outer-'))
    git(outer, 'init', '-q', '-b', 'main')
    const inner = join(outer, 'app')
    mkdirSync(inner)
    await expect(ensureRepo(inner)).rejects.toThrow(/inside the repo at/)

    // A stray `git init` in ~ must not swallow every project under it.
    const savedHome = process.env.HOME
    process.env.HOME = outer
    try {
      const repo = await ensureRepo(inner)
      expect(repo.initialized).toBe(true)
      expect(git(inner, 'rev-parse', '--show-toplevel')).toBe(realpathSync(inner))
    } finally {
      process.env.HOME = savedHome
    }
  })

  it('a repo stays a repo: ensureRepo is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-idem-'))
    scratch.push(dir)
    const first = await ensureRepo(dir)
    const second = await ensureRepo(dir)
    expect(first.initialized).toBe(true)
    expect(second.initialized).toBe(false)
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('1')
  })
})

describe('approval is a commit', () => {
  it('approving a doc commits its file and the decision line together, with the review as a git note', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { project, general, root, agentId } = await projectWithAsk(ctx, userId)
    const proposed = await proposePlan(ctx, {
      conversationRootId: root.id,
      channelId: general.id,
      runId: 'r1',
      agentId,
      title: 'Launch checklist',
      folder: 'plans',
      content: 'Ship on Friday.\n\n- [ ] freeze\n- [ ] announce',
      tasks: []
    })
    expect(proposed.status).toBe('proposed')
    await addComment(ctx, { artifactId: proposed.id, body: 'Friday is fine, no beta.', userId })

    const committed = await commitPlan(ctx, proposed.id, userId)
    expect(committed?.status).toBe('committed')
    expect(committed?.path).toBe(`${RECORD_DIR}/plans/launch-checklist.md`)
    expect(committed?.sha).toMatch(/^[0-9a-f]{7}$/)

    const dir = project.workingDir
    const file = readFileSync(join(dir, committed!.path!), 'utf8')
    expect(file.startsWith('# Launch checklist\n\nShip on Friday.')).toBe(true)
    expect(readFileSync(join(dir, DECISIONS_FILE), 'utf8')).toContain('Approved "Launch checklist" v1 · Tester')
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('docs: Launch checklist (v1)')
    const touched = git(dir, 'show', '--stat', '--format=', 'HEAD')
    expect(touched).toContain('plans/launch-checklist.md')
    expect(touched).toContain('decisions.md')
    expect(git(dir, 'notes', '--ref', 'opencrew', 'show', 'HEAD')).toContain('Friday is fine, no beta.')
    expect(git(dir, 'status', '--porcelain')).toBe('')
    // Exactly once: a second approve does nothing (the row is committed).
    expect(await commitPlan(ctx, proposed.id, userId)).toBeNull()
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('2')
  })

  it('rejecting records the decision and leaves no doc file behind', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { project, general, root, agentId } = await projectWithAsk(ctx, userId)
    const proposed = await proposePlan(ctx, {
      conversationRootId: root.id,
      channelId: general.id,
      runId: 'r1',
      agentId,
      title: 'Rewrite everything',
      content: 'Big bang.',
      tasks: []
    })
    const discarded = await discardPlan(ctx, proposed.id, userId)
    expect(discarded?.status).toBe('discarded')
    const dir = project.workingDir
    expect(readFileSync(join(dir, DECISIONS_FILE), 'utf8')).toContain('Rejected "Rewrite everything" v1')
    expect(existsSync(join(dir, RECORD_DIR, 'plans', 'rewrite-everything.md'))).toBe(false)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('record: rejected "Rewrite everything"')
  })

  it('approving a change commits the patch and the decision line in one commit', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { project, general, root, agentId } = await projectWithAsk(ctx, userId)
    const dir = project.workingDir
    writeFileSync(join(dir, 'index.js'), 'export const x = 1\n')
    const captured = await captureStagedDiff(dir)
    if ('error' in captured) throw new Error(captured.error)
    const proposed = await proposePlan(ctx, {
      conversationRootId: root.id,
      channelId: general.id,
      runId: 'r1',
      agentId,
      title: 'feat: add index',
      content: 'adds index.js',
      tasks: [],
      kind: 'change',
      sourceDir: dir,
      patch: captured.patch
    })
    const committed = await commitPlan(ctx, proposed.id, userId)
    expect(committed?.status).toBe('committed')
    expect(committed?.sha).toBeTruthy()
    const touched = git(dir, 'show', '--stat', '--format=', 'HEAD')
    expect(touched).toContain('index.js')
    expect(touched).toContain('decisions.md')
    expect(readFileSync(join(dir, DECISIONS_FILE), 'utf8')).toContain('Approved & committed "feat: add index"')
    expect(git(dir, 'log', '-1', '--format=%B')).toContain('Approved-by: Tester')
  })
})

describe('the record is what agents read', () => {
  it('read_doc returns the committed file, and the prompt lists the record', async () => {
    const ctx = await makeTestCtx()
    const userId = await seedUser(ctx.db)
    const { project, general, root, agentId } = await projectWithAsk(ctx, userId)
    const proposed = await proposePlan(ctx, {
      conversationRootId: root.id,
      channelId: general.id,
      runId: 'r1',
      agentId,
      title: 'Pricing',
      folder: 'notes',
      content: '$19 a month.',
      tasks: []
    })
    const committed = await commitPlan(ctx, proposed.id, userId)
    // A person edits the file in the repo directly — the file wins.
    writeFileSync(join(project.workingDir, committed!.path!), '# Pricing\n\n$19 a month, $49 with hosting.\n')
    const readDoc = listOpenCrewTools().find((t) => t.name === 'read_doc')!
    const text = await readDoc.execute(
      { title: 'Pricing' },
      { app: ctx, runId: 'r2', agentId, version: { tools: [], capabilities: {} } as never, channelId: general.id, threadRootId: root.id, depth: 0 }
    )
    expect(text).toContain('$49 with hosting')
    expect(text).toContain(`${RECORD_DIR}/notes/pricing.md@`)

    const section = await buildDocsPromptSection(ctx.db, 'another-conversation', project.workingDir)
    expect(section).toContain('THE RECORD')
    expect(section).toContain(`${RECORD_DIR}/notes/pricing.md`)
    expect(section).toContain('Approved "Pricing" v1')
  })
})
