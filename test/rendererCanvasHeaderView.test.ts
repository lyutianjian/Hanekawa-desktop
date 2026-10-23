import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { trackAnimationStarts, trackIdentity } from './helpers/motion.js'
import { createCanvasHeaderView, type CanvasHeaderDom } from '../src/desktop/renderer/dom/canvasHeaderView.js'
import { closeTopDismissable } from '../src/desktop/renderer/dom/dismiss.js'
import { createNoSessionView } from '../src/desktop/renderer/dom/noSessionView.js'
import {
  canvasHeaderView,
  type CanvasHeaderMenuItem,
  type CanvasHeaderThread,
} from '../src/desktop/renderer/model/canvasHeader.js'
import type { WireLaneInfo } from '../src/desktop/shellProtocol.js'

/**
 * The canvas header's *nodes*.
 *
 * The one thing here that cannot be model-tested is also the one most likely to
 * regress: this header repaints on every `onShellChanged` — which includes every
 * snapshot tick of a streaming turn — so the rename field has to survive a
 * `replace()` with its node identity, its value and its caret intact.
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

function lane(overrides: Partial<WireLaneInfo> = {}): WireLaneInfo {
  return {
    lane: '1',
    paneId: 's1',
    sessionId: 's1',
    projectRoot: 'c:\\repo\\alpha',
    projectName: 'alpha',
    sessionTitle: '原标题',
    ...overrides,
  }
}

// M06: streaming shell snapshots must not replay menu entry or move focus.
test('M06 keeps an open menu and its focused item through ten snapshots', (t) => {
  const r = render(t)
  r.paint({ menuOpen: true })
  const root = () => r.stub.inspect(r.container)
  const identity = trackIdentity(root, '.canvas-menu')
  const starts = trackAnimationStarts(root, '.canvas-menu', r.stub.observeMotion)
  t.after(starts.dispose)
  const menu = identity.sample()
  const second = r.menuItems()[1]!.node
  r.stub.focus(second)
  for (let i = 0; i < 10; i += 1) {
    r.paint({ menuOpen: true })
    assert.equal(identity.sample(), menu)
    assert.equal(r.stub.activeElement(), second)
  }
  assert.equal(identity.replacements, 0)
  assert.equal(starts.starts, 0)
  r.paint({ menuOpen: true, lane: lane({ sessionTitle: '新标题' }) })
  assert.equal(identity.sample(), menu)
  assert.equal(r.stub.activeElement(), second)
  r.paint({ menuOpen: true, pendingDelete: 's1' })
  assert.equal(identity.sample(), menu, 'confirmation updates the same menu container')
})

interface Rendered {
  readonly stub: DomStub
  readonly header: CanvasHeaderDom
  readonly container: HTMLElement
  readonly events: string[]
  readonly renamed: string[]
  /** Renders from the real model, so the view is never fed a shape it cannot get. */
  paint(state: {
    lane?: WireLaneInfo | undefined
    menuOpen?: boolean
    renaming?: boolean
    pendingDelete?: string
    role?: 'coordinator' | 'thread'
    thread?: CanvasHeaderThread
  }): void
  identity(): StubView
  titleNode(): StubView | undefined
  menuItems(): StubView[]
  openLocation(): StubView | undefined
  crumb(): StubView | undefined
}

const find = (view: StubView | undefined, className: string): StubView | undefined =>
  view?.children.find((child) => child.classes.includes(className))

