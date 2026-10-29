import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PANE_LIMIT,
  isPinned,
  selectEvictions,
  type PaneBudgetEntry,
} from '../src/desktop/paneBudget.js'

/**
 * `selectEvictions` — the resident-pane cap.
 *
 * The load-bearing case is the last one: when everything left is pinned this
 * must return *fewer* lanes than the limit demands rather than reaching for a
 * running turn. Every other case is bookkeeping around that.
 */

function entry(lane: string, overrides: Partial<PaneBudgetEntry> = {}): PaneBudgetEntry {
  return {
    lane,
    active: false,
    streaming: false,
    pending: false,
    blocked: false,
    processes: false,
    tabs: false,
    coordinator: false,
    draft: false,
    lastActiveTick: 0,
    ...overrides,
  }
}

test('nothing is evicted while the resident count is within budget', () => {
  const entries = [entry('1', { lastActiveTick: 1 }), entry('2', { lastActiveTick: 2 })]
  assert.deepEqual(selectEvictions({ entries, limit: DEFAULT_PANE_LIMIT }), [])
  assert.deepEqual(selectEvictions({ entries, limit: 2 }), [], 'exactly at the limit is within it')
})

test('the coldest pane goes first, and only as many as the excess', () => {
  const entries = [
    entry('1', { lastActiveTick: 10 }),
    entry('2', { lastActiveTick: 3 }),
    entry('3', { lastActiveTick: 7 }),
    entry('4', { lastActiveTick: 1 }),
    entry('5', { lastActiveTick: 20, active: true }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 4 }), ['4'])
  assert.deepEqual(selectEvictions({ entries, limit: 3 }), ['4', '2'])
  assert.deepEqual(selectEvictions({ entries, limit: 2 }), ['4', '2', '3'])
})

test('the active pane is never evicted, however cold it looks', () => {
  // A pane activated at tick 0 and then never re-stamped is the coldest thing in
  // the list, and it is the one on screen.
  const entries = [
    entry('1', { lastActiveTick: 0, active: true }),
    entry('2', { lastActiveTick: 5 }),
    entry('3', { lastActiveTick: 6 }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 1 }), ['2', '3'])
})

test('a streaming pane is never evicted', () => {
  const entries = [
    entry('1', { lastActiveTick: 1, streaming: true }),
    entry('2', { lastActiveTick: 2 }),
    entry('3', { lastActiveTick: 3, active: true }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 2 }), ['2'])
})

test('a pane holding an unanswered blocking request is never evicted', () => {
  // Its teardown would drain the bridge with a *denial*, so the user's tool call
  // fails silently instead of asking — worse than being over budget.
  const entries = [
    entry('1', { lastActiveTick: 1, blocked: true }),
    entry('2', { lastActiveTick: 2 }),
    entry('3', { lastActiveTick: 3, active: true }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 2 }), ['2'])
})

test('going over budget beats killing work: all-pinned returns fewer than needed', () => {
  const entries = [
    entry('1', { lastActiveTick: 1, streaming: true }),
    entry('2', { lastActiveTick: 2, blocked: true }),
    entry('3', { lastActiveTick: 3, active: true }),
    entry('4', { lastActiveTick: 4, streaming: true }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 1 }), [])
})

test('a partly pinned list evicts only what it may, not the excess count', () => {
  const entries = [
    entry('1', { lastActiveTick: 1, streaming: true }),
    entry('2', { lastActiveTick: 2 }),
    entry('3', { lastActiveTick: 3, blocked: true }),
    entry('4', { lastActiveTick: 4, active: true }),
  ]
  // Excess is 3, but only one lane is evictable.
  assert.deepEqual(selectEvictions({ entries, limit: 1 }), ['2'])
})

test('ties break on lane order, so the answer does not depend on the sort engine', () => {
  const entries = [
    entry('3', { lastActiveTick: 0 }),
    entry('1', { lastActiveTick: 0 }),
    entry('2', { lastActiveTick: 0 }),
    entry('10', { lastActiveTick: 0 }),
  ]
  // Lane keys are decimal counters, so '10' is newer than '2' — a string sort
  // would put it first and evict the second-oldest pane instead of the oldest.
  assert.deepEqual(selectEvictions({ entries, limit: 1 }), ['1', '2', '3'])
})

test('a nonsensical limit degrades rather than inverting the rule', () => {
  const entries = [entry('1', { lastActiveTick: 1 }), entry('2', { lastActiveTick: 2, active: true })]
  assert.deepEqual(selectEvictions({ entries, limit: 0 }), ['1'], 'the active pane still stays')
  assert.deepEqual(selectEvictions({ entries, limit: -5 }), ['1'])
})

test('an empty list is an empty answer', () => {
  assert.deepEqual(selectEvictions({ entries: [], limit: DEFAULT_PANE_LIMIT }), [])
})

test('isPinned is the one place the exemption is spelled', () => {
  assert.equal(isPinned(entry('1')), false)
  assert.equal(isPinned(entry('1', { active: true })), true)
  assert.equal(isPinned(entry('1', { streaming: true })), true)
  assert.equal(isPinned(entry('1', { pending: true })), true)
  assert.equal(isPinned(entry('1', { blocked: true })), true)
  assert.equal(isPinned(entry('1', { processes: true })), true)
  assert.equal(isPinned(entry('1', { tabs: true })), true)
  assert.equal(isPinned(entry('1', { coordinator: true })), true)
  assert.equal(isPinned(entry('1', { draft: true })), true)
})

test('an idle, inactive, oldest coordinator is never evicted', () => {
  const entries = [
    entry('1', { lastActiveTick: 0, coordinator: true }),
    entry('2', { lastActiveTick: 5 }),
    entry('3', { lastActiveTick: 6 }),
    entry('4', { lastActiveTick: 7 }),
    entry('5', { lastActiveTick: 8, active: true }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 2 }), ['2', '3', '4'])
  assert.deepEqual(selectEvictions({ entries, limit: 0 }), ['2', '3', '4'])
})

test('threads loading or waiting for their first turn survive a batch larger than the pane budget', () => {
  const entries = [
    entry('1', { coordinator: true }),
    ...Array.from({ length: 6 }, (_, i) => entry(String(i + 2), { pending: true })),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: DEFAULT_PANE_LIMIT }), [])
  entries[4] = entry('5')
  assert.deepEqual(selectEvictions({ entries, limit: DEFAULT_PANE_LIMIT }), ['5'])
})

test('an idle thread is still evictable', () => {
  const entries = [
    entry('1', { lastActiveTick: 0, coordinator: true }),
    entry('2', { lastActiveTick: 1 }),
    entry('3', { lastActiveTick: 2, active: true }),
  ]
  assert.deepEqual(selectEvictions({ entries, limit: 1 }), ['2'])
})
