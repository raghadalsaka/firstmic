import { api, ApiError } from '../services/api'

export type UploadTarget = { trackId: string; token: string }

export type UploadResult = 'complete' | 'rejected' | 'aborted'

export type UploadOptions = {
  onProgress?: (percent: number) => void
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const RETRYABLE_CLIENT_ERRORS: readonly number[] = [408, 429]

/** A 4xx other than timeout/rate-limit means the server will refuse every retry. */
function isRejection(status: number): boolean {
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_ERRORS.includes(status)
}

/** Resolves after `ms`, or as soon as the signal aborts. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Uploads a finished take's chunks in order, retrying with backoff, then finalizes the server track.
 * The server ignores a chunk index it already holds, so a retried PUT never duplicates audio.
 */
export async function uploadChunks(
  target: UploadTarget,
  chunks: readonly Blob[],
  durationMs: number,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { onProgress, signal } = options
  const sleep = options.sleep ?? ((ms: number) => wait(ms, signal))
  let backoffMs = INITIAL_BACKOFF_MS
  const backOff = async (): Promise<void> => {
    await sleep(backoffMs)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  }

  const totalBytes = chunks.reduce((sum, blob) => sum + blob.size, 0)
  let uploadedBytes = 0
  for (const [idx, blob] of chunks.entries()) {
    for (;;) {
      if (signal?.aborted) {
        return 'aborted'
      }
      let status = 0
      try {
        const res = await fetch(`/api/tracks/${target.trackId}/chunks/${idx}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${target.token}` },
          body: blob,
          signal,
        })
        status = res.status
      } catch {
        status = 0
      }
      if (status >= 200 && status < 300) {
        uploadedBytes += blob.size
        backoffMs = INITIAL_BACKOFF_MS
        onProgress?.(totalBytes === 0 ? 100 : Math.round((uploadedBytes / totalBytes) * 100))
        break
      }
      if (isRejection(status)) {
        return 'rejected'
      }
      await backOff()
    }
  }

  for (;;) {
    if (signal?.aborted) {
      return 'aborted'
    }
    try {
      await api(`/api/tracks/${target.trackId}/finalize`, {
        token: target.token,
        body: { finalChunkCount: chunks.length, durationMs },
        signal,
      })
      return 'complete'
    } catch (err) {
      if (err instanceof ApiError && isRejection(err.status)) {
        return 'rejected'
      }
    }
    await backOff()
  }
}
