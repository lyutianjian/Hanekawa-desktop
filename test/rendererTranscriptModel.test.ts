import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionEvent,
  createTranscriptState,
  formatMessageTime,
  formatTurnSummary,
  formatWorkedDuration,
  groupTranscript,
  presentationTranscript,
  toStep,
  toolCallSummary,
  toolStatusLabel,
} from '../src/desktop/renderer/model/transcript.js'
import type {
  ActivityRun,
  ToolDisplayLookup,
  ToolStepStatus,
  TranscriptItem,
  TranscriptState,
} from '../src/desktop/renderer/model/transcript.js'
import type { ToolDisplayDto } from '../src/runtime/protocol/wire.js'
import type { SessionRecord, ToolErrorCode } from '../src/harness/types.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import { wrapInSystemReminder } from '../src/harness/systemReminder.js'

/**
 * The desktop transcript's fold over the controller's event stream.
 *
 * The renderer that shipped in 阶段 2b-2 handled two of the ten variants, so the
 * property that matters most here is coverage: every variant does something, and
 * the streaming draft is *replaced* by the record that follows it rather than
 * appended alongside it.
 */

function fold(events: SessionEvent[], initial?: TranscriptState) {
  let state = initial ?? createTranscriptState()
  const restored: string[] = []
  const models: string[] = []
  for (const event of events) {
    const outcome = applySessionEvent(state, event)
    state = outcome.state
    if (outcome.restoreInput !== undefined) restored.push(outcome.restoreInput)
    if (outcome.activeModel !== undefined) models.push(outcome.activeModel)
  }
  return { state, restored, models }
}

function message(id: string, role: 'user' | 'assistant', content: string): SessionRecord {
  return { type: 'message', id, role, content, createdAt: 'now' }
}

const ALL_EVENT_TYPES: SessionEvent['type'][] = [
  'turn-start',
  'record',
  'stream',
  'tool-progress',
  'notice',
  'transcript-reset',
  'restore-input',
  'active-model',
  'turn-end',
]

test('every SessionEvent variant is handled, none throws', () => {
  const samples: SessionEvent[] = [
    { type: 'turn-start', messageId: 'm1', displayInput: 'hello', createdAt: 'now' },
    { type: 'record', record: message('m1', 'user', 'hello') },
    { type: 'stream', event: { type: 'text_delta', text: 'hi' } },
    { type: 'tool-progress', listContent: 'Reading a.txt' },
    { type: 'notice', level: 'system', content: 'note' },
    { type: 'transcript-reset', records: [], systemMessages: [], bumpGeneration: false },
    { type: 'restore-input', text: 'unsent' },
    { type: 'active-model', model: { model: 'claude-fallback', modelKey: 'fallback' } as never },
    { type: 'turn-end', aborted: false, rolledBack: false, durationMs: 1200 },
  ]

  assert.deepEqual(samples.map((event) => event.type).sort(), [...ALL_EVENT_TYPES].sort())
  assert.doesNotThrow(() => fold(samples))
})

test('an unknown event type throws rather than being silently dropped', () => {
  // `assertNever` is what makes the exhaustive switch load-bearing; without it a
  // new variant compiles clean and vanishes at runtime.
  assert.throws(
    () => applySessionEvent(createTranscriptState(), { type: 'invented' } as never),
    /Unhandled session event/,
  )
})

test('a wake turn started by background-agent reminders draws no user bubble', () => {
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: '<system-reminder>\nagent done\n</system-reminder>', createdAt: 'now' },
    { type: 'record', record: message('m1', 'user', '<system-reminder>\nagent done\n</system-reminder>') },
  ])
  assert.deepEqual(state.items, [])
})

test('a streamed draft is replaced by the assistant record, not appended twice', () => {
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' },
    { type: 'stream', event: { type: 'text_delta', text: 'Hel' } },
    { type: 'stream', event: { type: 'text_delta', text: 'lo!' } },
    { type: 'record', record: message('a1', 'assistant', 'Hello!') },
  ])

  const assistant = state.items.filter((item) => item.kind === 'assistant')
  assert.equal(assistant.length, 1, 'two bubbles is the duplicate the terminal avoids')
  assert.equal(assistant[0]?.text, 'Hello!')
  assert.equal(assistant[0]?.pending, undefined, 'the committed record is not pending')
})

/**
 * The user's own message is drawn twice unless `applyRecord` is idempotent by
 * id: `turn-start` puts it on screen immediately under `event.messageId`, and
 * `SessionController.submit` hands that very id to `AgentLoop`, which stamps it
 * on the persisted `message` record. The TUI dodges this by ignoring user
 * records entirely (`useAgentLoop.ts` only folds `role === 'assistant'`); here
 * the record is the authoritative text, so it replaces in place.
 */
test('the user message record replaces its turn-start bubble instead of doubling it', () => {
  const record: SessionRecord = {
    type: 'message', id: 'm1', role: 'user', content: '<long prompt>',
    displayContent: '/skill arg', createdAt: 'now',
  }

  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' },
    { type: 'record', record },
  ])

  const user = state.items.filter((item) => item.kind === 'user')
  assert.equal(user.length, 1, 'two identical bubbles is the desktop smoke-test duplicate')
  assert.equal(user[0]?.text, '/skill arg', 'the record carries displayContent; turn-start does not')
})

test('a user record for a different turn still appends', () => {
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'first', createdAt: 'now' },
    { type: 'record', record: message('m1', 'user', 'first') },
    { type: 'record', record: message('m2', 'user', 'second') },
  ])

  assert.deepEqual(
    state.items.filter((item) => item.kind === 'user').map((item) => item.text),
    ['first', 'second'],
  )
})

test('a draft that never became a record is dropped at turn-end', () => {  const { state } = fold([
    { type: 'stream', event: { type: 'text_delta', text: 'partial' } },
    { type: 'turn-end', aborted: true, rolledBack: false, durationMs: 900 },
  ])

  assert.deepEqual(state.items, [], 'a pending bubble would sit there looking live forever')
})

// --- thinking blocks (5d) ---------------------------------------------------
//
// The contract changed in 5d: a thinking block used to be a 240-character tail
// peek that `turn-end` deleted. It is now the turn's collapsible header, so it is
// retained in full, sealed rather than dropped, and it carries the elapsed time
// that used to be a separate `duration` line.

const thinkingDelta = (thinking: string): SessionEvent => ({
  type: 'stream',
  event: { type: 'thinking_delta', thinking },
})

const turnEnd = (durationMs: number, aborted = false): SessionEvent => ({
  type: 'turn-end', aborted, rolledBack: false, durationMs,
})

const thinkingItems = (state: TranscriptState) => state.items.filter((item) => item.kind === 'thinking')

test('a turn keeps one thinking block, and its text is retained in full', () => {
  const long = 'x'.repeat(500)
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' },
    thinkingDelta(long),
    thinkingDelta('!'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text.length, item.pending]), [
    ['thinking-0', 501, true],
  ])
  assert.equal(state.isThinking, true)
  assert.equal(state.thinkingCount, 1)
})

test('message_start closes the segment and opens a new one, one per model request', () => {
  // T3 (§4.2): a second request within the turn is a *second* segment, not more
  // text appended to the first — that is the shape replaying `thinkingBlocks`
  // produces, and the reason the two paths can be compared at all. Neither
  // boundary may delete reasoning: the block is what the header expands.
  const { state } = fold([
    thinkingDelta('before'),
    { type: 'record', record: message('a1', 'assistant', 'calling a tool') },
    { type: 'stream', event: { type: 'message_start' } },
    thinkingDelta('after'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text, item.pending]), [
    ['thinking-0', 'before', undefined],
    ['thinking-1', 'after', true],
  ])
})

