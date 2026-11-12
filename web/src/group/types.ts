// Mirrors GroupSnapshot in server/src/lib/groups.ts.
export type TakeStatus = 'recording' | 'mixing' | 'listening' | 'failed'

export interface GroupMember {
  participantId: string
  name: string
  emoji: string | null
  photo: string | null
  online: boolean
}

export interface GroupTake {
  id: string
  status: TakeStatus
  /** Who may Stop, Send or Try Again right now; the server hands control over when the starter leaves the call. */
  controllerId: string
  startedAtMs: number
  durationMs: number | null
}

export interface GroupState {
  id: string
  pin: string
  topic: { id: string; title: string } | null
  members: GroupMember[]
  take: GroupTake | null
  sent: { takeId: string; version: number; durationMs: number | null; sentAt: number } | null
}

export interface GroupAccess {
  groupId: string
  token: string
}
