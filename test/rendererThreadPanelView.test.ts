import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createThreadPanelView } from '../src/desktop/renderer/dom/threadPanelView.js'
import { threadPanelView, type ThreadGroup, type ThreadPanelIntent, type ThreadPanelView } from '../src/desktop/renderer/model/threadPanel.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

/**
 * The thread panel's nodes. The model decides which rows exist and what their
 * menu may offer (`test/rendererThreadPanel.test.ts`); this file checks what the
 * view makes of that: the intents it emits, the group bands, the row menu and
 * how it closes, and that an unchanged list is not rebuilt under the pointer.
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

function view(
  threads: WireThreadInfo[],
  overrides: { activeSessionId?: string; toggled?: ThreadGroup[]; pending?: string[]; menu?: string; seen?: Record<string, string>; notice?: string; noticeTone?: 'error' } = {},
): ThreadPanelView {
  const coordination: WireCoordinationThreads = { projectRoot: '/repo', threads }
  return threadPanelView({
    state: coordination,
    now: NOW,
    activeSessionId: overrides.activeSessionId,
    toggled: new Set(overrides.toggled ?? []),
    pending: new Set(overrides.pending ?? []),
    seen: new Map(Object.entries(overrides.seen ?? {})),
    menuThreadId: overrides.menu,
    notice: overrides.notice,
    noticeTone: overrides.noticeTone,
  })
}

interface Mounted {
  readonly stub: DomStub
  readonly root: HTMLElement
  readonly intents: ThreadPanelIntent[]
  render(next: ThreadPanelView): void
  closeMenu(): void
  /** The `.thread-panel` node, or `undefined` when the empty state is shown. */
  panel(): StubView | undefined
  menu(): StubView
  all(className: string): StubView[]
  one(className: string, index?: number): StubView
}