function render(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())

  const container = stub.createContainer('canvas-header')
  const events: string[] = []
  const renamed: string[] = []
  const header = createCanvasHeaderView(container, {
    onToggleMenu: () => events.push('toggle-menu'),
    onCloseMenu: () => events.push('close-menu'),
    onMenuItem: (id: CanvasHeaderMenuItem['id']) => events.push(`item:${id}`),
    onRename: (title) => renamed.push(title),
    onCancelRename: () => events.push('cancel-rename'),
    onOpenLocation: () => events.push('open-location'),
    onBackToCoordinator: () => events.push('back-to-coordinator'),
    onStopThread: () => events.push('stop-thread'),
  })

  const identity = () =>
    stub.inspect(container).children.find((child) => child.classes.includes('canvas-identity'))!
  return {
    stub,
    header,
    container,
    events,
    renamed,
    paint(state) {
      header.render(canvasHeaderView({
        lane: 'lane' in state ? state.lane : lane(),
        menuOpen: state.menuOpen ?? false,
        renaming: state.renaming ?? false,
        pendingDelete: state.pendingDelete,
        // Every case here is about a conversation on screen; the draft case (no
        // header at all) is a model decision and is asserted there.
        hasConversation: true,
        role: state.role,
        thread: state.thread,
      }))
    },
    identity,
    // The field when it is on screen, else the title or crumb it floats over.
    titleNode: () =>
      find(identity(), 'canvas-title-input') ??
      identity().children.find(
        (child) => child.classes.includes('canvas-title') || child.classes.includes('canvas-breadcrumb'),
      ),
    menuItems: () => {
      const shell = find(identity(), 'canvas-menu-shell')
      const menu = find(shell, 'canvas-menu')
      return [...(menu?.children ?? [])]
    },
    openLocation: () =>
      find(rightControls(), 'canvas-open-location'),
    crumb: () => find(identity(), 'canvas-breadcrumb'),
  }
  function rightControls(): StubView | undefined {
    return stub.inspect(container).children.find((child) => child.classes.includes('canvas-header-controls'))
  }
}

test('an empty window draws nothing rather than the last session it had', (t) => {
  const r = render(t)
  r.paint({})
  assert.equal(r.stub.inspect(r.container).hidden, false)

  r.paint({ lane: undefined })

  assert.equal(r.stub.inspect(r.container).hidden, true)
  assert.equal(r.identity, r.identity, 'identity is still addressable')
  assert.equal(r.stub.inspect(r.container).text, '', 'a stale title would be a lie about which session is open')
})

test('the header shows the title and the two right-hand controls', (t) => {
  const r = render(t)
  r.paint({})

  assert.equal(r.titleNode()?.text, '原标题')
  assert.equal(r.openLocation()?.text.includes('VS Code'), true)
  // `button()` puts the same string on `title` and `aria-label`; the attribute is
  // the one a screen reader reads, so that is the one asserted.
  assert.equal(r.openLocation()?.attributes.get('aria-label')?.includes('alpha'), true)

  r.stub.click(r.openLocation()!.node)
  assert.deepEqual(r.events, ['open-location'])
})

test('the menu is built only when open, and its items report by id', (t) => {
  const r = render(t)
  r.paint({})
  assert.deepEqual(r.menuItems(), [], 'a closed menu is absent, not hidden')

  r.paint({ menuOpen: true })
  assert.deepEqual(r.menuItems().map((item) => item.text), ['重命名', '删除会话'])
  r.stub.click(r.menuItems()[1]!.node)
  assert.deepEqual(r.events, ['item:delete'])

  r.paint({ menuOpen: true, pendingDelete: 's1' })
  assert.deepEqual(r.menuItems().map((item) => item.text), ['确认删除', '取消'])
})

test('the rename field survives the repaints a streaming turn causes', (t) => {
  // The header repaints on every `onShellChanged`. A field rebuilt inside
  // `replace()` would lose the caret — and the half-typed title — mid-word.
  const r = render(t)
  r.paint({})
  r.paint({ renaming: true })

  const field = r.titleNode()!
  assert.equal(field.classes.includes('canvas-title-input'), true)
  assert.equal(r.stub.activeElement(), field.node, 'the field takes focus when it appears')

  const input = field.node as { value: string }
  input.value = '用户正在打的字'
  r.paint({ renaming: true })

  assert.equal(r.titleNode()?.node, field.node, 'the same node, not a rebuilt one')
  assert.equal(input.value, '用户正在打的字', 'and it was not written back over')
})

test('Enter commits a real change; Escape and a no-op change do not', (t) => {
  const r = render(t)
  r.paint({ renaming: true })
  const input = r.titleNode()!.node as { value: string }

  input.value = '  新标题  '
  r.stub.dispatch(r.titleNode()!.node, 'keydown', { key: 'Enter' })
  assert.deepEqual(r.renamed, ['新标题'], 'trimmed on the way out')

  r.paint({ renaming: true })
  r.stub.dispatch(r.titleNode()!.node, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.renamed, ['新标题'])
  assert.equal(r.events.includes('cancel-rename'), true)
})

