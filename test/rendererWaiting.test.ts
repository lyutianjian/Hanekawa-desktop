import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applySessionEvent,
  createTranscriptState,
  groupTranscript,
  type TranscriptItem,
} from '../src/desktop/renderer/model/transcript.js'
import {
  activityCarrier,
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
    ['before the first step', '处理中', [USER], {}, true],
    ['a thought in progress', '先看看。', turn([THINKING])],
    ['between two tools', '跑测试', turn([DONE_BASH])],
    ['after a paragraph', '跑测试', turn([DONE_BASH, said])],
    ['a finished thought', '处理中', turn([{ ...THINKING, pending: false }])],
    ['a running call, in words', '跑测试', turn([THINKING, RUNNING_BASH])],
    ['an undescribed command says only that a command runs', '正在运行命令', turn([bare])],
    ['and only that when it waits on approval', '等待你确认 · 运行命令', turn([{ ...bare, tool: { ...bare.tool!, awaitingApproval: true } }])],
    ['parallel calls show the most recently started one', '读取 c.ts', turn([read('r1', 'a.ts'), read('r2', 'b.ts'), read('r3', 'c.ts')])],
    ['a mix follows the latest running call', '读取 a.ts', turn([RUNNING_BASH, read('r1', 'a.ts')])],
    ['a tool with no phrase of its own says only that a tool runs', '正在运行工具', turn([mcp])],
    ['an approval outranks running calls', '等待你确认 · 写入 a.ts', turn([asking, RUNNING_BASH])],
    ['a real prompt with no matching record still waits for the user', '等待你确认', turn([RUNNING_BASH]), { awaitingApproval: true }],
    ['a question outranks an approval', '正在提问 · 数据库', turn([asking]), { asking: '数据库' }],
    ['a compaction outranks a question', '正在压缩上下文', turn([RUNNING_BASH]), { asking: '数据库', phase: { kind: 'compacting' } }],
    ['a retry names its ordinal', '服务过载 · 第 2 次重试', turn([RUNNING_BASH]), { phase: { kind: 'retrying', attempt: 2, reason: 'overload' } }],
    ['a draft that is arriving', '正在输出', [USER, DRAFT('好的')], {}, true],
    ['an empty draft is still the gap', '处理中', [USER, DRAFT('')], {}, true],
    ['a whitespace draft is still the gap', '处理中', [USER, DRAFT('  \n')], {}, true],
  ]
  for (const [name, want, items, extra, noTurn] of cases) {
    assert.equal(activity(items, true, noTurn ? undefined : TURN, extra).row?.label, want, name)
  }
})

test('a batch follows its newest running call, then falls back to work still running', () => {
  const two = turn([RUNNING_BASH, read('r1', 'a.ts')])
  assert.equal(activity(two).row?.label, '读取 a.ts')
  assert.deepEqual(activity(two).mark, { body: 'read', state: 'working' }, 'the words and the mark describe the same call')
  assert.equal(activity(turn([RUNNING_BASH, { ...read('r1', 'a.ts'), pending: false }])).row?.label, '跑测试')
  assert.equal(activity(turn([DONE_BASH, read('r1', 'a.ts')])).row?.label, '读取 a.ts')
})

test('the status is there only while the turn is running, and an old run is not this turn’s', () => {
  const earlier: TranscriptItem = { ...DONE_BASH, id: 'call-0', turnId: 't0' }
  const next = [{ ...USER, turnId: 't0' }, earlier, { id: 'u2', kind: 'user', text: '再来' } as TranscriptItem]
  assert.equal(activity(next, true, undefined).row?.label, '处理中')
  // Even before the new turn stamps its records, an old run at the tail is not its run.
  assert.equal(activity(turn([{ ...RUNNING_BASH, turnId: 't0' }]), true, TURN).row?.label, '处理中')
  const interrupted: TranscriptItem = { id: 'stop', kind: 'notice', text: 'Interrupted.', turnId: TURN, interrupt: true }
  assert.equal(activity(turn([DONE_BASH, interrupted])).row?.label, '处理中')
})

