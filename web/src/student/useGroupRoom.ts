import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { api, ApiError, errorMessage, fetchAudio } from '../services/api'
import { chunkStore } from '../recorder/chunk-store'
import { discardTake, loadStoredTake, pickAudioMimeType, TakeRecorder, type FinishedTake } from '../recorder/local-take'
import { isRejection, uploadChunks, wait } from '../recorder/upload-manager'
import { MIC_CONSTRAINTS, requestWakeLock, type WakeLock } from '../recorder/device'
import { fetchRtcConfig, PeerManager } from '../group/peers'
import { Signaling } from '../group/signaling'
import type { GroupState, GroupTake } from '../group/types'
import { groupView } from '../group/view'
import { loadPendingVoice, savePendingVoice, type PendingVoice } from './storage'

export type RoomPhase = 'loading' | 'mic-blocked' | 'unsupported' | 'live' | 'replaced'

type GroupResponse = { selfId: string; maxSeconds: number; group: GroupState }
type ActiveRecording = { recorder: TakeRecorder; takeId: string; startOffsetMs: number }

const TICK_MS = 200
const RETRY_MS = 2000

/**
 * One student's side of a two-person podcast: the live call, recording their own microphone while the group's take
 * records, uploading that voice after Stop, and playing the server's mix. The server's group state drives all of it.
 */
