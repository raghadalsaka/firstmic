/** MediaRecorder timeslice; keeps chunks small enough to retry a failed upload cheaply. */
export const CHUNK_MS = 3000

export const AUDIO_BITS_PER_SECOND = 128_000

export const AUDIO_MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
]

/** Below this length the record screen suggests going for at least two minutes. */
export const SUGGESTED_MIN_SECONDS = 120

export const SUBMISSION_POLL_MS = 1500

/** How long Send waits for upload plus processing before telling the student it didn't work. */
export const SEND_DEADLINE_MS = 5 * 60 * 1000

/** Matches FEEDBACK_MAX_CHARS in server/src/lib/feedback.ts. */
export const MAX_FEEDBACK_LENGTH: number = 2000

// Roster limits match QuestRush and the server (server/src/lib/roster.ts).
export const MAX_NAME_LENGTH: number = 60
export const MAX_EMOJI_LENGTH: number = 16
export const MAX_STUDENTS: number = 200
export const PIN_LENGTH: number = 6
export const MAX_PHOTO_LENGTH: number = 45000
export const PHOTO_SIZE_PX: number = 160
export const PHOTO_QUALITIES: readonly number[] = [0.85, 0.7, 0.5]