test('Escape belongs to an open menu, leaving the closed header to the shell keymap', (t) => {
  const r = render(t)
  r.paint({ menuOpen: true })
  const open = r.stub.dispatch(r.container, 'keydown', { key: 'Escape' })
  assert.equal(open.defaultPrevented, true, 'closing a menu must not also interrupt the turn')
  assert.deepEqual(r.events, ['close-menu'])
  r.paint({ menuOpen: false })
  r.events.length = 0
  const closed = r.stub.dispatch(r.container, 'keydown', { key: 'Escape' })
  assert.equal(closed.defaultPrevented, false)
  assert.deepEqual(r.events, [])
})

test('blurring an untouched field cancels instead of writing the index', (t) => {
  // `rename-session` writes the index and broadcasts to every lane; clicking
  // away from a field the user never typed into must not cost that.
  const r = render(t)
  r.paint({ renaming: true })

  r.stub.dispatch(r.titleNode()!.node, 'blur')

  assert.deepEqual(r.renamed, [])
  assert.deepEqual(r.events, ['cancel-rename'])
})

test('opening the menu puts the keyboard on its first item, once', (t) => {
  // The click that opens the menu lands on a trigger this very repaint destroys,
  // and Chromium fires no blur for a removed node — so without this the menu is
  // on screen with focus back on `<body>`, and Escape has nothing to reach it
  // from. Only on the edge: the header repaints per streamed token, and
  // re-focusing every tick would take the caret out of wherever the user went.
  const r = render(t)
  r.paint({})
  r.paint({ menuOpen: true })

  assert.equal(r.stub.activeElement(), r.menuItems()[0]!.node)

  // Somewhere this header does not rebuild, which is the point: the repaint has
  // to leave the caret where the user put it.
  const composer = r.stub.createContainer('input')
  r.stub.focus(composer)
  r.paint({ menuOpen: true })
  assert.equal(r.stub.activeElement(), composer, 'a repaint is not a re-open')
})

test('the arrow keys rove the open menu, and open it from the closed trigger', (t) => {
  const r = render(t)
  r.paint({})
  const shell = find(r.identity(), 'canvas-menu-shell')!

  r.stub.dispatch(shell.node, 'keydown', { key: 'ArrowDown', target: find(shell, 'canvas-menu-trigger')!.node })
  assert.deepEqual(r.events, ['toggle-menu'], 'ArrowDown on the closed trigger asks to open it')

  r.paint({ menuOpen: true })
  const [first, second] = r.menuItems()
  assert.equal(r.stub.activeElement(), first!.node)
  r.stub.dispatch(shell.node, 'keydown', { key: 'ArrowDown', target: first!.node })
  assert.equal(r.stub.activeElement(), second!.node)
  r.stub.dispatch(shell.node, 'keydown', { key: 'ArrowDown', target: second!.node })
  assert.equal(r.stub.activeElement(), first!.node, 'wraps')
  r.stub.dispatch(shell.node, 'keydown', { key: 'End', target: first!.node })
  assert.equal(r.stub.activeElement(), second!.node)

  // The pointer takes focus along, so hover and keyboard cannot paint two rows.
  r.stub.dispatch(find(shell, 'canvas-menu')!.node, 'mousemove', { target: first!.node })
  assert.equal(r.stub.activeElement(), first!.node)
})

test('asking to confirm a delete leaves focus on 取消, not on the destructive item', (t) => {
  // The item that held focus is replaced by the next step, and Chromium fires no
  // blur for a removed node: without this the keyboard falls to `<body>`, where
  // Escape interrupts the turn instead of backing out of the question.
  const r = render(t)
  r.paint({ menuOpen: true })
  r.stub.focus(r.menuItems()[1]!.node)

  r.paint({ menuOpen: true, pendingDelete: 's1' })

  const [confirm, cancel] = r.menuItems()
  assert.deepEqual([confirm!.text, cancel!.text], ['确认删除', '取消'])
  assert.equal(r.stub.activeElement(), cancel!.node)
})

test('Escape closes an open menu from the document when focus has fallen to the body', (t) => {
  const r = render(t)
  r.paint({ menuOpen: true })

  assert.equal(closeTopDismissable(), true)
  assert.deepEqual(r.events, ['close-menu'])
})