function mount(t: { after(fn: () => void): void }): Mounted {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const root = stub.createContainer('thread-panel-host')
  const intents: ThreadPanelIntent[] = []
  const dom = createThreadPanelView(root, (intent) => intents.push(intent))
  const all = (className: string): StubView[] => {
    const hits: StubView[] = []
    const walk = (current: StubView): void => {
      if (current.classes.includes(className)) hits.push(current)
      for (const child of current.children) walk(child)
    }
    walk(stub.inspect(root))
    return hits
  }
  return {
    stub,
    root,
    intents,
    render: (next) => dom.render(next),
    closeMenu: () => dom.closeMenu(),
    panel: () => all('thread-panel')[0],
    menu: () => all('thread-menu')[0]!,
    all,
    one: (className, index = 0) => {
      const hit = all(className)[index]
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

test('a row views its thread; its mark carries the tone and the status as a tooltip', (t) => {
  const r = mount(t)
  r.render(view([thread('needs-you')], { activeSessionId: 's-needs-you' }))
  const main = r.one('thread-row-main')
  assert.equal(main.attributes.get('aria-current'), 'true')
  assert.equal(r.one('thread-row-title').text, '线程 needs-you')
  assert.equal(r.one('thread-row-line').text, '等你处理')
  const mark = r.one('thread-row-mark')
  assert.ok(mark.classes.includes('tone-attention'))
  assert.equal(mark.attributes.get('title') ?? (mark.node as HTMLElement).title, '阻塞')
  r.stub.click(main.node)
  assert.deepEqual(r.intents, [{ kind: 'view', threadId: 't-needs-you' }])
})

test('an unread row is marked and draws its dot', (t) => {
  const r = mount(t)
  r.render(view([thread('idle', { lastActivityAt: 'new' }), thread('failed')], { seen: { 't-idle': 'old', 't-failed': '2026-10-10T11:59:30Z' } }))
  assert.equal(r.all('thread-row-dot').length, 1)
  assert.ok(r.one('thread-row', 0).classes.includes('unread'))
  assert.equal(r.one('thread-row', 1).classes.includes('unread'), false)
})

test('group bands name and count their rows; a folded group draws none', (t) => {
  const r = mount(t)
  r.render(view([thread('running'), thread('quiet'), thread('resolved')]))
  const heads = r.all('thread-group-head')
  assert.deepEqual(heads.map((head) => [head.text, head.attributes.get('aria-expanded')]), [
    ['运行中1', 'true'],
    ['安静1', 'false'],
    ['已完成1', 'false'],
  ])
  assert.equal(r.all('thread-row').length, 1, 'only the open group draws rows')
  r.stub.click(heads[1]!.node)
  assert.deepEqual(r.intents, [{ kind: 'toggle-group', group: 'quiet' }])
})

test('the ⋯ asks for its menu, and asks to close it when it is the open one', (t) => {
  const r = mount(t)
  r.render(view([thread('running')]))
  r.stub.click(r.one('thread-row-more').node)
  r.render(view([thread('running')], { menu: 't-running' }))
  assert.ok(r.one('thread-row').classes.includes('menu-open'))
  assert.equal(r.one('thread-row-more').attributes.get('aria-expanded'), 'true')
  r.stub.click(r.one('thread-row-more').node)
  assert.deepEqual(r.intents, [{ kind: 'menu', threadId: 't-running' }, { kind: 'menu', threadId: undefined }])
})

test('the menu offers what the model allows, focuses its first item, and each item closes it', (t) => {
  const r = mount(t)
  r.render(view([thread('running'), thread('idle')], { menu: 't-running' }))
  assert.deepEqual(r.all('thread-menu-item').map((item) => item.text), ['在主画布打开', '停止'])
  assert.equal(r.stub.activeElement(), r.one('thread-menu-item').node)
  r.stub.click(r.one('thread-menu-item', 1).node)
  assert.deepEqual(r.intents, [{ kind: 'menu', threadId: undefined }, { kind: 'stop', threadId: 't-running' }])

  r.intents.length = 0
  r.render(view([thread('running'), thread('idle')], { menu: 't-idle' }))
  assert.deepEqual(r.all('thread-menu-item').map((item) => item.text), ['在主画布打开', '标为完成'])
  r.stub.click(r.one('thread-menu-item', 0).node)
  r.stub.click(r.one('thread-menu-item', 1).node)
  assert.deepEqual(r.intents, [
    { kind: 'menu', threadId: undefined },
    { kind: 'open', sessionId: 's-idle' },
    { kind: 'menu', threadId: undefined },
    { kind: 'resolve', threadId: 't-idle' },
  ])
})

test('a pending thread\'s menu items go dark', (t) => {
  const r = mount(t)
  r.render(view([thread('running')], { menu: 't-running', pending: ['t-running'] }))
  assert.equal(r.one('thread-menu-item', 1).disabled, true)
})

test('a press outside the menu and its trigger closes it; one inside does not', (t) => {
  const r = mount(t)
  r.render(view([thread('running')], { menu: 't-running' }))
  r.stub.dispatchDocument('pointerdown', { target: r.one('thread-menu-item').node })
  r.stub.dispatchDocument('pointerdown', { target: r.one('thread-row-more').node })
  assert.deepEqual(r.intents, [])
  r.stub.dispatchDocument('pointerdown', { target: r.one('thread-row-title').node })
  assert.deepEqual(r.intents, [{ kind: 'menu', threadId: undefined }])
})

test('focus leaving the panel closes the menu; a repaint\'s null focusout does not', (t) => {
  const r = mount(t)
  const outside = r.stub.createContainer('elsewhere')
  r.render(view([thread('running')], { menu: 't-running' }))
  r.stub.dispatch(r.root, 'focusout', { relatedTarget: null })
  r.stub.dispatch(r.root, 'focusout', { relatedTarget: r.one('thread-row-main').node })
  assert.deepEqual(r.intents, [])
  r.stub.dispatch(r.root, 'focusout', { relatedTarget: outside })
  assert.deepEqual(r.intents, [{ kind: 'menu', threadId: undefined }])
})

test('closing the menu hands focus back to its ⋯', (t) => {
  const r = mount(t)
  r.render(view([thread('running')], { menu: 't-running' }))
  assert.equal(r.stub.activeElement(), r.one('thread-menu-item').node)
  r.render(view([thread('running')]))
  assert.equal(r.stub.activeElement(), r.one('thread-row-more').node)
})

test('a push that changes the list leaves the open menu\'s nodes alone', (t) => {
  const r = mount(t)
  r.render(view([thread('running'), thread('idle')], { menu: 't-idle' }))
  const item = r.one('thread-menu-item').node
  r.render(view([thread('running', { statusLine: '新进展' }), thread('idle')], { menu: 't-idle' }))
  assert.equal(r.one('thread-row-line').text, '新进展')
  assert.equal(r.one('thread-menu-item').node, item)
})

test('closeMenu takes the menu down without an intent, and a press then closes nothing', (t) => {
  const r = mount(t)
  r.render(view([thread('running')], { menu: 't-running' }))
  assert.equal(r.menu().attributes.get('aria-hidden'), 'false')
  r.closeMenu()
  assert.equal(r.menu().attributes.get('aria-hidden'), 'true')
  r.stub.dispatchDocument('pointerdown', { target: r.one('thread-row-title').node })
  assert.deepEqual(r.intents, [])
})

test('an unchanged view keeps the same nodes; a changed one rebuilds', (t) => {
  const r = mount(t)
  r.render(view([thread('running'), thread('idle')]))
  const before = r.panel()!.node
  const main = r.one('thread-row-main').node
  r.stub.focus(main)
  r.render(view([thread('running'), thread('idle')]))
  assert.equal(r.panel()!.node, before)
  assert.equal(r.stub.activeElement(), main)

  r.render(view([thread('running', { title: '新标题' }), thread('idle')]))
  assert.notEqual(r.panel()!.node, before)
  assert.equal(r.one('thread-row-title').text, '新标题')
  assert.equal(r.stub.activeElement(), r.one('thread-row-main').node, 'focus follows the rebuilt row')
})

test('an error notice is drawn in the error tone; a plain one is not', (t) => {
  const r = mount(t)
  r.render(view([thread('idle')], { notice: '这个线程已被删除' }))
  assert.equal(r.one('thread-panel-notice').classes.includes('error'), false)
  r.render(view([thread('idle')], { notice: '停止线程失败：boom', noticeTone: 'error' }))
  assert.equal(r.one('thread-panel-notice').text, '停止线程失败：boom')
  assert.equal(r.one('thread-panel-notice').classes.includes('error'), true)
})
