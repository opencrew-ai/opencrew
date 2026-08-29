import { nanoid } from 'nanoid'
import type { DB } from './index'
import { agents, channels, memberships, users } from './schema'
import { hashPassword } from '../auth/passwords'
import { createVersion } from '../services/agents'

export const SEED_ADMIN_EMAIL = 'admin@opencrew.local'
export const SEED_ADMIN_PASSWORD = 'opencrew'

/** Boot the workspace into something alive: admin, channels, two demo agents. */
export function seedIfEmpty(db: DB): boolean {
  const hasUsers = db.select().from(users).all().length > 0
  if (hasUsers) return false

  const now = Date.now()
  const adminId = nanoid()
  db.insert(users)
    .values({
      id: adminId,
      name: 'Admin',
      email: SEED_ADMIN_EMAIL,
      passwordHash: hashPassword(SEED_ADMIN_PASSWORD),
      role: 'admin',
      createdAt: now
    })
    .run()

  const generalId = nanoid()
  const buildsId = nanoid()
  db.insert(channels)
    .values([
      {
        id: generalId,
        name: 'general',
        topic: 'OpenCrew HQ — humans and agents, one room',
        isPrivate: 0,
        createdAt: now
      },
      {
        id: buildsId,
        name: 'builds',
        topic: 'Build output, experiments, and code runs',
        isPrivate: 0,
        createdAt: now
      }
    ])
    .run()

  const scoutId = nanoid()
  db.insert(agents)
    .values({
      id: scoutId,
      name: 'Scout',
      avatarEmoji: '🔭',
      currentVersionId: 'pending',
      createdBy: adminId,
      status: 'active',
      createdAt: now
    })
    .run()
  createVersion(
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
        maxRunsPerHour: 30,
        requiresApprovalFor: []
      }
    },
    adminId,
    'initial version'
  )

  const coderId = nanoid()
  db.insert(agents)
    .values({
      id: coderId,
      name: 'Coder',
      avatarEmoji: '🛠️',
      currentVersionId: 'pending',
      createdBy: adminId,
      status: 'active',
      createdAt: now
    })
    .run()
  createVersion(
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
        maxRunsPerHour: 20,
        // Demo of the approval gate: every shell command run pauses for an admin.
        requiresApprovalFor: ['Bash']
      }
    },
    adminId,
    'initial version'
  )

  const captainId = nanoid()
  db.insert(agents)
    .values({
      id: captainId,
      name: 'Captain',
      avatarEmoji: '🧭',
      currentVersionId: 'pending',
      createdBy: adminId,
      status: 'active',
      createdAt: now
    })
    .run()
  createVersion(
    db,
    captainId,
    {
      systemPrompt:
        'You are Captain, the crew orchestrator. You read every message humans post ' +
        '(no @mention needed) and make the right thing happen:\n' +
        '1. Simple conversation or a question you can answer → reply briefly yourself.\n' +
        '2. Work for a specialist → delegate: @mention the right agent with a crisp, ' +
        'self-contained instruction. Use list_agents when unsure of the roster.\n' +
        '3. No agent fits → hire one with create_agent (strong system prompt, minimal ' +
        'tools), then @mention it to start the work.\n' +
        'Rules: never do specialist work yourself; keep replies to 1–3 sentences; ' +
        'delegate to one agent per task unless parallel work clearly helps.',
      model: 'claude-sonnet-4-6',
      skills: ['orchestration', 'delegation', 'hiring'],
      tools: ['list_agents', 'create_agent', 'post_to_channel'],
      capabilities: {
        canPostInChannels: ['*'],
        maxRunsPerHour: 60,
        // Hiring a new agent raises an approval card.
        requiresApprovalFor: ['create_agent'],
        watchesChannels: ['*'],
        workingDir: ''
      }
    },
    adminId,
    'initial version'
  )

  const rows = [
    { channelId: generalId, memberType: 'human' as const, memberId: adminId },
    { channelId: buildsId, memberType: 'human' as const, memberId: adminId },
    { channelId: generalId, memberType: 'agent' as const, memberId: scoutId },
    { channelId: buildsId, memberType: 'agent' as const, memberId: scoutId },
    { channelId: generalId, memberType: 'agent' as const, memberId: coderId },
    { channelId: buildsId, memberType: 'agent' as const, memberId: coderId }
  ]
  db.insert(memberships).values(rows).run()

  return true
}
