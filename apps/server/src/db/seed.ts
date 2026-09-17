import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { nanoid } from 'nanoid'
import type { DB } from './index'
import { channels, messages, users } from './schema'
import { hashPassword } from '../auth/passwords'
import {
  CODE_REVIEWER_SEED,
  CODE_REVIEWER_SETTING,
  DOC_REVIEWER_SEED,
  DOC_REVIEWER_SETTING
} from '../services/artifacts'
import {
  CHIEF_OF_STAFF_SEED,
  CHIEF_OF_STAFF_SETTING,
  HQ_CHANNEL_NAME,
  insertSeededAgent
} from '../services/projects'
import { seedTemplates } from '../services/templates'
import { setRawSetting } from '../services/settings'

export const SEED_ADMIN_EMAIL = 'admin@opencrew.local'
export const SEED_ADMIN_PASSWORD = 'opencrew'

/**
 * The local admin is the person at the keyboard — name them, don't call
 * them "Admin". Git identity first (what their commits say), then the OS
 * account.
 */
export function localOwnerName(): string {
  const git = spawnSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' })
  const fromGit = git.status === 0 ? git.stdout.trim() : ''
  if (fromGit) return fromGit.slice(0, 80)
  const fromOs = userInfo().username.trim()
  return fromOs ? fromOs.slice(0, 80) : 'Admin'
}

/**
 * Boot the workspace into its first-run shape:
 *  - the admin (you);
 *  - HQ: #hq, the Chief of Staff, and the two built-in reviewers (shared
 *    services that work across projects);
 *  - the role templates workers are spawned from.
 * No project is seeded: the first screen asks what you're building, and
 * creating that project seeds its rooms and its Captain (services/projects.ts).
 */
export async function seedIfEmpty(db: DB): Promise<boolean> {
  const hasUsers = (await db.select().from(users)).length > 0
  if (hasUsers) return false

  const now = Date.now()
  const adminId = nanoid()
  await db.insert(users).values({
    id: adminId,
    name: localOwnerName(),
    email: SEED_ADMIN_EMAIL,
    passwordHash: hashPassword(SEED_ADMIN_PASSWORD),
    role: 'admin',
    createdAt: now
  })

  const hqId = nanoid()
  await db.insert(channels).values({
    id: hqId,
    projectId: null,
    name: HQ_CHANNEL_NAME,
    topic: 'Every project, one room — ask here and the Chief of Staff routes it',
    isPrivate: false,
    createdAt: now
  })
  const chiefId = await insertSeededAgent(db, null, CHIEF_OF_STAFF_SEED, adminId)
  await setRawSetting(db, CHIEF_OF_STAFF_SETTING, chiefId)
  const librarianId = await insertSeededAgent(db, null, DOC_REVIEWER_SEED, adminId)
  await setRawSetting(db, DOC_REVIEWER_SETTING, librarianId)
  const codeReviewerId = await insertSeededAgent(db, null, CODE_REVIEWER_SEED, adminId)
  await setRawSetting(db, CODE_REVIEWER_SETTING, codeReviewerId)

  // A plain row, no run — a seed must never trigger agent turns.
  await db.insert(messages).values({
    id: nanoid(),
    channelId: hqId,
    authorType: 'agent',
    authorId: chiefId,
    content:
      `This is HQ — the one room across every project. Each product you add is a project ` +
      `with its own room and Captain; talk to a product in its #general. Ask here when you ` +
      `don't want to pick one and I'll route it. **Today** in the sidebar shows every project ` +
      `at a glance; I post a short brief here each morning.`,
    createdAt: now + 1
  })

  await seedTemplates(db)
  return true
}
