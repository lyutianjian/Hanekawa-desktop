import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applySessionEvent,
  createTranscriptState,
  groupTranscript,
  type TranscriptItem,
} from '../src/desktop/renderer/model/transcript.js'
import {
  rowLabel,
  settleLabel,
  statusMeta,
  thinkingPhaseLabel,
  turnActivity,
  waitingElapsedLabel,
  WAITING_CLOCK_AFTER_MS,
  type LabelGate,
  type WaitingInput,
} from '../src/desktop/renderer/model/waiting.js'

/**
 * Where the live status is said (`src/desktop/renderer/model/waiting.ts`).
 *
 * The status is one line, always last; this covers what it reads. `test/rendererTranscriptView.test.ts`
 * covers what each one is made of in the DOM; this file covers when it exists at all.
 */

const TURN = 't1'
const STARTED_AT = 1_700_000_000_000
const USER: TranscriptItem = { id: 'u1', kind: 'user', text: '改一下侧栏', turnId: TURN }

function activity(items: readonly TranscriptItem[], isStreaming = true, turnId: string | undefined = TURN, extra: Partial<WaitingInput> = {}) {
  return turnActivity(groupTranscript(items), { isStreaming, startedAt: STARTED_AT, turnId, ...extra })
}

function turn(steps: readonly TranscriptItem[]) {
  return [USER, ...steps]
}

const THINKING: TranscriptItem = { id: 'thinking-0', kind: 'thinking', text: '先看看。再读文件', pending: true, turnId: TURN, startedAt: STARTED_AT + 3_000 }
const RUNNING_BASH: TranscriptItem = {
  id: 'call-1',
  kind: 'tool',
  text: 'Bash npm test',
  toolName: 'Bash',
  pending: true,
  turnId: TURN,
  tool: { displayName: 'Bash', useSummary: 'npm run test -- --reporter dot', description: '跑测试' },
}
const DONE_BASH: TranscriptItem = { ...RUNNING_BASH, pending: false, tool: { ...RUNNING_BASH.tool!, durationMs: 12 } }

const DRAFT = (text: string): TranscriptItem => ({ id: '__draft__', kind: 'assistant', text, pending: true })
const read = (id: string, path: string): TranscriptItem =>
  ({ ...RUNNING_BASH, id, toolName: 'Read', tool: { displayName: 'Read', useSummary: path } })
const asking: TranscriptItem = { ...RUNNING_BASH, id: 'w', toolName: 'Write', tool: { displayName: 'Write', useSummary: 'src/a.ts', awaitingApproval: true } }
const mcp: TranscriptItem = { ...RUNNING_BASH, id: 'm', toolName: 'mcp__x__y', tool: { displayName: 'x - y', useSummary: '' } }
const bare: TranscriptItem = { ...RUNNING_BASH, id: 'c', tool: { displayName: 'Bash', useSummary: 'npm test' } }
const said: TranscriptItem = { id: 'a1', kind: 'assistant', text: '先看一下。', turnId: TURN }

test('an idle session says nothing at all', () => {
  assert.deepEqual(activity([USER, DONE_BASH], false), { row: undefined, mark: undefined })
})

test('what the status reads, by priority', () => {
  const cases: Array<[string, string | undefined, readonly TranscriptItem[], Partial<WaitingInput>?, boolean?]> = [
    ['before the first step', '正在思考', [USER], {}, true],
    ['a thought in progress', '正在思考', turn([THINKING])],
    ['between two tools', '正在思考', turn([DONE_BASH])],
    ['after a paragraph', '正在思考', turn([DONE_BASH, said])],
    ['a running call, in words', '跑测试', turn([THINKING, RUNNING_BASH])],
    ['a bare command keeps its verb', '运行 npm test', turn([bare])],
    ['one tool in parallel is counted', '读取 3 个文件', turn([read('r1', 'a.ts'), read('r2', 'b.ts'), read('r3', 'c.ts')])],
    ['a mix names the last', '读取 a.ts 等 2 项', turn([RUNNING_BASH, read('r1', 'a.ts')])],
    ['an unknown tool falls back to its name', '调用 x - y', turn([mcp])],
    ['an approval outranks running calls', '等待确认 · 写入 a.ts', turn([asking, RUNNING_BASH])],
    ['a question outranks an approval', '正在提问 · 数据库', turn([asking]), { asking: '数据库' }],
    ['a compaction outranks a question', '正在压缩上下文', turn([RUNNING_BASH]), { asking: '数据库', phase: { kind: 'compacting' } }],
    ['a retry names its ordinal', '服务过载 · 第 2 次重试', turn([RUNNING_BASH]), { phase: { kind: 'retrying', attempt: 2, reason: 'overload' } }],
    ['a draft that is arriving', '正在输出', [USER, DRAFT('好的')], {}, true],
    ['an empty draft is still the gap', '正在思考', [USER, DRAFT('')], {}, true],
    ['a whitespace draft is still the gap', '正在思考', [USER, DRAFT('  \n')], {}, true],
  ]
  for (const [name, want, items, extra, noTurn] of cases) {
    assert.equal(activity(items, true, noTurn ? undefined : TURN, extra).row?.label, want, name)
  }
})

