// Mirrors server/src/lib/grades.ts.
export const CRITERIA = ['content', 'organization', 'delivery', 'language'] as const
export type Criterion = (typeof CRITERIA)[number]
export type Scores = Record<Criterion, number>
export type Highlight = { startMs: number; endMs: number; note: string }

export type Grade = {
  scores: Scores
  total: number
  highlights: Highlight[]
  comment: string | null
}

export type ClassRecording = {
  recordingKey: string
  submissionIds: string[]
  names: string[]
  topicTitle: string | null
  durationMs: number | null
  grade: Grade | null
  rank: number | null
}

export type GradesResponse = {
  class: { id: string; name: string; classToken: string; top3PublishedAt: number | null }
  recordings: ClassRecording[]
}

export type GradeInput = {
  submissionId: string
  scores: Scores
  highlights: Highlight[]
  comment: string | null
}

const MAX_LEVEL = 4
export const MAX_TOTAL: number = CRITERIA.length * MAX_LEVEL
export const MAX_HIGHLIGHTS = 5

export const CRITERION_LABELS: Record<Criterion, string> = {
  content: 'Content',
  organization: 'Organization',
  delivery: 'Delivery',
  language: 'Language',
}

/** What a student sees for levels 1 to 4; only the teacher sees the numbers. */
export const LEVEL_WORDS: readonly [string, string, string, string] = ['Keep practising', 'Good', 'Great', 'Excellent']

/** What each level means, from 1 (beginning) to 4 (excellent). */
export const RUBRIC: Record<Criterion, readonly [string, string, string, string]> = {
  content: [
    'Off topic, or only one idea',
    'Answers part of the prompt with few details',
    'Answers the prompt with some details or examples',
    'Fully answers the prompt with details, examples and personal stories',
  ],
  organization: [
    'No clear start or end; jumps around',
    'Some order, but the start or end is missing',
    'Has an intro, body and ending',
    'Clear intro, body and ending; ideas flow (partners take turns well)',
  ],
  delivery: [
    'Hard to hear or understand; long silences',
    'Often unclear, too fast or too slow',
    'Mostly clear with a steady pace',
    'Clear, steady pace, expressive and confident',
  ],
  language: [
    'Very limited words; many errors',
    'Simple words; errors get in the way',
    'Some topic words; a few errors',
    "Uses the guide's language focus and topic words; mostly accurate",
  ],
}

export function totalOf(scores: Scores): number {
  return CRITERIA.reduce((sum, criterion) => sum + scores[criterion], 0)
}

/** "1:05" or "65" (seconds) to milliseconds; null when it isn't a time. */
export function parseClock(text: string): number | null {
  const match = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!match) {
    return null
  }
  const minutes = Number(match[1] ?? 0)
  const seconds = Number(match[2])
  if (match[1] !== undefined && seconds >= 60) {
    return null
  }
  return Math.round((minutes * 60 + seconds) * 1000)
}

function isLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LEVEL
}

function readHighlight(value: unknown): Highlight | null {
  const item = value as Partial<Highlight> | null
  if (typeof item?.startMs !== 'number' || typeof item.endMs !== 'number' || typeof item.note !== 'string') {
    return null
  }
  if (item.startMs < 0 || item.endMs <= item.startMs || !item.note.trim()) {
    return null
  }
  return { startMs: Math.round(item.startMs), endMs: Math.round(item.endMs), note: item.note.trim() }
}

/**
 * Reads a grades file: {"grades": [{"submissionId", "scores": {content, organization, delivery, language},
 * "highlights": [{startMs, endMs, note}], "comment"}]}. The server checks the rest (the recordings and their lengths).
 */
export function parseGradesFile(text: string): { grades: GradeInput[]; problems: string[] } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { grades: [], problems: ['This file is not a grades file (it is not valid JSON).'] }
  }
  const list = (data as { grades?: unknown } | null)?.grades
  if (!Array.isArray(list) || list.length === 0) {
    return { grades: [], problems: ['This file has no "grades" list.'] }
  }
  const grades: GradeInput[] = []
  const problems: string[] = []
  list.forEach((value, index) => {
    const item = value as Partial<Record<keyof GradeInput, unknown>> | null
    const label = `Grade ${index + 1}`
    const scores = item?.scores as Partial<Scores> | undefined
    if (typeof item?.submissionId !== 'string' || !item.submissionId) {
      problems.push(`${label}: missing submissionId`)
      return
    }
    if (!scores || !CRITERIA.every((criterion) => isLevel(scores[criterion]))) {
      problems.push(`${label}: every score must be a whole number from 1 to ${MAX_LEVEL}`)
      return
    }
    const rawHighlights = Array.isArray(item.highlights) ? item.highlights : []
    const highlights = rawHighlights.map(readHighlight)
    if (highlights.some((highlight) => highlight === null) || highlights.length > MAX_HIGHLIGHTS) {
      problems.push(`${label}: highlights need a start, a later end and a note (up to ${MAX_HIGHLIGHTS})`)
      return
    }
    const comment = typeof item.comment === 'string' && item.comment.trim() ? item.comment.trim() : null
    grades.push({ submissionId: item.submissionId, scores: scores as Scores, highlights: highlights as Highlight[], comment })
  })
  return { grades, problems }
}
