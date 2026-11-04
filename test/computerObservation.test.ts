import assert from 'node:assert/strict'
import test from 'node:test'
import { renderObservation } from '../src/desktop/computer/observation.js'
import type { ComputerNode } from '../src/desktop/computer/nativeSchema.js'

const first = 's11111111-1111-4111-8111-111111111111'
const next = 's22222222-2222-4222-8222-222222222222'
const make = (identity: string, index: number, label = identity): ComputerNode => ({
  identity, index, label, depth: 0, role: 'AXButton', value: '', actions: ['AXPress'], enabled: true, settable: false, writableAttributes: [],
})
function rows(text: string): Map<number, string> {
  const result = new Map<number, string>()
  for (const line of text.split('\n')) {
    const row = line.match(/^[+~]?\s*s[a-f0-9-]+:e(\d+)(?: \(from s[a-f0-9-]+:e\d+\))? (AX.*)$/)
    if (row) result.set(Number(row[1]), row[2]!)
  }
  return result
}
function restore(before: ComputerNode[], text: string): Map<number, string> {
  const result = rows(renderObservation(first, 1, before).text)
  // All removals/move sources refer to the OLD baseline, never newly written rows.
  for (const line of text.split('\n')) {
    const old = line.match(/^- (s[a-f0-9-]+):e(\d+)$/) ?? line.match(/\(from (s[a-f0-9-]+):e(\d+)\)/)
    if (old) { assert.equal(old[1], first); result.delete(Number(old[2])) }
  }
  for (const [index, row] of rows(text)) result.set(index, row)
  return result
}

test('identity-based diffs reconstruct insertion, deletion, reorder and replacement without index aliasing', () => {
  const cases = [
    { before: [make('n1', 0), make('n2', 1)], after: [make('n3', 0), make('n1', 1), make('n2', 2)] },
    { before: [make('n1', 0), make('n2', 1), make('n3', 2)], after: [make('n2', 0), make('n3', 1)] },
    { before: [make('n1', 0, 'Same'), make('n2', 1, 'Same')], after: [make('n2', 0, 'Same'), make('n1', 1, 'Same')] },
    { before: [make('n1', 0, 'Same')], after: [make('n2', 0, 'Same')] },
    { before: [make('n1', 0)], after: [{ ...make('n2', 0), value: 'changed content' }] },
  ]
  for (const { before, after } of cases) {
    const result = renderObservation(next, 7, after, { snapshotId: first, revision: 1, nodes: before })
    assert.equal(result.mode, 'diff')
    assert.equal(result.baseRevision, 1)
    assert.equal(result.truncated, false)
    assert.deepEqual(restore(before, result.text), rows(renderObservation(next, 7, after).text))
  }
})

test('same-label identities remain distinct and moved nodes explicitly identify their previous refs', () => {
  const before = [make('n1', 0, 'Same'), make('n2', 1, 'Same')]
  const result = renderObservation(next, 2, [make('n2', 0, 'Same'), make('n1', 1, 'Same')], { snapshotId: first, revision: 1, nodes: before })
  assert.ok(result.text.includes(`${next}:e0 (from ${first}:e1)`))
  assert.ok(result.text.includes(`${next}:e1 (from ${first}:e0)`))
  const replaced = renderObservation(next, 2, [make('n3', 0, 'Same')], { snapshotId: first, revision: 1, nodes: before })
  assert.ok(replaced.text.includes(`+ ${next}:e0`))
  assert.ok(replaced.text.includes(`- ${first}:e0`))
  assert.doesNotMatch(replaced.text, /identity=/, 'internal identities are not model action handles')
})

test('full reads declare no baseline, while unchanged diffs declare the published revision', () => {
  const nodes = [make('n1', 0)]
  const full = renderObservation(next, 8, nodes)
  assert.equal(full.mode, 'full')
  assert.equal(full.baseRevision, null)
  const diff = renderObservation(next, 8, nodes, { snapshotId: first, revision: 3, nodes })
  assert.equal(diff.baseRevision, 3)
  assert.match(diff.text, /No AX tree changes/)
})

test('long list descendants cannot hide later shallow controls or subtree entry refs', () => {
  const nodes = [
    { ...make('n1', 0, 'Window'), role: 'AXWindow' },
    { ...make('n2', 1, 'Long list'), role: 'AXTable', depth: 1 },
    ...Array.from({ length: 160 }, (_, i) => ({ ...make(`n${i + 3}`, i + 2), role: 'AXRow', depth: 2, value: 'x'.repeat(200) })),
    { ...make('n163', 162, 'Replacement button'), depth: 1 },
    { ...make('n164', 163, 'Other branch'), role: 'AXGroup', depth: 1 },
  ]
  const result = renderObservation(next, 9, nodes)
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 28_000)
  assert.ok(result.text.includes(`${next}:e1 AXTable`))
  assert.ok(result.text.includes(`${next}:e162 AXButton "Replacement button"`))
  assert.ok(result.text.includes(`${next}:e163 AXGroup "Other branch"`))
  const indices = [...rows(result.text).keys()]
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'published rows retain traversal order and native indices')
  assert.ok(indices.length < nodes.length)
  assert.match(result.text, /rootRef/)
})
