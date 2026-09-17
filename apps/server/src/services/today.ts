import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { ProjectToday } from '@opencrew/shared'
import type { AppContext } from '../context'
import { artifacts, channels, runs } from '../db/schema'
import { listAttention } from './attention'
import { projectSpendToday, startOfToday } from './budgets'
import { getRawSetting } from './settings'
import { HQ_CHANNEL_NAME, CHIEF_OF_STAFF_SETTING, listProjects } from './projects'
import { activeWorkerCount, channelIdsOfProject } from './workers'
import { postSystemMessage } from './messages'
import { getAgent } from './agents'

/**
 * Today — one project's day at a glance: what shipped, what's in flight,
 * what waits on the human, what it cost. HQ's Today is every project on
 * one screen, and the same numbers become the morning brief.
 */

export async function projectToday(ctx: AppContext, projectId: string | null): Promise<ProjectToday> {
  const since = startOfToday()
  const roomIds = await channelIdsOfProject(ctx, projectId)
  const shippedRows =
    roomIds.length === 0
      ? []
      : await ctx.db
          .select({ kind: artifacts.kind })
          .from(artifacts)
          .where(
            and(
              inArray(artifacts.channelId, roomIds),
              eq(artifacts.status, 'committed'),
              gt(artifacts.updatedAt, since)
            )
          )
  const scope = projectId ? eq(runs.projectId, projectId) : isNull(runs.projectId)
  const liveRuns = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(scope, inArray(runs.status, ['queued', 'running', 'awaiting_approval'])))
  const attention = await listAttention(ctx.db)
  const roomSet = new Set(roomIds)
  const project = projectId ? (await listProjects(ctx.db)).find((p) => p.id === projectId) : null
  return {
    projectId,
    shipped: {
      changes: shippedRows.filter((r) => r.kind === 'change').length,
      docs: shippedRows.filter((r) => r.kind !== 'change').length
    },
    inFlight: { runs: liveRuns.length, workers: await activeWorkerCount(ctx, projectId) },
    needsYou: attention.filter((a) => roomSet.has(a.channelId)).length,
    spendUsd: await projectSpendToday(ctx.db, projectId),
    budgetUsd: project?.dailyBudgetUsd ?? 0
  }
}

export async function workspaceToday(ctx: AppContext): Promise<ProjectToday[]> {
  const projects = await listProjects(ctx.db)
  const perProject = await Promise.all(projects.map((p) => projectToday(ctx, p.id)))
  return [await projectToday(ctx, null), ...perProject]
}

/** The morning brief: yesterday-and-today numbers, posted once a day in #hq. */
export async function postMorningBrief(ctx: AppContext): Promise<void> {
  const [hq] = await ctx.db
    .select()
    .from(channels)
    .where(and(isNull(channels.projectId), eq(channels.name, HQ_CHANNEL_NAME)))
    .limit(1)
  if (!hq) return
  const projects = await listProjects(ctx.db)
  if (projects.length === 0) return
  const lines: string[] = []
  for (const p of projects) {
    const t = await projectToday(ctx, p.id)
    const parts = [
      `${t.shipped.changes} change${t.shipped.changes === 1 ? '' : 's'} shipped`,
      `${t.shipped.docs} doc${t.shipped.docs === 1 ? '' : 's'} committed`,
      `${t.inFlight.runs} turn${t.inFlight.runs === 1 ? '' : 's'} in flight`,
      t.needsYou > 0 ? `**${t.needsYou} need${t.needsYou === 1 ? 's' : ''} you**` : 'nothing waiting on you',
      `$${t.spendUsd.toFixed(2)}${t.budgetUsd > 0 ? ` of $${t.budgetUsd.toFixed(0)}` : ''} today`
    ]
    lines.push(`• **${p.name}** — ${parts.join(', ')}`)
  }
  const chiefId = await getRawSetting(ctx.db, CHIEF_OF_STAFF_SETTING)
  const chief = chiefId ? await getAgent(ctx.db, chiefId) : null
  await postSystemMessage(
    ctx,
    hq.id,
    `${chief ? `${chief.avatarEmoji} ` : ''}**Morning brief**\n${lines.join('\n')}\n_Open Today for the full picture; Needs You has everything waiting on a decision._`
  )
}
