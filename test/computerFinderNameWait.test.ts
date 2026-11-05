import assert from 'node:assert/strict'
import test from 'node:test'
import { computerRows, finderNameMatches, observeFinderName, waitForFinderName } from '../scripts/computer-finder-name-wait.mjs'
import type { FinderNameObservationEvidence, FinderNameObservationState, FinderNameWaitEvidence, FinderNameWaitState } from '../scripts/computer-finder-name-wait.mjs'
import { computerInputSchema, isComputerRead } from '../src/tools/ComputerTool/schema.js'
import type { ComputerOperation } from '../src/runtime/protocol/computerHost.js'
import { renderObservation } from '../src/desktop/computer/observation.js'
import type { ComputerNode } from '../src/desktop/computer/nativeSchema.js'

const target = { appId: 'app-11111111-1111-4111-8111-111111111111', windowId: 'w7', name: '验证-唯一-1' }
type WaitInput = Extract<ComputerOperation, { operation: 'wait_for' }>
const result = (status: FinderNameWaitState['wait']['status'], elapsedMs = 1500): FinderNameWaitState =>
  ({ wait: { status, elapsedMs }, complete: true, truncated: false })
function assertRead(input: WaitInput) {
  assert.equal(isComputerRead(computerInputSchema.parse(input)), true)
  assert.equal(input.operation, 'wait_for')
  assert.equal(input.appId, target.appId)
  assert.equal(input.windowId, target.windowId)
  assert.equal(input.scope, undefined)
}

test('Finder label match uses one exact readonly production wait and stops', async () => {
  const calls: WaitInput[] = [], evidence: FinderNameWaitEvidence = {}
  const matched = result('matched', 12)
  assert.equal(await waitForFinderName(async input => {
    assertRead(input); calls.push(input); return matched
  }, target, evidence, () => 0), matched)
  assert.deepEqual(calls, [{ operation: 'wait_for', appId: target.appId, windowId: target.windowId, waitMs: 1500,
    condition: { kind: 'element', state: 'present', labelIncludes: target.name } }])
  assert.deepEqual(evidence, { budgetMs: 3000, attempts: [{ field: 'labelIncludes', waitMs: 1500,
    status: 'matched', elapsedMs: 12, complete: true, truncated: false }] })
})

test('Finder value fallback keeps exact fields and deducts overhead from the original budget', async () => {
  const calls: WaitInput[] = [], evidence: FinderNameWaitEvidence = {}
  let clock = 0
  const matched = result('matched', 30)
  assert.equal(await waitForFinderName(async input => {
    assertRead(input); calls.push(input)
    if (calls.length === 1) { clock = 1850; return result('timed_out', 1700) }
    return matched
  }, target, evidence, () => clock), matched)
  assert.deepEqual(calls.map(c => ({ condition: c.condition, waitMs: c.waitMs })), [
    { condition: { kind: 'element', state: 'present', labelIncludes: target.name }, waitMs: 1500 },
    { condition: { kind: 'element', state: 'present', valueIncludes: target.name }, waitMs: 1150 },
  ])
  assert.equal(evidence.remainingMsBeforeValue, 1150)
  assert.equal(evidence.attempts?.[1]?.field, 'valueIncludes')
  assert.equal(evidence.attempts?.[1]?.status, 'matched')
})

test('Finder timeouts stop after two reads and never allocate more than 3000ms', async () => {
  const calls: WaitInput[] = [], evidence: FinderNameWaitEvidence = {}
  const timedOut = result('timed_out')
  assert.equal(await waitForFinderName(async input => {
    assertRead(input); calls.push(input); return timedOut
  }, target, evidence, () => 0), timedOut)
  assert.equal(calls.length, 2)
  assert.equal(calls.reduce((sum, call) => sum + call.waitMs, 0), 3000)
  assert.deepEqual(evidence.attempts?.map(a => a.status), ['timed_out', 'timed_out'])
})