test('a draft that moved on to a tool call’s arguments names the call being written', () => {
  let state = createTranscriptState()
  const apply = (event: Parameters<typeof applySessionEvent>[1]) => { state = applySessionEvent(state, event).state }
  const label = () => activity([USER, ...state.items], true, undefined, state.draftCall ? { draftCall: state.draftCall } : {}).row?.label
  apply({ type: 'stream', event: { type: 'text_delta', text: '先读一下文件' } })
  assert.equal(label(), '正在输出')
  apply({ type: 'stream', event: { type: 'tool_input_delta', partialJson: '{"file' } })
  assert.equal(label(), '处理中')
  apply({ type: 'stream', event: { type: 'tool_input_delta', name: 'Edit', partialJson: '{"filePath":' } })
  assert.equal(label(), '正在编写文件')
  apply({ type: 'stream', event: { type: 'tool_input_delta', name: 'Edit', partialJson: '"/repo/src/a.ts","oldString":"x' } })
  assert.equal(label(), '正在编写 a.ts')
  apply({ type: 'stream', event: { type: 'tool_input_delta', name: 'Bash', index: 1, partialJson: '{"command":"ls' } })
  assert.equal(label(), '正在准备命令')
  apply({ type: 'stream', event: { type: 'tool_input_delta', name: 'Read', index: 2, partialJson: '{"filePath":"a.ts"' } })
  assert.equal(label(), '处理中')
})

test('a retry backoff and a compaction are over when their event says so', () => {
  let state = createTranscriptState()
  const apply = (event: Parameters<typeof applySessionEvent>[1]) => { state = applySessionEvent(state, event).state }
  const label = () => activity([USER, ...state.items], true, undefined, state.phase ? { phase: state.phase } : {}).row?.label
  apply({ type: 'stream', event: { type: 'compact', phase: 'start' } })
  assert.equal(label(), '正在压缩上下文')
  apply({ type: 'stream', event: { type: 'compact', phase: 'end' } })
  assert.equal(label(), '处理中')
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
  const row = activity(turn([{ ...THINKING, text: '' }])).row!
  assert.equal(row.thinkingSince, STARTED_AT + 3_000)
  assert.equal(rowLabel(row, STARTED_AT + 3_000 + 15_000), '仍在思考')
  const unstamped = activity(turn([{ ...THINKING, text: '', startedAt: undefined }])).row!
  assert.equal(unstamped.thinkingSince, STARTED_AT)
  // Anything but a thought keeps its words.
  const running = activity(turn([THINKING, RUNNING_BASH])).row!
  assert.equal(running.thinkingSince, undefined)
  assert.equal(rowLabel(running, STARTED_AT + 90_000), '跑测试')
})

// The ladder stops at 45s: 「快想好了」 at a minute promised an end the app
// cannot see, so a long thought keeps the last honest wording.
test('the thinking words climb at 15, 30 and 45 seconds, and stop there', () => {
  const cases: Array<[number, string]> = [
    [0, '正在思考'], [14_999, '正在思考'], [15_000, '仍在思考'], [29_999, '仍在思考'],
    [30_000, '还在想'], [44_999, '还在想'], [45_000, '再想一会'], [59_999, '再想一会'],
    [60_000, '再想一会'], [600_000, '再想一会'],
  ]
  for (const [ms, want] of cases) assert.equal(thinkingPhaseLabel(ms), want, `${ms}ms`)
})

test('the counter stays empty until the wait is worth timing', () => {
  assert.equal(waitingElapsedLabel(0), '')
  assert.equal(waitingElapsedLabel(WAITING_CLOCK_AFTER_MS - 1), '')
  assert.equal(waitingElapsedLabel(WAITING_CLOCK_AFTER_MS), '2 秒')
  assert.equal(waitingElapsedLabel(63_000), '1 分 3 秒')
})

test('the meta is seconds, then tokens beside them', () => {
  assert.deepEqual(statusMeta(1_999, 396), [])
  assert.deepEqual(statusMeta(2_000, undefined), ['2 秒'])
  assert.deepEqual(statusMeta(2_000, 0), ['2 秒'])
  assert.deepEqual(statusMeta(14_000, 396), ['14 秒', '396 token'])
  assert.deepEqual(statusMeta(14_000, 3_200), ['14 秒', '3.2k token'])
  assert.deepEqual(statusMeta(14_000, 2_000), ['14 秒', '2k token'])
})

