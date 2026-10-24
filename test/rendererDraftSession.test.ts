import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findDraft, planNewSession, type DraftCandidate } from '../src/desktop/renderer/model/draftSession.js'

function lane(id: string, overrides: Partial<DraftCandidate> = {}): DraftCandidate {
  return { lane: id, projectRoot: '/a', hasConversation: false, coordinated: false, lastActiveTick: 0, ...overrides }
}

test('the draft is the active pane when it has no conversation', () => {
  const lanes = [lane('1', { lastActiveTick: 5 }), lane('2', { lastActiveTick: 1 })]
  assert.equal(findDraft(lanes, '2')?.lane, '2')
})

test('away from it, the draft is the most recently used empty, uncoordinated pane', () => {
  const lanes = [
    lane('1', { lastActiveTick: 1 }),
    lane('2', { lastActiveTick: 3 }),
    lane('3', { lastActiveTick: 9, hasConversation: true }),
    lane('4', { lastActiveTick: 8, coordinated: true }),
  ]
  assert.equal(findDraft(lanes, '3')?.lane, '2')
  assert.equal(findDraft([lane('1', { hasConversation: true })], '1'), undefined)
})

test('new session in the draft\'s project returns to it; another project carries it over', () => {
  const draft = lane('2', { projectRoot: '/a' })
  assert.deepEqual(planNewSession('/a', draft), { kind: 'reuse', lane: '2' })
  assert.deepEqual(planNewSession(undefined, draft), { kind: 'reuse', lane: '2' })
  assert.deepEqual(planNewSession('/b', draft), { kind: 'open', carryFrom: '2' })
  assert.deepEqual(planNewSession('/b', undefined), { kind: 'open' })
})
