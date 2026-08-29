import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import type { User } from '@opencrew/shared'
import { api, ApiError } from './lib/api'
import { WorkspaceProvider } from './lib/workspace'
import { LoginPage } from './pages/LoginPage'
import { InvitePage } from './pages/InvitePage'
import { WorkspacePage } from './pages/WorkspacePage'
import { AgentsPage } from './pages/AgentsPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { SettingsPage } from './pages/SettingsPage'

type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous'; isBootstrap: boolean }
  | { kind: 'authed'; me: User }

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<User>('/api/auth/me')
      setAuth({ kind: 'authed', me })
    } catch (err) {
      const isBootstrap = err instanceof ApiError && err.message === 'bootstrap'
      setAuth({ kind: 'anonymous', isBootstrap })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (auth.kind === 'loading') {
    return <div className="grid h-screen place-items-center text-zinc-500">Loading…</div>
  }

  if (auth.kind === 'anonymous') {
    return (
      <Routes>
        <Route path="/invite/:token" element={<InvitePage onAuthed={refresh} />} />
        <Route
          path="*"
          element={<LoginPage isBootstrap={auth.isBootstrap} onAuthed={refresh} />}
        />
      </Routes>
    )
  }

  return (
    <WorkspaceProvider
      me={auth.me}
      onLoggedOut={() => setAuth({ kind: 'anonymous', isBootstrap: false })}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/channels" replace />} />
        <Route path="/channels" element={<WorkspacePage />} />
        <Route path="/channels/:channelId" element={<WorkspacePage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/channels" replace />} />
      </Routes>
    </WorkspaceProvider>
  )
}
