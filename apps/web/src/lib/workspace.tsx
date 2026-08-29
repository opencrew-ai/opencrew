import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type {
  AgentWithVersion,
  Channel,
  PresenceEntry,
  ServerEvent,
  User
} from '@opencrew/shared'
import { api } from './api'
import { wsClient } from './ws'

interface WorkspaceState {
  me: User
  channels: Channel[]
  agents: AgentWithVersion[]
  users: User[]
  presence: Map<string, PresenceEntry>
  refreshChannels: () => Promise<void>
  refreshAgents: () => Promise<void>
  logout: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceState | null>(null)

export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext)
  if (!state) throw new Error('useWorkspace outside provider')
  return state
}

export function presenceKey(memberType: string, memberId: string): string {
  return `${memberType}:${memberId}`
}

export function WorkspaceProvider({
  me,
  onLoggedOut,
  children
}: {
  me: User
  onLoggedOut: () => void
  children: ReactNode
}) {
  const [meState, setMeState] = useState<User>(me)
  const [channels, setChannels] = useState<Channel[]>([])
  const [agents, setAgents] = useState<AgentWithVersion[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map())
  const [loaded, setLoaded] = useState(false)

  const refreshChannels = useCallback(async () => {
    setChannels(await api.get<Channel[]>('/api/channels'))
  }, [])
  const refreshAgents = useCallback(async () => {
    setAgents(await api.get<AgentWithVersion[]>('/api/agents'))
  }, [])

  useEffect(() => {
    void Promise.all([
      refreshChannels(),
      refreshAgents(),
      api.get<User[]>('/api/users').then(setUsers)
    ]).then(() => setLoaded(true))
  }, [refreshChannels, refreshAgents])

  useEffect(() => {
    wsClient.connect()
    const unsubscribe = wsClient.subscribe((event: ServerEvent) => {
      if (event.type === 'presence') {
        setPresence(
          new Map(event.entries.map((e) => [presenceKey(e.memberType, e.memberId), e]))
        )
      } else if (event.type === 'channel_created') {
        setChannels((prev) =>
          prev.some((c) => c.id === event.channel.id) ? prev : [...prev, event.channel]
        )
      } else if (event.type === 'agent_updated') {
        setAgents((prev) => {
          const rest = prev.filter((a) => a.id !== event.agent.id)
          return [...rest, event.agent].sort((a, b) => a.name.localeCompare(b.name))
        })
      } else if (event.type === 'user_updated') {
        setUsers((prev) => prev.map((u) => (u.id === event.user.id ? event.user : u)))
        setMeState((prev) => (prev.id === event.user.id ? event.user : prev))
      }
    })
    return () => {
      unsubscribe()
      wsClient.disconnect()
    }
  }, [])

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout')
    onLoggedOut()
  }, [onLoggedOut])

  const value = useMemo(
    () => ({
      me: meState,
      channels,
      agents,
      users,
      presence,
      refreshChannels,
      refreshAgents,
      logout
    }),
    [meState, channels, agents, users, presence, refreshChannels, refreshAgents, logout]
  )

  if (!loaded) {
    return <div className="grid h-screen place-items-center text-zinc-500">Loading…</div>
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