test('Finder fallback respects the production minimum without extending an exhausted budget', async () => {
  for (const elapsed of [2900, 2901, 3000, 3500]) {
    let clock = 0
    const calls: WaitInput[] = [], evidence: FinderNameWaitEvidence = {}
    await waitForFinderName(async input => {
      assertRead(input); calls.push(input); clock = elapsed; return result('timed_out', elapsed)
    }, target, evidence, () => clock)
    assert.equal(calls.length, elapsed === 2900 ? 2 : 1)
    if (elapsed === 2900) assert.equal(calls[1]!.waitMs, 100)
    else assert.equal(evidence.valueWaitSkippedForBudget, true)
  }
})

test('Finder unsupported observation stops without fallback or action replay', async () => {
  const calls: WaitInput[] = [], evidence: FinderNameWaitEvidence = {}
  const unsupported = { ...result('unsupported'), complete: false, truncated: true }
  assert.equal(await waitForFinderName(async input => {
    assertRead(input); calls.push(input); return unsupported
  }, target, evidence, () => 0), unsupported)
  assert.equal(calls.length, 1)
  assert.equal(evidence.attempts?.[0]?.complete, false)
  assert.equal(evidence.attempts?.[0]?.truncated, true)
})

test('Finder errors propagate at either wait without retrying or issuing any action', async () => {
  for (const failAt of [1, 2]) {
    const calls: WaitInput[] = [], evidence: FinderNameWaitEvidence = {}
    const failure = new Error('injected readonly failure')
    await assert.rejects(waitForFinderName(async input => {
      assertRead(input); calls.push(input)
      if (calls.length === failAt) throw failure
      return result('timed_out')
    }, target, evidence, () => 0), error => error === failure)
    assert.equal(calls.length, failAt)
    assert.equal(evidence.attempts?.[failAt - 1]?.failed, true)
  }
})

test('Finder evidence counts only the generated name in each actual field and retains no AX contents', () => {
  const secret = 'MUST_NOT_LOG_USER_WINDOW_PATH_OR_INPUT'
  const summary = finderNameMatches([
    { role: 'AXStaticText', label: target.name, value: '' },
    { role: 'AXTextField', label: '', value: target.name },
    { role: 'AXStaticText', label: `${secret}/${target.name}`, value: target.name },
    { role: 'AXButton', label: secret, value: secret },
  ], target.name)
  assert.deepEqual(summary, { labelMatches: 2, valueMatches: 2, roles: [
    { role: 'AXStaticText', labelMatches: 2, valueMatches: 1 },
    { role: 'AXTextField', labelMatches: 0, valueMatches: 1 },
  ] })
  assert.deepEqual(finderNameMatches([{ role: 'AXButton', label: secret, value: secret }], target.name),
    { labelMatches: 0, valueMatches: 0, roles: [] })
  assert.doesNotMatch(JSON.stringify(summary), /MUST_NOT_LOG|验证/)
})

type StateInput = Extract<ComputerOperation, { operation: 'get_state' }>
const windowSnapshot = 's22222222-2222-4222-8222-222222222222'
const subtreeSnapshot = 's33333333-3333-4333-8333-333333333333'
const oldSnapshot = 's44444444-4444-4444-8444-444444444444'
const privateText = 'PRIVATE_USER_WINDOW_PATH_OR_INPUT'
function finderNode(index = 7, fields: Partial<ComputerNode> = {}): ComputerNode {
  return { index, identity: `n${index}`, depth: 1, role: 'AXStaticText', label: '', value: target.name,
    actions: [], writableAttributes: [], settable: false, enabled: true, windowId: target.windowId, ...fields }
}
function finderState(nodes = [finderNode()], snapshotId = windowSnapshot): FinderNameObservationState {
  const revision = snapshotId === windowSnapshot ? 1 : 2
  const rendered = renderObservation(snapshotId, revision, nodes)
  return { appId: target.appId, windowId: target.windowId, scope: 'window', snapshotId, revision,
    ...rendered, complete: !rendered.truncated }
}
function assertStateRead(input: StateInput) {
  assert.equal(isComputerRead(computerInputSchema.parse(input)), true)
  assert.equal(input.operation, 'get_state')
  assert.equal(input.appId, target.appId)
  assert.equal(input.windowId, target.windowId)
  assert.equal(input.disableDiffing, true)
  assert.equal(input.scope, undefined)
  assert.equal(input.includeScreenshot, undefined)
}

