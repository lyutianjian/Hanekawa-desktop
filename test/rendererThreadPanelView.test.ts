import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createThreadPanelView } from '../src/desktop/renderer/dom/threadPanelView.js'
import { threadPanelView, type ThreadPanelIntent, type ThreadPanelView } from '../src/desktop/renderer/model/threadPanel.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

/**
 * The thread panel's nodes. The model decides which rows exist and which
 * controls they may carry (`test/rendererThreadPanel.test.ts`); this file checks
 * what the view makes of that: the intents it emits, the disabled states, the
 * inline folds, and that an unchanged panel is not rebuilt under the pointer.
 *
 * Checked by `tsconfig.domtest.json`, as the other `dom/` tests are.
 */

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

function view(threads: WireThreadInfo[], overrides: { activeSessionId?: string; expanded?: Array<'quiet' | 'resolved'>; pending?: string[] } = {}): ThreadPanelView {
  const coordination: WireCoordinationThreads = { projectRoot: '/repo', threads }
  return threadPanelView({
    state: coordination,
    now: NOW,
    activeSessionId: overrides.activeSessionId,
    expanded: new Set(overrides.expanded ?? []),
    pending: new Set(overrides.pending ?? []),
  })
}

interface Mounted {
  readonly stub: DomStub
  readonly root: HTMLElement
  readonly intents: ThreadPanelIntent[]
  render(next: ThreadPanelView): void
  /** The `.thread-panel` node, or `undefined` when the empty line is shown. */
  panel(): StubView | undefined
  button(className: string, index?: number): StubView
  buttons(className: string): StubView[]
}

function mount(t: { after(fn: () => void): void }): Mounted {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const root = stub.createContainer('thread-panel-host')
  const intents: ThreadPanelIntent[] = []
  const dom = createThreadPanelView(root, (intent) => intents.push(intent))
  const find = (node: StubView, className: string): StubView[] => {
    const hits: StubView[] = []
    const walk = (current: StubView): void => {
      if (current.classes.includes(className)) hits.push(current)
      for (const child of current.children) walk(child)
    }
    walk(node)
    return hits
  }
  const rootView = (): StubView => stub.inspect(root)
  const panel = (): StubView | undefined => rootView().children.find((child) => child.classes.includes('thread-panel'))
  return {
    stub,
    root,
    intents,
    render: (next) => dom.render(next),
    panel,
    buttons: (className) => {
      return find(panel() ?? rootView(), className)
    },
    button: (className, index = 0) => {
      const hits = find(panel() ?? rootView(), className)
      const hit = hits[index]
      assert.ok(hit, `no .${className}[${index}]`)
      return hit
    },
  }
}

test('no threads shows the empty state and no panel', (t) => {
  const r = mount(t)
  r.render(view([]))
  assert.equal(r.panel(), undefined)
  assert.match(r.root.textContent ?? '', /线程会显示在这里/)
})

test('the header button stops everything and is disabled with nothing running', (t) => {
  const r = mount(t)
  r.render(view([thread('idle')]))
  const stopAll = r.button('thread-panel-stop-all')
  assert.equal(stopAll.disabled, true)
  assert.equal(stopAll.text, '全部停止')

  r.render(view([thread('running'), thread('idle')]))
  const enabled = r.button('thread-panel-stop-all')
  assert.equal(enabled.disabled, false)
  r.stub.click(enabled.node)
  assert.deepEqual(r.intents, [{ kind: 'stop-all' }])
})

test('the title views the thread, 打开 opens its session; stop and resolve carry the thread id', (t) => {
  const r = mount(t)
  r.render(view([thread('running'), thread('idle')]))
  r.stub.click(r.button('thread-row-title', 0).node)
  r.stub.click(r.button('thread-row-open', 0).node)
  r.stub.click(r.button('thread-row-stop').node)
  r.stub.click(r.button('thread-row-resolve').node)
  assert.deepEqual(r.intents, [
    { kind: 'view', threadId: 't-running' },
    { kind: 'open', sessionId: 's-running' },
    { kind: 'stop', threadId: 't-running' },
    { kind: 'resolve', threadId: 't-idle' },
  ])
})