test('the assistant record supersedes the streamed segment in place, under its own id', () => {
  // Replay mints `a1-thinking` from `thinkingBlocks`; the live path has to land on
  // the same id at the same position, or the symmetry below compares two trees
  // that differ only in bookkeeping.
  const record: SessionRecord = {
    type: 'message', id: 'a1', role: 'assistant', content: 'done', createdAt: 'now',
    thinkingBlocks: [{ type: 'thinking', thinking: 'reasoned' }],
  }

  const { state } = fold([thinkingDelta('reas'), thinkingDelta('oned'), { type: 'record', record }])

  assert.deepEqual(state.items.map((item) => [item.id, item.kind]), [['a1-thinking', 'thinking'], ['a1', 'assistant']])
  assert.equal(state.liveThinkingId, undefined, 'the segment is committed; a later delta opens a new one')
})

test('a record without thinkingBlocks keeps what streamed instead of deleting it', () => {
  const { state } = fold([
    thinkingDelta('reasoned'),
    { type: 'record', record: message('a1', 'assistant', 'done') },
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text, item.pending]), [
    ['thinking-0', 'reasoned', undefined],
  ])
})

test('thinking_stop does not close the block, so the live face survives it', () => {
  // This is what pins「活标签由 item.pending 驱动，不由 state.isThinking 驱动」:
  // the flag goes false here while the very same block keeps arriving.
  const { state } = fold([
    thinkingDelta('a'),
    { type: 'stream', event: { type: 'thinking_stop' } },
    thinkingDelta('b'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text, item.pending]), [
    ['thinking-0', 'ab', true],
  ])
})

test('turn-end closes the segment and the elapsed time rides on a duration item', () => {
  // T3 (§5.3): the turn's total belongs to the group head, not to whichever
  // request happened to reason last — under §4.2 that is one segment among many.
  const { state } = fold([thinkingDelta('why'), turnEnd(458_000)])

  assert.deepEqual(thinkingItems(state).map((item) => [item.pending, item.durationMs]), [[undefined, undefined]])
  assert.deepEqual(
    state.items.filter((item) => item.kind === 'duration').map((item) => [item.text, item.durationMs]),
    [['已处理 7m 38s', 458_000]],
  )
  assert.equal(state.isThinking, false)
})

test('a turn\'s elapsed time is a loose line after its last entry', () => {
  const { state } = fold([
    { type: 'record', record: stamped(message('u1', 'user', 'go'), 't1', 'now') },
    { type: 'record', record: toolUse('tu1', 't1', 'now') },
    { type: 'record', record: toolResult('tu1', 't1', 'now') },
    turnEnd(1200),
  ])

  const entries = groupTranscript(state.items)
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'run', 'item'])
  assert.deepEqual([itemAt(entries, 2).kind, itemAt(entries, 2).durationMs], ['duration', 1200])
})

test('a notice minted before turn-end does not separate the elapsed time from the answer', () => {
  // The controller emits turn-level notices — an interruption, a turn error —
  // between the turn's last record and `turn-end`, and those carry no `turnId`.
  // The duration is hoisted back beside the turn it measures.
  const { state } = fold([
    { type: 'record', record: stamped(message('u1', 'user', 'go'), 't1', 'now') },
    { type: 'record', record: toolUse('tu1', 't1', 'now') },
    { type: 'record', record: toolResult('tu1', 't1', 'later') },
    { type: 'record', record: assistant('a1', 't1', 'later', 'done') },
    { type: 'notice', level: 'system', content: 'Interrupted.' },
    turnEnd(1200),
  ])

  const entries = groupTranscript(state.items)
  assert.deepEqual(entries.map((entry) => entry.kind === 'item' ? entry.item.kind : entry.kind), ['user', 'run', 'assistant', 'duration', 'notice'])
  assert.equal(itemAt(entries, 3).durationMs, 1200)
})

test('an assistant record names the model that wrote it; the user and the draft do not', () => {
  const { state } = fold([
    { type: 'record', record: stamped(message('u1', 'user', 'go'), 't1', 'now') },
    { type: 'stream', event: { type: 'text_delta', text: 'part' } },
  ])
  assert.deepEqual(state.items.map((item) => [item.kind, item.model]), [
    ['user', undefined],
    ['assistant', undefined],
  ])

  const committed = applySessionEvent(state, {
    type: 'record',
    record: { ...assistant('a1', 't1', 'now', 'part done'), model: 'glm-5.3' } as SessionRecord,
  }).state
  assert.deepEqual(committed.items.map((item) => [item.kind, item.model]), [
    ['user', undefined],
    ['assistant', 'glm-5.3'],
  ])
})

test('a zero-step turn still draws the single elapsed line, under the answer', () => {
  const { state } = fold([
    { type: 'record', record: stamped(message('u1', 'user', 'hi'), 't1', 'now') },
    { type: 'stream', event: { type: 'text_delta', text: 'hi' } },
    { type: 'record', record: assistant('a1', 't1', 'now', 'hi') },
    turnEnd(1200),
  ])

  const entries = groupTranscript(state.items)
  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item', 'item'])
  assert.deepEqual([itemAt(entries, 1).text, itemAt(entries, 2).text], ['hi', '已处理 1s'])
})

test('a live thought is timed from its first delta to its last stop, and keeps the time through its commit', () => {
  let state = createTranscriptState()
  const at = (event: SessionEvent, now: number): void => { state = applySessionEvent(state, event, undefined, now).state }
  at({ type: 'stream', event: { type: 'message_start' } }, 0)
  at(thinkingDelta('a'), 1_000)
  at({ type: 'stream', event: { type: 'thinking_stop' } }, 3_000)
  at(thinkingDelta('b'), 4_000)
  at({ type: 'stream', event: { type: 'thinking_stop' } }, 13_000)
  assert.deepEqual(thinkingItems(state).map((item) => item.durationMs), [12_000])
  at({ type: 'record', record: { type: 'message', id: 'a1', role: 'assistant', content: 'hi',
    thinkingBlocks: [{ type: 'thinking', thinking: 'ab' }], createdAt: 'now' } }, 14_000)
  assert.deepEqual(thinkingItems(state).map((item) => [item.text, item.durationMs, item.startedAt]), [['ab', 12_000, undefined]])

  // Without a clock (a replay, a test) nothing is measured.
  const { state: untimed } = fold([thinkingDelta('why'), { type: 'stream', event: { type: 'thinking_stop' } }])
  assert.deepEqual(thinkingItems(untimed).map((item) => item.durationMs), [undefined])
})

test('an aborted turn seals the block without a summary', () => {
  const { state } = fold([thinkingDelta('why'), turnEnd(900, true)])

  assert.deepEqual(thinkingItems(state).map((item) => [item.pending, item.durationMs]), [[undefined, undefined]])
  assert.equal(state.items.some((item) => item.kind === 'duration'), false)
})

test('a later turn-end leaves an earlier turn is block alone', () => {
  const { state } = fold([
    thinkingDelta('first'),
    turnEnd(458_000),
    thinkingDelta('second'),
    turnEnd(2000),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => [item.id, item.text, item.pending]), [
    ['thinking-0', 'first', undefined],
    ['thinking-1', 'second', undefined],
  ])
  assert.deepEqual(
    state.items.filter((item) => item.kind === 'duration').map((item) => item.text),
    ['已处理 7m 38s', '已处理 2s'],
  )
})

test('block ids come from a counter, not from the list length', () => {
  // `turn-end` drops the draft, so the list shrinks between turns: two blocks would
  // be minted at the same length and a single toggle would fold both.
  const { state } = fold([
    thinkingDelta('first'),
    { type: 'stream', event: { type: 'text_delta', text: 'partial' } },
    turnEnd(1000, true),
    thinkingDelta('second'),
  ])

  assert.deepEqual(thinkingItems(state).map((item) => item.id), ['thinking-0', 'thinking-1'])
})

test('transcript-reset drops a block that was still arriving', () => {
  const { state: mid } = fold([thinkingDelta('half a thought')])
  const { state } = fold(
    [{ type: 'transcript-reset', records: [], systemMessages: [], bumpGeneration: false }],
    mid,
  )

  assert.deepEqual(thinkingItems(state), [])
  assert.equal(state.thinkingCount, 0, 'and the counter restarts — which is why the view prunes its toggles')
})

