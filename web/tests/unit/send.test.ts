import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TakeRecorder, type FinishedTake } from '../../src/recorder/local-take'
import { EpisodeGoneError, SendFailedError, sendTake } from '../../src/recorder/send'
import { uploadChunks } from '../../src/recorder/upload-manager'
import { FakeClock, FakeRecorder, jsonResponse } from './helpers'

async function recordTake(): Promise<FinishedTake> {
  const fake = new FakeRecorder('audio/webm')
  const take = new TakeRecorder({ maxMs: 60_000, onAutoStop: () => undefined, clock: new FakeClock(), createRecorder: () => fake })
  await take.start({} as MediaStream, 'audio/webm')
  fake.emit('chunk-0')
  return take.stop()
}

type Route = (url: string, init: RequestInit | undefined) => Response | undefined

function mockServer(route: Route) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return route(url, init) ?? jsonResponse({ error: 'unexpected' }, 500)
    }),
  )
  return calls
}

const noSleep = () => Promise.resolve()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendTake', () => {
  it('uploads every chunk, finalizes, and returns the new version once the server is ready', async () => {
    const take = await recordTake()
    let polls = 0
    const calls = mockServer((url, init) => {
      if (url === '/api/student/submissions') {
        return jsonResponse({ submissionId: 'sub1', trackId: 'trk1' })
      }
      if (url.startsWith('/api/tracks/trk1/chunks/') && init?.method === 'PUT') {
        return jsonResponse({ ok: true })
      }
      if (url === '/api/tracks/trk1/finalize') {
        return jsonResponse({ ok: true })
      }
      if (url === '/api/student/submissions/sub1') {
        polls++
        return jsonResponse(polls < 2 ? { status: 'sending', version: null } : { status: 'ready', version: 2 })
      }
      return undefined
    })

    const result = await sendTake(take, 'tok', { sleep: noSleep })
    expect(result.version).toBe(2)
    expect(calls).toEqual([
      'POST /api/student/submissions',
      'PUT /api/tracks/trk1/chunks/0',
      'PUT /api/tracks/trk1/chunks/1',
      'POST /api/tracks/trk1/finalize',
      'GET /api/student/submissions/sub1',
      'GET /api/student/submissions/sub1',
    ])
  })

  it('reports a server-side processing failure and can send the same take again', async () => {
    const take = await recordTake()
    let attempt = 0
    mockServer((url, init) => {
      if (url === '/api/student/submissions') {
        attempt++
        return jsonResponse({ submissionId: `sub${attempt}`, trackId: `trk${attempt}` })
      }
      if (url.includes('/chunks/') && init?.method === 'PUT') {
        return jsonResponse({ ok: true })
      }
      if (url.endsWith('/finalize')) {
        return jsonResponse({ ok: true })
      }
      if (url === '/api/student/submissions/sub1') {
        return jsonResponse({ status: 'failed', version: null })
      }
      if (url === '/api/student/submissions/sub2') {
        return jsonResponse({ status: 'ready', version: 1 })
      }
      return undefined
    })

    await expect(sendTake(take, 'tok', { sleep: noSleep })).rejects.toBeInstanceOf(SendFailedError)
    const retried = await sendTake(take, 'tok', { sleep: noSleep })
    expect(retried.version).toBe(1)
  })

  it('tells the caller when the episode was deleted so it can start a new one', async () => {
    const take = await recordTake()
    mockServer((url) => (url === '/api/student/submissions' ? jsonResponse({ error: 'gone' }, 401) : undefined))
    await expect(sendTake(take, 'tok', { sleep: noSleep })).rejects.toBeInstanceOf(EpisodeGoneError)
  })

  it('gives up when the upload cannot finish before the deadline', async () => {
    const take = await recordTake()
    mockServer((url) => {
      if (url === '/api/student/submissions') {
        return jsonResponse({ submissionId: 's', trackId: 't' })
      }
      return jsonResponse({ error: 'down' }, 503)
    })
    await expect(sendTake(take, 'tok', { deadlineMs: 50 })).rejects.toBeInstanceOf(SendFailedError)
  })
})

describe('uploadChunks', () => {
  const chunks = [new Blob(['a']), new Blob(['b'])]

  it('retries a failed finalize instead of stalling', async () => {
    let finalizeAttempts = 0
    mockServer((url) => {
      if (url.endsWith('/finalize')) {
        finalizeAttempts++
        return finalizeAttempts < 3 ? jsonResponse({ error: 'busy' }, 503) : jsonResponse({ ok: true })
      }
      return jsonResponse({ ok: true })
    })
    expect(await uploadChunks({ trackId: 'trk', token: 'tok' }, chunks, 1000, { sleep: noSleep })).toBe('complete')
    expect(finalizeAttempts).toBe(3)
  })

  it('stops instead of retrying forever when the server rejects the upload', async () => {
    let finalizeAttempts = 0
    mockServer((url) => {
      if (url.endsWith('/finalize')) {
        finalizeAttempts++
        return jsonResponse({ error: 'Invalid finalize payload' }, 400)
      }
      return jsonResponse({ ok: true })
    })
    expect(await uploadChunks({ trackId: 'trk', token: 'tok' }, chunks, 1000, { sleep: noSleep })).toBe('rejected')
    expect(finalizeAttempts).toBe(1)
  })

  it('retries a chunk after a network error and reports progress', async () => {
    let firstChunkAttempts = 0
    const progress: number[] = []
    mockServer((url) => {
      if (url.endsWith('/chunks/0')) {
        firstChunkAttempts++
        if (firstChunkAttempts === 1) {
          throw new TypeError('network down')
        }
      }
      return jsonResponse({ ok: true })
    })
    const result = await uploadChunks({ trackId: 'trk', token: 'tok' }, chunks, 1000, {
      sleep: noSleep,
      onProgress: (percent) => progress.push(percent),
    })
    expect(result).toBe('complete')
    expect(firstChunkAttempts).toBe(2)
    expect(progress).toEqual([50, 100])
  })
})
