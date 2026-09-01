import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The web APP owns 5173 (tunnels and LAN URLs point there). strictPort
    // makes a collision fail loudly instead of silently swapping the two
    // sites between browser dials (IPv4 vs IPv6).
    port: 5180,
    strictPort: true,
  },
  build: {
    // Static output — deploy to any CDN, no server required
    outDir: 'dist',
  },
})