test('the elapsed time reads as minutes and seconds, with a tenth under a second', () => {
  assert.equal(formatWorkedDuration(458_000), '7m 38s')
  assert.equal(formatWorkedDuration(62_000), '1m 2s')
  assert.equal(formatWorkedDuration(3400), '3s', 'above a second the fraction is noise')
  assert.equal(formatWorkedDuration(1000), '1s')
  // `已处理 0s` reads as a broken clock, so a sub-second turn keeps its fraction.
  assert.equal(formatWorkedDuration(420), '0.4s')
  assert.equal(formatWorkedDuration(-5), '0s')
})

test('a tool result replaces the pending call row it answers', () => {
  const toolUse: SessionRecord = {
    type: 'tool_use', id: 'tu1', tool: 'Read', input: { filePath: 'a.txt' },
    riskLevel: 'safe', createdAt: 'now',
  }
  const toolResult: SessionRecord = {
    type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Read', ok: true,
    content: 'file body\nmore', createdAt: 'now',
  }

  const { state: pending } = fold([{ type: 'record', record: toolUse }])
  assert.equal(pending.items.length, 1)
  assert.equal(pending.items[0]?.pending, true)
  assert.equal(pending.items[0]?.text, 'Read(a.txt)')

  const { state } = fold([{ type: 'record', record: toolResult }], pending)
  assert.equal(state.items.length, 1, 'the call and its result are one row')
  assert.equal(state.items[0]?.pending, undefined)
  // `tool`, not `toolName` — the field the shipped renderer read wrongly.
  assert.equal(state.items[0]?.toolName, 'Read')
  assert.match(state.items[0]?.text ?? '', /^Read → file body/)
})

test('a failed tool result is marked failed', () => {
  const { state } = fold([{
    type: 'record',
    record: {
      type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Bash', ok: false,
      content: 'command not found', createdAt: 'now',
    },
  }])

  assert.equal(state.items[0]?.failed, true)
  assert.match(state.items[0]?.text ?? '', /Bash failed: command not found/)
})

test('a failed result carries its error code; a successful one carries none', () => {
  const toolUse: SessionRecord = {
    type: 'tool_use', id: 'tu1', tool: 'Bash', input: { command: 'npm test' },
    riskLevel: 'dangerous', createdAt: 'now',
  }
  const result = (ok: boolean, errorCode?: ToolErrorCode): SessionRecord => ({
    type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Bash', ok,
    content: 'output', createdAt: 'later',
    ...(errorCode === undefined ? {} : { errorCode }),
  })

  const { state } = fold([
    { type: 'record', record: toolUse },
    { type: 'record', record: result(false, 'command_failed') },
  ])
  // §6.2's common body rule — 失败时错误码单独一行 — draws from this field.
  assert.equal(state.items[0]?.tool?.errorCode, 'command_failed')

  // A code the result succeeded with is not a failure's code; the body only
  // draws it on a failed step, so the field itself is only ever a failure's.
  const { state: oked } = fold([
    { type: 'record', record: toolUse },
    { type: 'record', record: result(true, 'command_failed') },
  ])
  assert.equal(oked.items[0]?.tool?.errorCode, undefined)
})

test('notices map to system and error rows', () => {
  const { state } = fold([
    { type: 'notice', level: 'system', content: 'connected' },
    { type: 'notice', level: 'error', content: 'boom' },
  ])

  assert.deepEqual(state.items.map((item) => [item.kind, item.text]), [
    ['notice', 'connected'],
    ['error', 'boom'],
  ])
})

test('transcript-reset rebuilds from records and only bumps the generation when asked', () => {
  const seeded = createTranscriptState([message('m1', 'user', 'old')])

  const { state: rollback } = fold([{
    type: 'transcript-reset', records: [message('m2', 'user', 'new')],
    systemMessages: ['restored'], bumpGeneration: false,
  }], seeded)
  assert.deepEqual(rollback.items.map((item) => item.text), ['new', 'restored'])
  assert.equal(rollback.generation, 0, 'a rollback must not remount the view')

  const { state: switched } = fold([{
    type: 'transcript-reset', records: [], systemMessages: [], bumpGeneration: true,
  }], rollback)
  assert.equal(switched.generation, 1)
})

test('restore-input and active-model leave the transcript alone and surface outward', () => {
  const seeded = createTranscriptState([message('m1', 'user', 'kept')])
  const { state, restored, models } = fold([
    { type: 'restore-input', text: 'unsent text' },
    { type: 'active-model', model: { model: 'claude-fallback' } as never },
  ], seeded)

  assert.deepEqual(restored, ['unsent text'], 'dropping this destroys the user\'s message')
  assert.deepEqual(models, ['claude-fallback'])
  assert.deepEqual(state.items.map((item) => item.text), ['kept'])
})

test('tool progress is state, not an item', () => {
  const { state } = fold([{ type: 'tool-progress', listContent: 'Reading a.txt' }])
  assert.equal(state.toolProgress, 'Reading a.txt')
  assert.deepEqual(state.items, [])
})

test('a running Agent step carries its sub-agent\'s latest tool until the result lands', () => {
  const call: SessionRecord = {
    type: 'tool_use', id: 'agent-call', tool: 'Agent', riskLevel: 'safe', createdAt: 'now',
    input: { subagent_type: 'explore', description: 'look', task: 'look around' },
  } as SessionRecord
  let { state } = fold([
    { type: 'record', record: call },
    { type: 'tool-progress', subagents: [{ toolUseId: 'agent-call', tool: 'Read', summary: 'a.txt', toolCount: 1 }] },
  ])
  const step = state.items.find((item) => item.id === 'agent-call')
  assert.equal(step?.tool?.displayName, '子代理')
  assert.equal(step?.tool?.agentType, 'explore')
  assert.deepEqual(step?.tool?.live, { tool: 'Read', summary: 'a.txt', toolCount: 1 })

  // An unchanged set keeps the array, so a repaint costs nothing.
  const same = fold([{ type: 'tool-progress', subagents: [{ toolUseId: 'agent-call', tool: 'Read', summary: 'a.txt', toolCount: 1 }] }], state).state
  assert.equal(same.items, state.items)

  state = fold([{ type: 'tool-progress' }], state).state
  assert.equal(state.items.find((item) => item.id === 'agent-call')?.tool?.live, undefined)
})

test('the subagent summary appended for the model draws nothing', () => {
  const { state } = fold([
    { type: 'record', record: message('s1', 'assistant', '<subagent-summary type="general" agent_id="a1" tokens="12" />') },
    { type: 'record', record: message('s2', 'assistant', '<subagent-summary type="explore">\n  <critical-file>a.ts</critical-file>\n</subagent-summary>') },
  ])
  assert.deepEqual(state.items, [])
  assert.deepEqual(createTranscriptState([message('s1', 'assistant', '<subagent-summary type="general" />')]).items, [])
})

test('a failed turn still gets its duration line; an aborted one does not', () => {
  assert.equal(formatTurnSummary({ type: 'turn-end', aborted: false, rolledBack: false, durationMs: 1250 }), '已处理 1s')
  assert.equal(formatTurnSummary({ type: 'turn-end', aborted: true, rolledBack: false, durationMs: 1250 }), undefined)
})

test('bookkeeping records render nothing, and the visible ones read plainly', () => {
  const { state } = fold([
    { type: 'record', record: { type: 'tool_approval', id: 'ta1', toolUseId: 'tu1', tool: 'Read', approved: true, createdAt: 'now' } as never },
    { type: 'record', record: { type: 'message_queue', id: 'mq1', messages: [], createdAt: 'now' } as never },
    { type: 'record', record: { type: 'turn_interruption', id: 'ti1', userMessageId: 'm1', prompt: 'p', remainingTasks: [], recoverable: true, createdAt: 'now' } },
    { type: 'record', record: { type: 'compact_boundary', id: 'cb1', summary: 's', preTokens: 10, createdAt: 'now' } },
  ])

  assert.deepEqual(state.items.map((item) => item.text), ['Interrupted.', 'Context compacted.'])
})

