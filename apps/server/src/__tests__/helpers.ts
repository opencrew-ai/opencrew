import { nanoid } from 'nanoid'
import type { AgentCapabilities, ServerEvent } from '@opencrew/shared'
import { createDb, type DB } from '../db'
import { agents, channels, users } from '../db/schema'
import { createVersion } from '../services/agents'
import type { AppContext } from '../context'
import { RunQueue } from '../runs/queue'
import type { SocketLike } from '../hub'
import { Hub } from '../hub'

export interface TestCtx extends AppContext {
  broadcasts: ServerEvent[]
  enqueued: string[]
}

class CapturingHub extends Hub {
  constructor(private sink: ServerEvent[]) {
    super()
  }
  override broadcast(event: ServerEvent): void {
    this.sink.push(event)
    super.broadcast(event)
  }
  override add(socket: SocketLike, userId: string): void {
    super.add(socket, userId)
  }
}

export function makeTestCtx(): TestCtx {
  const { db } = createDb(':memory:')
  const broadcasts: ServerEvent[] = []
  const enqueued: string[] = []
  const queue = new RunQueue()
  // Capture instead of executing — tests drive the executor pieces directly.
  queue.configure(async (runId) => {
    enqueued.push(runId)
  }, () => null)
  return {
    db,
    hub: new CapturingHub(broadcasts),
    queue,
    approvalWaiters: new Map(),
    activeRuns: new Map(),
    broadcasts,
    enqueued
  }
}

export function seedUser(db: DB): string {
  const id = nanoid()
  db.insert(users)
    .values({
      id,
      name: 'Tester',
      email: `${id}@test.local`,
      passwordHash: 'x',
      role: 'admin',
      createdAt: Date.now()
    })
    .run()
  return id
}

export function seedChannel(db: DB, name = `chan-${nanoid(6)}`): string {
  const id = nanoid()
  db.insert(channels)
    .values({ id, name, topic: '', isPrivate: 0, createdAt: Date.now() })
    .run()
  return id
}

export function seedAgent(
  db: DB,
  userId: string,
  opts: {
    name?: string
    tools?: string[]
    capabilities?: Partial<AgentCapabilities>
  } = {}
): { agentId: string; versionId: string } {
  const agentId = nanoid()
  db.insert(agents)
    .values({
      id: agentId,
      name: opts.name ?? `Agent${nanoid(4)}`,
      avatarEmoji: '🤖',
      currentVersionId: 'pending',
      createdBy: userId,
      status: 'active',
      createdAt: Date.now()
    })
    .run()
  const version = createVersion(
    db,
    agentId,
    {
      systemPrompt: 'test agent',
      model: 'claude-sonnet-4-6',
      skills: [],
      tools: opts.tools ?? ['Bash'],
      capabilities: {
        canPostInChannels: [],
        maxRunsPerHour: 10,
        requiresApprovalFor: [],
        ...opts.capabilities
      }
    },
    userId,
    'initial version'
  )
  return { agentId, versionId: version.id }
}