test('a press outside the header closes the menu', (t) => {
  // The gap `focusout` alone leaves. The trigger is rebuilt by the paint that
  // opens the menu, so by the user's next click there is nothing focused inside
  // the header to fire a `focusout` at all — the menu could only be closed by
  // choosing from it.
  const r = render(t)
  r.paint({ menuOpen: true })

  r.stub.dispatchDocument('pointerdown', { target: r.stub.createContainer('transcript-area') })
  assert.deepEqual(r.events, ['close-menu'])

  // Inside, including the trigger itself: that press is a toggle, and closing it
  // here would let the `click` that follows re-open what the user just shut.
  r.events.length = 0
  r.stub.dispatchDocument('pointerdown', { target: r.menuItems()[0]!.node })
  assert.deepEqual(r.events, [])
})

test('the rest of the header is outside the menu, not inside it', (t) => {
  // The scope is the menu and its trigger, not the bar they sit in. Pressing the
  // session title or 打开位置 beside an open menu is "somewhere else" to the
  // person doing it, and a header-wide scope answered it by leaving the menu up.
  const r = render(t)
  r.paint({ menuOpen: true })

  r.stub.dispatchDocument('pointerdown', { target: r.openLocation()?.node })
  assert.deepEqual(r.events, ['close-menu'], 'a press on 打开位置 leaves the menu standing')
})

test('a press the pointer events never reach still closes the menu', (t) => {
  // `pointerdown` is the one this is really about, but it is not the only way a
  // press arrives: `click` is the last-resort exit, so a popover cannot be left
  // hanging by whatever ate the press before it — which is the failure this
  // primitive grew a second event type for.
  const r = render(t)
  r.paint({ menuOpen: true })

  r.stub.dispatchDocument('click', { target: r.stub.createContainer('transcript-area') })
  assert.deepEqual(r.events, ['close-menu'])
})

test('focus leaving the header closes the menu; moving inside it does not', (t) => {
  const r = render(t)
  r.paint({ menuOpen: true })

  r.stub.dispatch(r.container, 'focusout', { relatedTarget: r.menuItems()[0]!.node })
  assert.deepEqual(r.events, [], 'focus moving between the trigger and an item is not leaving')

  r.stub.dispatch(r.container, 'focusout', { relatedTarget: r.stub.createContainer('composer') })
  assert.deepEqual(r.events, ['close-menu'])
})

test('focus going nowhere is this view’s own repaint, not the user leaving', (t) => {
  // The bug the whole dismissal pass was chasing, and it was never the press.
  // Opening the menu repaints the header, which destroys the trigger the mouse
  // is on; `firstMenuItem.focus()` then fires a `focusout` with `relatedTarget:
  // null` *from inside `render()`*. Reading that as a departure re-entered
  // `render()` with the menu closed, and the outer paint — still running — wrote
  // its menu-bearing subtree over the closed one. The menu stayed on screen with
  // `headerMenuOpen` already false, so every press outside hit `app.ts`'s early
  // return and only choosing an item could dismiss it.
  //
  // `sidebarView.ts` and `titleBarView.ts` have carried this guard all along;
  // this header is the one that did not.
  const r = render(t)
  r.paint({ menuOpen: true })

  r.stub.dispatch(r.container, 'focusout', { relatedTarget: null })
  assert.deepEqual(r.events, [], 'a repaint must not be mistaken for the user leaving')
})

test('the paint that opens the menu moves focus last of all', (t) => {
  // The other half of the same fix: `focus()` runs other people's code, so it
  // goes after every node this paint owns is in the page. A handler that
  // repaints in answer then wins, instead of being overwritten by the rest of
  // the paint that provoked it — the DOM cannot end up ahead of the state.
  const r = render(t)
  r.paint({ menuOpen: true })

  assert.equal(r.stub.activeElement(), r.menuItems()[0]?.node, 'the keyboard lands in the menu')
  assert.ok(r.openLocation(), '打开位置 is in the page by the time focus moves')
})

const thread: CanvasHeaderThread = { title: '缓存迁移', statusLabel: '运行中', tone: 'running', canStop: true }