test('a system-reminder user record is hidden from the transcript', () => {
  // The harness appends these as model-facing nudges (e.g. "all tool calls in
  // the previous turn failed"); the wrapper tag must not render as a user bubble.
  const record: SessionRecord = {
    type: 'message', id: 'r1', role: 'user',
    content: wrapInSystemReminder('All tool calls in the previous turn failed.'),
    createdAt: 'now',
  }

  const { state } = fold([{ type: 'record', record }])

  assert.equal(state.items.some((item) => item.kind === 'user'), false)
  assert.equal(state.items.length, 0, 'the nudge yields no item at all')
})

test('a user message that merely mentions the tag inline is still shown', () => {
  // Only an entire `<system-reminder>` block is hidden; an inline mention is real text.
  const { state } = fold([{
    type: 'record',
    record: message('m1', 'user', 'see <system-reminder> in the docs'),
  }])

  const user = state.items.filter((item) => item.kind === 'user')
  assert.equal(user.length, 1)
  assert.equal(user[0]?.text, 'see <system-reminder> in the docs')
})

test('the tool summary picks the most identifying argument', () => {
  assert.equal(toolCallSummary('Bash', { command: 'ls -la' }), 'Bash(ls -la)')
  assert.equal(toolCallSummary('Read', { filePath: 'a.txt' }), 'Read(a.txt)')
  assert.equal(toolCallSummary('Grep', { pattern: 'foo' }), 'Grep(foo)')
  assert.equal(toolCallSummary('Weird', { unknown: 1 }), 'Weird')
})

/**
 * 活动组（`activity_group_design.md` §4）: the replay path only — the live fold
 * keeps its shape until T3 moves `message_start` onto the same segmentation.
 * `groupTranscript` is a pure projection over `items`, so these read records in
 * and the group tree out.
 */

function stamped(record: SessionRecord, turnId: string, createdAt: string): SessionRecord {
  return { ...record, turnId, createdAt } as SessionRecord
}

function assistant(
  id: string,
  turnId: string,
  createdAt: string,
  content: string,
  thinking?: string[],
): SessionRecord {
  return {
    type: 'message', id, role: 'assistant', content, createdAt, turnId,
    ...(thinking ? { thinkingBlocks: thinking.map((text) => ({ type: 'thinking' as const, thinking: text })) } : {}),
  }
}

function toolUse(id: string, turnId: string, createdAt: string): SessionRecord {
  return { type: 'tool_use', id, tool: 'Read', input: { filePath: 'a.txt' }, riskLevel: 'safe', createdAt, turnId }
}

function toolResult(toolUseId: string, turnId: string, createdAt: string, ok = true): SessionRecord {
  return {
    type: 'tool_result', id: `${toolUseId}-r`, toolUseId, tool: 'Read', ok,
    content: ok ? 'contents' : 'boom', createdAt, turnId,
  }
}

function runAt(entries: ReturnType<typeof groupTranscript>, index: number): ActivityRun {
  const entry = entries[index]
  assert.equal(entry?.kind, 'run')
  return (entry as { kind: 'run'; run: ActivityRun }).run
}

/** A turn replayed from records has no measured elapsed line; the grouping makes one from the span. */
function withoutSpans(entries: ReturnType<typeof groupTranscript>) {
  return entries.filter((entry) => !(entry.kind === 'item' && entry.item.kind === 'duration'))
}

function itemAt(entries: ReturnType<typeof groupTranscript>, index: number): TranscriptItem {
  const entry = entries[index]
  assert.equal(entry?.kind, 'item')
  return (entry as { kind: 'item'; item: TranscriptItem }).item
}

function groupsOf(records: SessionRecord[]) {
  return groupTranscript(createTranscriptState(records).items)
}

test('a turn becomes runs of work between prose: thinking and tools together, the answer outside', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    assistant('a1', 't1', '2026-01-01T00:00:01.000Z', '', ['思考A']),
    toolUse('tu1', 't1', '2026-01-01T00:00:01.500Z'),
    toolResult('tu1', 't1', '2026-01-01T00:00:02.000Z'),
    assistant('a2', 't1', '2026-01-01T00:00:04.000Z', 'done', ['思考B']),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'run', 'item', 'item'])
  assert.equal(itemAt(entries, 0).kind, 'user')
  assert.equal(itemAt(entries, 2).text, 'done')

  const run = runAt(entries, 1)
  assert.equal(run.id, 'run:a1-thinking', 'the first step names the run')
  assert.equal(run.turnId, 't1')
  assert.deepEqual(run.steps.map((step) => step.kind), ['thinking', 'tool', 'thinking'])
  assert.equal(run.failedCount, 0)
  assert.equal(run.status, 'done')
  // No turn-end to quote on replay: the records span the turn, and the line is made here.
  assert.deepEqual([itemAt(entries, 3).kind, itemAt(entries, 3).durationMs, itemAt(entries, 3).text], ['duration', 4000, '已处理 4s'])
})

test('a failed call is counted, and a never-answered one keeps the group running', () => {
  const failed = runAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now', false),
  ]), 1)
  assert.equal(failed.failedCount, 1)
  assert.equal(failed.status, 'done')

  const running = runAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
  ]), 1)
  assert.equal(running.status, 'running')
})

test('a notice ends a run, and an interruption marks what it cut off as aborted', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    stamped({ type: 'compact_boundary', id: 'cb1', summary: 's', preTokens: 10, createdAt: 'now' }, 't1', 'now'),
    toolUse('tu2', 't1', 'now'),
    stamped(
      { type: 'turn_interruption', id: 'ti1', userMessageId: 'u1', prompt: 'p', remainingTasks: [], recoverable: true, createdAt: 'now' },
      't1',
      'now',
    ),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind === 'item' ? entry.item.kind : entry.kind), ['user', 'run', 'notice', 'run', 'notice'])
  assert.equal(runAt(entries, 1).status, 'done')
  assert.equal(runAt(entries, 3).status, 'aborted', 'the call the abort cut off must not read as running')
})

test('prose between tools is a loose item that ends the run before it', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    assistant('a1', 't1', 'now', '先看文件'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a2', 't1', 'now', '看完了'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item', 'run', 'item'])
  assert.equal(itemAt(entries, 1).text, '先看文件')
  assert.deepEqual(runAt(entries, 2).steps.map((step) => [step.kind, step.text]), [['tool', 'Read → contents']])
  assert.equal(itemAt(entries, 3).text, '看完了')
})

test('adjacent thinking with no tool between it is one segment', () => {
  const steps = runAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    assistant('a1', 't1', 'now', '', ['第一段', '第二段']),
    assistant('a2', 't1', 'now', '', ['第三段']),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a3', 't1', 'now', 'done', ['第四段']),
  ]), 1).steps

  assert.deepEqual(steps.map((step) => step.kind), ['thinking', 'tool', 'thinking'])
  assert.equal(steps[0]?.text, '第一段\n\n第二段\n\n第三段')
  assert.equal(steps[2]?.text, '第四段')
})

test('an old session without thinkingBlocks degrades to tool-only steps, unannotated', () => {
  const group = runAt(groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    assistant('a1', 't1', 'now', ''),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a2', 't1', 'now', 'done'),
  ]), 1)

  assert.deepEqual(group.steps.map((step) => step.kind), ['tool'])
  assert.equal(group.steps.some((step) => step.text.includes('思考')), false)
})

test('a zero-step turn draws no empty group', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'hi'), 't1', 'now'),
    assistant('a1', 't1', 'now', 'hello'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item'])
})

test('turn-less items stay loose, in place', () => {
  const entries = groupsOf([
    message('u0', 'user', 'before'),
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'item', 'run'])
  assert.equal(itemAt(entries, 0).text, 'before')
})

/**
 * §4.2 的地基：直播与回放走同一套切分。
 *
 * The live fold and `createTranscriptState` over the very same records must land
 * on the same group tree — same steps, same ids, same order, same status. Anything
 * less and the picture deforms the moment a turn ends, and a `transcript-reset`
 * (`/resume`, a rollback) reshuffles content the reader has already read.
 */

