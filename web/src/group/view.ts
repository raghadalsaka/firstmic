import type { GroupMember, GroupState, TakeStatus } from './types'

export type GroupView = 'waiting-partner' | 'partner-away' | 'ready' | 'sent' | TakeStatus

export interface GroupViewState {
  view: GroupView
  partner: GroupMember | null
  /** The student whose Stop, Send and Try Again count for the current take. */
  controller: GroupMember | null
  canControl: boolean
}

/**
 * What the record screen shows, from the server's group state. `dismissedSentId` is the sent take this device
 * moved past with Try Again; the partner keeps seeing Sent! until one of them taps Record.
 */
export function groupView(state: GroupState, selfId: string, dismissedSentId: string | null): GroupViewState {
  const partner = state.members.find((member) => member.participantId !== selfId) ?? null
  const take = state.take
  if (take) {
    const controller = state.members.find((member) => member.participantId === take.controllerId) ?? null
    return { view: take.status, partner, controller, canControl: take.controllerId === selfId }
  }
  const idle = { partner, controller: null, canControl: true }
  if (!partner) {
    return { view: 'waiting-partner', ...idle }
  }
  if (state.sent && state.sent.takeId !== dismissedSentId) {
    return { view: 'sent', ...idle }
  }
  if (!partner.online) {
    return { view: 'partner-away', ...idle }
  }
  return { view: 'ready', ...idle }
}
