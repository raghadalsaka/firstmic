import { describe, expect, it } from 'vitest'
import type { GroupMember, GroupState, GroupTake } from '../../src/group/types'
import { groupView } from '../../src/group/view'

function member(participantId: string, online = true): GroupMember {
  return { participantId, name: participantId, emoji: '🦊', photo: null, online }
}

function take(status: GroupTake['status'], controllerId = 'ali'): GroupTake {
  return { id: 'take-1', status, controllerId, startedAtMs: 0, durationMs: null }
}

function state(patch: Partial<GroupState> = {}): GroupState {
  return { id: 'g', pin: '123456', topic: null, members: [member('ali'), member('sara')], take: null, sent: null, pastFeedback: [], ...patch }
}

const sent = { takeId: 'take-0', version: 1, durationMs: 5000, sentAt: 1, feedback: null }

describe('groupView', () => {
  it('waits for a partner until someone joins with the PIN', () => {
    expect(groupView(state({ members: [member('ali')] }), 'ali', null).view).toBe('waiting-partner')
  })

  it('waits for a partner who joined but is not in the call', () => {
    const view = groupView(state({ members: [member('ali'), member('sara', false)] }), 'ali', null)
    expect(view.view).toBe('partner-away')
    expect(view.partner?.participantId).toBe('sara')
  })

  it('is ready to record when both are in the call', () => {
    expect(groupView(state(), 'sara', null).view).toBe('ready')
  })

  it('gives control of a take only to the student who started it', () => {
    const recording = state({ take: take('recording', 'ali') })
    expect(groupView(recording, 'ali', null)).toMatchObject({ view: 'recording', canControl: true })
    expect(groupView(recording, 'sara', null)).toMatchObject({ view: 'recording', canControl: false })
    expect(groupView(recording, 'sara', null).controller?.participantId).toBe('ali')
  })

  it('follows the server when it hands control to the partner', () => {
    const listening = state({ members: [member('ali', false), member('sara')], take: take('listening', 'sara') })
    expect(groupView(listening, 'sara', null)).toMatchObject({ view: 'listening', canControl: true })
    expect(groupView(listening, 'ali', null)).toMatchObject({ view: 'listening', canControl: false })
  })

  it('shows an open take before a sent one', () => {
    expect(groupView(state({ take: take('mixing'), sent }), 'ali', null).view).toBe('mixing')
  })

  it('shows Sent! until this device taps Try Again, then Record again', () => {
    expect(groupView(state({ sent }), 'ali', null).view).toBe('sent')
    expect(groupView(state({ sent }), 'ali', 'take-0').view).toBe('ready')
    expect(groupView(state({ sent: { ...sent, takeId: 'take-2' } }), 'ali', 'take-0').view).toBe('sent')
  })
})
