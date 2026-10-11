import assert from 'node:assert/strict'
import test from 'node:test'

import {
  autoOpensOverview,
  isSectionCollapsed,
  keepSelectedSubagent,
  parseOverviewClosed,
  parseSectionsCollapsed,
  serializeOverviewClosed,
  serializeSectionsCollapsed,
  sidePanelView,
  threadStripText,
  threadStripView,
  visibleSections,
  withSectionCollapsed,
  type SidePanelInput,
  type SideSection,
} from '../src/desktop/renderer/model/sidePanel.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

type Has = SidePanelInput['has']
type Overrides = Partial<Omit<SidePanelInput, 'has'>> & { has?: Partial<Has> }

function input(overrides: Overrides = {}): SidePanelInput {
  const { has, ...rest } = overrides
  return {
    coordinated: false,
    browserOpen: false,
    mode: 'browser',
    overviewClosed: false,
    ...rest,
    has: { browser: true, plan: false, subagents: false, threads: false, ...has },
  }
}

test('an ordinary session follows the browser switch and offers the overview only with sections', () => {
  const cases: Array<[Overrides, unknown]> = [
    [{}, { open: false, mode: 'browser', modes: ['browser'], sections: [] }],
    [{ browserOpen: true, mode: 'overview', has: { subagents: true } }, { open: true, mode: 'overview', modes: ['browser', 'overview'], sections: ['subagents'] }],
    [{ browserOpen: true, mode: 'browser', has: { plan: true, subagents: true, threads: true } }, { open: true, mode: 'browser', modes: ['browser', 'overview'], sections: ['plan', 'subagents', 'threads'] }],
    // The overview chosen, then its last section went away: back to the browser.
    [{ browserOpen: true, mode: 'overview' }, { open: true, mode: 'browser', modes: ['browser'], sections: [] }],
    [{ overviewClosed: true, has: { plan: true } }, { open: false, mode: 'browser', modes: ['browser', 'overview'], sections: ['plan'] }],
  ]
  for (const [overrides, expected] of cases) assert.deepEqual(sidePanelView(input(overrides)), expected)
})

test('a coordination session follows the overview switch, whatever the browser switch says', () => {
  const cases: Array<[Overrides, unknown]> = [
    [{ mode: 'overview' }, { open: true, mode: 'overview', modes: ['overview'], sections: ['threads'] }],
    [{ mode: 'overview', overviewClosed: true }, { open: false, mode: 'overview', modes: ['overview'], sections: ['threads'] }],
    [{ mode: 'overview', browserOpen: true, overviewClosed: true }, { open: false, mode: 'overview', modes: ['overview'], sections: ['threads'] }],
    [{ mode: 'browser', has: { browser: true } }, { open: true, mode: 'browser', modes: ['browser', 'overview'], sections: ['threads'] }],
    // The browser asked for but not raised here: the overview it is.
    [{ mode: 'browser', has: { browser: false, plan: true, subagents: true } }, { open: true, mode: 'overview', modes: ['overview'], sections: ['plan', 'subagents', 'threads'] }],
  ]
  for (const [overrides, expected] of cases) {
    const base = { coordinated: true, has: { browser: false, threads: true, ...overrides.has } }
    assert.deepEqual(sidePanelView(input({ ...overrides, ...base })), expected)
  }
})

test('the browser mode keeps the other sections and their order', () => {
  const has = { plan: true, subagents: true, threads: true }
  const inBrowser = sidePanelView(input({ browserOpen: true, mode: 'browser', has }))
  const inOverview = sidePanelView(input({ browserOpen: true, mode: 'overview', has }))
  assert.deepEqual(inBrowser.sections, inOverview.sections)
})

test('folds are remembered per project and survive bad storage', () => {
  let folded = parseSectionsCollapsed(null)
  assert.equal(isSectionCollapsed(folded, '/a', 'plan'), false)
  folded = withSectionCollapsed(folded, '/a', 'plan', true)
  folded = withSectionCollapsed(folded, '/b', 'threads', true)
  assert.equal(isSectionCollapsed(folded, '/a', 'plan'), true)
  assert.equal(isSectionCollapsed(folded, '/a', 'threads'), false)
  assert.equal(isSectionCollapsed(folded, undefined, 'plan'), false)
  const again = parseSectionsCollapsed(serializeSectionsCollapsed(folded))
  assert.deepEqual([...again.get('/a')!], ['plan'])
  assert.deepEqual([...again.get('/b')!], ['threads'])
  // Opening the last folded section drops the project's entry; the input is untouched.
  const opened = withSectionCollapsed(folded, '/a', 'plan', false)
  assert.equal(opened.has('/a'), false)
  assert.equal(isSectionCollapsed(folded, '/a', 'plan'), true)
  for (const raw of [null, '', 'nope', '[]', '{"/a":"plan"}', '{"/a":["bogus"]}', '{"/a":["plan",3]}']) {
    const parsed = parseSectionsCollapsed(raw)
    assert.deepEqual([...(parsed.get('/a') ?? [])], raw === '{"/a":["plan",3]}' ? ['plan'] : [])
  }
})

test('a page inside a section stands alone only while that section is open', () => {
  const all: SideSection[] = ['plan', 'subagents', 'threads']
  assert.deepEqual(visibleSections(all, new Set(), undefined), { sections: all, focus: undefined })
  assert.deepEqual(visibleSections(all, new Set(), 'subagents'), { sections: ['subagents'], focus: 'subagents' })
  assert.deepEqual(visibleSections(all, new Set<SideSection>(['subagents']), 'subagents'), { sections: all, focus: undefined })
  assert.deepEqual(visibleSections(['plan'], new Set(), 'threads'), { sections: ['plan'], focus: undefined })
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

test('switching sessions drops a sub-agent selection with nothing behind it', () => {
  assert.equal(keepSelectedSubagent('a', ['a', 'b']), 'a')
  assert.equal(keepSelectedSubagent('c', ['a', 'b']), undefined)
  assert.equal(keepSelectedSubagent(undefined, ['a']), undefined)
})
