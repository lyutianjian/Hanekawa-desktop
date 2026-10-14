import assert from 'node:assert/strict'
import test from 'node:test'

import { threadPanelView } from '../src/desktop/renderer/model/threadPanel.js'
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

const EMPTY = { expanded: new Set<'quiet' | 'resolved'>(), pending: new Set<string>(), activeSessionId: undefined }

test('no state or no threads leaves the tab unavailable', () => {
  assert.equal(threadPanelView({ state: undefined, now: NOW, ...EMPTY }).available, false)
  const none = threadPanelView({ state: state([]), now: NOW, ...EMPTY })
  assert.equal(none.available, false)
  assert.deepEqual(none.active, [])
  assert.equal(none.quiet.count, 0)
  assert.equal(none.resolved.count, 0)
})

test('threads split into active, quiet and resolved, keeping the wire order', () => {
  const view = threadPanelView({
    state: state([thread('idle'), thread('quiet'), thread('running'), thread('resolved'), thread('stale'), thread('failed')]),
    now: NOW,
    ...EMPTY,
  })
  assert.equal(view.available, true)
  assert.deepEqual(view.active.map((row) => row.threadId), ['t-idle', 't-running', 't-failed'])
  assert.deepEqual(view.quiet.rows.map((row) => row.threadId), ['t-quiet'])
  assert.deepEqual(view.resolved.rows.map((row) => row.threadId), ['t-resolved', 't-stale'])
  assert.equal(view.quiet.count, 1)
  assert.equal(view.resolved.count, 2)
})

test('stop is offered for running, needs-you and awaiting-coordinator only', () => {
  const statuses: WireThreadStatus[] = ['running', 'needs-you', 'awaiting-coordinator', 'idle', 'failed', 'interrupted', 'quiet', 'resolved', 'stale']
  const view = threadPanelView({ state: state(statuses.map((status) => thread(status))), now: NOW, ...EMPTY })
  const rows = [...view.active, ...view.quiet.rows, ...view.resolved.rows]
  for (const row of rows) {
    const stoppable = ['running', 'needs-you', 'awaiting-coordinator'].includes(row.threadId.slice(2))
    assert.equal(row.canStop, stoppable, row.threadId)
  }
})

test('resolve is offered for every thread except the live three and the settled two', () => {
  const statuses: WireThreadStatus[] = ['running', 'needs-you', 'awaiting-coordinator', 'idle', 'failed', 'interrupted', 'quiet', 'resolved', 'stale']
  const view = threadPanelView({ state: state(statuses.map((status) => thread(status))), now: NOW, ...EMPTY })
  const byId = new Map([...view.active, ...view.quiet.rows, ...view.resolved.rows].map((row) => [row.threadId, row]))
  for (const status of ['idle', 'failed', 'interrupted', 'quiet'] as const) assert.equal(byId.get(`t-${status}`)?.canResolve, true, status)
  for (const status of ['running', 'needs-you', 'awaiting-coordinator', 'resolved', 'stale'] as const) assert.equal(byId.get(`t-${status}`)?.canResolve, false, status)
})

test('labels, tones and relative time come from the shared status helpers', () => {
  const [row] = threadPanelView({ state: state([thread('needs-you')]), now: NOW, ...EMPTY }).active
  assert.equal(row?.statusLabel, '阻塞')
  assert.equal(row?.tone, 'attention')
  assert.equal(row?.statusLine, '等你处理', 'the reason stands in for a missing status line')
  assert.equal(row?.lastActivity, '刚刚')
})

test('the open thread is marked current; a pending thread is marked pending', () => {
  const view = threadPanelView({
    state: state([thread('running'), thread('idle')]),
    now: NOW,
    activeSessionId: 's-idle',
    expanded: new Set(),
    pending: new Set(['t-running']),
  })
  assert.equal(view.active[0]?.current, false)
  assert.equal(view.active[0]?.pending, true)
  assert.equal(view.active[1]?.current, true)
  assert.equal(view.active[1]?.pending, false)
})

test('statusLine is carried only when non-empty', () => {
  const view = threadPanelView({
    state: state([thread('running', { statusLine: '正在跑测试' }), thread('idle', { statusLine: '' })]),
    now: NOW,
    ...EMPTY,
  })
  assert.equal(view.active[0]?.statusLine, '正在跑测试')
  assert.equal('statusLine' in view.active[1]!, false)
})

test('a fold reports its expansion and always carries its rows', () => {
  const threads = state([thread('quiet'), thread('resolved')])
  const closed = threadPanelView({ state: threads, now: NOW, ...EMPTY })
  assert.equal(closed.quiet.expanded, false)
  assert.equal(closed.quiet.rows.length, 1)
  const open = threadPanelView({ state: threads, now: NOW, ...EMPTY, expanded: new Set(['resolved']) })
  assert.equal(open.quiet.expanded, false)
  assert.equal(open.resolved.expanded, true)
})

test('a failed thread reads 失败 in the danger tone, still with its reason line', () => {
  const view = threadPanelView({
    state: state([thread('failed')]),
    now: Date.parse('2026-10-10T12:00:00Z'),
    activeSessionId: undefined,
    expanded: new Set(),
    pending: new Set(),
  })
  const row = view.active[0]!
  assert.equal(row.statusLabel, '失败')
  assert.equal(row.tone, 'danger')
  assert.equal(row.statusLine, '上一回合出错')
})

test('the notice carries its tone only when it has one', () => {
  const input = { state: state([thread('idle')]), now: 0, activeSessionId: undefined, expanded: new Set<never>(), pending: new Set<string>() }
  assert.deepEqual([threadPanelView({ ...input, notice: 'a' }).notice, threadPanelView({ ...input, notice: 'a' }).noticeTone], ['a', undefined])
  assert.equal(threadPanelView({ ...input, notice: 'a', noticeTone: 'error' }).noticeTone, 'error')
  assert.equal(threadPanelView({ ...input, noticeTone: 'error' }).noticeTone, undefined, 'no notice, no tone')
})