const TURN = 't1'
const AT = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms)).toISOString()

/** One realistic turn: reason, call a tool, reason again, answer. */
const REPLAYED: SessionRecord[] = [
  stamped(message('u1', 'user', 'go'), TURN, AT(0)),
  assistant('a1', TURN, AT(500), '先看文件', ['思考A']),
  toolUse('tu1', TURN, AT(600)),
  toolResult('tu1', TURN, AT(900)),
  assistant('a2', TURN, AT(2000), 'done', ['思考B']),
]

/** The same turn as it actually arrives: streamed, then committed by records. */
const LIVE: SessionEvent[] = [
  { type: 'turn-start', messageId: 'u1', displayInput: 'go', createdAt: AT(0) },
  { type: 'record', record: REPLAYED[0]! },
  { type: 'stream', event: { type: 'message_start' } },
  thinkingDelta('思考'),
  thinkingDelta('A'),
  { type: 'stream', event: { type: 'thinking_stop' } },
  { type: 'stream', event: { type: 'text_delta', text: '先看文件' } },
  { type: 'record', record: REPLAYED[1]! },
  { type: 'record', record: REPLAYED[2]! },
  { type: 'record', record: REPLAYED[3]! },
  { type: 'stream', event: { type: 'message_start' } },
  thinkingDelta('思考B'),
  { type: 'stream', event: { type: 'text_delta', text: 'done' } },
  { type: 'record', record: REPLAYED[4]! },
  turnEnd(2000),
]

test('a live turn and a replay of its records produce the same runs, field for field', () => {
  const live = groupTranscript(fold(LIVE).state.items)
  const replayed = groupTranscript(createTranscriptState(REPLAYED).items)

  // The elapsed line is measured live and made from the span on replay.
  assert.deepEqual(withoutSpans(live), withoutSpans(replayed))
  assert.equal(itemAt(live, live.length - 1).durationMs, 2000)
  assert.equal(itemAt(replayed, replayed.length - 1).durationMs, 2000)
  // Not vacuous: the tree is the real one, with both segments and the tool between.
  assert.deepEqual(withoutSpans(live).map((entry) => entry.kind === 'run' ? entry.run.steps.map((step) => step.id) : entry.item.text), [
    'go',
    ['a1-thinking'],
    '先看文件',
    ['tu1', 'a2-thinking'],
    'done',
  ])
})

test('stream commits keep presentation ids while canonical items still match replay', () => {
  const before = fold(LIVE.slice(0, 7)).state
  const after = fold(LIVE.slice(0, 8)).state
  const presented = (state: TranscriptState) => presentationTranscript(state).items.map((item) => item.id)
  assert.deepEqual(presented(after), presented(before))
  assert.notDeepEqual(after.items.map((item) => item.id), before.items.map((item) => item.id))
  const complete = fold(LIVE).state
  const ids = presented(complete)
  assert.equal(new Set(ids).size, ids.length, 'a later draft must not take the previous answer’s identity')
  assert.ok((complete.presentationIds?.size ?? 0) <= complete.items.length)
  const reset = applySessionEvent(complete, { type: 'transcript-reset', records: REPLAYED, systemMessages: [], bumpGeneration: true }).state
  assert.equal(presentationTranscript(reset), reset, 'replay has no live aliases from the previous pane')
})

test('prose streamed before a tool call stays a loose item when the call arrives', () => {
  const upTo = (count: number) => withoutSpans(groupTranscript(fold(LIVE.slice(0, count)).state.items))

  const tentative = upTo(8)
  assert.deepEqual(tentative.map((entry) => entry.kind), ['item', 'run', 'item'])
  assert.equal(itemAt(tentative, 2).text, '先看文件')

  const demoted = upTo(9)
  assert.deepEqual(demoted.map((entry) => entry.kind), ['item', 'run', 'item', 'run'])
  assert.equal(itemAt(demoted, 2).text, '先看文件', 'the prose does not move')
  assert.deepEqual(runAt(demoted, 3).steps.map((step) => [step.kind, step.text]), [['tool', 'Read(a.txt)']])
})

test('an interrupted turn reads aborted live and on replay, tool still unanswered', () => {
  const interruption: SessionRecord = stamped(
    { type: 'turn_interruption', id: 'ti1', userMessageId: 'u1', prompt: 'p', remainingTasks: [], recoverable: true, createdAt: AT(900) },
    TURN,
    AT(900),
  )
  const records = [REPLAYED[0]!, REPLAYED[2]!, interruption]

  const live = fold([
    { type: 'record', record: records[0]! },
    { type: 'record', record: records[1]! },
    { type: 'stream', event: { type: 'text_delta', text: 'half' } },
    { type: 'record', record: records[2]! },
    turnEnd(900, true),
  ]).state

  assert.equal(live.items.some((item) => item.text === 'half'), false, 'the orphan draft is dropped')
  assert.equal(live.items.some((item) => item.kind === 'duration'), false, 'an aborted turn has no elapsed line')

  const group = runAt(groupTranscript(live.items), 1)
  assert.equal(group.status, 'aborted', 'a call the abort cut off must not read as still running')
  assert.equal(runAt(groupTranscript(createTranscriptState(records).items), 1).status, 'aborted')
})

