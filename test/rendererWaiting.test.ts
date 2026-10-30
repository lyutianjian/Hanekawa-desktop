import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applySessionEvent,
  createTranscriptState,
  groupTranscript,
  type TranscriptItem,
} from '../src/desktop/renderer/model/transcript.js'
import {
  completedRow,
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

test('normal completion labels use only the ending turn’s last step and measured thinking duration', () => {
  const input: WaitingInput = { isStreaming: true, startedAt: STARTED_AT, turnId: TURN }
  const thought = (durationMs?: number): TranscriptItem => ({ ...THINKING, pending: false, durationMs })
  const cases: Array<[readonly TranscriptItem[], string]> = [
    [[USER], '已完成'],
    [turn([DONE_BASH, said]), '已完成'],
    [turn([thought()]), '已完成'],
    [turn([thought(0)]), '思考了 1 秒'],
    [turn([thought(1_499)]), '思考了 1 秒'],
    [turn([thought(1_500), said]), '思考了 2 秒'],
    [turn([thought(63_000)]), '思考了 63 秒'],
    [turn([thought(3_000), DONE_BASH]), '已完成'],
    [[{ ...thought(3_000), turnId: 't0' }, USER, said], '已完成'],
  ]
  for (const [items, label] of cases) {
    assert.deepEqual(completedRow(groupTranscript(items), input), { label, startedAt: STARTED_AT, timing: 'immediate' })
  }
  assert.equal(completedRow(groupTranscript(turn([thought(3_000)])), { ...input, startedAt: undefined })?.startedAt, undefined)
})

test('failed and interrupted turns do not get normal completion feedback', () => {
  const input: WaitingInput = { isStreaming: true, startedAt: STARTED_AT, turnId: TURN }
  const cases: readonly TranscriptItem[][] = [
    turn([DONE_BASH, { id: 'e', kind: 'error', text: 'boom', turnId: TURN }]),
    turn([DONE_BASH, { id: 'e', kind: 'turn-failure', text: '失败', turnId: TURN }]),
    turn([{ ...DONE_BASH, failed: true }]),
    turn([THINKING, { id: 'stop', kind: 'notice', text: '中断', interrupt: true }]),
  ]
  for (const items of cases) assert.equal(completedRow(groupTranscript(items), input), undefined)
})

test('what the status reads, by priority', () => {
  const cases: Array<[string, string | undefined, readonly TranscriptItem[], Partial<WaitingInput>?, boolean?]> = [
    ['before the first step', '处理中', [USER], {}, true],
    ['a thought in progress', '正在思考', turn([THINKING])],
    ['between two tools', '处理中', turn([DONE_BASH])],
    ['after a paragraph', '处理中', turn([DONE_BASH, said])],
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

test('the label gate: a burst shows only its last word, once it has held', () => {
  const step = (gate: LabelGate | undefined, want: string, now: number) => settleLabel(gate, want, 1, now, 'tool')
  let r = step(undefined, 'A', 0)
  assert.equal(r.label, 'A')
  // Past the minimum stay, a new word still waits out the debounce.
  r = step(r.gate, 'B', 650)
  assert.deepEqual([r.label, r.recheckAt], ['A', 800])
  // A change of mind restarts the debounce; B never showed.
  r = step(r.gate, 'C', 700)
  assert.deepEqual([r.label, r.recheckAt], ['A', 850])
  r = step(r.gate, 'C', 850)
  assert.deepEqual([r.label, r.recheckAt], ['C', undefined])
})

test('the label gate: a tool stays 650ms, and asking for it back cancels the switch', () => {
  const step = (gate: LabelGate | undefined, want: string, now: number) => settleLabel(gate, want, 1, now, 'tool')
  let r = step(undefined, 'A', 0)
  r = step(r.gate, 'B', 200)
  assert.deepEqual([r.label, r.recheckAt], ['A', 650])
  r = step(r.gate, 'B', 649)
  assert.equal(r.label, 'A')
  r = step(r.gate, 'B', 650)
  assert.equal(r.label, 'B')
  // B came back to A inside the delay: nothing pending, nothing to recheck.
  r = step(r.gate, 'C', 700)
  r = step(r.gate, 'B', 710)
  assert.deepEqual([r.label, r.recheckAt, r.gate.pending], ['B', undefined, undefined])
})

test('the label gate: a new epoch switches at once', () => {
  let r = settleLabel(undefined, 'A', 1, 0, 'tool')
  r = settleLabel(r.gate, 'B', 2, 10, 'tool')
  assert.deepEqual([r.label, r.recheckAt, r.gate.epoch], ['B', undefined, 2])
})

test('short tools and processing share a 150ms debounce and 650ms minimum stay', () => {
  const tool = activity(turn([RUNNING_BASH])).row!
  const gap = activity(turn([DONE_BASH])).row!
  const step = (gate: LabelGate | undefined, row: typeof tool, now: number) => settleLabel(gate, row.label, row.startedAt, now, row.timing)
  let r = step(undefined, tool, 0)
  r = step(r.gate, gap, 200)
  assert.deepEqual([r.label, r.recheckAt], ['跑测试', 650], 'the two delays overlap instead of adding up')
  r = step(r.gate, gap, 649)
  assert.equal(r.label, '跑测试')
  r = step(r.gate, gap, 650)
  assert.equal(r.label, '处理中')

  r = step(undefined, tool, 0)
  r = step(r.gate, gap, 2_000)
  assert.deepEqual([r.label, r.recheckAt], ['跑测试', 2_150])
  r = step(r.gate, gap, 2_149)
  assert.equal(r.label, '跑测试')
  r = step(r.gate, gap, 2_150)
  assert.equal(r.label, '处理中')
})

test('the next tool cancels a pending gap, while a shown gap has the same minimum stay', () => {
  let r = settleLabel(undefined, 'A', 1, 0, 'tool')
  r = settleLabel(r.gate, '处理中', 1, 100, 'gap')
  r = settleLabel(r.gate, 'B', 1, 200, 'tool')
  assert.deepEqual([r.label, r.recheckAt], ['A', 650])
  r = settleLabel(r.gate, 'B', 1, 650, 'tool')
  assert.equal(r.label, 'B')

  r = settleLabel(undefined, '处理中', 1, 0, 'gap')
  r = settleLabel(r.gate, 'A', 1, 100, 'tool')
  assert.equal(r.recheckAt, 650, 'processing stays readable too')
})

test('thinking, output and compaction share the normal label rhythm', () => {
  const rows = [
    activity(turn([THINKING])).row!,
    activity([USER, DRAFT('好的')], true, undefined).row!,
    activity(turn([RUNNING_BASH]), true, TURN, { phase: { kind: 'compacting' } }).row!,
  ]
  for (const row of rows) {
    assert.notEqual(row.timing, 'immediate', row.label)
    let r = settleLabel(undefined, '跑测试', STARTED_AT, 0, 'tool')
    r = settleLabel(r.gate, row.label, STARTED_AT, 30, row.timing)
    assert.deepEqual([r.label, r.recheckAt], ['跑测试', 650])
    r = settleLabel(r.gate, row.label, STARTED_AT, 650, row.timing)
    r = settleLabel(r.gate, row.label, STARTED_AT, 700, row.timing)
    assert.equal(r.gate.shownAt, 650, 'unchanged paints do not restart the minimum stay')
    r = settleLabel(r.gate, '下一条命令', STARTED_AT, 710, 'tool')
    assert.equal(r.recheckAt, 1_300)
  }
})

test('user waits, retries, failures and interruptions bypass a held description', () => {
  const cases = [
    activity(turn([asking])),
    activity(turn([RUNNING_BASH]), true, TURN, { asking: '数据库' }),
    activity(turn([RUNNING_BASH]), true, TURN, { awaitingApproval: true }),
    activity(turn([RUNNING_BASH]), true, TURN, { phase: { kind: 'retrying', attempt: 2, reason: 'overload' } }),
    activity(turn([{ ...DONE_BASH, failed: true }])),
    activity(turn([DONE_BASH, { id: 'stop', kind: 'notice', text: 'Interrupted.', turnId: TURN, interrupt: true }])),
  ]
  for (const { row } of cases) {
    assert.ok(row)
    assert.equal(row.timing, 'immediate', row.label)
    let r = settleLabel(undefined, '跑测试', STARTED_AT, 0, 'tool')
    r = settleLabel(r.gate, '下一条命令', STARTED_AT, 20, 'tool')
    r = settleLabel(r.gate, row.label, STARTED_AT, 30, row.timing)
    assert.deepEqual([r.label, r.recheckAt, r.gate.pending], [row.label, undefined, undefined])
    r = settleLabel(r.gate, row.label, STARTED_AT, 40, row.timing)
    assert.equal(r.gate.shownAt, 30)
    r = settleLabel(r.gate, '下一条命令', STARTED_AT, 50, 'tool')
    assert.equal(r.recheckAt, 680, 'normal replacements still respect the minimum stay')
  }
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

test('turn activity only describes the row and mark, regardless of the transcript’s last entry', () => {
  for (const items of [[USER], turn([THINKING]), turn([RUNNING_BASH]), turn([DONE_BASH]), turn([DONE_BASH, said])]) {
    const live = activity(items)
    assert.deepEqual(Object.keys(live).sort(), ['mark', 'row'])
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
