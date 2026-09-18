import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../env'
import { createProject } from '../services/projects'
import { ensureRepo } from '../services/record'
import { knownProjectsFile, listResumableProjects, rememberProject } from '../services/resume'
import { makeTestCtx, seedUser, type TestCtx } from './helpers'

describe('projects survive the database', () => {
  let ctx: TestCtx
  let userId: string
  let folder: string

  beforeEach(async () => {
    rmSync(knownProjectsFile(), { force: true })
    ctx = await makeTestCtx()
    userId = await seedUser(ctx.db)
    folder = mkdtempSync(join(tmpdir(), 'oc-resume-'))
  })
  afterEach(async () => {
    rmSync(folder, { recursive: true, force: true })
    rmSync(knownProjectsFile(), { force: true })
  })

  it('creating a project writes it to the index next to the data dir', async () => {
    const project = await createProject(ctx, { name: 'Shop', workingDir: folder, createdBy: userId })
    const index = JSON.parse(readFileSync(knownProjectsFile(), 'utf8')) as { projects: { name: string; workingDir: string }[] }
    expect(index.projects).toEqual([expect.objectContaining({ name: 'Shop', workingDir: project.workingDir })])
  })

  it('a fresh database offers remembered projects back, and stops once they exist again', async () => {
    rememberProject({ name: 'Shop', slug: 'shop', workingDir: folder })
    expect((await listResumableProjects(ctx.db)).map((p) => p.name)).toEqual(['Shop'])

    await createProject(ctx, { name: 'Shop', workingDir: folder, createdBy: userId })
    expect(await listResumableProjects(ctx.db)).toEqual([])
  })

  it('folders that no longer exist are not offered', async () => {
    rememberProject({ name: 'Gone', slug: 'gone', workingDir: join(folder, 'missing') })
    expect(await listResumableProjects(ctx.db)).toEqual([])
  })

  it('repos OpenCrew kept itself count too, even without an index; HQ does not', async () => {
    await ensureRepo(join(env.reposDir, 'notes-only'))
    await ensureRepo(join(env.reposDir, 'hq'))
    const offered = await listResumableProjects(ctx.db)
    expect(offered.map((p) => [p.name, p.workingDir])).toEqual([['Notes Only', join(env.reposDir, 'notes-only')]])
    expect(existsSync(knownProjectsFile())).toBe(false)
  })
})
