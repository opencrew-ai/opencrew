import { spawn, type ChildProcess } from 'node:child_process'
import { env } from '../env'

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const START_TIMEOUT_MS = 25_000

export interface TunnelState {
  url: string
  startedAt: number
}

/**
 * Public access via a Cloudflare quick tunnel: spawns `cloudflared` pointed
 * at the local web app and extracts the generated https URL. Free, no
 * account, HTTPS + WebSockets included. Password auth remains the boundary;
 * the URL is unguessable but public — stop the tunnel when done.
 */
class TunnelManager {
  private proc: ChildProcess | null = null
  private state: TunnelState | null = null

  current(): TunnelState | null {
    return this.state
  }

  async start(): Promise<TunnelState> {
    if (this.state) return this.state

    // Named tunnel on the user's own domain when configured; otherwise a
    // zero-config quick tunnel with a random URL.
    const named = Boolean(env.tunnelToken)
    const target = `http://localhost:${env.webPort}`
    const args = named
      ? ['tunnel', 'run', '--token', env.tunnelToken]
      : ['tunnel', '--url', target, '--no-autoupdate']
    const proc = spawn('cloudflared', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.proc = proc

    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null
        this.state = null
      }
    })

    const url = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('tunnel did not come up in time — is your network blocking it?'))
      }, START_TIMEOUT_MS)

      const scan = (chunk: Buffer) => {
        output += chunk.toString()
        if (named) {
          // Token mode never prints a URL — wait for a live connection.
          if (/Registered tunnel connection/.test(output)) {
            clearTimeout(timer)
            resolve(env.tunnelUrl || 'https://<your configured hostname>')
          }
          return
        }
        const match = output.match(TUNNEL_URL_PATTERN)
        if (match) {
          clearTimeout(timer)
          resolve(match[0])
        }
      }
      proc.stdout?.on('data', scan)
      proc.stderr?.on('data', scan)
      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(
          err.code === 'ENOENT'
            ? new Error(
                'cloudflared is not installed — run `brew install cloudflared` (macOS) and try again'
              )
            : err
        )
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`cloudflared exited early (code ${code})`))
      })
    })

    this.state = { url, startedAt: Date.now() }
    return this.state
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
    this.state = null
  }
}

export const tunnel = new TunnelManager()

// Never leave an orphaned public tunnel behind.
process.on('exit', () => tunnel.stop())
