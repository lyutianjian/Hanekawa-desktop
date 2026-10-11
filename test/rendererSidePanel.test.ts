import assert from 'node:assert/strict'
import test from 'node:test'

import {
  autoOpensOverview,
  keepSelectedSubagent,
  pruneExtras,
  threadStripText,
  parseOverviewClosed,
  serializeOverviewClosed,
  sidePanelView,
  sideTabEntries,
  threadStripView,
  type ExtraTab,
  type SidePanelInput,
} from '../src/desktop/renderer/model/sidePanel.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

function input(overrides: Partial<SidePanelInput> = {}): SidePanelInput {
  return { coordinated: false, browserOpen: false, sideTab: 'browser', extras: new Set<ExtraTab>(), overviewClosed: false, ...overrides }
}

test('an ordinary session follows the browser switch and the stored tab', () => {
  const cases: Array<[Partial<SidePanelInput>, { open: boolean; tab: string }]> = [
    [{}, { open: false, tab: 'browser' }],
    [{ browserOpen: true, sideTab: 'subagents' }, { open: true, tab: 'subagents' }],
    [{ browserOpen: true, overviewClosed: true }, { open: true, tab: 'browser' }],
    [{ overviewClosed: false }, { open: false, tab: 'browser' }],
  ]
  for (const [overrides, expected] of cases) assert.deepEqual(sidePanelView(input(overrides)), expected)
})

test('a coordination session follows the overview switch, whatever the browser switch says', () => {
  const cases: Array<[Partial<SidePanelInput>, { open: boolean; tab: string }]> = [
    [{}, { open: true, tab: 'threads' }],
    [{ overviewClosed: true }, { open: false, tab: 'threads' }],
    [{ browserOpen: true, overviewClosed: true }, { open: false, tab: 'threads' }],
    [{ sideTab: 'browser', extras: new Set<ExtraTab>(['browser']) }, { open: true, tab: 'browser' }],
    [{ sideTab: 'subagents', extras: new Set<ExtraTab>(['browser']) }, { open: true, tab: 'threads' }],
    [{ sideTab: 'threads', extras: new Set<ExtraTab>(['browser']) }, { open: true, tab: 'threads' }],
    [{ sideTab: 'browser', extras: new Set<ExtraTab>(['browser']), overviewClosed: true }, { open: false, tab: 'browser' }],
  ]
  for (const [overrides, expected] of cases) {
    assert.deepEqual(sidePanelView(input({ coordinated: true, ...overrides })), expected)
  }
})

test('tabs: 概览 first and permanent, extras closable; ordinary sessions keep the old strip', () => {
  const extras = new Set<ExtraTab>(['subagents', 'browser'])
  assert.deepEqual(sideTabEntries(input({ coordinated: true }), 'threads', true, false), [{ tab: 'threads', closable: false }])
  assert.deepEqual(sideTabEntries(input({ coordinated: true, extras }), 'threads', true, true), [
    { tab: 'threads', closable: false },
    { tab: 'browser', closable: true },
    { tab: 'subagents', closable: true },
  ])
  assert.deepEqual(sideTabEntries(input({ browserOpen: true }), 'browser', false, false), [])
  assert.deepEqual(sideTabEntries(input({ browserOpen: true }), 'browser', true, false).map((e) => e.tab), ['browser', 'threads'])
  assert.deepEqual(sideTabEntries(input({ browserOpen: true }), 'browser', false, true).map((e) => e.tab), ['browser', 'subagents'])
  assert.deepEqual(sideTabEntries(input({ browserOpen: true, sideTab: 'subagents' }), 'subagents', false, false).map((e) => e.tab), ['browser', 'subagents'])
})

test('a new thread raises the overview only when the user has not closed it', () => {
  assert.equal(autoOpensOverview(true, false), true)
  assert.equal(autoOpensOverview(true, true), false)
  assert.equal(autoOpensOverview(false, false), false)
})

test('the closed set round-trips and survives bad storage', () => {
  assert.deepEqual([...parseOverviewClosed(serializeOverviewClosed(new Set(['/a', '/b'])))], ['/a', '/b'])
  for (const raw of [null, '', 'not json', '{"a":1}', '[1,"/a"]']) {
    assert.deepEqual([...parseOverviewClosed(raw)], raw === '[1,"/a"]' ? ['/a'] : [])
  }
})

function thread(id: string, status: WireThreadStatus): WireThreadInfo {
  return { threadId: id, sessionId: `s-${id}`, title: id, status, lastActivityAt: '2026-10-10T11:59:30Z' }
}
function state(...threads: WireThreadInfo[]): WireCoordinationThreads {
  return { projectRoot: '/repo', coordinatorSessionId: 'coord', threads }
}

test('the thread strip counts every live thread, finished or not, and picks its click target', () => {
  const overview = { kind: 'overview' }
  const cases: Array<[boolean, WireCoordinationThreads | undefined, unknown]> = [
    [false, state(thread('a', 'running')), undefined],
    [true, undefined, undefined],
    [true, state(), undefined],
    [true, state(thread('a', 'stale')), undefined],
    [true, state(thread('a', 'idle'), thread('b', 'resolved'), thread('c', 'stale')), { total: 2, running: 0, blocked: 0, target: overview }],
    [true, state(thread('a', 'running'), thread('b', 'running')), { total: 2, running: 2, blocked: 0, target: overview }],
    [true, state(thread('a', 'needs-you')), { total: 1, running: 0, blocked: 1, target: { kind: 'thread', sessionId: 's-a' } }],
    [true, state(thread('a', 'running'), thread('b', 'awaiting-coordinator')), { total: 2, running: 1, blocked: 1, target: overview }],
    [true, state(thread('a', 'awaiting-coordinator'), thread('b', 'needs-you')), { total: 2, running: 0, blocked: 2, target: { kind: 'thread', sessionId: 's-b' } }],
    [true, state(thread('a', 'needs-you'), thread('b', 'needs-you')), { total: 2, running: 0, blocked: 2, target: overview }],
  ]
  for (const [coordinated, table, expected] of cases) assert.deepEqual(threadStripView(coordinated, table), expected)
})

test('the chip leaves out the counts that are zero', () => {
  const overview = { kind: 'overview' } as const
  assert.deepEqual(threadStripText({ total: 3, running: 2, blocked: 1, target: overview }), { total: '3 个线程', running: '· 2 个运行中', blocked: '· 1 个需要你' })
  assert.deepEqual(threadStripText({ total: 3, running: 0, blocked: 0, target: overview }), { total: '3 个线程', running: undefined, blocked: undefined })
})

test('switching sessions prunes extras and selections with nothing behind them', () => {
  const both = new Set<ExtraTab>(['browser', 'subagents'])
  const cases: Array<[{ browserTabs: boolean; subagents: boolean }, ExtraTab[]]> = [
    [{ browserTabs: true, subagents: true }, ['browser', 'subagents']],
    [{ browserTabs: false, subagents: true }, ['subagents']],
    [{ browserTabs: true, subagents: false }, ['browser']],
    [{ browserTabs: false, subagents: false }, []],
  ]
  for (const [has, expected] of cases) assert.deepEqual([...pruneExtras(both, has)], expected)
  assert.equal(keepSelectedSubagent('a', ['a', 'b']), 'a')
  assert.equal(keepSelectedSubagent('c', ['a', 'b']), undefined)
  assert.equal(keepSelectedSubagent(undefined, ['a']), undefined)
})
