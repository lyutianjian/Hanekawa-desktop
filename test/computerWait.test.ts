import assert from 'node:assert/strict'
import test from 'node:test'
import { checkCondition } from '../src/desktop/computer/wait.js'
import type { ObservationSample } from '../src/desktop/computer/wait.js'

const bounds = { x: 0, y: 0, width: 800, height: 600 }
const windows = [{ id: 'w1', title: 'Test A', role: 'AXWindow', bounds }, { id: 'w2', title: 'Test B', role: 'AXWindow', bounds }]
const button = { index: 0, identity: 'n1', depth: 0, role: 'AXButton', label: 'Save', value: '', actions: ['AXPress'], settable: false, writableAttributes: [], enabled: true }
const sample: ObservationSample = { windows, observation: {
  scope: 'window', sampledAt: 1, revision: 1, processId: 123, windowId: 'w1', windows, bounds, truncated: false,
  nodes: [button, { ...button, index: 1, identity: 'n2', role: 'AXStaticText', label: 'Status', value: 'Ready 😀' }],
} }

test('element conditions require all matchers on the same node and preserve case', () => {
  assert.equal(checkCondition({ kind: 'element', state: 'present', role: 'AXStaticText', labelIncludes: 'tatu', valueIncludes: '😀' }, sample), 'matched')
  assert.equal(checkCondition({ kind: 'element', state: 'present', labelIncludes: 'Save', valueIncludes: 'Ready' }, sample), undefined)
  assert.equal(checkCondition({ kind: 'element', state: 'present', valueIncludes: 'ready' }, sample), undefined)
  assert.equal(checkCondition({ kind: 'element', state: 'absent', labelIncludes: 'Missing' }, sample), 'matched')
})
test('incomplete or unselected AX trees cannot prove element conditions', () => {
  const condition = { kind: 'element', state: 'absent', labelIncludes: 'Missing' } as const
  assert.equal(checkCondition(condition, { windows }), 'unsupported')
  assert.equal(checkCondition(condition, { windows, observation: { ...sample.observation!, truncated: true } }), 'unsupported')
})
test('window conditions work without a selected AX window, including closed handles', () => {
  assert.equal(checkCondition({ kind: 'window', state: 'present', titleIncludes: 'B' }, { windows }), 'matched')
  assert.equal(checkCondition({ kind: 'window', state: 'absent', windowId: 'w1' }, { windows: [] }), 'matched')
  assert.equal(checkCondition({ kind: 'window', state: 'absent', windowId: 'w2' }, { windows }), undefined)
})
