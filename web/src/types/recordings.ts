// Mirrors GET /api/class/:classToken/recordings in server/src/routes/student.ts.
export interface MyRecording {
  id: string
  topicTitle: string | null
  /** A copy of a group podcast: the partners' names. Null for a recording made alone. */
  withNames: string | null
  savedAt: number
  durationMs: number | null
}

export interface MyRecordings {
  recordings: MyRecording[]
  submittedId: string | null
  /** Epoch ms after which the submission can't change; null for no deadline. */
  deadline: number | null
  /** Whether the student can still submit or change their submission (the server checks the deadline). */
  open: boolean
}
