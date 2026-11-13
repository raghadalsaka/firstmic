import { onMounted, onUnmounted, ref } from 'vue'
import { api, ApiError } from '../services/api'
import { discardTake, loadStoredTake, pickAudioMimeType, TakeRecorder, type FinishedTake } from '../recorder/local-take'
import { MIC_CONSTRAINTS, requestWakeLock, type WakeLock } from '../recorder/device'
import { EpisodeGoneError, sendTake } from '../recorder/send'
import { loadEpisode, loadPendingTake, saveEpisode, savePendingTake, type StoredEpisode } from './storage'

export type RecorderPhase =
  | 'loading'
  | 'ready'
  | 'starting'
  | 'recording'
  | 'recorded'
  | 'sending'
  | 'send-failed'
  | 'mic-blocked'
  | 'unsupported'

const TICK_MS = 200

export function useRecorder(options: {
  classToken: string
  topicId: string
  studentToken: string
  maxSeconds: number
  // The student's sign-in stopped working (new PIN, removed from the class): show the name list again.
  onSignedOut: () => void
  // The take is saved in My Recordings.
  onSaved: () => void
}) {
  const phase = ref<RecorderPhase>('loading')
  const elapsedMs = ref(0)
  const sendPercent = ref(0)
  // Not reactive: nothing renders the take itself, only audioUrl and elapsedMs.
  let take: FinishedTake | null = null
  const audioUrl = ref<string | null>(null)
  const maxMs = options.maxSeconds * 1000

  let recorder: TakeRecorder | null = null
  let stream: MediaStream | null = null
  let ticker: number | null = null
  let wakeLock: WakeLock | null = null

  function setTake(next: FinishedTake | null): void {
    if (audioUrl.value) {
      URL.revokeObjectURL(audioUrl.value)
    }
    take = next
    audioUrl.value = next ? URL.createObjectURL(new Blob(next.chunks, { type: next.mimeType })) : null
    elapsedMs.value = next?.durationMs ?? 0
  }

  function releaseDevices(): void {
    if (ticker !== null) {
      window.clearInterval(ticker)
      ticker = null
    }
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    void wakeLock?.release().catch(() => undefined)
    wakeLock = null
  }

  async function loadPending(): Promise<FinishedTake | null> {
    const pendingId = loadPendingTake(options.classToken, options.topicId)
    return pendingId ? loadStoredTake(pendingId).catch(() => null) : null
  }

  onMounted(async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      phase.value = 'unsupported'
      return
    }
    const pending = await loadPending()
    if (pending) {
      setTake(pending)
      phase.value = 'recorded'
      return
    }
    savePendingTake(options.classToken, options.topicId, null)
    phase.value = 'ready'
  })

  async function record(): Promise<void> {
    if (phase.value !== 'ready' && phase.value !== 'mic-blocked') {
      return
    }
    phase.value = 'starting'
    const mimeType = pickAudioMimeType((mime) => MediaRecorder.isTypeSupported(mime))
    if (!mimeType) {
      phase.value = 'unsupported'
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false })
    } catch {
      phase.value = 'mic-blocked'
      return
    }
    recorder = new TakeRecorder({ maxMs, onAutoStop: () => void stop() })
    try {
      await recorder.start(stream, mimeType)
    } catch {
      releaseDevices()
      phase.value = 'unsupported'
      return
    }
    elapsedMs.value = 0
    phase.value = 'recording'
    ticker = window.setInterval(() => {
      elapsedMs.value = recorder?.elapsedMs() ?? 0
    }, TICK_MS)
    wakeLock = await requestWakeLock()
  }

  async function stop(): Promise<void> {
    if (phase.value !== 'recording' || !recorder) {
      return
    }
    const active = recorder
    recorder = null
    const finished = await active.stop()
    releaseDevices()
    if (finished.chunks.length === 0) {
      await discardTake(finished).catch(() => undefined)
      setTake(null)
      phase.value = 'ready'
      return
    }
    setTake(finished)
    savePendingTake(options.classToken, options.topicId, finished.localId)
    phase.value = 'recorded'
  }

  async function tryAgain(): Promise<void> {
    if (phase.value !== 'recorded' && phase.value !== 'send-failed') {
      return
    }
    if (take) {
      await discardTake(take).catch(() => undefined)
    }
    setTake(null)
    savePendingTake(options.classToken, options.topicId, null)
    phase.value = 'ready'
  }

  async function ensureEpisode(): Promise<StoredEpisode> {
    const stored = loadEpisode(options.classToken, options.topicId)
    if (stored) {
      return stored
    }
    try {
      const episode = await api<StoredEpisode>(`/api/class/${encodeURIComponent(options.classToken)}/episodes`, {
        body: { topicId: options.topicId },
        token: options.studentToken,
      })
      saveEpisode(options.classToken, options.topicId, episode)
      return episode
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        options.onSignedOut()
      }
      throw err
    }
  }

  /** Uploads the take; the server saves it in My Recordings. */
  async function send(): Promise<void> {
    const current = take
    if (!current || (phase.value !== 'recorded' && phase.value !== 'send-failed')) {
      return
    }
    phase.value = 'sending'
    sendPercent.value = 0
    const onProgress = (percent: number) => {
      sendPercent.value = percent
    }
    const attempt = async () => sendTake(current, (await ensureEpisode()).token, { onProgress })
    try {
      await attempt().catch((err: unknown) => {
        if (!(err instanceof EpisodeGoneError)) {
          throw err
        }
        saveEpisode(options.classToken, options.topicId, null)
        return attempt()
      })
      await discardTake(current).catch(() => undefined)
      savePendingTake(options.classToken, options.topicId, null)
      setTake(null)
      phase.value = 'ready'
      options.onSaved()
    } catch (err) {
      console.error('Save failed', err)
      phase.value = 'send-failed'
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden' && phase.value === 'recording') {
      void stop()
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (phase.value === 'recording') {
      void stop()
    } else {
      releaseDevices()
    }
    if (audioUrl.value) {
      URL.revokeObjectURL(audioUrl.value)
    }
  })

  return { phase, elapsedMs, maxMs, sendPercent, audioUrl, record, stop, tryAgain, send }
}
