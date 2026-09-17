import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'

interface VersionInfo {
  current: string
  latest: string | null
  updateAvailable: boolean
  telemetryAllowed: boolean
}

/**
 * Privacy & updates: the one toggle for the anonymous daily ping, and the
 * running version with an "update available" line that the ping's reply
 * powers. Says exactly what is sent, because that's the deal.
 */
export function PrivacyCard() {
  const { me } = useWorkspace()
  const isAdmin = me.role === 'admin'
  const [version, setVersion] = useState<VersionInfo | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<VersionInfo>('/api/version').then(setVersion).catch(() => {})
    api
      .get<{ telemetryEnabled: boolean }>('/api/settings')
      .then((s) => setEnabled(s.telemetryEnabled))
      .catch(() => {})
  }, [])

  const toggle = async () => {
    if (enabled === null) return
    setBusy(true)
    try {
      const next = await api.post<{ telemetryEnabled: boolean }>('/api/settings', {
        telemetryEnabled: !enabled
      })
      setEnabled(next.telemetryEnabled)
    } catch {
      // leave the switch where it was
    } finally {
      setBusy(false)
    }
  }

  const effective = enabled === true && version?.telemetryAllowed !== false

  return (
    <div className="mt-8 max-w-xl rounded-lg border border-border p-5">
      <h2 className="font-semibold">Privacy & updates</h2>
      <div className="mt-3 flex items-center justify-between gap-4 text-sm">
        <span className="text-text-secondary">
          Version <span className="font-mono">{version?.current ?? '…'}</span>
          {version?.updateAvailable && version.latest && (
            <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
              {version.latest} available — re-run the install line to update
            </span>
          )}
        </span>
      </div>
      <label className="mt-4 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={effective}
          onChange={() => void toggle()}
          disabled={!isAdmin || busy || enabled === null || version?.telemetryAllowed === false}
        />
        <span>
          <span className="text-text-primary">Send an anonymous daily ping</span>
          <span className="mt-1 block text-xs text-text-faint">
            Once a day: a random install id, the version, OS, and counts (projects, agents,
            runs). Never messages, prompts, file paths, names, or emails. It's how the project
            knows installs exist and whether they come back, and it's what tells you when an
            update is out.
            {version?.telemetryAllowed === false && ' Disabled by OPENCREW_TELEMETRY=0 on this server.'}
          </span>
        </span>
      </label>
    </div>
  )
}
