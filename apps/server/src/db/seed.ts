import { nanoid } from 'nanoid'
import type { DB } from './index'
import { agents, channels, memberships, users } from './schema'
import { hashPassword } from '../auth/passwords'
import { createVersion } from '../services/agents'
import {
  CODE_REVIEWER_SEED,
  CODE_REVIEWER_SETTING,
  DOC_REVIEWER_SEED,
  DOC_REVIEWER_SETTING
} from '../services/artifacts'
import { setRawSetting } from '../services/settings'

export const SEED_ADMIN_EMAIL = 'admin@opencrew.local'
export const SEED_ADMIN_PASSWORD = 'opencrew'

/** Boot the workspace into something alive: admin, channels, two demo agents. */
export async function seedIfEmpty(db: DB): Promise<boolean> {
  const hasUsers = (await db.select().from(users)).length > 0
  if (hasUsers) return false

  const now = Date.now()
  const adminId = nanoid()
  await db.insert(users)
    .values({
      id: adminId,
      name: 'Admin',
      email: SEED_ADMIN_EMAIL,
      passwordHash: hashPassword(SEED_ADMIN_PASSWORD),
      role: 'admin',
      createdAt: now
    })

  const generalId = nanoid()
  const buildsId = nanoid()
  await db.insert(channels)
    .values([
      {
        id: generalId,
        name: 'general',
        topic: 'OpenCrew HQ — humans and agents, one room',
        isPrivate: false,
        createdAt: now
      },
      {
        id: buildsId,
        name: 'builds',
        topic: 'Build output, experiments, and code runs',
        isPrivate: false,
        createdAt: now
      }
    ])

  const scoutId = nanoid()
  await db.insert(agents)
    .values({
      id: scoutId,
      name: 'Scout',
      avatarEmoji: '🔭',
      currentVersionId: 'pending',
      createdBy: adminId,
      status: 'active',
      createdAt: now
    })
  await createVersion(
    db,
    scoutId,
    {
      systemPrompt:
        'You are Scout, the crew researcher. You dig up information from the web, ' +
        'summarize it crisply, and always cite the URLs you fetched. Be concise and concrete.',
      model: 'claude-sonnet-4-6',
      skills: ['research', 'summarization'],
      tools: ['WebFetch', 'WebSearch', 'post_to_channel'],
      capabilities: {
        canPostInChannels: [generalId, buildsId],
        maxRunsPerHour: 1000,
        requiresApprovalFor: []
      }
    },
    adminId,
    'initial version'
  )

  const coderId = nanoid()
  await db.insert(agents)
    .values({
      id: coderId,
      name: 'Coder',
      avatarEmoji: '🛠️',
      currentVersionId: 'pending',
      createdBy: adminId,
      status: 'active',
      createdAt: now
    })
  await createVersion(
    db,
    coderId,
    {
      systemPrompt:
        'You are Coder, the crew engineer. You write real code in your workspace and run it ' +
        'to answer questions with actual computed results. Show your code and its output.',
      model: 'claude-sonnet-4-6',
      skills: ['typescript', 'shell', 'computation'],
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'post_to_channel'],
      capabilities: {
        canPostInChannels: [generalId, buildsId],
        maxRunsPerHour: 1000,
        // Demo of the approval gate: every shell command run pauses for an admin.
        requiresApprovalFor: ['Bash']
      }
    },
    adminId,
    'initial version'
  )

  const captainId = nanoid()
  await db.insert(agents)
    .values({
      id: captainId,
      name: 'Captain',
      avatarEmoji: '🧭',
      currentVersionId: 'pending',
      createdBy: adminId,
      status: 'active',
      createdAt: now
    })
  await createVersion(
    db,
    captainId,
    {
      systemPrompt:
        'You are Captain, the crew orchestrator and head of hiring. You read every ' +
        'message humans post (no @mention needed) and make the right thing happen:\n' +
        '1. Simple conversation or a question you can answer → reply briefly yourself.\n' +
        '2. A task squarely in an existing SPECIALIST\'s lane → delegate: @mention them ' +
        'with a crisp, self-contained instruction. Use list_agents when unsure.\n' +
        '3. A message addressed to the whole crew ("everyone", "folks", "team") or one ' +
        'where multiple voices ARE the point (brainstorms, banter, naming, reviews) → ' +
        'rally the crew: @mention every specialist whose perspective genuinely fits ' +
        '(the fan-out limit caps this), giving each ' +
        'their own angle, and add your own take. One voice answering for the whole ' +
        'crew is a failure mode — the crew should feel alive.\n' +
        '4. A task in a discipline nobody OWNS (mobile UX, docs, SEO, data viz, QA, ' +
        'security, marketing, design, …) → HIRE a specialist with create_agent: strong ' +
        'focused system prompt, minimal tools for the job, then @mention the new hire.\n' +
        'Hiring philosophy: a crew of named specialists beats overworked generalists. ' +
        'If a task type will plausibly recur, staff it. Do not dump every coding task ' +
        'on the same generalist — hire per domain. create_agent pauses for human ' +
        'approval; that is normal, request it confidently.\n' +
        'Rules: never do specialist work yourself; keep replies to 1–3 sentences; ' +
        'delegate to one agent per task unless parallel work or a whole-crew ask ' +
        'clearly calls for more. If an agent is stuck, looping, or working on ' +
        'something obsolete, stop it with stop_agent and redirect.',
      model: 'claude-sonnet-4-6',
      skills: ['orchestration', 'delegation', 'hiring'],
      tools: ['list_agents', 'create_agent', 'update_agent', 'stop_agent', 'post_to_channel'],
      capabilities: {
        canPostInChannels: ['*'],
        maxRunsPerHour: 1000,
        // Hiring or reconfiguring an agent raises an approval card.
        requiresApprovalFor: ['create_agent', 'update_agent'],
        watchesChannels: ['*'],
        workingDir: ''
      }
    },
    adminId,
    'initial version'
  )

  // Built-in doc reviewer — every proposed doc passes Librarian before it
  // reaches a human. Config shared with the boot-time self-heal path.
  const librarianId = nanoid()
  await db.insert(agents).values({
    id: librarianId,
    name: DOC_REVIEWER_SEED.name,
    avatarEmoji: DOC_REVIEWER_SEED.avatarEmoji,
    currentVersionId: 'pending',
    createdBy: adminId,
    status: 'active',
    createdAt: now
  })
  await createVersion(
    db,
    librarianId,
    {
      ...DOC_REVIEWER_SEED.version,
      skills: [...DOC_REVIEWER_SEED.version.skills],
      tools: [...DOC_REVIEWER_SEED.version.tools],
      capabilities: { ...DOC_REVIEWER_SEED.version.capabilities }
    },
    adminId,
    'initial version'
  )
  await setRawSetting(db, DOC_REVIEWER_SETTING, librarianId)

  // Built-in code reviewer — every proposed change (diff) passes CodeReviewer
  // before a human; the human's approval performs the git commit.
  const codeReviewerId = nanoid()
  await db.insert(agents).values({
    id: codeReviewerId,
    name: CODE_REVIEWER_SEED.name,
    avatarEmoji: CODE_REVIEWER_SEED.avatarEmoji,
    currentVersionId: 'pending',
    createdBy: adminId,
    status: 'active',
    createdAt: now
  })
  await createVersion(
    db,
    codeReviewerId,
    {
      ...CODE_REVIEWER_SEED.version,
      skills: [...CODE_REVIEWER_SEED.version.skills],
      tools: [...CODE_REVIEWER_SEED.version.tools],
      capabilities: { ...CODE_REVIEWER_SEED.version.capabilities }
    },
    adminId,
    'initial version'
  )
  await setRawSetting(db, CODE_REVIEWER_SETTING, codeReviewerId)

  const rows = [
    { channelId: generalId, memberType: 'human' as const, memberId: adminId },
    { channelId: buildsId, memberType: 'human' as const, memberId: adminId },
    { channelId: generalId, memberType: 'agent' as const, memberId: scoutId },
    { channelId: buildsId, memberType: 'agent' as const, memberId: scoutId },
    { channelId: generalId, memberType: 'agent' as const, memberId: coderId },
    { channelId: buildsId, memberType: 'agent' as const, memberId: coderId }
  ]
  await db.insert(memberships).values(rows)

  return true
}
