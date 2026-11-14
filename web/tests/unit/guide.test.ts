import { describe, expect, it } from 'vitest'
import { guideSections, hasGuide, type TopicGuide } from '../../src/utils/guide'

const emptyGuide = (): TopicGuide => ({ prompt: null, solo: null, partner: null, language: null })

const full: TopicGuide = {
  prompt: 'Describe an outfit.\nWhy did you choose it?',
  solo: 'Start with "My favourite thing to wear in winter is..."',
  partner: 'Take turns describing what you wear.',
  language: 'Use "put on" and "take off."',
}

const keys = (guide: TopicGuide | null | undefined, mode: 'all' | 'solo' | 'partner'): string[] =>
  guideSections(guide, mode).map((section) => section.key)

describe('guideSections', () => {
  it('shows every section when picking how to record', () => {
    expect(keys(full, 'all')).toEqual(['prompt', 'solo', 'partner', 'language'])
  })

  it('shows only the solo guide when recording alone, and only the partner guide with a partner', () => {
    expect(keys(full, 'solo')).toEqual(['prompt', 'solo', 'language'])
    expect(keys(full, 'partner')).toEqual(['prompt', 'partner', 'language'])
  })

  it('keeps line breaks and labels each section', () => {
    expect(guideSections(full, 'solo')[0]).toEqual({ key: 'prompt', label: 'Podcast Prompt', text: full.prompt })
  })

  it('hides empty or blank sections', () => {
    expect(keys({ ...full, solo: '   ', language: null }, 'solo')).toEqual(['prompt'])
  })

  it('has nothing to show for a topic without a guide', () => {
    expect(guideSections(emptyGuide(), 'all')).toEqual([])
    expect(guideSections(undefined, 'partner')).toEqual([])
    expect(keys({ ...emptyGuide(), partner: 'Ask a question.' }, 'solo')).toEqual([])
  })

  it('says whether a topic has any guidance', () => {
    expect(hasGuide(full)).toBe(true)
    expect(hasGuide({ ...emptyGuide(), language: 'Use it.' })).toBe(true)
    expect(hasGuide({ ...emptyGuide(), solo: '  ' })).toBe(false)
    expect(hasGuide(undefined)).toBe(false)
  })
})
