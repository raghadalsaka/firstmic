import { describe, expect, it } from 'vitest'
import { MAX_TOTAL, parseClock, parseGradesFile, totalOf } from '../../src/utils/grading'
import { topPath } from '../../src/utils/slug'

const scores = { content: 4, organization: 3, delivery: 2, language: 1 }

describe('grading helpers', () => {
  it('totals the four criteria out of 16', () => {
    expect(totalOf(scores)).toBe(10)
    expect(MAX_TOTAL).toBe(16)
  })

  it('reads m:ss and plain seconds, and refuses anything else', () => {
    expect(parseClock('0:42')).toBe(42_000)
    expect(parseClock('1:05')).toBe(65_000)
    expect(parseClock('75')).toBe(75_000)
    expect(parseClock(' 2:00 ')).toBe(120_000)
    expect(parseClock('1:75')).toBeNull()
    expect(parseClock('abc')).toBeNull()
    expect(parseClock('')).toBeNull()
  })

  it('puts the Top 3 page beside the class page', () => {
    expect(topPath('tok', 'Class 6B')).toBe('/top/tok/class-6b')
    expect(topPath('tok', '!!!')).toBe('/top/tok')
  })
})

describe('parseGradesFile', () => {
  it('reads a valid file, trimming notes and dropping an empty comment', () => {
    const file = JSON.stringify({
      grades: [
        { submissionId: 'a', scores, highlights: [{ startMs: 1000, endMs: 5000, note: ' Great opening ' }], comment: '  ' },
        { submissionId: 'b', scores },
      ],
    })
    const { grades, problems } = parseGradesFile(file)
    expect(problems).toEqual([])
    expect(grades).toEqual([
      { submissionId: 'a', scores, highlights: [{ startMs: 1000, endMs: 5000, note: 'Great opening' }], comment: null },
      { submissionId: 'b', scores, highlights: [], comment: null },
    ])
  })

  it('names each bad grade and keeps the good ones', () => {
    const file = JSON.stringify({
      grades: [
        { submissionId: 'a', scores: { ...scores, delivery: 5 } },
        { submissionId: 'b', scores, highlights: [{ startMs: 5000, endMs: 1000, note: 'backwards' }] },
        { scores },
        { submissionId: 'c', scores },
      ],
    })
    const { grades, problems } = parseGradesFile(file)
    expect(grades.map((grade) => grade.submissionId)).toEqual(['c'])
    expect(problems).toHaveLength(3)
    expect(problems[0]).toMatch(/^Grade 1:/)
    expect(problems[2]).toMatch(/^Grade 3: missing submissionId/)
  })

  it('refuses something that is not a grades file', () => {
    expect(parseGradesFile('not json').problems[0]).toMatch(/not valid JSON/)
    expect(parseGradesFile('{"grades": []}').problems[0]).toMatch(/no "grades" list/)
  })
})
