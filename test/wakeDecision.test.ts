import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUTO_WAKE_LIMIT,
  decideWake,
  initialWakeLock,
  nextAutoWakeCount,
  releaseWake,
  requestWake,
  type WakeInput,
  type WakeNote,
} from '../src/runtime/coordination/wakeDecision.js'

const report: WakeNote = { threadId: 't1', kind: 'report', userDriven: false }
const question: WakeNote = { threadId: 't1', kind: 'question', userDriven: false }
const driven: WakeNote = { threadId: 't2', kind: 'report', userDriven: true }

function input(over: Omit<Partial<WakeInput>, 'parent'> & { parent?: Partial<WakeInput['parent']> } = {}): WakeInput {
  return {
    children: [{ threadId: 't1', running: false }],
    notes: [report],
    autoWakeCount: 0,
    ...over,
    parent: {
      status: 'idle',
      lastTurnOutcome: 'completed',
      pendingApproval: false,
      pendingDialog: false,
      startingThreads: 0,
      ...over.parent,
    },
  }
}

describe('decideWake', () => {
  it('wakes converged by default', () => {
    assert.deepEqual(decideWake(input()), { wake: true, reason: 'converged' })
  })
  it('lastTurnOutcome none is fine', () => {
    assert.equal(decideWake(input({ parent: { lastTurnOutcome: 'none' } })).wake, true)
  })
  it('no notes / only user-driven notes do not wake', () => {
    const none = { wake: false, reason: 'no-wakeable-notes', retryLater: false }
    assert.deepEqual(decideWake(input({ notes: [] })), none)
    assert.deepEqual(decideWake(input({ notes: [driven] })), none)
    assert.deepEqual(decideWake(input({ notes: [{ ...driven, kind: 'question' }] })), none)
  })
  it('user-driven note takes priority over every other gate', () => {
    assert.equal(decideWake(input({ notes: [driven], autoWakeCount: 99, parent: { status: 'running' } })).reason, 'no-wakeable-notes')
  })
  it('mixed user-driven + report wakes converged', () => {
    assert.deepEqual(decideWake(input({ notes: [driven, report] })), { wake: true, reason: 'converged' })
  })
  it('limit reached', () => {
    const v = decideWake(input({ autoWakeCount: AUTO_WAKE_LIMIT }))
    assert.deepEqual(v, { wake: false, reason: 'limit-reached', retryLater: false })
    assert.equal(decideWake(input({ autoWakeCount: AUTO_WAKE_LIMIT - 1 })).wake, true)
    assert.equal(decideWake(input({ autoWakeCount: 2, limit: 2 })).reason, 'limit-reached')
  })
  it('limit beats question and parent state', () => {
    assert.equal(decideWake(input({ notes: [question], autoWakeCount: AUTO_WAKE_LIMIT })).reason, 'limit-reached')
    assert.equal(decideWake(input({ autoWakeCount: AUTO_WAKE_LIMIT, parent: { status: 'running' } })).reason, 'limit-reached')
  })
  it('parent running', () => {
    assert.deepEqual(decideWake(input({ notes: [question], parent: { status: 'running' } })), {
      wake: false,
      reason: 'parent-running',
      retryLater: false,
    })
  })
  it('parent stopping retries', () => {
    assert.deepEqual(decideWake(input({ parent: { status: 'stopping', lastTurnOutcome: 'interrupted' } })), {
      wake: false,
      reason: 'parent-stopping',
      retryLater: true,
    })
  })
  it('interrupted / failed do not wake, even for questions', () => {
    assert.deepEqual(decideWake(input({ notes: [question], parent: { lastTurnOutcome: 'interrupted' } })), {
      wake: false,
      reason: 'parent-interrupted',
      retryLater: false,
    })
    assert.deepEqual(decideWake(input({ parent: { lastTurnOutcome: 'failed' } })), {
      wake: false,
      reason: 'parent-failed',
      retryLater: false,
    })
  })
  it('interrupted beats pending approval', () => {
    assert.equal(decideWake(input({ parent: { lastTurnOutcome: 'interrupted', pendingApproval: true } })).reason, 'parent-interrupted')
  })
  it('approval and dialog retry, even for questions', () => {
    assert.deepEqual(decideWake(input({ notes: [question], parent: { pendingApproval: true } })), {
      wake: false,
      reason: 'awaiting-approval',
      retryLater: true,
    })
    assert.deepEqual(decideWake(input({ parent: { pendingDialog: true } })), {
      wake: false,
      reason: 'dialog-open',
      retryLater: true,
    })
    assert.equal(decideWake(input({ parent: { pendingApproval: true, pendingDialog: true } })).reason, 'awaiting-approval')
  })
  it('question wakes immediately despite running and starting threads', () => {
    const v = decideWake(
      input({ notes: [report, question], children: [{ threadId: 't1', running: true }], parent: { startingThreads: 2 } }),
    )
    assert.deepEqual(v, { wake: true, reason: 'question' })
  })
  it('starting threads retry', () => {
    assert.deepEqual(decideWake(input({ parent: { startingThreads: 1 } })), {
      wake: false,
      reason: 'threads-starting',
      retryLater: true,
    })
    assert.equal(
      decideWake(input({ parent: { startingThreads: 1 }, children: [{ threadId: 't1', running: true }] })).reason,
      'threads-starting',
    )
  })
  it('a report wakes at once while other threads still run', () => {
    assert.deepEqual(decideWake(input({ children: [{ threadId: 't1', running: false }, { threadId: 't3', running: true }] })), {
      wake: true,
      reason: 'progress',
    })
  })
})

describe('wake lock', () => {
  it('two near-simultaneous requests yield one proceed', () => {
    const a = requestWake(initialWakeLock)
    const b = requestWake(a.state)
    assert.equal(a.proceed, true)
    assert.equal(b.proceed, false)
    assert.deepEqual(b.state, { locked: true, suppressed: true })
  })
  it('release replays once then not again', () => {
    const a = requestWake(initialWakeLock)
    const b = requestWake(a.state)
    const r1 = releaseWake(b.state)
    assert.equal(r1.replay, true)
    assert.deepEqual(r1.state, initialWakeLock)
    assert.equal(releaseWake(r1.state).replay, false)
  })
  it('release without suppression does not replay', () => {
    assert.equal(releaseWake(requestWake(initialWakeLock).state).replay, false)
  })
  it('does not mutate input', () => {
    const s = { locked: true, suppressed: false }
    requestWake(s)
    assert.deepEqual(s, { locked: true, suppressed: false })
  })
})

describe('nextAutoWakeCount', () => {
  it('increments on auto-wake and resets on user message', () => {
    assert.equal(nextAutoWakeCount(3, 'auto-wake'), 4)
    assert.equal(nextAutoWakeCount(7, 'user-message-in-coordinator'), 0)
  })
})