export function useGroupRoom(options: {
  classToken: string
  groupId: string
  token: string
  // The group token stopped working: the PIN changed, or the teacher removed the group.
  onGone: () => void
}) {
  const phase = ref<RoomPhase>('loading')
  const group = shallowRef<GroupState | null>(null)
  const selfId = ref('')
  const maxMs = ref(0)
  const partnerStream = shallowRef<MediaStream | null>(null)
  const callState = ref<RTCPeerConnectionState | 'none'>('none')
  const elapsedMs = ref(0)
  const uploadPercent = ref<number | null>(null)
  const mixUrl = ref<string | null>(null)
  const dismissedSentId = ref<string | null>(null)
  const busy = ref(false)
  const actionError = ref('')
  const view = computed(() =>
    group.value && selfId.value ? groupView(group.value, selfId.value, dismissedSentId.value) : null,
  )

  let stream: MediaStream | null = null
  let signaling: Signaling | null = null
  let peers: PeerManager | null = null
  let active: ActiveRecording | null = null
  // A take this device already recorded for is never recorded again, even if a late state still says "recording".
  const recordedTakeIds = new Set<string>()
  let mixTakeId: string | null = null
  let ticker: number | null = null
  let wakeLock: WakeLock | null = null
  let unmounted = false
  const uploads = new AbortController()

  const serverNow = (): number => Date.now() + (signaling?.clockOffsetMs ?? 0)

  function gone(): void {
    if (!unmounted) {
      options.onGone()
    }
  }

  function applyGroup(next: GroupState): void {
    group.value = next
    const take = next.take
    if (take?.status === 'recording' && !recordedTakeIds.has(take.id)) {
      void startRecorder(take)
    }
    if (active && (take?.id !== active.takeId || take.status !== 'recording')) {
      void stopRecorder()
    }
    syncTicker(take)
    // The sent mix only while this device shows Sent!, not after it moved on with Try Again.
    const sentMix = !take && next.sent && next.sent.takeId !== dismissedSentId.value ? next.sent.takeId : null
    const wantedMix = take?.status === 'listening' ? take.id : sentMix
    if (wantedMix !== mixTakeId) {
      void loadMix(wantedMix)
    }
  }

  function syncTicker(take: GroupTake | null): void {
    if (take?.status === 'recording') {
      if (ticker === null) {
        ticker = window.setInterval(() => {
          const current = group.value?.take
          elapsedMs.value = current ? Math.max(0, Math.min(maxMs.value, serverNow() - current.startedAtMs)) : 0
        }, TICK_MS)
      }
      return
    }
    if (ticker !== null) {
      window.clearInterval(ticker)
      ticker = null
    }
    elapsedMs.value = take?.durationMs ?? 0
  }

  async function startRecorder(take: GroupTake): Promise<void> {
    const mic = stream
    if (!mic) {
      return
    }
    recordedTakeIds.add(take.id)
    const mimeType = pickAudioMimeType((mime) => MediaRecorder.isTypeSupported(mime))
    if (!mimeType) {
      actionError.value = "This browser can't record. Try the latest Chrome or Safari."
      return
    }
    const remainingMs = maxMs.value - (serverNow() - take.startedAtMs)
    const recorder = new TakeRecorder({ maxMs: Math.max(1000, remainingMs), onAutoStop: () => void stopRecorder() })
    try {
      await recorder.start(mic, mimeType)
    } catch {
      actionError.value = "Your microphone couldn't start recording. Leave and come back to try again."
      return
    }
    // Where this voice starts on the take's timeline, so the server can line both voices up.
    const startOffsetMs = Math.max(0, Math.min(maxMs.value, Math.round(serverNow() - take.startedAtMs)))
    active = { recorder, takeId: take.id, startOffsetMs }
    wakeLock = await requestWakeLock()
    const current = group.value?.take
    if (current?.id !== take.id || current.status !== 'recording') {
      void stopRecorder()
    }
  }

  async function stopRecorder(): Promise<void> {
    const stopping = active
    if (!stopping) {
      return
    }
    active = null
    const finished = await stopping.recorder.stop()
    void wakeLock?.release().catch(() => undefined)
    wakeLock = null
    if (finished.chunks.length === 0) {
      await discardTake(finished).catch(() => undefined)
      return
    }
    const pending: PendingVoice = { takeId: stopping.takeId, localId: finished.localId, startOffsetMs: stopping.startOffsetMs }
    savePendingVoice(options.classToken, options.groupId, pending)
    await uploadVoice(pending, finished)
  }

  /** The server track for this device's voice, or why there is none: the take ended, or the upload was abandoned. */
  async function voiceTrack(pending: PendingVoice, take: FinishedTake): Promise<string | 'ended' | 'aborted'> {
    const signal = uploads.signal
    for (;;) {
      if (signal.aborted) {
        return 'aborted'
      }
      try {
        const created = await api<{ trackId: string }>(`/api/group/takes/${pending.takeId}/voice`, {
          token: options.token,
          body: { mimeType: take.mimeType, startOffsetMs: pending.startOffsetMs, durationMs: take.durationMs },
          signal,
        })
        return created.trackId
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          gone()
          return 'aborted'
        }
        if (err instanceof ApiError && isRejection(err.status)) {
          return 'ended'
        }
      }
      await wait(RETRY_MS, signal)
    }
  }

  async function uploadVoice(pending: PendingVoice, take: FinishedTake): Promise<void> {
    uploadPercent.value = 0
    try {
      const trackId = await voiceTrack(pending, take)
      if (trackId === 'aborted') {
        return
      }
      if (trackId !== 'ended') {
        const result = await uploadChunks({ trackId, token: options.token }, take.chunks, take.durationMs, {
          onProgress: (percent) => (uploadPercent.value = percent),
          signal: uploads.signal,
        })
        if (result === 'aborted') {
          return
        }
      }
      savePendingVoice(options.classToken, options.groupId, null)
      await discardTake(take).catch(() => undefined)
    } finally {
      uploadPercent.value = null
    }
  }

  /** Finishes uploading a voice that a reload interrupted, or drops it if its take is over. */
  async function resumePendingVoice(state: GroupState): Promise<void> {
    const pending = loadPendingVoice(options.classToken, options.groupId)
    if (!pending) {
      return
    }
    if (state.take?.id === pending.takeId && state.take.status === 'mixing') {
      const stored = await loadStoredTake(pending.localId).catch(() => null)
      if (stored) {
        recordedTakeIds.add(pending.takeId)
        await uploadVoice(pending, stored)
        return
      }
    }
    savePendingVoice(options.classToken, options.groupId, null)
    await chunkStore.deleteTrack(pending.localId).catch(() => undefined)
  }

  function fetchMix(takeId: string): Promise<Blob> {
    return fetchAudio(`/api/group/takes/${takeId}/mix`, options.token)
  }

  async function loadMix(takeId: string | null): Promise<void> {
    mixTakeId = takeId
    if (mixUrl.value) {
      URL.revokeObjectURL(mixUrl.value)
      mixUrl.value = null
    }
    if (!takeId) {
      return
    }
    try {
      const blob = await fetchMix(takeId)
      if (mixTakeId === takeId && !unmounted) {
        mixUrl.value = URL.createObjectURL(blob)
      }
    } catch (err) {
      console.error('Loading the mix failed', err)
      if (mixTakeId === takeId) {
        mixTakeId = null
        window.setTimeout(() => group.value && !unmounted && applyGroup(group.value), RETRY_MS)
      }
    }
  }

  async function joinCall(mic: MediaStream): Promise<void> {
    const rtcConfig = await fetchRtcConfig()
    if (unmounted) {
      return
    }
    const call = new Signaling(options.token, {
      onWelcome: (peerIds) => {
        // A reconnect gets a fresh welcome: rebuild the call, and as the newcomer, offer to whoever is there.
        peers?.closeAll()
        peerIds.forEach((id) => peers?.addPeer(id))
      },
      onPeerLeft: (participantId) => peers?.removePeer(participantId),
      onSignal: (from, data) => peers?.handleSignal(from, data),
      onGroup: applyGroup,
      onClosed: (reason) => {
        if (reason === 'replaced') {
          phase.value = 'replaced'
          peers?.closeAll()
          return
        }
        gone()
      },
    })
    signaling = call
    peers = new PeerManager({
      signaling: call,
      selfId: selfId.value,
      rtcConfig,
      onRemoteStream: (_participantId, remote) => (partnerStream.value = remote),
      onConnectionState: (_participantId, state) => (callState.value = state),
    })
    peers.setLocalStream(mic)
    call.connect()
    phase.value = 'live'
  }

  async function startMic(): Promise<void> {
    phase.value = 'loading'
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false })
    } catch {
      phase.value = 'mic-blocked'
      return
    }
    if (unmounted) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    await joinCall(stream)
  }

  /** Keeps the mix playing on this device from reaching the partner through the microphone. */
  function setMicLive(live: boolean): void {
    stream?.getAudioTracks().forEach((track) => (track.enabled = live))
  }

  onMounted(async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      phase.value = 'unsupported'
      return
    }
    try {
      const response = await api<GroupResponse>('/api/group', { token: options.token })
      selfId.value = response.selfId
      maxMs.value = response.maxSeconds * 1000
      applyGroup(response.group)
      void resumePendingVoice(response.group)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        gone()
        return
      }
      actionError.value = "Can't reach First Mic. Check your internet, then reload this page."
      return
    }
    await startMic()
  })

  onUnmounted(() => {
    unmounted = true
    const mic = stream
    void stopRecorder().finally(() => mic?.getTracks().forEach((track) => track.stop()))
    uploads.abort()
    signaling?.close()
    peers?.closeAll()
    if (ticker !== null) {
      window.clearInterval(ticker)
    }
    if (mixUrl.value) {
      URL.revokeObjectURL(mixUrl.value)
    }
  })

  async function act(path: string): Promise<void> {
    if (busy.value) {
      return
    }
    busy.value = true
    actionError.value = ''
    try {
      await api(path, { token: options.token, body: {} })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        gone()
        return
      }
      actionError.value = errorMessage(err, "That didn't work. Check your internet and try again.")
    } finally {
      busy.value = false
    }
  }

  const takePath = (action: string): string => `/api/group/takes/${group.value?.take?.id ?? ''}/${action}`

  function tryAgain(): Promise<void> | void {
    const sent = group.value?.sent
    if (view.value?.view === 'sent' && sent) {
      dismissedSentId.value = sent.takeId
      applyGroup(group.value as GroupState)
      return
    }
    return act(takePath('discard'))
  }

  return {
    phase,
    group,
    view,
    maxMs,
    partnerStream,
    callState,
    elapsedMs,
    uploadPercent,
    mixUrl,
    busy,
    actionError,
    startMic,
    setMicLive,
    record: () => act('/api/group/takes'),
    stop: () => act(takePath('stop')),
    send: () => act(takePath('send')),
    tryAgain,
    loadPastMix: fetchMix,
  }
}
