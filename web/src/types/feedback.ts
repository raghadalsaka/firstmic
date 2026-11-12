// Mirrors PastFeedback in server/src/lib/feedback.ts.
export interface PastFeedback {
  id: string
  version: number
  sentAt: number
  durationMs: number | null
  feedback: string
}
