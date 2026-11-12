export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** A sent version's label, when it was sent and, if known, how long it is: "Version 2 · Nov 12, 5:05 PM · 0:10". */
export function describeVersion(label: string, sentAt: number, durationMs: number | null): string {
  const parts = [label, formatDateTime(sentAt)]
  return (durationMs === null ? parts : [...parts, formatClock(durationMs)]).join(' · ')
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
