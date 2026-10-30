import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { PendingRequests } from '../src/runtime/protocol/pendingRequests.js'
import { UI_REQUEST_FALLBACKS } from '../src/runtime/protocol/wire.js'
import type {
  HostEvent,
  PermissionRequestDto,
  UiRequest,
  UiResponse,
} from '../src/runtime/protocol/wire.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { SessionRecord } from '../src/harness/types.js'

/**
 * The protocol's one non-negotiable property: every payload survives
 * `structuredClone`. Electron IPC and `child_process` both use it, so anything
 * that fails here fails silently in production as a dropped or mangled field.
 */

const message: SessionRecord = {
  type: 'message',
  id: 'm1',
  role: 'assistant',
  content: 'hello',
  createdAt: new Date().toISOString(),
}

const allEventVariants: SessionEvent[] = [
  { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: new Date().toISOString() },
  { type: 'record', record: message, approvalToolUseId: 'tu1', subagentProgress: 'Exploring' },
  { type: 'tool-progress', listContent: 'Bash, Read' },
  { type: 'stream', event: { type: 'text_delta', index: 0, text: 'chunk' } },
  { type: 'stream', event: { type: 'idle_warning', idleMs: 1000 } },
  { type: 'notice', level: 'error', content: 'boom' },
  { type: 'transcript-reset', records: [message], systemMessages: ['note'], bumpGeneration: true },
  { type: 'restore-input', text: 'draft' },
  { type: 'active-model', model: { model: 'm', modelKey: 'main', contextWindow: 200_000 } },
  {
    type: 'turn-end',
    aborted: false,
    rolledBack: false,
    durationMs: 12,
    usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
  },
]

test('every SessionEvent variant survives structuredClone unchanged', () => {
  for (const event of allEventVariants) {
    const cloned = structuredClone(event)
    assert.deepEqual(cloned, event, `${event.type} lost data crossing the boundary`)
  }
})

test('the event union covers every variant the controller can emit', () => {
  // Guards against a new variant being added without a serializability check.
  const covered = new Set(allEventVariants.map((event) => event.type))
  assert.deepEqual([...covered].sort(), [
    'active-model',
    'notice',
    'record',
    'restore-input',
    'stream',
    'tool-progress',
    'transcript-reset',
    'turn-end',
    'turn-start',
  ])
})

test('the tool display projection is three strings, so it clones by construction', () => {
  const event: HostEvent = {
    type: 'session-event',
    event: { type: 'record', record: message },
    toolDisplays: {
      tu1: { displayName: 'Search', useSummary: 'pattern: "foo"', activityDescription: 'Searching' },
      // The optional third field stays absent rather than becoming `undefined`,
      // which `structuredClone` would keep and `deepEqual` would not forgive.
      tu2: { displayName: 'Bash', useSummary: 'ls' },
    },
  }
  assert.deepEqual(structuredClone(event), event)
})

const permissionDto: PermissionRequestDto = {
  toolName: 'Write',
  riskLevel: 'confirm',
  input: { filePath: 'src/app.ts', content: 'export {}\n' },
  reason: 'requires confirmation',
  source: 'mode',
  matchedRule: { toolName: 'Write', behavior: 'ask', source: 'config' },
  alwaysAllowRule: { toolName: 'Write', contentPattern: 'src/**', behavior: 'allow', source: 'session' },
  denialStreak: 2,
  canAlwaysAllow: true,
  preview: {
    kind: 'diff',
    title: 'Edit file',
    filePath: 'src/app.ts',
    oldText: 'a\nb\n',
    newText: 'a\nc\n',
    summary: 'src/app.ts will be edited',
    elided: { oldLines: 300, newLines: 12 },
  },
  destructiveWarnings: [{ code: 'recursive_force_delete', message: 'boom', segment: 'rm -rf x' }],
}

const allUiRequestVariants: UiRequest[] = [
  { kind: 'permission', requestId: 'r1', payload: permissionDto },
  {
    kind: 'permission',
    requestId: 'r2',
    payload: {
      ...permissionDto,
      preview: { kind: 'message', title: 'Edit preview unavailable', filePath: 'x', message: 'nope' },
    },
  },
  {
    kind: 'ask-user-question',
    requestId: 'r3',
    payload: {
      questions: [{
        question: 'Which one?',
        header: 'Pick',
        multiSelect: false,
        options: [{ label: 'A', description: 'first' }],
      }],
    },
  },
  { kind: 'enter-plan', requestId: 'r4' },
  {
    kind: 'exit-plan',
    requestId: 'r5',
    payload: { planContent: 'do the thing', planFilePath: '.hanekawa/plans/p.md' },
  },
]

