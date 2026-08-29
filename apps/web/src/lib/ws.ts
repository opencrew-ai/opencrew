import type { ServerEvent } from '@opencrew/shared'

type Listener = (event: ServerEvent) => void

const RECONNECT_DELAY_MS = 2000

/** Tiny WS client: single connection, fan-out to listeners, auto-reconnect. */
class WsClient {
  private socket: WebSocket | null = null
  private listeners = new Set<Listener>()
  private shouldRun = false

  connect(): void {
    if (this.shouldRun) return
    this.shouldRun = true
    this.open()
  }

  disconnect(): void {
    this.shouldRun = false
    this.socket?.close()
    this.socket = null
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${proto}://${location.host}/api/ws`)
    this.socket = socket
    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as ServerEvent
        for (const listener of this.listeners) listener(event)
      } catch {
        // Ignore malformed frames.
      }
    }
    socket.onclose = () => {
      if (this.shouldRun) setTimeout(() => this.open(), RECONNECT_DELAY_MS)
    }
  }
}

export const wsClient = new WsClient()