test('the status is there only while the turn is running, and an old run is not this turn’s', () => {
  const earlier: TranscriptItem = { ...DONE_BASH, id: 'call-0', turnId: 't0' }
  const next = [{ ...USER, turnId: 't0' }, earlier, { id: 'u2', kind: 'user', text: '再来' } as TranscriptItem]
  assert.equal(activity(next, true, undefined).row?.label, '正在思考')
  // Even before the new turn stamps its records, an old run at the tail is not its run.
  assert.equal(activity(turn([{ ...RUNNING_BASH, turnId: 't0' }]), true, TURN).row?.label, '正在思考')
  const interrupted: TranscriptItem = { id: 'stop', kind: 'notice', text: 'Interrupted.', turnId: TURN, interrupt: true }
  assert.equal(activity(turn([DONE_BASH, interrupted])).row?.label, '正在思考')
})

test('a draft that moved on to a tool call’s arguments is the gap again', () => {
  let state = createTranscriptState()
  const apply = (event: Parameters<typeof applySessionEvent>[1]) => { state = applySessionEvent(state, event).state }
  apply({ type: 'stream', event: { type: 'text_delta', text: '先读一下文件' } })
  assert.equal(activity([USER, ...state.items], true, undefined).row?.label, '正在输出')
  apply({ type: 'stream', event: { type: 'tool_input_delta', partialJson: '{"file' } })
  assert.equal(activity([USER, ...state.items], true, undefined).row?.label, '正在思考')
})

test('a retry backoff and a compaction are over when their event says so', () => {
  let state = createTranscriptState()
  const apply = (event: Parameters<typeof applySessionEvent>[1]) => { state = applySessionEvent(state, event).state }
  const label = () => activity([USER, ...state.items], true, undefined, state.phase ? { phase: state.phase } : {}).row?.label
  apply({ type: 'stream', event: { type: 'compact', phase: 'start' } })
  assert.equal(label(), '正在压缩上下文')
  apply({ type: 'stream', event: { type: 'compact', phase: 'end' } })
  assert.equal(label(), '正在思考')
  apply({ type: 'stream', event: { type: 'text_delta', text: '先读' } })
  apply({ type: 'stream', event: { type: 'retry', attempt: 2, reason: 'overload', delayMs: 2000 } })
  assert.equal(label(), '服务过载 · 第 2 次重试')
  apply({ type: 'stream', event: { type: 'message_start' } })
  assert.equal(state.phase, undefined)
})

test('the clock is carried through, missing and all', () => {
  assert.equal(turnActivity(groupTranscript([USER]), { isStreaming: true, startedAt: undefined, turnId: undefined }).row?.startedAt, undefined)
})

test('a thought escalates from its own start, else from the turn’s', () => {
  const row = activity(turn([THINKING])).row!
  assert.equal(row.thinkingSince, STARTED_AT + 3_000)
  assert.equal(rowLabel(row, STARTED_AT + 3_000 + 15_000), '仍在思考')
  const unstamped = activity(turn([{ ...THINKING, startedAt: undefined }])).row!
  assert.equal(unstamped.thinkingSince, STARTED_AT)
  // Anything but a thought keeps its words.
  const running = activity(turn([THINKING, RUNNING_BASH])).row!
  assert.equal(running.thinkingSince, undefined)
  assert.equal(rowLabel(running, STARTED_AT + 90_000), '跑测试')
})

