import { describe, expect, it } from 'vitest'
import { EMOJI_POOL, nextEmoji, normalizeName, normalizePin, validateStudent } from '../../src/utils/roster'

describe('normalizeName', () => {
  it('collapses spaces and keeps letters from any script', () => {
    expect(normalizeName('  Amira   Haddad ')).toEqual({ ok: true, name: 'Amira Haddad' })
    expect(normalizeName('سارة')).toEqual({ ok: true, name: 'سارة' })
  })

  it('refuses empty names and names without letters', () => {
    expect(normalizeName('   ').ok).toBe(false)
    expect(normalizeName('12345').ok).toBe(false)
  })
})

describe('normalizePin', () => {
  it('accepts exactly six digits and treats empty as "make one"', () => {
    expect(normalizePin(' 012345 ')).toEqual({ ok: true, pin: '012345' })
    expect(normalizePin('')).toEqual({ ok: true, pin: null })
  })

  it('refuses anything else', () => {
    expect(normalizePin('12345').ok).toBe(false)
    expect(normalizePin('1234567').ok).toBe(false)
    expect(normalizePin('12a456').ok).toBe(false)
  })
})

describe('validateStudent', () => {
  const base = { name: 'Sara', emoji: '🦊', pin: '', photo: null }

  it('leaves the PIN out when the teacher wants one made', () => {
    expect(validateStudent(base, new Set())).toEqual({ ok: true, student: { name: 'Sara', emoji: '🦊', photo: null } })
  })

  it('refuses a PIN another student in the class already has', () => {
    const result = validateStudent({ ...base, pin: '111111' }, new Set(['111111']))
    expect(result).toEqual({ ok: false, error: 'Another student in this class already has that PIN.' })
  })

  it('refuses a missing emoji', () => {
    expect(validateStudent({ ...base, emoji: ' ' }, new Set()).ok).toBe(false)
  })
})

describe('nextEmoji', () => {
  it('suggests the first emoji nobody has yet', () => {
    expect(nextEmoji([])).toBe(EMOJI_POOL[0])
    expect(nextEmoji([EMOJI_POOL[0] as string])).toBe(EMOJI_POOL[1])
  })
})
