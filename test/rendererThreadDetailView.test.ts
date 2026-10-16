import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type StubView } from './helpers/domStub.js'
import { createThreadPanelView } from '../src/desktop/renderer/dom/threadPanelView.js'
import { threadPanelView } from '../src/desktop/renderer/model/threadPanel.js'
import { threadPage } from '../src/desktop/renderer/model/threadDetail.js'
import { createThreadDetailView } from '../src/desktop/renderer/dom/threadDetailView.js'
import type { ThreadPage } from '../src/desktop/renderer/model/threadDetail.js'
import type { WireShellThreadTranscriptResult, WireThreadInfo } from '../src/desktop/shellProtocol.js'

/**
 * The thread page's timer and controls: it re-reads a running thread, leaves
 * nothing behind when the page goes, and the needs-you notice opens the thread
 * in the main canvas. Checked by `tsconfig.domtest.json`.
 */

type Detail = Extract<ThreadPage, { kind: 'detail' }>

function page(overrides: Partial<Detail> = {}): Detail {
  return {
    kind: 'detail',
    threadId: 't1',
    sessionId: 's1',
    title: 'T',
    statusLabel: '运行中',
    tone: 'running',
    poll: true,
    needsYou: false,
    canStop: true,
    stopPending: false,
    ...overrides,
  }
}

function mount(t: { after(fn: () => void): void; mock: { timers: { enable(options: { apis: ['setInterval'] }): void } } }) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const root = stub.createContainer('thread-detail')
  const loads: Array<string | undefined> = []
  const calls: string[] = []
  const reply: { next: WireShellThreadTranscriptResult; fail?: Error } = { next: { unchanged: false, token: '1', records: [] } }
  const view = createThreadDetailView(root, {
    onBack: () => calls.push('back'),
    onOpen: (sessionId) => calls.push(`open:${sessionId}`),
    onStop: (threadId) => calls.push(`stop:${threadId}`),
    loadTranscript: async (_threadId, since) => {
      loads.push(since)
      if (reply.fail) throw reply.fail
      return reply.next
    },
    onOpenPath: () => {},
  })
  const find = (className: string): StubView[] => {
    const hits: StubView[] = []
    const walk = (node: StubView): void => {
      if (node.classes.includes(className)) hits.push(node)
      node.children.forEach(walk)
    }
    walk(stub.inspect(root))
    return hits
  }
  return { stub, root, view, loads, calls, reply, find }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('a running thread is re-read on the timer with the last token; leaving the page stops it', async (t) => {
  const m = mount(t)
  m.view.render(page())
  await flush()
  assert.deepEqual(m.loads, [undefined])

  t.mock.timers.tick(1500)
  await flush()
  assert.deepEqual(m.loads, [undefined, '1'])

  m.view.render(undefined)
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(m.loads.length, 2, 'no read after the page is gone')
})

test('a failed read says so with a way to ask again, instead of leaving the page blank', async (t) => {
  const m = mount(t)
  m.reply.fail = new Error('文件被占用')
  m.view.render(page({ poll: false, canStop: false }))
  await flush()

  const [failure] = m.find('thread-detail-error')
  assert.equal(failure?.hidden, false)
  assert.equal(failure?.text, '无法读取线程对话：文件被占用重试')
  assert.equal(m.find('subagent-empty')[0]?.hidden, true, 'a thread that could not be read is not an empty one')

  m.reply.fail = undefined
  m.stub.click(m.find('thread-detail-retry')[0]!.node)
  await flush()
  assert.equal(m.loads.length, 2)
  assert.equal(m.find('thread-detail-error')[0]?.hidden, true, 'a good read withdraws it')
  assert.equal(m.find('thread-detail-retry').length, 0)
})

test('a failure that repeats on the timer keeps the same button under the pointer', async (t) => {
  const m = mount(t)
  m.reply.fail = new Error('x')
  m.view.render(page())
  await flush()
  const before = m.find('thread-detail-retry')[0]!.node
  t.mock.timers.tick(1500)
  await flush()
  assert.equal(m.loads.length, 2)
  assert.equal(m.find('thread-detail-retry')[0]!.node, before)
})

test('a settled thread is read once and has no timer', async (t) => {
  const m = mount(t)
  m.view.render(page({ poll: false, canStop: false }))
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(m.loads.length, 1)
  assert.equal(m.find('thread-row-stop').length, 0)
})

