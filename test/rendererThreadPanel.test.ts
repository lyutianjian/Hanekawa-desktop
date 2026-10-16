import assert from 'node:assert/strict'
import test from 'node:test'

import { nextThreadSeen, threadPanelView, type ThreadPanelInput } from '../src/desktop/renderer/model/threadPanel.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

const NOW = Date.parse('2026-10-10T12:00:00Z')

function thread(status: WireThreadStatus, overrides: Partial<WireThreadInfo> = {}): WireThreadInfo {
  return {
    threadId: `t-${status}`,
    sessionId: `s-${status}`,
    title: `线程 ${status}`,
    status,
    lastActivityAt: '2026-10-10T11:59:30Z',
    ...overrides,
  }
}

function state(threads: WireThreadInfo[]): WireCoordinationThreads {
  return { projectRoot: '/repo', coordinatorSessionId: 'coord', threads }
}

function input(threads: WireThreadInfo[] | undefined, overrides: Partial<ThreadPanelInput> = {}): ThreadPanelInput {
  return {
    state: threads === undefined ? undefined : state(threads),
    now: NOW,
    activeSessionId: undefined,
    toggled: new Set(),
    pending: new Set(),
    seen: new Map(),
    ...overrides,
  }
}

const ALL: WireThreadStatus[] = ['running', 'needs-you', 'awaiting-coordinator', 'idle', 'failed', 'interrupted', 'quiet', 'resolved', 'stale']

test('no state or no threads leaves the section unavailable', () => {
  assert.equal(threadPanelView(input(undefined)).available, false)
  const none = threadPanelView(input([]))
  assert.equal(none.available, false)
  assert.deepEqual(none.groups, [])
})

test('threads group by state in a fixed order, keeping the wire order inside a group', () => {
  const view = threadPanelView(input([
    thread('idle'), thread('quiet'), thread('running'), thread('resolved'), thread('stale'),
    thread('failed'), thread('needs-you'), thread('awaiting-coordinator'), thread('interrupted'),
  ]))
  assert.deepEqual(view.groups.map((group) => [group.label, group.rows.map((row) => row.threadId)]), [
    ['阻塞', ['t-needs-you', 't-awaiting-coordinator']],
    ['运行中', ['t-running']],
    ['空闲', ['t-idle', 't-failed', 't-interrupted']],
    ['安静', ['t-quiet']],
    ['已完成', ['t-resolved', 't-stale']],
  ])
})

test('empty groups are left out', () => {
  assert.deepEqual(threadPanelView(input([thread('idle')])).groups.map((group) => group.group), ['idle'])
})

test('安静 and 已完成 start folded; a toggle flips a group against its default', () => {
  const threads = [thread('running'), thread('quiet'), thread('resolved')]
  const folded = (toggled: Parameters<typeof threadPanelView>[0]['toggled']) =>
    threadPanelView(input(threads, { toggled })).groups.map((group) => [group.group, group.folded])
  assert.deepEqual(folded(new Set()), [['running', false], ['quiet', true], ['resolved', true]])
  assert.deepEqual(folded(new Set(['running', 'quiet'])), [['running', true], ['quiet', false], ['resolved', true]])
})

test('the menu offers stop for the live three and resolve for the rest that are not settled', () => {
  for (const status of ALL) {
    const menu = threadPanelView(input([thread(status)], { menuThreadId: `t-${status}` })).menu
    assert.ok(menu, status)
    assert.equal(menu.canStop, ['running', 'needs-you', 'awaiting-coordinator'].includes(status), status)
    assert.equal(menu.canResolve, ['idle', 'failed', 'interrupted', 'quiet'].includes(status), status)
    assert.equal(menu.sessionId, `s-${status}`)
  }
})

test('a menu for a thread no longer in the table is dropped', () => {
  assert.equal(threadPanelView(input([thread('idle')], { menuThreadId: 't-gone' })).menu, undefined)
  assert.equal('menu' in threadPanelView(input([thread('idle')])), false)
})

test('a pending thread is marked in its row and its menu', () => {
  const view = threadPanelView(input([thread('running')], { pending: new Set(['t-running']), menuThreadId: 't-running' }))
  assert.equal(view.groups[0]?.rows[0]?.pending, true)
  assert.equal(view.menu?.pending, true)
})

test('labels, tones and relative time come from the shared status helpers', () => {
  const row = threadPanelView(input([thread('needs-you')])).groups[0]!.rows[0]!
  assert.equal(row.statusLabel, '阻塞')
  assert.equal(row.tone, 'attention')
  assert.equal(row.statusLine, '等你处理', 'the reason stands in for a missing status line')
  assert.equal(row.lastActivity, '刚刚')
  const failed = threadPanelView(input([thread('failed')])).groups[0]!.rows[0]!
  assert.deepEqual([failed.statusLabel, failed.tone, failed.statusLine], ['失败', 'danger', '上一回合出错'])
})

test('statusLine is carried only when non-empty', () => {
  const [running, idle] = threadPanelView(input([thread('running', { statusLine: '正在跑测试' }), thread('idle', { statusLine: '' })])).groups
  assert.equal(running?.rows[0]?.statusLine, '正在跑测试')
  assert.equal('statusLine' in idle!.rows[0]!, false)
})

test('the open thread is marked current', () => {
  const [running, idle] = threadPanelView(input([thread('running'), thread('idle')], { activeSessionId: 's-idle' })).groups
  assert.equal(running?.rows[0]?.current, false)
  assert.equal(idle?.rows[0]?.current, true)
})

test('unread: activity past what was seen, never for a running, current or unseen thread', () => {
  const later = '2026-10-10T11:59:50Z'
  const seen = new Map([['t-idle', '2026-10-10T11:59:30Z'], ['t-running', '2026-10-10T11:00:00Z'], ['t-failed', '2026-10-10T11:00:00Z']])
  const rows = threadPanelView(input(
    [thread('idle', { lastActivityAt: later }), thread('running'), thread('failed'), thread('resolved')],
    { seen, activeSessionId: 's-failed' },
  )).groups.flatMap((group) => group.rows)
  assert.deepEqual(rows.map((row) => [row.threadId, row.unread]), [
    ['t-running', false],
    ['t-idle', true],
    ['t-failed', false],
    ['t-resolved', false],
  ])
})

test('nextThreadSeen seeds new threads, follows watched ones and keeps the rest', () => {
  const before = new Map([['t-idle', 'old'], ['t-running', 'old'], ['t-elsewhere', 'kept']])
  const after = nextThreadSeen(
    before,
    state([thread('idle', { lastActivityAt: 'a' }), thread('running', { lastActivityAt: 'b' }), thread('quiet', { lastActivityAt: 'c' })]),
    new Set(['s-running']),
  )
  assert.deepEqual(Object.fromEntries(after), { 't-idle': 'old', 't-running': 'b', 't-quiet': 'c', 't-elsewhere': 'kept' })
  assert.equal(before.get('t-running'), 'old', 'the input is left alone')
})

test('the notice carries its tone only when it has one', () => {
  const base = input([thread('idle')])
  assert.deepEqual([threadPanelView({ ...base, notice: 'a' }).notice, threadPanelView({ ...base, notice: 'a' }).noticeTone], ['a', undefined])
  assert.equal(threadPanelView({ ...base, notice: 'a', noticeTone: 'error' }).noticeTone, 'error')
  assert.equal(threadPanelView({ ...base, noticeTone: 'error' }).noticeTone, undefined, 'no notice, no tone')
})