test('the thinking words climb at 15, 30, 45 and 60 seconds', () => {
  const cases: Array<[number, string]> = [
    [0, '正在思考'], [14_999, '正在思考'], [15_000, '仍在思考'], [29_999, '仍在思考'],
    [30_000, '还在想'], [44_999, '还在想'], [45_000, '再想一会'], [59_999, '再想一会'],
    [60_000, '快想好了'], [600_000, '快想好了'],
  ]
  for (const [ms, want] of cases) assert.equal(thinkingPhaseLabel(ms), want, `${ms}ms`)
})

test('the counter stays empty until the wait is worth timing', () => {
  assert.equal(waitingElapsedLabel(0), '')
  assert.equal(waitingElapsedLabel(WAITING_CLOCK_AFTER_MS - 1), '')
  assert.equal(waitingElapsedLabel(WAITING_CLOCK_AFTER_MS), '2s')
  assert.equal(waitingElapsedLabel(63_000), '1m 3s')
})

test('the meta is seconds, then tokens beside them', () => {
  assert.deepEqual(statusMeta(1_999, 396), [])
  assert.deepEqual(statusMeta(2_000, undefined), ['2s'])
  assert.deepEqual(statusMeta(2_000, 0), ['2s'])
  assert.deepEqual(statusMeta(14_000, 396), ['14s', '396 tokens'])
  assert.deepEqual(statusMeta(14_000, 3_200), ['14s', '3.2k tokens'])
  assert.deepEqual(statusMeta(14_000, 2_000), ['14s', '2k tokens'])
})

test('the working mark follows what the status is about', () => {
  const plain = { body: 'default', state: 'working' }
  assert.equal(activity([USER, DONE_BASH], false).mark, undefined)
  assert.deepEqual(activity([USER, DRAFT('好的')], true, undefined).mark, plain)
  assert.deepEqual(activity([USER], true, undefined).mark, plain)
  assert.deepEqual(activity(turn([DONE_BASH])).mark, plain)
  assert.deepEqual(activity(turn([THINKING])).mark, { body: 'think', state: 'working' })
  assert.deepEqual(activity(turn([THINKING, RUNNING_BASH])).mark, { body: 'code', state: 'working' })
  assert.deepEqual(activity(turn([asking, RUNNING_BASH])).mark, { body: 'write', state: 'blocked' })
  assert.deepEqual(activity(turn([RUNNING_BASH]), true, TURN, { phase: { kind: 'compacting' } }).mark, plain)
  assert.deepEqual(activity(turn([RUNNING_BASH]), true, TURN, { asking: '数据库' }).mark, plain)
})

test('the label gate: a burst shows only its last word, once it has held', () => {
  const step = (gate: LabelGate | undefined, want: string, now: number) => settleLabel(gate, want, 1, now)
  let r = step(undefined, 'A', 0)
  assert.equal(r.label, 'A')
  // Past the minimum stay, a new word still waits out the debounce.
  r = step(r.gate, 'B', 1_000)
  assert.deepEqual([r.label, r.recheckAt], ['A', 1_150])
  // A change of mind restarts the debounce; B never showed.
  r = step(r.gate, 'C', 1_100)
  assert.deepEqual([r.label, r.recheckAt], ['A', 1_250])
  r = step(r.gate, 'C', 1_250)
  assert.deepEqual([r.label, r.recheckAt], ['C', undefined])
})

test('the label gate: a word stays 650ms, and asking for it back cancels the switch', () => {
  const step = (gate: LabelGate | undefined, want: string, now: number) => settleLabel(gate, want, 1, now)
  let r = step(undefined, 'A', 0)
  r = step(r.gate, 'B', 200)
  assert.deepEqual([r.label, r.recheckAt], ['A', 650])
  r = step(r.gate, 'B', 649)
  assert.equal(r.label, 'A')
  r = step(r.gate, 'B', 650)
  assert.equal(r.label, 'B')
  // B came back to A inside the delay: nothing pending, nothing to recheck.
  r = step(r.gate, 'C', 700)
  r = step(r.gate, 'B', 760)
  assert.deepEqual([r.label, r.recheckAt, r.gate.pending], ['B', undefined, undefined])
})

test('the label gate: a new epoch switches at once', () => {
  let r = settleLabel(undefined, 'A', 1, 0)
  r = settleLabel(r.gate, 'B', 2, 10)
  assert.deepEqual([r.label, r.recheckAt, r.gate.epoch], ['B', undefined, 2])
})