test('a thread session draws 「← 协调 · 线程名 [状态] [停止]」 in place of the title', (t) => {
  const r = render(t)
  r.paint({ role: 'thread', thread })

  const crumb = r.crumb()!
  assert.equal(crumb.text, '← 协调·缓存迁移运行中停止')
  assert.equal(r.titleNode()?.classes.includes('canvas-breadcrumb'), true)
  assert.equal(r.titleNode()?.node, crumb.node)

  const status = crumb.children.find((child) => child.classes.includes('canvas-status'))!
  assert.equal(status.classes.includes('tone-running'), true)
  assert.equal(status.text, '运行中')

  r.stub.click(crumb.children.find((child) => child.classes.includes('canvas-back-coordinator'))!.node)
  r.stub.click(crumb.children.find((child) => child.classes.includes('canvas-stop-thread'))!.node)
  assert.deepEqual(r.events, ['back-to-coordinator', 'stop-thread'])
})

test('the stop button is drawn only while a stop applies', (t) => {
  const r = render(t)
  r.paint({ role: 'thread', thread: { ...thread, canStop: false } })
  assert.equal(r.crumb()!.children.some((child) => child.classes.includes('canvas-stop-thread')), false)
  assert.equal(r.crumb()!.text, '← 协调·缓存迁移运行中')
})

test('the crumb keeps its nodes across streamed repaints', (t) => {
  const r = render(t)
  r.paint({ role: 'thread', thread })
  const crumb = r.crumb()!.node
  const back = r.crumb()!.children[0]!.node
  r.paint({ role: 'thread', thread: { ...thread, statusLabel: '等待你', tone: 'attention' } })
  assert.equal(r.crumb()!.node, crumb)
  assert.equal(r.crumb()!.children[0]!.node, back)
  assert.equal(r.crumb()!.text, '← 协调·缓存迁移等待你停止')
  assert.equal(r.crumb()!.children.find((child) => child.classes.includes('canvas-status'))!.classes.includes('tone-attention'), true)
})

test('renaming floats the field over the title instead of replacing it', (t) => {
  // The title keeps its place in the flow (hidden by the stylesheet), so a field
  // wider than the name cannot push the menu trigger or the controls to its right.
  const r = render(t)
  r.paint({})
  const title = r.identity().children.find((child) => child.classes.includes('canvas-title'))!.node
  r.paint({ renaming: true })
  assert.equal(r.identity().classes.includes('renaming'), true)
  assert.deepEqual(
    r.identity().children.map((child) => child.classes[0]),
    ['canvas-title', 'canvas-title-input', 'canvas-menu-shell'],
  )
  assert.equal(r.identity().children[0]!.node, title, 'the same title node stays')
  r.paint({})
  assert.equal(r.identity().classes.includes('renaming'), false)
  assert.deepEqual(r.identity().children.map((child) => child.classes[0]), ['canvas-title', 'canvas-menu-shell'])
})

test('renaming a thread session keeps the crumb under the field, and back', (t) => {
  const r = render(t)
  r.paint({ role: 'thread', thread })
  const crumb = r.crumb()!.node
  r.paint({ role: 'thread', thread, renaming: true })
  assert.equal(r.titleNode()?.classes.includes('canvas-title-input'), true)
  assert.equal(r.crumb()?.node, crumb)
  r.paint({ role: 'thread', thread })
  assert.equal(r.titleNode()?.node, crumb)
})

test('the empty canvas says so and offers the two ways out', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const mount = stub.createContainer('transcript-area')
  const calls: string[] = []
  const view = createNoSessionView(mount, {
    onNewSession: () => calls.push('new'),
    onOpenProject: () => calls.push('open'),
  })
  const node = stub.inspect(mount).children[0]!
  assert.equal(node.hidden, true, 'built hidden: a launching window is not an empty one')
  view.set(true)
  const shown = stub.inspect(mount).children[0]!
  assert.equal(shown.hidden, false)
  assert.equal(shown.children[0]!.text, '没有打开的会话')
  const [create, open] = shown.children[1]!.children
  assert.ok(create!.classes.includes('primary'), 'a new session is the way out most people want')
  stub.click(create!.node)
  stub.click(open!.node)
  assert.deepEqual(calls, ['new', 'open'])
})
