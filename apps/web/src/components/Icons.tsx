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
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className={`${BASE} ${className}`}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" strokeLinecap="round" />
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
