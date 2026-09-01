import { nanoid } from 'nanoid'
import type { AgentCapabilities, ServerEvent } from '@opencrew/shared'
import { createDb, type DB } from '../db'
import { agents, channels, users } from '../db/schema'
import { createVersion } from '../services/agents'
import type { AppContext } from '../context'
import { FabricRuntime } from '../fabric/runtime'
import type { SocketLike } from '../hub'
import { Hub } from '../hub'

export interface TestCtx extends AppContext {
  broadcasts: ServerEvent[]
  /** Fabric task ids created by admission — tests assert on these instead
   *  of executing real Claude Code sessions. */
  enqueued: string[]
}

class CapturingHub extends Hub {
  constructor(
    private sink: ServerEvent[],
    private enqueued: string[]
  ) {
    super()
  }
  override broadcast(event: ServerEvent): void {
    this.sink.push(event)
    if (event.type === 'run_status' && event.status === 'queued') {
      this.enqueued.push(event.runId)
    }
    super.broadcast(event)
  }
  override add(socket: SocketLike, userId: string): void {
    super.add(socket, userId)
  }
}

/**
 * Test context: real DB + real fabric runtime, but the runtime is never
 * started — tasks stay 'ready' in the store where tests can assert on them.
 */
export async function makeTestCtx(): Promise<TestCtx> {
  const { db } = await createDb(':memory:')
  const broadcasts: ServerEvent[] = []
  const enqueued: string[] = []
  const hub = new CapturingHub(broadcasts, enqueued)
  const fabric = new FabricRuntime(db, {
    capacity: 4,
    interactiveReserve: 1,
    workerId: 'test-worker'
  })
  return { db, hub, fabric, broadcasts, enqueued }
}

export async function seedUser(db: DB): Promise<string> {
  const id = nanoid()
  await db.insert(users).values({
    id,
    name: 'Tester',
    email: `${id}@test.local`,
    passwordHash: 'x',
    role: 'admin',
    createdAt: Date.now()
  })
  return id
}

export async function seedChannel(db: DB, name = `chan-${nanoid(6)}`): Promise<string> {
  const id = nanoid()
  await db.insert(channels).values({ id, name, topic: '', isPrivate: false, createdAt: Date.now() })
  return id
}

export async function seedAgent(
  db: DB,
  userId: string,
  opts: {
    name?: string
    tools?: string[]
    capabilities?: Partial<AgentCapabilities>
  } = {}
): Promise<{ agentId: string; versionId: string }> {
  const agentId = nanoid()
  await db.insert(agents).values({
    id: agentId,
    name: opts.name ?? `Agent${nanoid(4)}`,
    avatarEmoji: '🤖',
    currentVersionId: 'pending',
    createdBy: userId,
    status: 'active',
    createdAt: Date.now()
  })
  const version = await createVersion(
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
