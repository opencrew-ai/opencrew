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

export function getAgent(db: DB, agentId: string): Agent | null {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get()
  return row ? toAgent(row) : null
}

export function getVersion(db: DB, versionId: string): AgentVersion | null {
  const row = db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.id, versionId))
    .get()
  return row ? toAgentVersion(row) : null
}

export function getAgentWithVersion(db: DB, agentId: string): AgentWithVersion | null {
  const agent = getAgent(db, agentId)
  if (!agent) return null
  const version = getVersion(db, agent.currentVersionId)
  if (!version) return null
  return { ...agent, currentVersion: version }
}

export function listAgentsWithVersions(db: DB): AgentWithVersion[] {
  return db
    .select()
    .from(agents)
    .all()
    .map((row) => getAgentWithVersion(db, row.id))
    .filter((a): a is AgentWithVersion => a !== null)
}

/**
 * Append an immutable version row and point the agent at it.
 * This is the ONLY way agent config changes — existing rows are never updated.
 */
export function createVersion(
  db: DB,
  agentId: string,
  config: AgentVersionConfig,
  createdBy: string,
  changeNote: string
): AgentVersion {
  const latest = db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .limit(1)
    .get()
  const nextVersion = (latest?.version ?? 0) + 1
  const id = nanoid()
  const now = Date.now()
  db.insert(agentVersions)
    .values({
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
    .run()
  db.update(agents).set({ currentVersionId: id }).where(eq(agents.id, agentId)).run()
  const created = getVersion(db, id)
  if (!created) throw new Error('failed to create agent version')
  return created
}
