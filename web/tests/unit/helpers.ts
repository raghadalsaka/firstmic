import type { Clock, RecorderLike } from '../../src/recorder/local-take'

export class FakeClock implements Clock {
  private current = 0
  private timers: { at: number; fn: () => void; id: number }[] = []
  private nextId = 1

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ at: this.current + ms, fn, id })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle)
  }

  advance(ms: number): void {
    this.current += ms
    const due = this.timers.filter((timer) => timer.at <= this.current)
    this.timers = this.timers.filter((timer) => timer.at > this.current)
    due.forEach((timer) => timer.fn())
  }
}

export class FakeRecorder implements RecorderLike {
  readonly mimeType: string
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(mimeType: string) {
    this.mimeType = mimeType
  }

  start(): void {
    this.state = 'recording'
  }

  emit(text: string): void {
    this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) })
  }

  stop(): void {
    this.emit('last')
    this.state = 'inactive'
    queueMicrotask(() => this.onstop?.())
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