test('two turns are two runs, in order', () => {
  const entries = groupsOf([
    stamped(message('u1', 'user', 'one'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
    assistant('a1', 't1', 'now', 'first'),
    stamped(message('u2', 'user', 'two'), 't2', 'now'),
    toolUse('tu2', 't2', 'now'),
    toolResult('tu2', 't2', 'now'),
    assistant('a2', 't2', 'now', 'second'),
  ])

  assert.deepEqual(entries.map((entry) => entry.kind), ['item', 'run', 'item', 'item', 'run', 'item'])
  assert.equal(runAt(entries, 1).turnId, 't1')
  assert.equal(runAt(entries, 4).turnId, 't2')
})

/**
 * §4.5 / T4: a tool is **one** step holding both records.
 *
 * The caption comes from the host's `ToolDisplayDto` (T1) rather than from
 * guessing at `input`'s keys, and the body from `display.detail ?? content`. The
 * fallback path is kept deliberately: an older host sends no captions at all, and
 * degrading to the previous one-liner beats drawing raw JSON.
 */

function displays(map: Record<string, ToolDisplayDto>): ToolDisplayLookup {
  return (recordId) => map[recordId]
}

function captionedRead(): ToolDisplayLookup {
  return displays({ tu1: { displayName: 'Read', useSummary: 'src/a.ts' } })
}

function toolStep(entries: ReturnType<typeof groupTranscript>, index: number, step = 0) {
  const found = runAt(entries, index).steps[step]
  assert.ok(found?.kind === 'tool' || found?.kind === 'task', `step ${step} is ${found?.kind}`)
  return found
}

function stepStatuses(entries: ReturnType<typeof groupTranscript>, index: number) {
  return runAt(entries, index).steps.map((step) => ('status' in step ? step.status : undefined))
}

test('the call and its result are one step: head from the DTO, body from display.detail', () => {
  const entries = groupTranscript(createTranscriptState([
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    toolUse('tu1', 't1', '2026-01-01T00:00:01.000Z'),
    {
      type: 'tool_result', id: 'tr1', toolUseId: 'tu1', tool: 'Read', ok: true,
      content: 'raw contents', createdAt: '2026-01-01T00:00:03.500Z', turnId: 't1',
      display: { summary: 'Read 240 lines', headerSuffix: '240 行', detail: '1 | export {}' },
    },
  ], captionedRead()).items)

  assert.equal(runAt(entries, 1).steps.length, 1, 'not one row for the call and another for the result')

  const step = toolStep(entries, 1)
  assert.equal(step.kind, 'tool')
  assert.equal(step.text, 'Read src/a.ts', 'the head stays the call, captioned host-side')
  assert.equal(step.tool.displayName, 'Read')
  assert.equal(step.tool.useSummary, 'src/a.ts', 'not a guess at input.filePath')
  assert.equal(step.tool.headerSuffix, '240 行')
  assert.equal(step.tool.resultSummary, 'Read 240 lines')
  assert.equal(step.tool.detail, '1 | export {}')
  assert.equal(step.tool.content, 'raw contents', 'the body falls back to it when detail is absent')
})

test('a tool step measures itself from the two records, with no new record field', () => {
  const entries = groupTranscript(createTranscriptState([
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    toolUse('tu1', 't1', '2026-01-01T00:00:01.000Z'),
    toolResult('tu1', 't1', '2026-01-01T00:00:03.500Z'),
  ], captionedRead()).items)

  assert.equal(toolStep(entries, 1).tool.durationMs, 2500)
})

test('the four tool states are derived, and each one has words as well as a colour', () => {
  const call = toolUse('tu1', 't1', '2026-01-01T00:00:01.000Z')
  const approval: SessionRecord = {
    type: 'tool_approval', id: 'ta1', tool: 'Read', input: {}, approved: true,
    riskLevel: 'safe', createdAt: '2026-01-01T00:00:02.000Z', turnId: 't1',
  }
  const head = stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z')
  const statusOf = (records: SessionRecord[]) =>
    toolStep(groupTranscript(createTranscriptState([head, ...records], captionedRead()).items), 1).status

  assert.equal(statusOf([call]), 'awaiting-approval', 'recorded, but the gate has not answered')
  assert.equal(statusOf([call, approval]), 'running')
  assert.equal(statusOf([call, approval, toolResult('tu1', 't1', 'now')]), 'done')
  assert.equal(statusOf([call, approval, toolResult('tu1', 't1', 'now', false)]), 'failed')

  // §3 makes the bead the only *visual* vocabulary, so the state must also exist
  // as text — the bead is aria-hidden and a colour is not a label.
  assert.deepEqual(
    (['awaiting-approval', 'running', 'done', 'failed'] as ToolStepStatus[]).map(toolStatusLabel),
    ['等待授权', '执行中', '完成', '失败'],
  )
})

test('an approval answers the earliest waiting call of its tool, live and on replay', () => {
  // The approval record names no call, so a finished Read's approval must not be
  // what clears a second, still-waiting Read.
  const records: SessionRecord[] = [
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    toolUse('tu1', 't1', '2026-01-01T00:00:01.000Z'),
    {
      type: 'tool_approval', id: 'ta1', tool: 'Read', input: {}, approved: true,
      riskLevel: 'safe', createdAt: '2026-01-01T00:00:01.500Z', turnId: 't1',
    },
    toolResult('tu1', 't1', '2026-01-01T00:00:02.000Z'),
    { ...(toolUse('tu2', 't1', '2026-01-01T00:00:03.000Z') as Extract<SessionRecord, { type: 'tool_use' }>) },
  ]

  const replayed = groupTranscript(createTranscriptState(records, captionedRead()).items)
  assert.deepEqual(stepStatuses(replayed, 1), ['done', 'awaiting-approval'])

  const live = fold(records.map((record): SessionEvent => ({ type: 'record', record }))).state
  assert.deepEqual(
    stepStatuses(groupTranscript(live.items), 1),
    ['done', 'awaiting-approval'],
    'live and replay agree, which is the property T3 established',
  )
})

test('without a DTO the step falls back to the old key-guessing line', () => {
  const entries = groupTranscript(createTranscriptState([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    toolUse('tu1', 't1', 'now'),
    toolResult('tu1', 't1', 'now'),
  ]).items)

  const step = toolStep(entries, 1)
  assert.equal(step.text, 'Read → contents', 'an older host sends no captions; this beats raw JSON')
  assert.equal(step.tool.useSummary, 'a.txt', 'guessed from input, exactly as before')
  assert.equal(step.tool.content, 'contents', 'the body is still there to expand')
})

test('TodoWrite is a single task step, and its list lives in the panel instead', () => {
  const entries = groupTranscript(createTranscriptState([
    stamped(message('u1', 'user', 'go'), 't1', 'now'),
    { type: 'tool_use', id: 'tw1', tool: 'TodoWrite', input: {}, riskLevel: 'safe', createdAt: 'now', turnId: 't1' },
    {
      type: 'tool_result', id: 'twr1', toolUseId: 'tw1', tool: 'TodoWrite', ok: true,
      content: 'updated', createdAt: 'now', turnId: 't1',
      display: {
        summary: '更新任务清单',
        taskSnapshot: {
          tasks: [],
          counts: { total: 6, remaining: 3, pending: 2, inProgress: 1, completed: 3 },
        },
      },
    },
  ], displays({ tw1: { displayName: 'TodoWrite', useSummary: '更新任务清单' } })).items)

  const step = toolStep(entries, 1)
  assert.equal(step.kind, 'task', 'not a foldable tool step — the panel above the composer owns the list')
  assert.equal(step.text, 'TodoWrite 更新任务清单')
  assert.deepEqual(step.tool.progress, { completed: 3, total: 6 }, 'the head reads 3/6')
})

// --- the Agent family's run record (T16) -------------------------------------

/**
 * §6.2 Agent: the sub-agent's own `subagent_transcript` record is appended to
 * the parent session *beside* the call's `tool_result`, pointing back at the
 * call through `parentToolUseId`. It merges into that step — the head gains the
 * run's model and tool count, the body its report — so the run paints once,
 * not once as a tool row and again as a transcript row.
 */
function agentCall(id: string, turnId: string, createdAt: string): SessionRecord {
  return {
    type: 'tool_use', id, tool: 'Agent',
    input: { task: '找到 display 的所有用法', subagent_type: 'explore', description: '扫一遍 tools/' },
    riskLevel: 'safe', createdAt, turnId,
  }
}

function agentResult(toolUseId: string, turnId: string, createdAt: string): SessionRecord {
  return {
    type: 'tool_result', id: `${toolUseId}-r`, toolUseId, tool: 'Agent', ok: true,
    content: '22 个工具返回了 display.summary，其中 6 个带 detail。', createdAt, turnId,
    display: { summary: 'Done (12 tool uses · 34k tokens · 5s)', headerSuffix: 'opus' },
  }
}

function agentTranscript(parentToolUseId: string, id: string, createdAt: string): SessionRecord {
  return {
    type: 'subagent_transcript', id, agentId: 'ag-1', subagentType: 'explore', model: 'opus',
    parentToolUseId, status: 'completed', summary: '22 个工具返回了 display.summary。',
    toolUseCount: 12, usage: { inputTokens: 34_000, cacheReadInputTokens: 0, outputTokens: 200 },
    records: [], createdAt, turnId: 't1',
  }
}

test('a sub-agent run merges into the call it belongs to, live and on replay', () => {
  const records: SessionRecord[] = [
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    agentCall('ag1', 't1', '2026-01-01T00:00:01.000Z'),
    agentTranscript('ag1', 'st1', '2026-01-01T00:00:41.000Z'),
    agentResult('ag1', 't1', '2026-01-01T00:00:42.000Z'),
  ]
  const captions = displays({ ag1: { displayName: 'explore agent', useSummary: '扫一遍 tools/' } })

  const replayed = groupTranscript(createTranscriptState(records, captions).items)
  // The call stands alone as an entry (never a step of a run), with the run's facts merged in.
  assert.deepEqual(withoutSpans(replayed).map((entry) => entry.kind), ['item', 'item'])
  const entry = replayed[1]
  assert.ok(entry?.kind === 'item')
  const step = toStep(entry.item)
  assert.ok(step.kind === 'tool')
  assert.equal(step.kind, 'tool')
  assert.equal(step.toolName, 'Agent')
  assert.equal(step.tool.task, '找到 display 的所有用法', 'the prompt rides the call it came in on')
  assert.deepEqual(step.tool.subagent, {
    subagentType: 'explore', agentId: 'ag-1', model: 'opus', toolUseCount: 12, summary: '22 个工具返回了 display.summary。',
  })
  assert.equal(step.tool.headerSuffix, 'opus')
  assert.equal(step.tool.content, '22 个工具返回了 display.summary，其中 6 个带 detail。')
  assert.equal(step.tool.durationMs, 41_000, 'the span is the call’s own — the run record does not stretch it')

  // The property every merge has to keep (T3): folding the same records live
  // produces the same tree, field for field — captions included, which is why
  // the fold here carries the same lookup the replay above did.
  let live = createTranscriptState()
  for (const record of records) {
    live = applySessionEvent(live, { type: 'record', record }, captions).state
  }
  assert.deepEqual(
    groupTranscript(live.items).map((entry) => entry.kind === 'run' ? entry.run : entry.item),
    replayed.map((entry) => entry.kind === 'run' ? entry.run : entry.item),
  )
})

test('a thought with no tool is a run of its own, and a sub-agent run is a step', () => {
  const thoughtOnly = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    assistant('a1', 't1', '2026-01-01T00:00:01.000Z', '中间说明', ['思考A']),
    assistant('a2', 't1', '2026-01-01T00:00:02.000Z', 'done', ['思考B']),
  ])
  assert.deepEqual(withoutSpans(thoughtOnly).map((entry) => entry.kind), ['item', 'run', 'item', 'run', 'item'])
  assert.deepEqual(runAt(thoughtOnly, 1).steps.map((step) => step.kind), ['thinking'])

  const withRun = runAt(groupsOf([
    stamped(message('u2', 'user', 'go'), 't2', '2026-01-01T00:00:00.000Z'),
    assistant('a3', 't2', '2026-01-01T00:00:01.000Z', '', ['思考']),
    toolUse('tu1', 't2', '2026-01-01T00:00:02.000Z'),
    toolResult('tu1', 't2', '2026-01-01T00:00:03.000Z'),
    {
      type: 'subagent_transcript', id: 'st-1', agentId: 'ag-1', subagentType: 'explore',
      summary: '报告', usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      records: [], createdAt: '2026-01-01T00:00:04.000Z', turnId: 't2',
    },
    assistant('a4', 't2', '2026-01-01T00:00:05.000Z', 'done'),
  ]), 1)
  assert.deepEqual(withRun.steps.map((step) => step.kind), ['thinking', 'tool', 'subagent'])
})

