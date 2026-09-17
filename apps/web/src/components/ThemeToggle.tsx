/**
 * ThemeToggle — segmented Light / Auto / Dark control
 * ("Light Mode Theme — Design Token & Component Spec" §5).
 *
 *   ┌───────────────────────────┐
 *   │  [☀ ] [◑ ] [☾ ]           │  ← radiogroup, roving tabindex, ←/→ moves
 *   └───────────────────────────┘
 *
 * Persistence + OS handshake live in lib/theme.ts; this is purely the control.
 * Icon-only at sidebar-footer size — each segment carries an aria-label and a
 * title, and the active segment is marked by surface + aria-checked (never
 * colour alone).
 */
import { useRef, type KeyboardEvent } from 'react'
import { setThemePreference, useThemePreference, type ThemePreference } from '../lib/theme'
import { MonitorIcon, MoonIcon, SunIcon } from './Icons'

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light theme', Icon: SunIcon },
  { value: 'auto', label: 'Match system theme', Icon: MonitorIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon }
]

interface ThemeToggleProps {
  className?: string
  /** Show text labels beside the icons — for roomy surfaces like Settings. */
  showLabels?: boolean
}

const SHORT_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  auto: 'Auto',
  dark: 'Dark'
}

export function ThemeToggle({ className = '', showLabels = false }: ThemeToggleProps) {
  const preference = useThemePreference()
  const groupRef = useRef<HTMLDivElement>(null)

  // Radiogroup keyboard model: ← / → (and ↑ / ↓) move and select.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (dir === 0) return
    e.preventDefault()
    const i = OPTIONS.findIndex((o) => o.value === preference)
    const next = OPTIONS[(i + dir + OPTIONS.length) % OPTIONS.length]
    if (!next) return
    setThemePreference(next.value)
    groupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-theme-option="${next.value}"]`)
      ?.focus()
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={`inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = value === preference
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            data-theme-option={value}
            tabIndex={active ? 0 : -1}
            onClick={() => setThemePreference(value)}
            className={`flex items-center justify-center gap-1.5 rounded-md transition-colors duration-100
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500
              ${showLabels ? 'h-8 px-3 text-sm' : 'h-6 w-7'}
              ${
                active
                  ? 'bg-surface font-medium text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-primary'
              }`}
          >
            <Icon className={showLabels ? 'h-4 w-4' : 'h-[13px] w-[13px]'} />
            {showLabels && <span>{SHORT_LABELS[value]}</span>}
          </button>
        )
      })}
    </div>
  )
}
