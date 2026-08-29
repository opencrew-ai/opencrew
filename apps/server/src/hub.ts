import type { ServerEvent } from '@opencrew/shared'

/** Structural socket type — avoids a direct dependency on `ws` types. */
export interface SocketLike {
  readyState: number
  OPEN: number
  send(data: string): void
}

interface Connection {
  userId: string
  isAdmin: boolean
}

/**
 * Event types that expose the owner's machine (terminal output can contain
 * file contents, env values, command output) — admins only.
 */
const ADMIN_ONLY_EVENTS = new Set<ServerEvent['type']>(['run_step'])

/** Tracks connected sockets and broadcasts events to every client. */
export class Hub {
  private sockets = new Map<SocketLike, Connection>()

  add(socket: SocketLike, userId: string, isAdmin = true): void {
    this.sockets.set(socket, { userId, isAdmin })
  }

  remove(socket: SocketLike): void {
    this.sockets.delete(socket)
  }

  onlineUserIds(): string[] {
    return [...new Set([...this.sockets.values()].map((c) => c.userId))]
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event)
    const adminOnly = ADMIN_ONLY_EVENTS.has(event.type)
    for (const [socket, conn] of this.sockets) {
      if (adminOnly && !conn.isAdmin) continue
      if (socket.readyState === socket.OPEN) {
        socket.send(payload)
      }
    }
  }
}