test('the working mark follows what the status is about', () => {
  const plain = { body: 'default', state: 'working' }
  const think = { body: 'think', state: 'working' }
  const code = { body: 'code', state: 'working' }
  assert.equal(activity([USER, DONE_BASH], false).mark, undefined)
  assert.deepEqual(activity([USER, DRAFT('好的')], true, undefined).mark, plain)
  assert.deepEqual(activity([USER], true, undefined).mark, plain)
  // The last call holds the mark through the gap and the text after it.
  assert.deepEqual(activity(turn([DONE_BASH])).mark, code)
  assert.deepEqual(activity(turn([DONE_BASH, DRAFT('测试通过了')])).mark, code)
  assert.deepEqual(activity(turn([THINKING])).mark, think)
  assert.deepEqual(activity(turn([THINKING, RUNNING_BASH])).mark, code)
  assert.deepEqual(activity(turn([asking, RUNNING_BASH])).mark, { body: 'write', state: 'blocked' })
  assert.deepEqual(activity(turn([DONE_BASH]), true, TURN, { draftCall: { name: 'Write', input: '{"filePath":"a.md"' } }).mark,
    { body: 'compose', state: 'working' })
  assert.deepEqual(activity(turn([RUNNING_BASH]), true, TURN, { phase: { kind: 'compacting' } }).mark, plain)
  assert.deepEqual(activity(turn([RUNNING_BASH]), true, TURN, { asking: '数据库' }).mark, { body: 'default', state: 'blocked' })
})

test('the streaming call is remembered until its message lands', () => {
  let state = createTranscriptState()
  const apply = (event: Parameters<typeof applySessionEvent>[1]) => { state = applySessionEvent(state, event).state }
  apply({ type: 'stream', event: { type: 'tool_input_delta', index: 1, name: 'Write', partialJson: '{"filePath":' } })
  apply({ type: 'stream', event: { type: 'tool_input_delta', index: 1, name: 'Write', partialJson: '"a.md"' } })
  assert.deepEqual(state.draftCall, { name: 'Write', index: 1, input: '{"filePath":"a.md"' })
  apply({ type: 'stream', event: { type: 'tool_input_delta', index: 2, name: 'Bash', partialJson: '{"c' } })
  assert.deepEqual(state.draftCall, { name: 'Bash', index: 2, input: '{"c' })
  apply({ type: 'stream', event: { type: 'tool_input_delta', index: 2, name: 'Bash', partialJson: 'x'.repeat(5000) } })
  const capped = state
  apply({ type: 'stream', event: { type: 'tool_input_delta', index: 2, name: 'Bash', partialJson: 'more' } })
  assert.equal(state, capped, 'past the peek a delta changes nothing')
  apply({ type: 'record', record: { type: 'message', id: 'a1', role: 'assistant', content: [] } as never })
  assert.equal(state.draftCall, undefined)
})

test('work-line text settles for 250ms and tool labels stay readable for two seconds', () => {
  let gate = settleLabel(undefined, '读取 a.ts', STARTED_AT, 0, 'tool').gate
  const next = settleLabel(gate, '读取 b.ts', STARTED_AT, 100, 'tool')
  assert.equal(next.label, '读取 a.ts')
  assert.equal(next.recheckAt, 2_000)
  gate = next.gate
  assert.equal(settleLabel(gate, '读取 b.ts', STARTED_AT, 1_999, 'tool').label, '读取 a.ts')
  assert.equal(settleLabel(gate, '读取 b.ts', STARTED_AT, 2_000, 'tool').label, '读取 b.ts')
  assert.equal(settleLabel(gate, '读取 a.ts', STARTED_AT, 500, 'tool').gate.pending, undefined)
})

test('requests and failures bypass the hold; a new turn never inherits it', () => {
  const gate = settleLabel(undefined, '读取 a.ts', STARTED_AT, 0, 'tool').gate
  for (const label of ['等待你确认', '正在提问', '请求失败 · 第 1 次重试', '处理中']) {
    assert.equal(settleLabel(gate, label, STARTED_AT, 10, 'immediate').label, label)
  }
  assert.equal(settleLabel(gate, '处理中', STARTED_AT + 1, 10, 'gap').label, '处理中')
  const gap = settleLabel(gate, '正在输出', STARTED_AT, 10, 'gap')
  assert.equal(gap.recheckAt, 260, 'the fallback does not inherit the tool minimum')
  assert.equal(settleLabel(gap.gate, '正在输出', STARTED_AT, 260, 'gap').label, '正在输出')
})

