import { describe, expect, it } from 'vitest'
import { classPath, slugify } from '../../src/utils/slug'

describe('slugify', () => {
  it('turns a class name into a lowercase hyphenated slug', () => {
    expect(slugify('Grade 6B')).toBe('grade-6b')
    expect(slugify('  Ms. Raghad’s  Class (2026)! ')).toBe('ms-raghad-s-class-2026')
  })

  it('keeps non-Latin letters', () => {
    expect(slugify('الصف السادس ب')).toBe('الصف-السادس-ب')
  })

  it('returns an empty slug when nothing readable is left', () => {
    expect(slugify('!!! ???')).toBe('')
  })

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(59)} b`)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('classPath', () => {
  it('puts the slug after the private token', () => {
    expect(classPath('abc123', 'Grade 6B')).toBe('/c/abc123/grade-6b')
  })

  it('percent-encodes non-Latin slugs and drops an empty one', () => {
    expect(classPath('abc123', 'الصف')).toBe(`/c/abc123/${encodeURIComponent('الصف')}`)
    expect(classPath('abc123', '???')).toBe('/c/abc123')
  })
})
