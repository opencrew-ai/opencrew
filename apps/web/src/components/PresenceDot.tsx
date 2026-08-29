import type { PresenceState } from '@opencrew/shared'

const COLORS: Record<PresenceState, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-zinc-600',
  idle: 'bg-zinc-500',
  running: 'bg-amber-400 animate-pulse'
}

export function PresenceDot({ state }: { state: PresenceState }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${COLORS[state]}`}
      title={state}
    />
  )
}