test('the carrier follows the running step, holds through results, and releases on exceptional states', () => {
  const state = turn([RUNNING_BASH, read('r', 'a.ts')])
  const current = activity(state)
  assert.deepEqual(current.carrier, { runId: 'run:call-1', stepId: 'r' })
  assert.deepEqual(activity(turn([DONE_BASH])).carrier, { runId: 'run:call-1', stepId: 'call-1' })
  assert.deepEqual(activity(turn([DONE_BASH, said])).carrier, { runId: 'run:call-1', stepId: 'call-1' })
  assert.equal(activity(state, true, TURN, { awaitingApproval: true }).carrier, undefined)
  assert.equal(activity(state, true, TURN, { asking: '选一个' }).carrier, undefined)
  assert.equal(activity(state, true, TURN, { phase: { kind: 'compacting' } }).carrier, undefined)
  assert.equal(activity(turn([{ ...DONE_BASH, failed: true }])).carrier, undefined)
  assert.equal(activity(turn([DONE_BASH, { id: 'stop', kind: 'notice', text: 'stop', interrupt: true }])).carrier, undefined)
  assert.equal(activity(turn([DONE_BASH, { id: 'error', kind: 'error', text: 'failed' }])).carrier, undefined)
  assert.equal(activity(state, false).carrier, undefined)
})

test('a running sub-agent names the status, though it is no run’s step', () => {
  const agent: TranscriptItem = {
    id: 'ag', kind: 'tool', text: 'ag', toolName: 'Agent', pending: true, turnId: TURN,
    tool: { displayName: '子代理', useSummary: '扫一遍 tools/', agentType: 'explore' },
  }
  assert.equal(activity(turn([agent]))?.row?.label, '子代理 · 扫一遍 tools/')
  const asking = { ...agent, tool: { ...agent.tool!, awaitingApproval: true } }
  assert.equal(activity(turn([asking]))?.row?.label, '等待你确认 · 子代理 · 扫一遍 tools/')
})

test('every live activity describes its row and mark, with an optional work carrier', () => {
  for (const items of [[USER], turn([THINKING]), turn([RUNNING_BASH]), turn([DONE_BASH]), turn([DONE_BASH, said])]) {
    const live = activity(items)
    assert.ok(live.row)
    assert.ok(live.mark)
  }
})

test('with a checklist on screen the activity still describes the current work', () => {
  const taskCard = { rows: [{ id: '1', status: 'in_progress' as const, label: '改侧栏' }], hiddenBefore: 0, openAfter: 0 }
  for (const items of [turn([THINKING]), turn([RUNNING_BASH]), turn([DONE_BASH])]) {
    assert.deepEqual(activity(items, true, TURN, { taskCard }), activity(items))
  }
})

test('thinking status follows only the current segment’s first sentence as it arrives', () => {
  for (const [text, label] of [['先', '先'], ['先看看。第二句话。', '先看看。'], ['First sentence. Next sentence.', 'First sentence.'], ['第一行\n第二行', '第一行']]) {
    const current = activity(turn([{ ...THINKING, text }]))
    assert.equal(current.row?.label, label)
    assert.equal(current.row?.thinkingSince, undefined)
    assert.equal(current.row?.timing, 'immediate')
    assert.deepEqual(current.carrier, { runId: 'run:thinking-0', stepId: 'thinking-0' }, 'the thought itself carries the expandable status')
  }
})

test('tool groups always carry their status in the header, while successive thoughts keep their own row', () => {
  const tools = groupTranscript(turn([RUNNING_BASH, read('r', 'a.ts')]))
  assert.equal(activityCarrier(tools, activity(turn([RUNNING_BASH, read('r', 'a.ts')]))), 'run:call-1')
  const thoughts = turn([{ ...THINKING, pending: false }, { ...THINKING, id: 'thinking-1' }])
  assert.equal(activityCarrier(groupTranscript(thoughts), activity(thoughts)), 'thinking-1')
})
