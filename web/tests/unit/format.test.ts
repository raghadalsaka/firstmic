import { describe, expect, it } from 'vitest'
import { formatClock } from '../../src/utils/format'

describe('formatClock', () => {
  it('shows minutes and zero-padded seconds', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9_999)).toBe('0:09')
    expect(formatClock(180_000)).toBe('3:00')
    expect(formatClock(-5)).toBe('0:00')
  })
})
