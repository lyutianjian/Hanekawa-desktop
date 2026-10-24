import assert from 'node:assert/strict'
import test from 'node:test'

import { splitThreadBrief, threadActivity, threadPage } from '../src/desktop/renderer/model/threadDetail.js'
import { createTranscriptState, type TranscriptItem } from '../src/desktop/renderer/model/transcript.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

function thread(status: WireThreadStatus): WireThreadInfo {
  return { threadId: 't1', sessionId: 's1', title: 'T', status, lastActivityAt: '2026-10-10T00:00:00Z' }
}

function state(threads: WireThreadInfo[], projectRoot = '/repo'): WireCoordinationThreads {
  return { projectRoot, threads }
}

const selection = { projectRoot: '/repo', threadId: 't1' }
const none = new Set<string>()

test('the page follows the selection, and drops one that leads nowhere', () => {
  assert.deepEqual(threadPage(undefined, state([thread('running')]), none), { kind: 'list', clear: false })
  assert.deepEqual(threadPage(selection, undefined, none), { kind: 'list', clear: false })
  assert.deepEqual(threadPage(selection, state([]), none), { kind: 'list', clear: true, notice: '这个线程已被删除' })
  assert.deepEqual(threadPage(selection, state([thread('stale')]), none), { kind: 'list', clear: true, notice: '这个线程的会话已不存在' })
  assert.deepEqual(threadPage(selection, state([thread('running')], '/other'), none), { kind: 'list', clear: true })
})

test('poll, notice and stop follow the thread status', () => {
  const cases: Array<[WireThreadStatus, { poll: boolean; needsYou: boolean; canStop: boolean }]> = [
    ['running', { poll: true, needsYou: false, canStop: true }],
    ['needs-you', { poll: false, needsYou: true, canStop: true }],
    ['awaiting-coordinator', { poll: false, needsYou: false, canStop: true }],
    ['idle', { poll: false, needsYou: false, canStop: false }],
    ['failed', { poll: false, needsYou: false, canStop: false }],
    ['resolved', { poll: false, needsYou: false, canStop: false }],
  ]
  for (const [status, expected] of cases) {
    const page = threadPage(selection, state([thread(status)]), none)
    assert.equal(page.kind, 'detail')
    if (page.kind !== 'detail') continue
    assert.deepEqual({ poll: page.poll, needsYou: page.needsYou, canStop: page.canStop }, expected, status)
  }
})

test('a stop in flight is carried to the page', () => {
  const page = threadPage(selection, state([thread('running')]), new Set(['t1']))
  assert.equal(page.kind === 'detail' && page.stopPending, true)
})

test('the first user message is the brief and leaves the conversation; later ones stay', () => {
  const items: TranscriptItem[] = [
    { id: 'u1', kind: 'user', text: 'Background:\nbuild it' },
    { id: 'a1', kind: 'assistant', text: 'ok' },
    { id: 'u2', kind: 'user', text: 'more' },
  ]
  const split = splitThreadBrief({ ...createTranscriptState([]), items })
  assert.equal(split.brief, 'Background:\nbuild it')
  assert.deepEqual(split.state.items.map((item) => item.id), ['a1', 'u2'])
  assert.equal(splitThreadBrief(createTranscriptState([])).brief, undefined)
})

test('a running thread streams from its turn\'s first record; a settled one is idle', () => {
  const items: TranscriptItem[] = [
    { id: 'a0', kind: 'assistant', text: 'old', turnId: 't0', createdAt: '2026-10-10T00:00:00Z' },
    { id: 'u1', kind: 'user', text: 'go', turnId: 't1', createdAt: '2026-10-10T00:01:00Z' },
  ]
  const state = { ...createTranscriptState([]), items, turnId: 't1' }
  assert.deepEqual(threadActivity(state, true), { isStreaming: true, startedAt: Date.parse('2026-10-10T00:01:00Z'), turnId: 't1' })
  assert.deepEqual(threadActivity(state, false), { isStreaming: false, startedAt: undefined, turnId: undefined })
})
