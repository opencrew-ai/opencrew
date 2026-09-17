import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import type { User } from '@opencrew/shared'
import { api, ApiError } from './lib/api'
import { WorkspaceProvider } from './lib/workspace'
import { LoginPage } from './pages/LoginPage'
import { InvitePage } from './pages/InvitePage'
import { WorkspacePage } from './pages/WorkspacePage'
import { ArtifactsPage } from './pages/ArtifactsPage'
import { TodayPage } from './pages/TodayPage'
import { TasksPage } from './pages/TasksPage'
import { AgentsPage } from './pages/AgentsPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { SettingsPage } from './pages/SettingsPage'
import { CrewActivityBar } from './components/CrewActivityBar'
import { DialogHost } from './lib/dialogs'
import { initTheme } from './lib/theme'

// Apply the stored/OS theme before the first render — no dark flash.
initTheme()

// The app owns scroll: the channel timeline pins itself to the latest
// message once data arrives. Left on 'auto', the browser replays the
// previous session's pixel offsets on refresh — measured against a page
// that hasn't loaded its messages yet — so the restore clamps/lands
// mid-timeline instead of at the latest message. 'manual' also covers
// Chrome's restore of inner overflow scrollers, not just the document.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual'
}

type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous'; isBootstrap: boolean }
  | { kind: 'offline' }
  | { kind: 'authed'; me: User }

const OFFLINE_RETRY_MS = 5000

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<User>('/api/auth/me')
      setAuth({ kind: 'authed', me })
    } catch (err) {
      // Server restarting or crew unreachable through the relay is not a
      // sign-out — hold on the offline screen and keep retrying.
      if (err instanceof ApiError && (err.status === 503 || err.status === 502)) {
        setAuth({ kind: 'offline' })
        return
      }
      if (!(err instanceof ApiError)) {
        setAuth({ kind: 'offline' })
        return
      }
      const isBootstrap = err.message === 'bootstrap'
      setAuth({ kind: 'anonymous', isBootstrap })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (auth.kind !== 'offline') return
    const timer = setInterval(() => void refresh(), OFFLINE_RETRY_MS)
    return () => clearInterval(timer)
  }, [auth.kind, refresh])

  if (auth.kind === 'loading') {
    return <div className="grid h-screen place-items-center text-text-faint">Loading…</div>
  }

  if (auth.kind === 'offline') {
    return (
      <div className="bg-stage grid h-screen place-items-center px-6 text-center">
        <div>
          <p className="text-4xl">😴</p>
          <h1 className="mt-3 text-lg font-semibold text-text-primary">Crew is waking up</h1>
          <p className="mt-1 text-sm text-text-muted">
            The machine running this crew isn&apos;t reachable right now — retrying
            automatically.
          </p>
        </div>
      </div>
    )
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
        <Route path="/today" element={<TodayPage />} />
        <Route path="/artifacts" element={<ArtifactsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/channels" replace />} />
      </Routes>
      <CrewActivityBar />
      <DialogHost />
    </WorkspaceProvider>
  )
}
