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
  Project,
  ServerEvent,
  User
} from '@opencrew/shared'
import { api } from './api'
import { wsClient } from './ws'

interface WorkspaceState {
  me: User
  channels: Channel[]
  agents: AgentWithVersion[]
  /** Ordered by creation; a channel or agent with projectId null is HQ. */
  projects: Project[]
  /** Palette offered when creating a project. */
  projectColors: string[]
  users: User[]
  presence: Map<string, PresenceEntry>
  /** The project a channel belongs to; null for HQ channels. */
  projectOfChannel: (channelId: string | undefined) => Project | null
  refreshChannels: () => Promise<void>
  refreshAgents: () => Promise<void>
  refreshProjects: () => Promise<void>
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
  const [projects, setProjects] = useState<Project[]>([])
  const [projectColors, setProjectColors] = useState<string[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [presence, setPresence] = useState<Map<string, PresenceEntry>>(new Map())
  const [loaded, setLoaded] = useState(false)

  const refreshChannels = useCallback(async () => {
    setChannels(await api.get<Channel[]>('/api/channels'))
  }, [])
  const refreshAgents = useCallback(async () => {
    setAgents(await api.get<AgentWithVersion[]>('/api/agents'))
  }, [])
  const refreshProjects = useCallback(async () => {
    const data = await api.get<{ projects: Project[]; colors: string[] }>('/api/projects')
    setProjects(data.projects)
    setProjectColors(data.colors)
  }, [])

  useEffect(() => {
    void Promise.all([
      refreshChannels(),
      refreshAgents(),
      refreshProjects(),
      api.get<User[]>('/api/users').then(setUsers)
    ]).then(() => setLoaded(true))
  }, [refreshChannels, refreshAgents, refreshProjects])

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
      } else if (event.type === 'project_created') {
        setProjects((prev) =>
          prev.some((p) => p.id === event.project.id) ? prev : [...prev, event.project]
        )
      } else if (event.type === 'project_updated') {
        setProjects((prev) => prev.map((p) => (p.id === event.project.id ? event.project : p)))
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
    // Behind the relay the identity header re-authenticates every request —
    // signing out means ending the opencrew.run session, not the local one.
    if (document.cookie.includes('ocr_via_relay=1')) {
      window.location.href = '/portal/logout'
      return
    }
    onLoggedOut()
  }, [onLoggedOut])

  const projectOfChannel = useCallback(
    (channelId: string | undefined): Project | null => {
      const channel = channels.find((c) => c.id === channelId)
      if (!channel?.projectId) return null
      return projects.find((p) => p.id === channel.projectId) ?? null
    },
    [channels, projects]
  )

  const value = useMemo(
    () => ({
      me: meState,
      channels,
      agents,
      projects,
      projectColors,
      users,
      presence,
      projectOfChannel,
      refreshChannels,
      refreshAgents,
      refreshProjects,
      logout
    }),
    [
      meState,
      channels,
      agents,
      projects,
      projectColors,
      users,
      presence,
      projectOfChannel,
      refreshChannels,
      refreshAgents,
      refreshProjects,
      logout
    ]
  )

  if (!loaded) {
    return <div className="grid h-screen place-items-center text-zinc-500">Loading…</div>
  }
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
