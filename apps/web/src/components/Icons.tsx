/**
 * Minimal line icons for UI chrome. Emoji stays reserved for agent identity
 * (avatars) — chrome gets crafted glyphs instead.
 */

interface IconProps {
  className?: string
}

const BASE = 'h-[15px] w-[15px] shrink-0'

export function FolderIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`${BASE} ${className}`}>
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.8h6a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function TasksIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`${BASE} ${className}`}>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="M5.5 8.2l1.8 1.8 3.4-3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function GearIcon({ className = '' }: IconProps) {
  return (
    // A toothed gear — the old circle-and-rays read as a sun / theme toggle.
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`${BASE} ${className}`}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function DocIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`${BASE} ${className}`}>
      <path d="M4 1.8h5.2L12.5 5v9.2h-8.5z" strokeLinejoin="round" />
      <path d="M9 2v3.2h3.3" strokeLinejoin="round" />
      <path d="M6 8.5h4.5M6 11h4.5" strokeLinecap="round" />
    </svg>
  )
}

export function DiffIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`${BASE} ${className}`}>
      <path d="M5 2.5v11M5 2.5a2 2 0 1 0 0 .01M5 13.5a2 2 0 1 0 0 .01" />
      <path d="M11 6.5v5M8.8 8.5L11 6.3l2.2 2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Collapse: chevron pointing up. */
export function CollapseIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`${BASE} ${className}`}>
      <path d="M3.5 10.5L8 5.5l4.5 5" />
    </svg>
  )
}

/** Expand: chevron pointing down. */
export function ExpandIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`${BASE} ${className}`}>
      <path d="M3.5 5.5L8 10.5l4.5-5" />
    </svg>
  )
}

/** Double-check mark: mark as read. */
export function CheckCheckIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`${BASE} ${className}`}>
      <path d="M1.5 8.5l3 3L11 5" />
      <path d="M6 11l1.5 1.5L14 5.5" />
    </svg>
  )
}

/** Today: a calendar page with one mark. */
export function TodayIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className={`${BASE} ${className}`}>
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" />
      <circle cx="8" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Sun: light theme. */
export function SunIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className={`${BASE} ${className}`}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
    </svg>
  )
}

/** Crescent moon: dark theme. */
export function MoonIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className={`${BASE} ${className}`}>
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
    </svg>
  )
}

/** Monitor: follow the system theme. */
export function MonitorIcon({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className={`${BASE} ${className}`}>
      <rect x="1.8" y="2.8" width="12.4" height="8.2" rx="1.4" />
      <path d="M6 13.4h4M8 11v2.4" />
    </svg>
  )
}
