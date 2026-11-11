import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { chunkStore } from '../../src/recorder/chunk-store'
import { discardTake, loadStoredTake, pickAudioMimeType, TakeRecorder } from '../../src/recorder/local-take'
import { FakeClock, FakeRecorder } from './helpers'

const stream = {} as MediaStream

function makeRecorder(maxMs: number) {
  const clock = new FakeClock()
  const fake = new FakeRecorder('audio/webm;codecs=opus')
  const onAutoStop = vi.fn()
  const take = new TakeRecorder({ maxMs, onAutoStop, clock, createRecorder: () => fake })
  return { clock, fake, onAutoStop, take }
}

describe('pickAudioMimeType', () => {
  it('prefers opus webm and falls back to mp4 for Safari', () => {
    expect(pickAudioMimeType(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickAudioMimeType((mime) => mime === 'audio/mp4')).toBe('audio/mp4')
    expect(pickAudioMimeType(() => false)).toBeNull()
  })
})

describe('TakeRecorder', () => {
  it('asks to stop when the time limit is reached and caps the duration', async () => {
    const { clock, fake, onAutoStop, take } = makeRecorder(180_000)
    await take.start(stream, 'audio/webm;codecs=opus')
    fake.emit('a')
    clock.advance(179_999)
    expect(onAutoStop).not.toHaveBeenCalled()
    clock.advance(5_000)
    expect(onAutoStop).toHaveBeenCalledTimes(1)

    const finished = await take.stop()
    expect(finished.durationMs).toBe(180_000)
    expect(finished.chunks).toHaveLength(2)
  })

  it('reports a whole-millisecond duration, which the server requires', async () => {
    const { clock, take } = makeRecorder(60_000)
    await take.start(stream, 'audio/webm')
    clock.advance(4_321.789)
    const finished = await take.stop()
    expect(finished.durationMs).toBe(4_322)
    expect((await chunkStore.getTrack(finished.localId))?.durationMs).toBe(4_322)
  })

  it('does not auto-stop after a manual stop', async () => {
    const { clock, onAutoStop, take } = makeRecorder(10_000)
    await take.start(stream, 'audio/webm')
    clock.advance(4_000)
    const finished = await take.stop()
    clock.advance(20_000)
    expect(onAutoStop).not.toHaveBeenCalled()
    expect(finished.durationMs).toBe(4_000)
  })

  it('persists every chunk so a stopped take survives a reload, and Try Again removes it', async () => {
    const { clock, fake, take } = makeRecorder(60_000)
    await take.start(stream, 'audio/webm')
    fake.emit('one')
    fake.emit('two')
    clock.advance(7_000)
    const finished = await take.stop()

    const restored = await loadStoredTake(finished.localId)
    expect(restored?.chunks).toHaveLength(3)
    expect(restored?.durationMs).toBe(7_000)

    await discardTake(finished)
    expect(await chunkStore.getTrack(finished.localId)).toBeNull()
    expect(await loadStoredTake(finished.localId)).toBeNull()
  })
})
