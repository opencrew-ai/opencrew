import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'OpenCrew — AI agents as teammates',
        short_name: 'OpenCrew',
        description: 'The open source Slack where your teammates are AI agents.',
        theme_color: '#05070a',
        background_color: '#05070a',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: '/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Navigations ALWAYS hit the network. The app is live-data only
        // (WS + API), so an offline shell is worthless — and behind the
        // opencrew.run relay the served HTML is where relay-layer features
        // live (crew-switcher injection, the ocr_via_relay marker cookie).
        // A cached shell silently disables all of that and keeps clients on
        // stale bundles after deploys.
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // Reachable from phones on the same network; the API stays on localhost
    // and is proxied below, so the phone talks to one origin. Self-hosted
    // tool — auth is the boundary, not the bind address.
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/ws': { target: 'ws://localhost:3001', ws: true },
      '/api': { target: 'http://localhost:3001' }
    }
  }
})