test('stop and resolve appear only where the model allows them, and go dark while pending', (t) => {
  const r = mount(t)
  r.render(view([thread('running'), thread('resolved')], { pending: ['t-running'] }))
  assert.equal(r.buttons('thread-row-stop').length, 1)
  assert.equal(r.button('thread-row-stop').disabled, true)
  assert.equal(r.buttons('thread-row-resolve').length, 0)
})

test('the current thread is marked, its status chip carries the tone', (t) => {
  const r = mount(t)
  r.render(view([thread('needs-you')], { activeSessionId: 's-needs-you' }))
  const title = r.button('thread-row-title')
  assert.equal(title.attributes.get('aria-current'), 'true')
  const chip = r.button('thread-status')
  assert.equal(chip.text, '阻塞')
  assert.ok(chip.classes.includes('tone-attention'))
})

test('folds are inline disclosures: closed by default, rows drawn only while open', (t) => {
  const r = mount(t)
  r.render(view([thread('quiet'), thread('resolved')]))
  const quietHead = r.button('thread-fold-head', 0)
  assert.equal(quietHead.text, '安静 · 1')
  assert.equal(quietHead.attributes.get('aria-expanded'), 'false')
  assert.equal(r.button('thread-fold-head', 1).text, '已完成 · 1')
  assert.equal(r.buttons('thread-row-title').length, 0, 'the folded rows are not drawn')

  r.stub.click(quietHead.node)
  assert.deepEqual(r.intents, [{ kind: 'toggle-fold', fold: 'quiet' }])
})

test('an open fold draws its rows', (t) => {
  const r = mount(t)
  r.render(view([thread('quiet')], { expanded: ['quiet'] }))
  assert.equal(r.button('thread-fold-head').attributes.get('aria-expanded'), 'true')
  assert.equal(r.buttons('thread-row-title').length, 1)
  assert.equal(r.button('thread-row-title').text, '线程 quiet')
})

test('an empty fold is not drawn', (t) => {
  const r = mount(t)
  r.render(view([thread('idle')]))
  assert.equal(r.buttons('thread-fold-head').length, 0)
  assert.equal(r.panel()?.children.some((child) => child.classes.includes('thread-fold')), false)
})

test('an unchanged view keeps the same nodes; a changed one rebuilds', (t) => {
  const r = mount(t)
  const same = view([thread('running'), thread('idle')])
  r.render(same)
  const before = r.panel()!.node
  const stop = r.button('thread-row-stop').node
  r.stub.focus(stop)
  r.render(view([thread('running'), thread('idle')]))
  assert.equal(r.panel()!.node, before)
  assert.equal(r.button('thread-row-stop').node, stop)
  assert.equal(r.stub.activeElement(), stop)

  r.render(view([thread('running', { title: '新标题' }), thread('idle')]))
  assert.notEqual(r.panel()!.node, before)
  assert.equal(r.button('thread-row-title').text, '新标题')
})

test('an error notice is drawn in the error tone; a plain one is not', (t) => {
  const r = mount(t)
  const noticeOf = (): StubView => {
    const found = r.buttons('thread-panel-notice')[0]
    assert.ok(found, 'a notice line')
    return found
  }
  const base = { state: { projectRoot: '/repo', threads: [thread('idle')] }, now: NOW, activeSessionId: undefined, expanded: new Set<never>(), pending: new Set<string>() }

  r.render(threadPanelView({ ...base, notice: '这个线程已被删除' }))
  assert.equal(noticeOf().classes.includes('error'), false)

  r.render(threadPanelView({ ...base, notice: '停止线程失败：boom', noticeTone: 'error' }))
  assert.equal(noticeOf().text, '停止线程失败：boom')
  assert.equal(noticeOf().classes.includes('error'), true)
})