test('a message time is the local wall clock, and unparseable stamps draw nothing', () => {
  const at = new Date(2026, 4, 7, 9, 5)
  assert.equal(formatMessageTime(at.toISOString()), '09:05', 'padded, so the column stays aligned')
  assert.equal(formatMessageTime(undefined), undefined)
  assert.equal(formatMessageTime('not a date'), undefined)
})

test('a run record no call claims keeps a row of its own, without erroring', () => {
  // Two orphans: an old record with no parent pointer at all, and one whose
  // pointer names a call a truncated log no longer holds. Neither may throw,
  // and neither may vanish.
  const entries = groupsOf([
    stamped(message('u1', 'user', 'go'), 't1', '2026-01-01T00:00:00.000Z'),
    {
      type: 'subagent_transcript', id: 'st-old', agentId: 'ag-1', subagentType: 'explore',
      summary: '旧报告', usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      records: [], createdAt: '2026-01-01T00:00:01.000Z', turnId: 't1',
    },
    agentTranscript('gone', 'st-orphan', '2026-01-01T00:00:02.000Z'),
  ])

  const group = runAt(entries, 1)
  assert.equal(group.steps.length, 1)
  // The parent-less record is the standalone row it has always been.
  assert.equal(group.steps[0]!.kind, 'subagent')
  assert.equal(group.steps[0]!.text, '子代理 · explore 已完成：旧报告')
  // The unanswerable pointer paints as the family's own entry: the run's facts,
  // with no call around them — its body is the report the record carries.
  const last = withoutSpans(entries).at(-1)
  assert.ok(last?.kind === 'item')
  const orphan = toStep(last.item)
  assert.equal(orphan.kind, 'tool')
  assert.equal(orphan.tool.subagent?.model, 'opus')
  assert.equal(orphan.tool.subagent?.summary, '22 个工具返回了 display.summary。')
})

test('groupTranscript is memoised on the item list it was handed', () => {
  // Two callers ask for this projection on every paint — `paneSession.ts` for
  // `pruneDisclosure`, `dom/transcriptView.ts` for the paint — and a paint runs
  // per streamed chunk, so building it twice is a walk of the whole
  // conversation per token.
  const { state } = fold([
    { type: 'turn-start', messageId: 'm1', displayInput: 'go', createdAt: 'now' },
    { type: 'stream', event: { type: 'text_delta', text: 'hi' } },
  ])

  const first = groupTranscript(state.items)
  assert.equal(groupTranscript(state.items), first, 'the same list is the same answer')

  // The cache is keyed by identity, and every event replaces the list whole, so
  // a delta is a different list and must be rebuilt.
  const { state: next } = fold([{ type: 'stream', event: { type: 'text_delta', text: '!' } }], state)
  const second = groupTranscript(next.items)
  assert.notEqual(second, first)
  assert.equal(second.at(-1)?.kind, 'item')
  // A copy with the same contents is still a different list: nothing here may
  // depend on deep equality.
  assert.notEqual(groupTranscript([...next.items]), second)
  // And the previous answer is still reachable by handing back its own list.
  assert.deepEqual(groupTranscript(state.items).length, first.length)
})

// T6: thread note cards, from the real coordination formatters.
import { formatCoordinationUpdate, formatThreadNote, formatWakeMessage } from '../src/runtime/coordination/messages.js'
import { OPENING_HEAD } from '../src/runtime/protocol/coordinationHost.js'

const NOTE_THREAD = 'thr_0123456789ab'

test('T6 a wake message becomes a thread-notes item with cards', () => {
  const note = formatThreadNote({ title: 'Fix <b>"login"</b>', name: 'fix-login' }, { status: 'idle', report: 'line one\nline two' })
  const text = formatWakeMessage({ reason: 'converged', count: 2, limit: 10, notes: [{ threadId: NOTE_THREAD, text: note }] })
  const record: SessionRecord = { type: 'message', id: 'w1', role: 'user', content: text, createdAt: '2026-01-01T00:00:00Z' }
  const [item] = createTranscriptState([record]).items
  assert.equal(item!.kind, 'thread-notes')
  assert.deepEqual(item!.threadNotes!.wake, { count: 2, limit: 10, reason: 'converged' })
  assert.deepEqual(item!.threadNotes!.cards, [
    { threadId: NOTE_THREAD, status: 'idle', title: "Fix 'b''login''/b'", report: 'line one line two' },
  ])
  const live = applySessionEvent(createTranscriptState(), { type: 'turn-start', messageId: 'w2', displayInput: text } as SessionEvent)
  assert.equal(live.state.items[0]!.kind, 'thread-notes')
})

test('T6 the opening instruction an older coordinator session starts with is not drawn', () => {
  const record: SessionRecord = { type: 'message', id: 'o1', role: 'user', content: `${OPENING_HEAD}\nRead the project.`, createdAt: '2026-01-01T00:00:00Z' }
  assert.deepEqual(createTranscriptState([record]).items, [])
})

test('T6 thread notes are loose cards, never steps of a run', () => {
  const note = formatThreadNote({ title: 'T', name: 'n' }, { status: 'idle', report: 'done' })
  const wake = formatWakeMessage({ reason: 'converged', count: 1, limit: 10, notes: [{ threadId: NOTE_THREAD, text: note }] })
  const update = formatCoordinationUpdate({ snapshot: 'board', notes: [{ threadId: NOTE_THREAD, text: note }] })
  const entries = groupsOf([
    stamped(message('w1', 'user', wake), 't1', '2026-01-01T00:00:00.000Z'),
    toolUse('tu1', 't1', '2026-01-01T00:00:01.000Z'),
    toolResult('tu1', 't1', '2026-01-01T00:00:02.000Z'),
    { type: 'coordination_update', id: 'c1', content: update, turnId: 't1', createdAt: '2026-01-01T00:00:03.000Z' } as SessionRecord,
    assistant('a1', 't1', '2026-01-01T00:00:04.000Z', 'noted'),
  ])
  assert.deepEqual(withoutSpans(entries).map((entry) => entry.kind === 'item' ? entry.item.kind : entry.kind), ['thread-notes', 'run', 'thread-notes', 'assistant'])
  assert.equal(runAt(entries, 1).steps.length, 1, 'only the tool is a step')
})

