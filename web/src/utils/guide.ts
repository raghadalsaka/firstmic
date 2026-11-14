// Mirrors TopicGuide in server/src/lib/topic-guide.ts.
export interface TopicGuide {
  prompt: string | null
  solo: string | null
  partner: string | null
  language: string | null
}

/** Which screen shows the guide: picking how to record shows every section; a recording screen only its own. */
export type GuideMode = 'all' | 'solo' | 'partner'

export interface GuideSection {
  key: keyof TopicGuide
  label: string
  text: string
}

export const GUIDE_KEYS: readonly (keyof TopicGuide)[] = ['prompt', 'solo', 'partner', 'language']

export const GUIDE_LABELS: Record<keyof TopicGuide, string> = {
  prompt: 'Podcast Prompt',
  solo: 'Solo Guide',
  partner: 'Partner Guide',
  language: 'Language Challenge',
}

const SECTIONS_BY_MODE: Record<GuideMode, readonly (keyof TopicGuide)[]> = {
  all: GUIDE_KEYS,
  solo: ['prompt', 'solo', 'language'],
  partner: ['prompt', 'partner', 'language'],
}

/** The sections with text for the mode, in reading order; empty when there's nothing to show. */
export function guideSections(guide: TopicGuide | null | undefined, mode: GuideMode): GuideSection[] {
  if (!guide) {
    return []
  }
  return SECTIONS_BY_MODE[mode].flatMap((key) => {
    const text = guide[key]?.trim()
    return text ? [{ key, label: GUIDE_LABELS[key], text }] : []
  })
}

// Desktop grid while the guide is open: title across the top, guide box on the left, Hide button and controls on the right.
export const GUIDE_SPLIT: Record<'layout' | 'title' | 'guide' | 'toggle' | 'panel' | 'controls', string> = {
  layout: 'lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_auto_minmax(0,1fr)] lg:items-start lg:gap-x-12',
  title: 'lg:col-span-2',
  guide: 'lg:contents',
  toggle: 'lg:col-start-2 lg:row-start-2 lg:justify-self-center',
  panel: 'lg:col-start-1 lg:row-span-2 lg:row-start-2 lg:max-h-none lg:min-h-0 lg:self-stretch lg:p-5',
  controls: 'lg:col-start-2 lg:row-start-3 lg:flex lg:flex-col lg:items-center',
}

export function hasGuide(guide: TopicGuide | null | undefined): boolean {
  return GUIDE_KEYS.some((key) => Boolean(guide?.[key]?.trim()))
}
