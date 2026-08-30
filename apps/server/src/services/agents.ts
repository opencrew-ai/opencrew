import { desc, eq } from 'drizzle-orm'
import type {
  Agent,
  AgentVersion,
  AgentVersionConfig,
  AgentWithVersion
} from '@opencrew/shared'
import type { DB } from '../db'
import { agents, agentVersions } from '../db/schema'
import { nanoid } from 'nanoid'

type AgentRow = typeof agents.$inferSelect
type VersionRow = typeof agentVersions.$inferSelect

export function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    avatarEmoji: row.avatarEmoji,
    currentVersionId: row.currentVersionId,
    createdBy: row.createdBy,
    status: row.status
  }
}

export function toAgentVersion(row: VersionRow): AgentVersion {
  return {
    id: row.id,
    agentId: row.agentId,
    version: row.version,
    systemPrompt: row.systemPrompt,
    model: row.model,
    skills: JSON.parse(row.skills),
    tools: JSON.parse(row.tools),
    capabilities: JSON.parse(row.capabilities),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    changeNote: row.changeNote
  }
}

export async function getAgent(db: DB, agentId: string): Promise<Agent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
  return row ? toAgent(row) : null
}

export async function getVersion(db: DB, versionId: string): Promise<AgentVersion | null> {
  const [row] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, versionId))
    .limit(1)
  return row ? toAgentVersion(row) : null
}

export async function getAgentWithVersion(
  db: DB,
  agentId: string
): Promise<AgentWithVersion | null> {
  const agent = await getAgent(db, agentId)
  if (!agent) return null
  const version = await getVersion(db, agent.currentVersionId)
  if (!version) return null
  return { ...agent, currentVersion: version }
}

export async function listAgentsWithVersions(db: DB): Promise<AgentWithVersion[]> {
  const rows = await db.select().from(agents)
  const results = await Promise.all(rows.map((row) => getAgentWithVersion(db, row.id)))
  return results.filter((a): a is AgentWithVersion => a !== null)
}

/**
 * Append an immutable version row and point the agent at it.
 * This is the ONLY way agent config changes — existing rows are never updated.
 */
export async function createVersion(
  db: DB,
  agentId: string,
  config: AgentVersionConfig,
  createdBy: string,
  changeNote: string
): Promise<AgentVersion> {
  const [latest] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .limit(1)
  const nextVersion = (latest?.version ?? 0) + 1
  const id = nanoid()
  const now = Date.now()
  await db.insert(agentVersions).values({
    id,
    agentId,
    version: nextVersion,
    systemPrompt: config.systemPrompt,
    model: config.model,
    skills: JSON.stringify(config.skills),
    tools: JSON.stringify(config.tools),
    capabilities: JSON.stringify(config.capabilities),
    createdBy,
    createdAt: now,
    changeNote
  })
  await db.update(agents).set({ currentVersionId: id }).where(eq(agents.id, agentId))
  const created = await getVersion(db, id)
  if (!created) throw new Error('failed to create agent version')
  return created
}
