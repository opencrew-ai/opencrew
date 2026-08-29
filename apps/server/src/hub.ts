import type { ServerEvent } from '@opencrew/shared'

/** Structural socket type — avoids a direct dependency on `ws` types. */
export interface SocketLike {
  readyState: number
  OPEN: number
  send(data: string): void
}

/** Tracks connected sockets and broadcasts events to every client. */
export class Hub {
  private sockets = new Map<SocketLike, string>() // socket -> userId

  add(socket: SocketLike, userId: string): void {
    this.sockets.set(socket, userId)
  }

  remove(socket: SocketLike): void {
    this.sockets.delete(socket)
  }

  onlineUserIds(): string[] {
    return [...new Set(this.sockets.values())]
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.sockets.keys()) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload)
      }
    }
  }
}
