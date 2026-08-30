import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { LandingPage } from './LandingPage'

/**
 * Server-side render entry point.
 * Called by scripts/prerender.mjs at build time to generate a fully-populated
 * index.html that Googlebot (and any other crawler) can read without executing JS.
 */
export function render(): string {
  return renderToString(
    <StrictMode>
      <LandingPage />
    </StrictMode>
  )
}
