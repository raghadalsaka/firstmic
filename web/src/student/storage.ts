import type { PublicStudent } from '../types/roster'

export type StoredEpisode = { episodeId: string; token: string }

function key(classToken: string, suffix: string): string {
  return `firstmic:${classToken}:${suffix}`
}

function read(name: string): string | null {
  try {
    return localStorage.getItem(name)
  } catch {
    return null
  }
}

function write(name: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(name)
    } else {
      localStorage.setItem(name, value)
    }
  } catch {
    // Storage blocked (private mode): the student picks their name and types their PIN again next time.
  }
}

export type StoredLogin = { studentToken: string; student: PublicStudent }

export function loadLogin(classToken: string): StoredLogin | null {
  const raw = read(key(classToken, 'login'))
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLogin>
    if (typeof parsed.studentToken === 'string' && typeof parsed.student?.id === 'string') {
      return parsed as StoredLogin
    }
    return null
  } catch {
    return null
  }
}

export function saveLogin(classToken: string, login: StoredLogin): void {
  write(key(classToken, 'login'), JSON.stringify(login))
}

/** "Not you?": forgets the sign-in and every episode this device opened for the class. */
export function forgetStudent(classToken: string): void {
  try {
    const prefix = key(classToken, '')
    const names: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(prefix)) {
        names.push(name)
      }
    }
    names.forEach((name) => localStorage.removeItem(name))
  } catch {
    // Nothing stored.
  }
}

export function loadEpisode(classToken: string, topicId: string): StoredEpisode | null {
  const raw = read(key(classToken, `episode:${topicId}`))
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEpisode>
    if (typeof parsed.episodeId === 'string' && typeof parsed.token === 'string') {
      return { episodeId: parsed.episodeId, token: parsed.token }
    }
    return null
  } catch {
    return null
  }
}

export function saveEpisode(classToken: string, topicId: string, episode: StoredEpisode | null): void {
  write(key(classToken, `episode:${topicId}`), episode ? JSON.stringify(episode) : null)
}

export function loadPendingTake(classToken: string, topicId: string): string | null {
  return read(key(classToken, `take:${topicId}`))
}

export function savePendingTake(classToken: string, topicId: string, localId: string | null): void {
  write(key(classToken, `take:${topicId}`), localId)
}
