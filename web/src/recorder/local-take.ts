import { AUDIO_BITS_PER_SECOND, AUDIO_MIME_CANDIDATES, CHUNK_MS } from '../config'
import { chunkStore } from './chunk-store'

export type FinishedTake = {
  localId: string
  mimeType: string
  durationMs: number
  chunks: Blob[]
}

export type Clock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type RecorderLike = {
  readonly mimeType: string
  state: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(timeslice: number): void
  stop(): void
}

export type CreateRecorder = (stream: MediaStream, mimeType: string) => RecorderLike

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
}

export function pickAudioMimeType(isSupported: (mime: string) => boolean): string | null {
  return AUDIO_MIME_CANDIDATES.find((mime) => isSupported(mime)) ?? null
}

const createMediaRecorder: CreateRecorder = (stream, mimeType) =>
  new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }) as unknown as RecorderLike

/** Records one take: MediaRecorder chunks, persisted to IndexedDB, stopped by the student or by the time limit. */
export class TakeRecorder {
  private recorder: RecorderLike | null = null
  private chunks: Blob[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private startedAt = 0
  private stoppedAt: number | null = null
  private limitTimer: unknown = null
  private stopPromise: Promise<FinishedTake> | null = null
  private localId = ''
  private requestedMimeType = ''
  private readonly maxMs: number
  private readonly onAutoStop: () => void
  private readonly clock: Clock
  private readonly createRecorder: CreateRecorder

  constructor(options: { maxMs: number; onAutoStop: () => void; clock?: Clock; createRecorder?: CreateRecorder }) {
    this.maxMs = options.maxMs
    this.onAutoStop = options.onAutoStop
    this.clock = options.clock ?? systemClock
    this.createRecorder = options.createRecorder ?? createMediaRecorder
  }

  async start(stream: MediaStream, mimeType: string): Promise<void> {
    if (this.recorder) {
      throw new Error('This take has already started')
    }
    this.localId = crypto.randomUUID()
    this.requestedMimeType = mimeType
    await chunkStore.putTrack({ localId: this.localId, mimeType, finalChunkCount: null, durationMs: null })

    const recorder = this.createRecorder(stream, mimeType)
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return
      }
      const idx = this.chunks.length
      this.chunks.push(event.data)
      this.writeChain = this.writeChain.then(() => chunkStore.putChunk(this.localId, idx, event.data))
    }
    this.recorder = recorder
    recorder.start(CHUNK_MS)
    this.startedAt = this.clock.now()
    this.limitTimer = this.clock.setTimeout(() => {
      if (this.stopPromise === null) {
        this.onAutoStop()
      }
    }, this.maxMs)
  }

  elapsedMs(): number {
    if (!this.recorder) {
      return 0
    }
    const end = this.stoppedAt ?? this.clock.now()
    return Math.round(Math.min(this.maxMs, Math.max(0, end - this.startedAt)))
  }

  stop(): Promise<FinishedTake> {
    if (this.stopPromise) {
      return this.stopPromise
    }
    const recorder = this.recorder
    if (!recorder) {
      return Promise.reject(new Error('Nothing is recording'))
    }
    this.clock.clearTimeout(this.limitTimer)
    this.stoppedAt = this.clock.now()
    this.stopPromise = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      if (recorder.state === 'inactive') {
        resolve()
      } else {
        recorder.stop()
      }
    })
      .then(() => this.writeChain)
      .then(async () => {
        const take: FinishedTake = {
          localId: this.localId,
          mimeType: recorder.mimeType || this.requestedMimeType,
          durationMs: this.elapsedMs(),
          chunks: [...this.chunks],
        }
        await chunkStore.putTrack({
          localId: take.localId,
          mimeType: take.mimeType,
          finalChunkCount: take.chunks.length,
          durationMs: take.durationMs,
        })
        return take
      })
    return this.stopPromise
  }
}

export async function discardTake(take: FinishedTake): Promise<void> {
  await chunkStore.deleteTrack(take.localId)
}

/** Rebuilds a stopped, unsent take that IndexedDB still holds, e.g. after the page reloaded before Send succeeded. */
export async function loadStoredTake(localId: string): Promise<FinishedTake | null> {
  const meta = await chunkStore.getTrack(localId)
  if (!meta || meta.finalChunkCount === null) {
    return null
  }
  const chunks = await chunkStore.getChunks(localId)
  if (chunks.length === 0 || chunks.length !== meta.finalChunkCount) {
    return null
  }
  return { localId, mimeType: meta.mimeType, durationMs: meta.durationMs ?? 0, chunks }
}