const allUiResponseVariants: UiResponse[] = [
  { kind: 'permission', approved: true, alwaysAllow: true },
  { kind: 'ask-user-question', result: { kind: 'answers', answers: { Pick: 'A' } } },
  { kind: 'enter-plan', approved: false },
  { kind: 'exit-plan', decision: { kind: 'reject', feedback: 'no' } },
]

test('every UiRequest variant survives structuredClone unchanged', () => {
  // Only the event side was pinned before; a permission DTO now carries a file
  // preview and the destructive analysis, both of which cross per prompt.
  for (const request of allUiRequestVariants) {
    assert.deepEqual(structuredClone(request), request, `${request.kind} lost data`)
  }
})

test('every UiResponse variant survives structuredClone unchanged', () => {
  for (const response of allUiResponseVariants) {
    assert.deepEqual(structuredClone(response), response, `${response.kind} lost data`)
  }
})

test('the UI request union covers every kind the host can ask', () => {
  const covered = new Set(allUiRequestVariants.map((request) => request.kind))
  assert.deepEqual([...covered].sort(), ['ask-user-question', 'enter-plan', 'exit-plan', 'permission'])
  assert.deepEqual(
    [...covered].sort(),
    Object.keys(UI_REQUEST_FALLBACKS).sort(),
    'every request kind needs a fallback for when the client dies',
  )
})

test('UI request fallbacks are asymmetric: only entering plan mode approves', () => {
  const permission = UI_REQUEST_FALLBACKS.permission()
  assert.equal(permission.kind === 'permission' && permission.approved, false)

  const enterPlan = UI_REQUEST_FALLBACKS['enter-plan']()
  assert.equal(enterPlan.kind === 'enter-plan' && enterPlan.approved, true,
    'entering plan mode only restricts the agent, so a lost UI approves')

  const exitPlan = UI_REQUEST_FALLBACKS['exit-plan']()
  assert.equal(exitPlan.kind === 'exit-plan' && exitPlan.decision.kind, 'reject')

  const question = UI_REQUEST_FALLBACKS['ask-user-question']()
  assert.equal(question.kind === 'ask-user-question' && question.result.kind, 'rejected')
})

test('each fallback call returns a fresh object', () => {
  // settleAll hands one value per waiter; a shared object would let one
  // consumer's mutation leak into another's answer.
  assert.notEqual(UI_REQUEST_FALLBACKS['exit-plan'](), UI_REQUEST_FALLBACKS['exit-plan']())
})

test('PendingRequests settles by id and reports unknown ids', async () => {
  const pending = new PendingRequests<string>()
  const first = pending.create('a')
  const second = pending.create('b')

  assert.equal(pending.size, 2)
  assert.equal(pending.settle('a', 'answer-a'), true)
  assert.equal(pending.settle('a', 'again'), false, 'an id settles once')
  assert.equal(pending.settle('missing', 'x'), false)

  pending.settle('b', 'answer-b')
  assert.deepEqual(await Promise.all([first, second]), ['answer-a', 'answer-b'])
  assert.equal(pending.size, 0)
})

test('PendingRequests.settleAll releases everything outstanding', async () => {
  const pending = new PendingRequests<string>()
  const waiting = [pending.create('a'), pending.create('b'), pending.create('c')]

  pending.settleAll(() => 'disconnected')

  assert.deepEqual(await Promise.all(waiting), ['disconnected', 'disconnected', 'disconnected'])
  assert.equal(pending.size, 0)
})

test('the memory channel clones payloads, so a live object cannot sneak through', async () => {
  const [a, b] = createMemoryChannelPair()
  const received: unknown[] = []
  b.onMessage((message) => received.push(message))

  const payload = { nested: { value: 1 } }
  a.post(payload)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(received, [payload])
  assert.notEqual(received[0], payload, 'the receiver must not share the sender\'s object')

  assert.throws(() => a.post({ fn: () => {} }), 'a function payload fails here, as it would over IPC')
})

test('closing one end of the memory channel closes the other', async () => {
  const [a, b] = createMemoryChannelPair()
  let aClosed = false
  let bClosed = false
  a.onClose(() => { aClosed = true })
  b.onClose(() => { bClosed = true })

  a.close()

  assert.equal(aClosed, true)
  assert.equal(bClosed, true, 'a peer that goes away must notify the other side')
})