test('Finder truncated full window supplies its visible ref for a complete target subtree after readonly value wait', async () => {
  const calls: Array<WaitInput | StateInput> = []
  const evidence: FinderNameWaitEvidence & FinderNameObservationEvidence = {}
  const waited = await waitForFinderName(async input => {
    assertRead(input); calls.push(input)
    return { ...finderState([finderNode(99)], oldSnapshot),
      ...renderObservation(oldSnapshot, 2, [finderNode(99)], { snapshotId: subtreeSnapshot, revision: 1, nodes: [] }),
      wait: { status: input.condition.kind === 'element' && input.condition.labelIncludes ? 'timed_out' : 'matched', elapsedMs: 10 } }
  }, target, evidence, () => 0)
  assert.equal(waited.wait.status, 'matched')
  const window = finderState([finderNode(), ...Array.from({ length: 40 }, (_, index) =>
    finderNode(index + 100, { depth: 2, label: privateText.repeat(40), value: '' }))])
  assert.equal(window.truncated, true, 'Exercise real output-budget truncation')
  const subtree = finderState([finderNode(0, { depth: 0 })], subtreeSnapshot)
  assert.equal(await observeFinderName(async input => {
    assertStateRead(input); calls.push(input)
    return input.rootRef === undefined ? window : subtree
  }, target, evidence), subtree)
  assert.deepEqual(calls, [
    { operation: 'wait_for', appId: target.appId, windowId: target.windowId, waitMs: 1500,
      condition: { kind: 'element', state: 'present', labelIncludes: target.name } },
    { operation: 'wait_for', appId: target.appId, windowId: target.windowId, waitMs: 1500,
      condition: { kind: 'element', state: 'present', valueIncludes: target.name } },
    { operation: 'get_state', appId: target.appId, windowId: target.windowId, disableDiffing: true },
    { operation: 'get_state', appId: target.appId, windowId: target.windowId, rootRef: `${windowSnapshot}:e7`, disableDiffing: true },
  ])
  const hits = { appMatches: true, windowMatches: true, full: true, candidateCount: 1, labelMatches: 0, valueMatches: 1,
    roles: [{ role: 'AXStaticText', labelMatches: 0, valueMatches: 1 }] }
  assert.deepEqual(evidence.windowObservation, { complete: false, truncated: true, ...hits })
  assert.deepEqual(evidence.targetSubtree, { complete: true, truncated: false, ...hits })
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_USER|验证|snapshotId|:e\d/)
})

test('Finder one node matching both fields is one candidate and subtree name may be exposed in either field', async () => {
  const window = finderState([finderNode(7, { label: target.name })])
  const subtree = finderState([finderNode(0, { label: target.name, value: '' })], subtreeSnapshot)
  const evidence: FinderNameObservationEvidence = {}
  await observeFinderName(async input => {
    assertStateRead(input)
    return input.rootRef === undefined ? window : subtree
  }, target, evidence)
  assert.equal(evidence.windowObservation?.candidateCount, 1)
  assert.equal(evidence.windowObservation?.labelMatches, 1)
  assert.equal(evidence.windowObservation?.valueMatches, 1)
  assert.equal(evidence.targetSubtree?.candidateCount, 1)
  assert.equal(evidence.targetSubtree?.labelMatches, 1)
  assert.equal(evidence.targetSubtree?.valueMatches, 0)
})

