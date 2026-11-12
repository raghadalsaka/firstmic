// Trimmed from Tributary's web/src/lib/rtc/signaling.ts: the live call's WebSocket, with reconnects and the
// NTP-style clock offset that places each student's recording on the server's timeline.
import type { GroupState } from './types'

export type SignalingEvents = {
  onWelcome: (peerIds: string[]) => void
  onPeerLeft: (participantId: string) => void
  onSignal: (from: string, data: unknown) => void
  onGroup: (group: GroupState) => void
  /** The server ended this connection for good: the group opened on another tab, or the token stopped working. */
  onClosed: (reason: 'replaced' | 'signed-out') => void
}

const PING_MS = 5000
const MAX_RECONNECT_MS = 15_000
const CLOSE_REPLACED = 4000
const CLOSE_SIGNED_OUT = 4401

type ServerMessage =
  | { t: 'welcome'; peers: { participantId: string }[] }
  | { t: 'peer-left'; participantId: string }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'group'; group: GroupState }
  | { t: 'pong'; clientNow: number; serverNow: number }

export class Signaling {
  /** Best estimate of (server clock - this device's clock), from the lowest-latency ping. */
  clockOffsetMs = 0
  private ws: WebSocket | null = null
  private closed = false
  private pingTimer: number | null = null
  private reconnectDelay = 1000
  private bestRtt = Number.POSITIVE_INFINITY
  private readonly token: string
  private readonly events: SignalingEvents

  constructor(token: string, events: SignalingEvents) {
    this.token = token
    this.events = events
  }

  connect(): void {
    if (this.closed) {
      return
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`)
    this.ws = ws
    ws.onopen = () => {
      this.reconnectDelay = 1000
      this.sendPing()
      this.pingTimer = window.setInterval(() => this.sendPing(), PING_MS)
    }
    ws.onmessage = (event) => this.handleMessage(JSON.parse(String(event.data)) as ServerMessage)
    ws.onclose = (event) => {
      if (this.pingTimer !== null) {
        window.clearInterval(this.pingTimer)
      }
      this.pingTimer = null
      if (event.code === CLOSE_REPLACED || event.code === CLOSE_SIGNED_OUT) {
        this.closed = true
        this.events.onClosed(event.code === CLOSE_REPLACED ? 'replaced' : 'signed-out')
        return
      }
      if (!this.closed) {
        window.setTimeout(() => this.connect(), this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS)
      }
    }
  }

  close(): void {
    this.closed = true
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer)
    }
    this.ws?.close()
  }

  sendSignal(to: string, data: unknown): void {
    this.send({ t: 'signal', to, data })
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private sendPing(): void {
    this.send({ t: 'ping', now: Date.now() })
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.t === 'welcome') {
      this.events.onWelcome(msg.peers.map((peer) => peer.participantId))
    } else if (msg.t === 'peer-left') {
      this.events.onPeerLeft(msg.participantId)
    } else if (msg.t === 'signal') {
      this.events.onSignal(msg.from, msg.data)
    } else if (msg.t === 'group') {
      this.events.onGroup(msg.group)
    } else if (msg.t === 'pong') {
      const now = Date.now()
      const rtt = now - msg.clientNow
      // Keep the offset from the lowest-RTT sample: the least skewed by queueing.
      if (rtt < this.bestRtt + 10) {
        this.bestRtt = Math.min(rtt, this.bestRtt)
        this.clockOffsetMs = msg.serverNow + rtt / 2 - now
      }
    }
  }
}