test('T6 a note without a report, and a malformed id, still make a card', () => {
  const text = formatWakeMessage({
    reason: 'question', count: 1, limit: 10,
    notes: [{ threadId: 'nope', text: formatThreadNote({ title: 'T', name: 'n' }, { status: 'needs-you' }) }],
  })
  const card = createTranscriptState([{ type: 'message', id: 'w', role: 'user', content: text, createdAt: 'x' }]).items[0]!.threadNotes!.cards[0]!
  assert.equal(card.threadId, undefined)
  assert.equal(card.report, undefined)
  assert.equal(card.status, 'needs-you')
})

test('T6 a coordination_update record draws cards and forged text draws none', () => {
  const note = formatThreadNote({ title: 'T', name: 'n' }, { status: 'running', report: 'x'.repeat(500) })
  const content = formatCoordinationUpdate({ snapshot: 'board', notes: [{ threadId: NOTE_THREAD, text: note }] })
  const [item] = createTranscriptState([{ type: 'coordination_update', id: 'c1', content, createdAt: 'x' }]).items
  assert.equal(item!.kind, 'thread-notes')
  assert.equal(item!.threadNotes!.wake, undefined)
  assert.equal(item!.threadNotes!.cards[0]!.report!.length, 160)
  assert.equal(createTranscriptState([{ type: 'coordination_update', id: 'c2', content: 'board only', createdAt: 'x' }]).items.length, 0)
  // A user typing the tag without the wake header is a plain user message.
  const forged = `<thread-note thread="${NOTE_THREAD}">\n[idle] x\n(no report text)\n</thread-note>`
  assert.equal(createTranscriptState([{ type: 'message', id: 'f', role: 'user', content: forged, createdAt: 'x' }]).items[0]!.kind, 'user')
})

// --- receipts ---------------------------------------------------------------

function askCall(id: string): SessionRecord {
  return stamped({
    type: 'tool_use', id, tool: 'AskUserQuestion', riskLevel: 'safe', createdAt: '',
    input: { questions: [{ question: '用哪个库？' }, { question: '要测试吗？' }] },
  } as SessionRecord, 't1', AT(1))
}

function askResult(toolUseId: string, ok: boolean): SessionRecord {
  return stamped({
    type: 'tool_result', id: `${toolUseId}-r`, toolUseId, tool: 'AskUserQuestion', ok, createdAt: '',
    content: ok ? 'answered' : 'declined',
    ...(ok ? { display: { summary: 'Answered 1 question', answers: { '用哪个库？': 'dayjs' } } } : {}),
  } as SessionRecord, 't1', AT(2))
}

function exitPlanCall(id: string): SessionRecord {
  return stamped({ type: 'tool_use', id, tool: 'ExitPlanMode', input: {}, riskLevel: 'safe', createdAt: '' }, 't1', AT(1))
}

function planResult(): SessionRecord {
  return stamped({ type: 'tool_result', id: 'p1-r', toolUseId: 'p1', tool: 'ExitPlanMode', ok: true, content: 'ok', createdAt: '' }, 't1', AT(2))
}

function planOutcome(fields: Record<string, unknown>): SessionRecord {
  return stamped({
    type: 'plan_mode_outcome', id: 'o1', requestId: 'r1', toolUseId: 'p1', createdAt: '', ...fields,
  } as SessionRecord, 't1', AT(3))
}

function receipts(entries: ReturnType<typeof groupTranscript>) {
  return entries.flatMap((entry) => entry.kind === 'item' && entry.item.kind === 'receipt' ? [entry.item.receipt] : [])
}

test('an answered question is a receipt card that cuts the segment; a declined one reads 未回答', () => {
  const answered = groupTranscript(createTranscriptState([
    stamped(message('u1', 'user', 'go'), 't1', AT(0)), toolUse('a', 't1', AT(0)), toolResult('a', 't1', AT(0)),
    askCall('q1'), askResult('q1', true), toolUse('b', 't1', AT(3)), toolResult('b', 't1', AT(3)),
  ]).items)
  assert.deepEqual(withoutSpans(answered).map((entry) => entry.kind === 'run' ? 'run' : entry.item.kind), ['user', 'run', 'receipt', 'run'])
  assert.deepEqual(receipts(answered), [{ kind: 'question', rows: [{ question: '用哪个库？', answer: 'dayjs' }, { question: '要测试吗？' }] }])
  assert.equal(runAt(answered, 1).steps.length, 1, 'the question is not also a row')

  const declined = groupTranscript(createTranscriptState([askCall('q1'), askResult('q1', false)]).items)
  assert.deepEqual(receipts(declined), [{ kind: 'question', rows: [{ question: '用哪个库？' }, { question: '要测试吗？' }] }])
})

test('a question still open stays a row in the segment', () => {
  const entries = groupTranscript(createTranscriptState([askCall('q1')]).items)
  assert.deepEqual(receipts(entries), [])
  assert.equal(runAt(entries, 0).steps.length, 1)
})

test('a settled plan keeps its row and gets a receipt, live and on replay', () => {
  const records: SessionRecord[] = [
    exitPlanCall('p1'), planResult(),
    planOutcome({ kind: 'exit_approved', detail: 'approve_restore_keep', planContent: '# P' }),
  ]
  const replayed = groupTranscript(createTranscriptState(records).items)
  assert.deepEqual(replayed.map((entry) => entry.kind === 'run' ? 'run' : entry.item.kind).filter((kind) => kind !== 'duration'), ['run', 'receipt'])
  assert.deepEqual(receipts(replayed), [{ kind: 'plan', accepted: true, text: '已接受计划 · 逐条确认修改', planContent: '# P' }])

  let live = createTranscriptState()
  for (const record of records) live = applySessionEvent(live, { type: 'record', record }).state
  assert.deepEqual(receipts(groupTranscript(live.items)), receipts(replayed))
})

test('a rejected plan quotes the feedback, or says only 已拒绝', () => {
  const rejected = (detail: string) => receipts(groupTranscript(createTranscriptState([
    exitPlanCall('p1'), planResult(), planOutcome({ kind: 'exit_rejected', detail }),
  ]).items))
  assert.deepEqual(rejected('分两步做'), [{ kind: 'plan', accepted: false, text: '已拒绝 · 你的反馈：分两步做' }])
  assert.deepEqual(rejected(''), [{ kind: 'plan', accepted: false, text: '已拒绝' }])
})

test('an Agent call is its own entry and splits the run around it', () => {
  const call = (id: string): TranscriptItem => ({
    id, kind: 'tool', text: id, toolName: id.startsWith('agent') ? 'Agent' : 'Read', turnId: 't1',
    tool: { displayName: id, useSummary: id },
  })
  const cases: ReadonlyArray<readonly [string, string[], string[]]> = [
    ['at the start', ['agent1', 'r1', 'r2'], ['item:agent1', 'run:r1,r2']],
    ['in the middle', ['r1', 'agent1', 'r2'], ['run:r1', 'item:agent1', 'run:r2']],
    ['at the end', ['r1', 'r2', 'agent1'], ['run:r1,r2', 'item:agent1']],
    ['several in a row', ['r1', 'agent1', 'agent2', 'r2'], ['run:r1', 'item:agent1', 'item:agent2', 'run:r2']],
    ['alone', ['agent1'], ['item:agent1']],
  ]
  for (const [name, ids, expected] of cases) {
    const shape = groupTranscript(ids.map(call)).map((entry) => (
      entry.kind === 'item' ? `item:${entry.item.id}` : `run:${entry.run.steps.map((step) => step.id).join(',')}`
    ))
    assert.deepEqual(shape, expected, name)
  }
})