const windowFailures: Array<{ name: string; state: FinderNameObservationState; error: RegExp }> = [
  { name: 'no visible target in a truncated tree', state: { ...finderState([finderNode(0,
    { label: privateText, value: '', actions: [target.name] })]), complete: false, truncated: true }, error: /exactly one visible/ },
  { name: 'ambiguous targets across label and value', state: finderState([finderNode(), finderNode(8,
    { label: target.name, value: '' })]), error: /exactly one visible/ },
  { name: 'another app', state: { ...finderState(), appId: 'app-55555555-5555-4555-8555-555555555555' }, error: /bound app/ },
  { name: 'another window', state: { ...finderState(), windowId: 'w8' }, error: /selected window/ },
  { name: 'application scope', state: { ...finderState(), scope: 'application' }, error: /selected window/ },
  { name: 'diff mode', state: { ...finderState(), mode: 'diff', baseRevision: 1 }, error: /full mode/ },
  { name: 'a full mode with a diff baseline', state: { ...finderState(), baseRevision: 1 }, error: /diff baseline/ },
  { name: 'a ref from an older observation', state: { ...finderState(), snapshotId: oldSnapshot }, error: /ref must be published/ },
  { name: 'a foreign target despite a window token in its text', state: finderState([finderNode(7,
    { label: `windowId=${target.windowId}`, windowId: 'w8' })]), error: /selected window/ },
  { name: 'a target with unknown window ownership', state: finderState([finderNode(7, { windowId: undefined })]), error: /selected window/ },
]
for (const { name, state, error } of windowFailures) test(`Finder windowObservation rejects ${name} without a subtree read`, async () => {
  const calls: StateInput[] = [], evidence: FinderNameObservationEvidence = {}
  await assert.rejects(observeFinderName(async input => {
    assertStateRead(input); calls.push(input)
    assert.equal(input.rootRef, undefined)
    return state
  }, target, evidence), error)
  assert.equal(calls.length, 1)
  assert.ok(evidence.windowObservation)
  assert.equal(evidence.targetSubtree, undefined)
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_USER|验证|snapshotId|:e\d/)
})

const completeSubtree = finderState([finderNode(0)], subtreeSnapshot)
const subtreeFailures: Array<{ name: string; state: FinderNameObservationState; error: RegExp }> = [
  { name: 'an incomplete truncated tree', state: { ...completeSubtree, complete: false, truncated: true }, error: /must be complete/ },
  { name: 'an incomplete untruncated tree', state: { ...completeSubtree, complete: false }, error: /must be complete/ },
  { name: 'truncation even with complete true', state: { ...completeSubtree, truncated: true }, error: /must not be truncated/ },
  { name: 'a vanished name', state: finderState([finderNode(0, { value: privateText })], subtreeSnapshot), error: /exactly one visible/ },
  { name: 'ambiguous names', state: finderState([finderNode(0), finderNode(1)], subtreeSnapshot), error: /exactly one visible/ },
  { name: 'another app', state: { ...completeSubtree, appId: 'app-55555555-5555-4555-8555-555555555555' }, error: /bound app/ },
  { name: 'another window', state: { ...completeSubtree, windowId: 'w8' }, error: /selected window/ },
  { name: 'application scope', state: { ...completeSubtree, scope: 'application' }, error: /selected window/ },
  { name: 'a target owned by another window', state: finderState([finderNode(0, { windowId: 'w8' })], subtreeSnapshot), error: /selected window/ },
  { name: 'diff mode', state: { ...completeSubtree, mode: 'diff', baseRevision: 1 }, error: /full mode/ },
]
for (const { name, state, error } of subtreeFailures) test(`Finder targetSubtree rejects ${name} without retry or replay`, async () => {
  const calls: StateInput[] = [], evidence: FinderNameObservationEvidence = {}
  await assert.rejects(observeFinderName(async input => {
    assertStateRead(input); calls.push(input)
    return input.rootRef === undefined ? finderState() : state
  }, target, evidence), error)
  assert.deepEqual(calls, [
    { operation: 'get_state', appId: target.appId, windowId: target.windowId, disableDiffing: true },
    { operation: 'get_state', appId: target.appId, windowId: target.windowId, rootRef: `${windowSnapshot}:e7`, disableDiffing: true },
  ])
  assert.ok(evidence.targetSubtree)
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_USER|验证|snapshotId|:e\d/)
})

test('Finder observation failures propagate at either read without retries or actions', async () => {
  for (const failAt of [1, 2]) {
    let calls = 0
    const error = new Error('injected observation failure')
    await assert.rejects(observeFinderName(async input => {
      assertStateRead(input)
      if (++calls === failAt) throw error
      return finderState()
    }, target, {}), failure => failure === error)
    assert.equal(calls, failAt)
  }
})

test('Finder shared parser reads window ownership only from metadata, never label or value text', () => {
  const state = finderState([finderNode(7, { label: 'windowId=w7', value: 'windowId=w7', windowId: 'w8' })])
  assert.equal(computerRows(state)[0]?.windowId, 'w8')
  assert.equal(computerRows(finderState([finderNode(7, { label: 'windowId=w7', windowId: undefined })]))[0]?.windowId, undefined)
})