test('the controls and the needs-you notice reach the host', (t) => {
  const m = mount(t)
  m.view.render(page({ needsYou: true, poll: false }))
  m.stub.click(m.find('subagent-back')[0]!.node)
  m.stub.click(m.find('thread-row-open')[0]!.node)
  m.stub.click(m.find('thread-row-stop')[0]!.node)
  m.stub.click(m.find('thread-detail-needs-you')[0]!.node)
  assert.deepEqual(m.calls, ['back', 'open:s1', 'stop:t1', 'open:s1'])
  assert.equal(m.find('thread-detail-needs-you')[0]!.text, '需要你处理 · 去处理')

  m.view.render(page({ needsYou: false, poll: false }))
  assert.equal(m.find('thread-detail-needs-you').length, 0)
})

test('a refresh follows the tail for a reader at the bottom and leaves a reader who scrolled up', async (t) => {
  const m = mount(t)
  m.view.render(page())
  await flush()

  m.stub.setMetrics(m.find('thread-detail-body')[0]!.node, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 })
  m.reply.next = { unchanged: false, token: '2', records: [] }
  t.mock.timers.tick(1500)
  await flush()
  assert.equal(m.find('thread-detail-body')[0]!.scrollTop, 0, 'scrolled up: kept')

  m.stub.setMetrics(m.find('thread-detail-body')[0]!.node, { scrollTop: 490 })
  m.reply.next = { unchanged: false, token: '3', records: [] }
  t.mock.timers.tick(1500)
  await flush()
  assert.equal(m.find('thread-detail-body')[0]!.scrollTop, 1000, 'at the bottom: follows')
})

test('the head is pinned outside the scrolling body, and back leads to a list whose rows still open', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const listRoot = stub.createContainer('list')
  const detailRoot = stub.createContainer('detail')
  const threads: WireThreadInfo[] = ['a', 'b'].map((id) => ({ threadId: id, sessionId: `s-${id}`, title: id, status: 'idle', lastActivityAt: '2026-10-10T00:00:00Z' }))
  const coordination = { projectRoot: '/repo', threads }
  let viewed: { projectRoot: string; threadId: string } | undefined
  const opened: string[] = []
  const list = createThreadPanelView(listRoot, (intent) => {
    if (intent.kind === 'view') viewed = { projectRoot: '/repo', threadId: intent.threadId }
    paint()
  })
  const detail = createThreadDetailView(detailRoot, {
    onBack: () => { viewed = undefined; paint() },
    onOpen: () => {},
    onStop: () => {},
    loadTranscript: async (threadId) => {
      opened.push(threadId)
      return { unchanged: false, token: '1', records: [] }
    },
    onOpenPath: () => {},
  })
  function paint(): void {
    const current = threadPage(viewed, coordination, new Set())
    const page = current.kind === 'detail' ? current : undefined
    listRoot.hidden = page !== undefined
    detailRoot.hidden = page === undefined
    detail.render(page)
    if (page === undefined) {
      list.render(threadPanelView({ state: coordination, now: Date.now(), activeSessionId: undefined, toggled: new Set(), pending: new Set(), seen: new Map() }))
    }
  }
  const all = (root: HTMLElement, className: string): StubView[] => {
    const hits: StubView[] = []
    const walk = (node: StubView): void => {
      if (node.classes.includes(className)) hits.push(node)
      node.children.forEach(walk)
    }
    walk(stub.inspect(root))
    return hits
  }

  paint()
  stub.click(all(listRoot, 'thread-row-main')[0]!.node)
  await flush()
  assert.deepEqual(opened, ['a'])
  const head = all(detailRoot, 'thread-detail-head')[0]!
  const body = all(detailRoot, 'thread-detail-body')[0]!
  assert.equal(all(detailRoot, 'subagent-back').length, 1)
  assert.ok(head)
  assert.equal(all(body.node as HTMLElement, 'subagent-back').length, 0, 'the back button is not inside the scrolling body')
  assert.equal(listRoot.hidden, true)

  stub.click(all(detailRoot, 'subagent-back')[0]!.node)
  assert.equal(listRoot.hidden, false)
  assert.equal(detailRoot.hidden, true)

  stub.click(all(listRoot, 'thread-row-main')[1]!.node)
  await flush()
  assert.deepEqual(opened, ['a', 'b'])
  assert.equal(detailRoot.hidden, false)
})
