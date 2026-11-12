// Trimmed from Tributary's web/src/lib/rtc/peers.ts: a mesh WebRTC call using the "perfect negotiation" pattern,
// carrying only each student's microphone.

export type SignalSender = { sendSignal(to: string, data: unknown): void }

type SignalData = {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit | null
}

type PeerConn = {
  pc: RTCPeerConnection
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  /** Serializes signal processing so trickle candidates never race ahead of descriptions. */
  signalQueue: Promise<void>
}

const STALL_MS = 10_000
const MAX_REBUILDS = 4
const FALLBACK_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

/** ICE servers from the server (STUN by default, TURN when ICE_SERVERS is set there). */
export async function fetchRtcConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch('/api/rtc-config')
    const data = (await res.json()) as { iceServers?: RTCIceServer[] }
    return Array.isArray(data.iceServers) && data.iceServers.length > 0
      ? { iceServers: data.iceServers }
      : FALLBACK_RTC_CONFIG
  } catch {
    return FALLBACK_RTC_CONFIG
  }
}

export class PeerManager {
  private readonly peers = new Map<string, PeerConn>()
  private readonly watchdogs = new Map<string, number>()
  private readonly rebuildAttempts = new Map<string, number>()
  private localStream: MediaStream | null = null
  private readonly signaling: SignalSender
  private readonly selfId: string
  private readonly rtcConfig: RTCConfiguration
  private readonly onRemoteStream: (participantId: string, stream: MediaStream | null) => void
  private readonly onConnectionState: (participantId: string, state: RTCPeerConnectionState) => void

  constructor(options: {
    signaling: SignalSender
    selfId: string
    rtcConfig: RTCConfiguration
    onRemoteStream: (participantId: string, stream: MediaStream | null) => void
    onConnectionState: (participantId: string, state: RTCPeerConnectionState) => void
  }) {
    this.signaling = options.signaling
    this.selfId = options.selfId
    this.rtcConfig = options.rtcConfig
    this.onRemoteStream = options.onRemoteStream
    this.onConnectionState = options.onConnectionState
  }

  setLocalStream(stream: MediaStream): void {
    this.localStream = stream
    for (const id of this.peers.keys()) {
      this.syncTracks(id)
    }
  }

  addPeer(participantId: string): void {
    if (this.peers.has(participantId)) {
      return
    }
    const pc = new RTCPeerConnection(this.rtcConfig)
    const conn: PeerConn = {
      pc,
      polite: this.selfId < participantId,
      makingOffer: false,
      ignoreOffer: false,
      signalQueue: Promise.resolve(),
    }
    this.peers.set(participantId, conn)

    pc.onnegotiationneeded = async () => {
      try {
        conn.makingOffer = true
        await pc.setLocalDescription()
        this.signaling.sendSignal(participantId, { description: pc.localDescription })
      } catch (err) {
        console.error('negotiation failed', err)
      } finally {
        conn.makingOffer = false
      }
    }
    pc.onicecandidate = (event) => {
      this.signaling.sendSignal(participantId, { candidate: event.candidate })
    }
    pc.ontrack = (event) => {
      this.onRemoteStream(participantId, event.streams[0] ?? new MediaStream([event.track]))
    }
    pc.onconnectionstatechange = () => {
      this.onConnectionState(participantId, pc.connectionState)
      if (pc.connectionState === 'connected') {
        this.clearWatchdog(participantId)
        this.rebuildAttempts.delete(participantId)
      } else if (pc.connectionState === 'failed') {
        pc.restartIce()
        this.armWatchdog(participantId)
      }
    }

    this.syncTracks(participantId)
    this.armWatchdog(participantId)
  }

  removePeer(participantId: string): void {
    this.clearWatchdog(participantId)
    const conn = this.peers.get(participantId)
    if (!conn) {
      return
    }
    conn.pc.close()
    this.peers.delete(participantId)
    this.onRemoteStream(participantId, null)
    this.onConnectionState(participantId, 'closed')
  }

  closeAll(): void {
    for (const id of [...this.peers.keys()]) {
      this.removePeer(id)
    }
  }

  handleSignal(from: string, data: unknown): void {
    if (!this.peers.has(from)) {
      this.addPeer(from)
    }
    const conn = this.peers.get(from) as PeerConn
    // Process strictly in arrival order: a description must be applied before the candidates that followed it.
    conn.signalQueue = conn.signalQueue.then(() => this.processSignal(conn, from, data as SignalData))
  }

  /**
   * ICE can stall (never gather, never leave "connecting"). If a peer hasn't connected in time, rebuild the
   * connection; the fresh offer lands on the remote's existing connection as an ICE restart.
   */
  private armWatchdog(participantId: string): void {
    this.clearWatchdog(participantId)
    const timer = window.setTimeout(() => {
      const conn = this.peers.get(participantId)
      if (!conn || conn.pc.connectionState === 'connected') {
        return
      }
      const attempt = (this.rebuildAttempts.get(participantId) ?? 0) + 1
      if (attempt > MAX_REBUILDS) {
        return
      }
      this.rebuildAttempts.set(participantId, attempt)
      this.removePeer(participantId)
      this.addPeer(participantId)
    }, STALL_MS)
    this.watchdogs.set(participantId, timer)
  }

  private clearWatchdog(participantId: string): void {
    const timer = this.watchdogs.get(participantId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
    }
    this.watchdogs.delete(participantId)
  }

  private syncTracks(participantId: string): void {
    const conn = this.peers.get(participantId)
    const stream = this.localStream
    if (!conn || !stream) {
      return
    }
    const senders = conn.pc.getSenders()
    for (const track of stream.getTracks()) {
      if (!senders.some((sender) => sender.track === track)) {
        conn.pc.addTrack(track, stream)
      }
    }
  }

  private async processSignal(conn: PeerConn, from: string, data: SignalData): Promise<void> {
    const { pc } = conn
    if (pc.connectionState === 'closed') {
      return
    }
    try {
      if (data.description) {
        const description = data.description
        const offerCollision = description.type === 'offer' && (conn.makingOffer || pc.signalingState !== 'stable')
        conn.ignoreOffer = !conn.polite && offerCollision
        if (conn.ignoreOffer) {
          return
        }
        await pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          await pc.setLocalDescription()
          this.signaling.sendSignal(from, { description: pc.localDescription })
        }
      } else if (data.candidate !== undefined) {
        try {
          await pc.addIceCandidate(data.candidate ?? undefined)
        } catch (err) {
          if (!conn.ignoreOffer) {
            throw err
          }
        }
      }
    } catch (err) {
      console.error('signal handling failed', err)
    }
  }
}
