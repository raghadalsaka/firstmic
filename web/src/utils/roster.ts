// Name and emoji rules from QuestRush's src/utils/roster.ts, plus the 6-digit PIN First Mic adds.
// The server (server/src/lib/roster.ts) applies the same rules, so the form predicts what is accepted.
import { MAX_EMOJI_LENGTH, MAX_NAME_LENGTH, PIN_LENGTH } from '../config'
import type { NewStudent } from '../types/roster'

export const EMOJI_POOL: readonly string[] = [
  '🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦉', '🐢', '🐬', '🦄', '🐝', '🦋', '🐧', '🐨', '🦒', '🐘', '🦓', '🐳', '🦜', '🐞',
  '🦀', '🦔', '🐻', '🐰', '🐮', '🐷', '🐵', '🦩', '🦦', '🦥', '🐿️', '🦭', '🐊', '🦚', '🐌', '🦕', '🦖', '🐠', '🦅', '🐺',
]

export function normalizeName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim().split(/\s+/u).join(' ')
  if (name === '') {
    return { ok: false, reason: 'is empty' }
  }
  if ([...name].length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_NAME_LENGTH} characters` }
  }
  if (/\p{Cc}/u.test(name)) {
    return { ok: false, reason: 'contains control characters' }
  }
  if (!/\p{L}/u.test(name)) {
    return { ok: false, reason: 'has no letters, so it does not look like a name' }
  }
  return { ok: true, name }
}

export function emojiChoices(current: string): readonly string[] {
  return EMOJI_POOL.includes(current) ? EMOJI_POOL : [current, ...EMOJI_POOL]
}

export function isValidEmoji(raw: string): boolean {
  const emoji = raw.trim()
  return (
    emoji !== '' &&
    [...emoji].length <= MAX_EMOJI_LENGTH &&
    new TextEncoder().encode(emoji).length <= MAX_EMOJI_LENGTH * 4 &&
    !/[\s\p{Cc}]/u.test(emoji)
  )
}

/** The first emoji nobody in the class has yet, then the pool again. */
export function nextEmoji(taken: readonly string[]): string {
  const takenSet = new Set(taken)
  return EMOJI_POOL.find((emoji) => !takenSet.has(emoji)) ?? (EMOJI_POOL[taken.length % EMOJI_POOL.length] as string)
}

export type PinResult = { ok: true; pin: string | null } | { ok: false; reason: string }

export function isPin(value: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(value)
}

/** Empty means "make one for me" (null). */
export function normalizePin(raw: string): PinResult {
  const value = raw.trim()
  if (value === '') {
    return { ok: true, pin: null }
  }
  if (!isPin(value)) {
    return { ok: false, reason: `must be ${PIN_LENGTH} digits` }
  }
  return { ok: true, pin: value }
}

/** Checks the add/edit form; `pinsInUse` are the other students' PINs in the class. */
export function validateStudent(
  input: { name: string; emoji: string; pin: string; photo: string | null },
  pinsInUse: ReadonlySet<string>,
): { ok: true; student: NewStudent } | { ok: false; error: string } {
  const name = normalizeName(input.name)
  if (!name.ok) {
    return { ok: false, error: `The name ${name.reason}.` }
  }
  if (!isValidEmoji(input.emoji)) {
    return { ok: false, error: 'Choose one emoji.' }
  }
  const pin = normalizePin(input.pin)
  if (!pin.ok) {
    return { ok: false, error: `The PIN ${pin.reason}.` }
  }
  if (pin.pin !== null && pinsInUse.has(pin.pin)) {
    return { ok: false, error: 'Another student in this class already has that PIN.' }
  }
  const student: NewStudent = { name: name.name, emoji: input.emoji.trim(), photo: input.photo }
  if (pin.pin !== null) {
    student.pin = pin.pin
  }
  return { ok: true, student }
}
