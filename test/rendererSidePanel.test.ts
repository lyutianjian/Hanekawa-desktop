import assert from 'node:assert/strict'
import test from 'node:test'

import {
  autoOpensThreads,
  isSectionCollapsed,
  keepSelectedSubagent,
  parsePanelClosed,
  parseSectionsCollapsed,
  serializePanelClosed,
  serializeSectionsCollapsed,
  sidePanelView,
  threadStripText,
  threadStripView,
  threadsHeadView,
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
    laneOpen: false,
    mode: 'tasks',
    panelClosed: false,
    ...rest,
    has: { plan: false, commands: false, subagents: false, threads: false, ...has },
  }
}

test('an ordinary session follows its lane switch and always offers its three pages', () => {
  const pages = ['tasks', 'changes', 'browser']
  const cases: Array<[Overrides, unknown]> = [
    [{}, { open: false, mode: 'tasks', modes: pages, sections: [] }],
    [{ laneOpen: true, mode: 'browser' }, { open: true, mode: 'browser', modes: pages, sections: [] }],
    [{ laneOpen: true, mode: 'changes', has: { plan: true, commands: true, subagents: true } }, { open: true, mode: 'changes', modes: pages, sections: ['plan', 'commands', 'subagents'] }],
    // The project has coordination: 线程 sits after 任务.
    [{ laneOpen: true, mode: 'threads', has: { threads: true } }, { open: true, mode: 'threads', modes: ['tasks', 'threads', 'changes', 'browser'], sections: [] }],
    // 线程 chosen, then the project's coordination went away: back to 任务.
    [{ laneOpen: true, mode: 'threads' }, { open: true, mode: 'tasks', modes: pages, sections: [] }],
    [{ panelClosed: true, laneOpen: true }, { open: true, mode: 'tasks', modes: pages, sections: [] }],
  ]
  for (const [overrides, expected] of cases) assert.deepEqual(sidePanelView(input(overrides)), expected)
})

test('a coordination session follows its project switch, whatever the lane switch says', () => {
  const pages = ['tasks', 'threads', 'changes', 'browser']
  const cases: Array<[Overrides, unknown]> = [
    [{ mode: 'threads' }, { open: true, mode: 'threads', modes: pages, sections: [] }],
    [{ mode: 'threads', panelClosed: true }, { open: false, mode: 'threads', modes: pages, sections: [] }],
    [{ mode: 'browser', laneOpen: true, panelClosed: true }, { open: false, mode: 'browser', modes: pages, sections: [] }],
    [{ mode: 'tasks', has: { plan: true, subagents: true } }, { open: true, mode: 'tasks', modes: pages, sections: ['plan', 'subagents'] }],
  ]
  for (const [overrides, expected] of cases) {
    assert.deepEqual(sidePanelView(input({ ...overrides, coordinated: true, has: { threads: true, ...overrides.has } })), expected)
  }
})

test('folds are remembered per project and survive bad storage', () => {
  let folded = parseSectionsCollapsed(null)
  assert.equal(isSectionCollapsed(folded, '/a', 'plan'), false)
  folded = withSectionCollapsed(folded, '/a', 'plan', true)
  folded = withSectionCollapsed(folded, '/b', 'commands', true)
  assert.equal(isSectionCollapsed(folded, '/a', 'plan'), true)
  assert.equal(isSectionCollapsed(folded, '/a', 'commands'), false)
  assert.equal(isSectionCollapsed(folded, undefined, 'plan'), false)
  const again = parseSectionsCollapsed(serializeSectionsCollapsed(folded))
  assert.deepEqual([...again.get('/a')!], ['plan'])
  assert.deepEqual([...again.get('/b')!], ['commands'])
  // Opening the last folded section drops the project's entry; the input is untouched.
  const opened = withSectionCollapsed(folded, '/a', 'plan', false)
  assert.equal(opened.has('/a'), false)
  assert.equal(isSectionCollapsed(folded, '/a', 'plan'), true)
  // A section from before the task page (the old 线程 section) reads as nothing folded.
  for (const raw of [null, '', 'nope', '[]', '{"/a":"plan"}', '{"/a":["threads"]}', '{"/a":["plan",3]}']) {
    const parsed = parseSectionsCollapsed(raw)
    assert.deepEqual([...(parsed.get('/a') ?? [])], raw === '{"/a":["plan",3]}' ? ['plan'] : [])
  }
})

test('a page inside a section stands alone only while that section is open', () => {
  const all: SideSection[] = ['plan', 'commands', 'subagents']
  assert.deepEqual(visibleSections(all, new Set(), undefined), { sections: all, focus: undefined })
  assert.deepEqual(visibleSections(all, new Set(), 'subagents'), { sections: ['subagents'], focus: 'subagents' })
  assert.deepEqual(visibleSections(all, new Set<SideSection>(['subagents']), 'subagents'), { sections: all, focus: undefined })
  assert.deepEqual(visibleSections(['plan'], new Set(), 'subagents'), { sections: ['plan'], focus: undefined })
})

test('a new thread raises the thread page only when the user has not closed the panel', () => {
  assert.equal(autoOpensThreads(true, false), true)
  assert.equal(autoOpensThreads(true, true), false)
  assert.equal(autoOpensThreads(false, false), false)
})

test('the closed set round-trips and survives bad storage', () => {
  assert.deepEqual([...parsePanelClosed(serializePanelClosed(new Set(['/a', '/b'])))], ['/a', '/b'])
  for (const raw of [null, '', 'not json', '{"a":1}', '[1,"/a"]']) {
    assert.deepEqual([...parsePanelClosed(raw)], raw === '[1,"/a"]' ? ['/a'] : [])
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

test('the thread page head joins the chip\'s words and offers 全部停止 while anything can stop', () => {
  const overview = { kind: 'overview' } as const
  assert.equal(threadsHeadView(undefined), undefined)
  assert.deepEqual(threadsHeadView({ total: 3, running: 2, blocked: 1, target: overview }), { summary: '3 个线程 · 2 个运行中 · 1 个需要你', canStopAll: true })
  assert.deepEqual(threadsHeadView({ total: 2, running: 0, blocked: 1, target: overview }), { summary: '2 个线程 · 1 个需要你', canStopAll: true })
  assert.deepEqual(threadsHeadView({ total: 2, running: 0, blocked: 0, target: overview }), { summary: '2 个线程', canStopAll: false })
})

test('switching sessions drops a sub-agent selection with nothing behind it', () => {
  assert.equal(keepSelectedSubagent('a', ['a', 'b']), 'a')
  assert.equal(keepSelectedSubagent('c', ['a', 'b']), undefined)
  assert.equal(keepSelectedSubagent(undefined, ['a']), undefined)
})
