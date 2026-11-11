import { SEND_DEADLINE_MS, SUBMISSION_POLL_MS } from '../config'
import { api, ApiError } from '../services/api'
import type { FinishedTake } from './local-take'
import { uploadChunks, wait } from './upload-manager'

export class EpisodeGoneError extends Error {}

export class SendFailedError extends Error {}

export type SendOptions = {
  onProgress?: (percent: number) => void
  sleep?: (ms: number) => Promise<void>
  deadlineMs?: number
}

type SubmissionStatus = 'sending' | 'ready' | 'failed' | 'replaced'

/** Uploads the take as a new submission and waits until the server has made it the current one. */
export async function sendTake(take: FinishedTake, token: string, options: SendOptions = {}): Promise<{ version: number }> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? SEND_DEADLINE_MS)
  const signal = deadline.signal
  const sleep = options.sleep ?? ((ms: number) => wait(ms, signal))
  try {
    let created: { submissionId: string; trackId: string }
    try {
      created = await api('/api/student/submissions', {
        token,
        body: { mimeType: take.mimeType, durationMs: take.durationMs },
        signal,
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new EpisodeGoneError('This episode no longer exists')
      }
      throw err
    }

    const uploaded = await uploadChunks({ trackId: created.trackId, token }, take.chunks, take.durationMs, {
      onProgress: options.onProgress,
      sleep,
      signal,
    })
    if (uploaded !== 'complete') {
      throw new SendFailedError(`The upload was ${uploaded}`)
    }

    while (!signal.aborted) {
      const status = await api<{ status: SubmissionStatus; version: number | null }>(
        `/api/student/submissions/${created.submissionId}`,
        { token, signal },
      )
      if (status.status === 'ready' && status.version !== null) {
        return { version: status.version }
      }
      if (status.status !== 'sending') {
        throw new SendFailedError(`The submission ended as ${status.status}`)
      }
      await sleep(SUBMISSION_POLL_MS)
    }
    throw new SendFailedError('The server did not finish the recording in time')
  } finally {
    clearTimeout(timer)
  }
}
