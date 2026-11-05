import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCompleteFull, restoreCompleteDiff, assertRestoredDiff, refFromCompleteDiff, assertTruncatedFull, fixtureBusinessWindows } from '../scripts/computer-native-observation.mjs'
import type { NativeObservation } from '../scripts/computer-native-observation.mjs'

const first = 's11111111-1111-4111-8111-111111111111'
const next = 's22222222-2222-4222-8222-222222222222'
const fresh = 's33333333-3333-4333-8333-333333333333'
const a = 'AXButton "A" value="" actions=["AXPress"]'
const b = 'AXButton "B" value="" actions=["AXPress"]'
const c = 'AXButton "C" value="" actions=["AXPress"]'
const row = (index: number, value: string, from?: number) =>
  `${next}:e${index}${from === undefined ? '' : ` (from ${first}:e${from})`} ${value}`
function full(values: string[], snapshotId = first, revision = 1): NativeObservation {
  return { snapshotId, revision, mode: 'full', baseRevision: null, complete: true, truncated: false,
    text: [`snapshotId=${snapshotId}; revision=${revision}; Full AX tree.`,
      ...values.map((value, index) => `  ${snapshotId}:e${index} ${value}`)].join('\n') }
}
function diff(lines = ['No AX tree changes.']): NativeObservation {
  return { snapshotId: next, revision: 2, mode: 'diff', baseRevision: 1, complete: true, truncated: false,
    text: [`snapshotId=${next}; revision=2; Diff: baseRevision=1.`, ...lines].join('\n') }
}

test('stale-ref acceptance ignores asynchronous telemetry but still detects business mutations', () => {
  const before = { A: { text: 'fixture', count: 1, selection: { start: 0, length: 7 },
    focus: { keyWindow: true }, selectAllCalls: 1 }, B: { text: 'B', count: 2 } }
  const after = { A: { ...before.A, focus: { keyWindow: false }, selectAllCalls: 2 }, B: before.B }
  assert.deepEqual(fixtureBusinessWindows(after), fixtureBusinessWindows(before))
  for (const change of [{ text: 'changed' }, { count: 2 }, { selection: { start: 7, length: 0 } }]) {
    assert.notDeepEqual(fixtureBusinessWindows({ ...after, A: { ...after.A, ...change } }), fixtureBusinessWindows(before))
  }
  assert.notDeepEqual(fixtureBusinessWindows({ ...after, B: { ...after.B, count: 3 } }), fixtureBusinessWindows(before))
})

test('native acceptance requires complete full and reconstructs unchanged diff against a fresh full', () => {
  const before = full([a, b])
  const unchanged = diff()
  assert.deepEqual(restoreCompleteDiff(before, unchanged), assertCompleteFull(before))
  assertRestoredDiff(before, unchanged, full([a, b], fresh, 3))
})

test('native acceptance fails incomplete full/diff instead of skipping baseline verification', () => {
  for (const patch of [{ complete: false }, { truncated: true }, { text: 'x'.repeat(28_001) }]) {
    assert.throws(() => assertCompleteFull({ ...full([a]), ...patch }))
    assert.throws(() => restoreCompleteDiff(full([a]), { ...diff(), ...patch }))
  }
  assert.throws(() => assertCompleteFull(full([])))
})

test('native driver derives unchanged-diff refs from restored rows with the current snapshot owner', () => {
  const before = full([a.replace('"A"', '"Increment"'), b])
  const unchanged = diff()
  assert.doesNotMatch(unchanged.text, /AXButton/)
  assert.equal(refFromCompleteDiff(before, unchanged, 'Increment', 'AXButton'), `${next}:e0`)
  assert.throws(() => refFromCompleteDiff(before, { ...unchanged, snapshotId: first }, 'Increment', 'AXButton'))
  assert.throws(() => refFromCompleteDiff(before, diff([`~ ${first}:e0 ${a}`]), 'A', 'AXButton'), /fresh snapshot refs/)
  const moved = a.replace('"A"', '"Moved control"')
  assert.equal(refFromCompleteDiff(full([moved, b]), diff([`~ ${row(0, b, 1)}`, `~ ${row(1, moved, 0)}`]), 'Moved control', 'AXButton'), `${next}:e1`)
})

test('native acceptance rejects incorrect baseline metadata and reused snapshot/revision', () => {
  const before = full([a])
  for (const patch of [
    { baseRevision: null }, { baseRevision: 9 }, { mode: 'full' as const },
    { revision: 1 }, { snapshotId: first },
  ]) assert.throws(() => restoreCompleteDiff(before, { ...diff(), ...patch }))
  assert.throws(() => assertRestoredDiff(before, diff(), full([a], next, 3)))
  assert.throws(() => assertRestoredDiff(before, diff(), full([a], fresh, 2)))
})

const changes = [
  { name: 'insertion', before: [a, b], after: [c, a, b],
    lines: [`+ ${row(0, c)}`, `~ ${row(1, a, 0)}`, `~ ${row(2, b, 1)}`] },
  { name: 'deletion', before: [a, b, c], after: [b, c],
    lines: [`~ ${row(0, b, 1)}`, `~ ${row(1, c, 2)}`, `- ${first}:e0`] },
  { name: 'cyclic reorder', before: [a, b], after: [b, a],
    lines: [`~ ${row(0, b, 1)}`, `~ ${row(1, a, 0)}`] },
  { name: 'same-label same-index replacement', before: [a], after: [a],
    lines: [`+ ${row(0, a)}`, `- ${first}:e0`] },
  { name: 'value change', before: [a], after: [c], lines: [`~ ${row(0, c)}`] },
]
for (const change of changes) {
  test(`native acceptance independently restores ${change.name}`, () => {
    assertRestoredDiff(full(change.before), diff(change.lines), full(change.after, fresh, 3))
  })
}

test('native acceptance rejects corrupt refs, indices and a diff that cannot reconstruct the full tree', () => {
  const before = full([a, b])
  for (const lines of [
    [`- ${fresh}:e0`], [`~ ${next}:e0 (from ${fresh}:e1) ${b}`],
    [`- ${first}:e99`], [`- malformed-ref`], [`+ ${first}:e2 ${c}`],
    [`+ ${row(2, c)}`, `+ ${row(2, a)}`], ['not an AX row'],
  ]) assert.throws(() => restoreCompleteDiff(before, diff(lines)))
  assert.throws(() => assertRestoredDiff(before, diff(), full([b, a], fresh, 3)), /reconstruct/)
})

test('native long-list acceptance requires real truncation within the unchanged product budget', () => {
  const truncated = { ...full([a]), complete: false, truncated: true,
    text: `${full([a]).text}\nOutput truncated. Read get_state with rootRef.` }
  assertTruncatedFull(truncated)
  for (const patch of [
    { complete: true }, { truncated: false }, { mode: 'diff' as const }, { baseRevision: 1 },
    { text: 'Output truncated. '.repeat(2000) }, { text: full([a]).text },
  ]) assert.throws(() => assertTruncatedFull({ ...truncated, ...patch }))
})
