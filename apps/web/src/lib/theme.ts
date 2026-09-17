/**
 * Theme runtime — "Light Mode Theme — Design Token & Component Spec" §5.
 *
 * Preference model:
 *   'light' | 'dark'  — explicit choice, persisted to localStorage("theme")
 *   'auto'            — follow the OS (default when nothing is stored);
 *                       tracks prefers-color-scheme changes live
 *
 * The RESOLVED theme ('light' | 'dark') is applied as `data-theme` on <html>;
 * styles.css keys every token off that attribute, so CSS stays single-source
 * (no duplicated media-query block) and the toggle can override the OS.
 *
 * `initTheme()` is called from App.tsx at module scope — before the first
 * React render — so the initial paint is already in the right theme.
 */
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'theme'
const media = window.matchMedia('(prefers-color-scheme: light)')

const listeners = new Set<() => void>()
let preference: ThemePreference = readStoredPreference()

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'auto'
  } catch {
    return 'auto' // storage unavailable (private mode) — OS preference only
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'auto') return media.matches ? 'light' : 'dark'
  return pref
}

function apply(): void {
  document.documentElement.dataset.theme = resolveTheme(preference)
}

export function getThemePreference(): ThemePreference {
  return preference
}

export function setThemePreference(pref: ThemePreference): void {
  preference = pref
  try {
    if (pref === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // Non-fatal: theme still applies for this session.
  }
  apply()
  listeners.forEach((fn) => fn())
}

let initialized = false

/** Idempotent: applies the theme now and follows OS changes while on 'auto'. */
export function initTheme(): void {
  if (initialized) return
  initialized = true
  apply()
  media.addEventListener('change', () => {
    if (preference !== 'auto') return
    apply()
    listeners.forEach((fn) => fn())
  })
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The stored preference (drives which toggle segment is active). */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference)
}
