import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useWorkspace } from '../lib/workspace'

interface CloudStatus {
  linked: boolean
}

/**
 * Plan status. Local use is free and always will be; Pro is the relay's
 * part — deciding from anywhere — so this card only has something to say
 * once the crew is linked to opencrew.run.
 */
export function ProCard() {
  const { me } = useWorkspace()
  const [linked, setLinked] = useState<boolean | null>(null)
  const [cloudUrl, setCloudUrl] = useState<string | null>(null)

  useEffect(() => {
    api.get<CloudStatus>('/api/cloudlink/status').then((s) => setLinked(s.linked)).catch(() => setLinked(false))
    api.get<{ cloudUrl: string | null }>('/api/auth/methods').then((m) => setCloudUrl(m.cloudUrl)).catch(() => {})
  }, [])

  const proUrl = `${cloudUrl ?? 'https://relay.opencrew.run'}/portal/pro`
  const viaRelay = me.viaRelay === true
  const plan = viaRelay ? (me.pro ? 'Pro' : me.pro === false ? 'Free' : null) : null

  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Plan</h2>
        {plan && (
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
              plan === 'Pro' ? 'bg-emerald-900/50 text-emerald-300' : 'bg-zinc-800 text-zinc-300'
            }`}
          >
            {plan}
          </span>
        )}
      </div>
      <p className="text-sm text-zinc-400">
        Everything on this machine is free, forever. <span className="text-zinc-200">Pro</span> is
        for deciding from your phone: unlimited approvals through opencrew.run. Free gets three a
        month.
      </p>
      {linked === false && (
        <p className="text-xs text-zinc-500">Link to opencrew.run above first.</p>
      )}
      {plan !== 'Pro' && (
        <a
          href={proUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block rounded border border-emerald-700/60 bg-emerald-900/40 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-800/50"
        >
          See Pro · $19/mo
        </a>
      )}
    </section>
  )
}
