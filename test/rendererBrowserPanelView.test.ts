import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub } from './helpers/domStub.js'
import {
  createBrowserPanelView,
  type BrowserPanelView,
  type BrowserPanelViewModel,
} from '../src/desktop/renderer/dom/browserPanelView.js'
import type { WireBrowserRect, WireBrowserTabInfo } from '../src/desktop/shellProtocol.js'

/**
 * The browser panel's *nodes*, and the one thing about it that is not arithmetic:
 * the geometry it reports.
 *
 * The page is a native `WebContentsView` the main process parks over a hole in
 * this panel, so every bug in this file is invisible to the model tests and
 * loud on screen — a page that keeps painting over the settings screen, or one
 * left floating after the panel went away. What can be checked here is that the
 * view *says* the right thing: one push per real change, visibility told rather
 * than styled, and a hide on the way out.
 *
 * Whether the native view actually lands on the hole is the smoke's job — there
 * is no compositor here.
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

/** The hole, as the layout rule measures it: x 800..1280, y 100..700. */
const HOLE = { top: 100, bottom: 700, left: 800, right: 1280 }
const HOLE_RECT: WireBrowserRect = { x: 800, y: 100, width: 480, height: 600 }

function tab(overrides: Partial<WireBrowserTabInfo> & { tabId: string; lane: string }): WireBrowserTabInfo {
  return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, ...overrides }
}

interface Rendered {
  stub: DomStub
  view: BrowserPanelView
  nodes: {
    panel: HTMLElement
    tabs: HTMLElement
    address: HTMLElement
    banner: HTMLElement
    hole: HTMLElement
  }
  bounds: Array<{ tabId: string; rect: WireBrowserRect; visible: boolean }>
  closed: string[]
  selected: string[]
  navigated: Array<{ tabId: string; url: string }>
  tookOver: string[]
  released: string[]
  paint(overrides?: Partial<BrowserPanelViewModel>): void
}

function render(t: { after(fn: () => void): void }, options: { measurable?: boolean } = {}): Rendered {
  const stub = installDomStub()
  const nodes = {
    panel: stub.createContainer('panel'),
    tabs: stub.createContainer('tabs'),
    address: stub.createContainer('address'),
    banner: stub.createContainer('banner'),
    hole: stub.createContainer('hole'),
  }
  // A rule keyed off what the node *is*, because the nodes a view builds do not
  // exist until the paint that measures them.
  stub.onLayout((view) =>
    options.measurable !== false && view.classes.includes('hole') ? HOLE : undefined,
  )

  const bounds: Rendered['bounds'] = []
  const closed: string[] = []
  const selected: string[] = []
  const navigated: Rendered['navigated'] = []
  const tookOver: string[] = []
  const released: string[] = []

  const view = createBrowserPanelView(nodes, {
    onSelectTab: (tabId) => selected.push(tabId),
    onCloseTab: (tabId) => closed.push(tabId),
    onNewTab: () => selected.push('new'),
    onNavigate: (tabId, url) => navigated.push({ tabId, url }),
    onBack: () => {},
    onForward: () => {},
    onReload: () => {},
    onTakeOver: (tabId) => tookOver.push(tabId),
    onRelease: (tabId) => released.push(tabId),
    onBounds: (tabId, rect, visible) => bounds.push({ tabId, rect, visible }),
  })
  // One hook, in this order: `after` callbacks run in registration order, and
  // the view's teardown unsubscribes from `window` — which `uninstall` deletes.
  // Registering them separately tears the stub down first and every test that
  // does not dispose inline dies in its own cleanup.
  t.after(() => {
    view.dispose()
    stub.uninstall()
  })

  const paint = (overrides: Partial<BrowserPanelViewModel> = {}): void => {
    view.render({
      tabs: [tab({ tabId: 't1', lane: '1', url: 'https://example.com/a', title: '示例' })],
      lane: '1',
      activeTabId: 't1',
      open: true,
      occluded: false,
      ...overrides,
    })
  }

  return { stub, view, nodes, bounds, closed, selected, navigated, tookOver, released, paint }
}

// --- geometry ---------------------------------------------------------------------

test('the hole is measured and pushed once, and an unchanged paint pushes nothing', (t) => {
  const r = render(t)
  r.paint()
  assert.deepEqual(r.bounds, [{ tabId: 't1', rect: HOLE_RECT, visible: true }])

  // The panel repaints on every title change of a loading page. Re-pushing an
  // identical rect per repaint would make this the chattiest thing on the wire.
  r.paint()
  r.paint()
  assert.equal(r.bounds.length, 1)
})

test('being covered keeps the rect but stops the page painting', (t) => {
  const r = render(t)
  r.paint()
  r.paint({ occluded: true })

  // Not a smaller rect and not a missing push: the stylesheet can hide the
  // panel's DOM, but a native view is not in the document and would keep
  // painting over the settings screen unless it is *told*.
  assert.deepEqual(r.bounds.at(-1), { tabId: 't1', rect: HOLE_RECT, visible: false })
})

test('a hidden window stops the page painting too', (t) => {
  const r = render(t)
  r.paint()
  r.stub.setHidden(true)
  r.view.measure()
  assert.equal(r.bounds.at(-1)?.visible, false)
})

test('a closed panel stops the page painting', (t) => {
  const r = render(t)
  r.paint()
  r.paint({ open: false })
  assert.equal(r.bounds.at(-1)?.visible, false)
  assert.equal(r.stub.inspect(r.nodes.panel).hidden, true)
})

test('an unmeasurable hole is not pushed at all', (t) => {
  // What a hole inside a `display: none` subtree measures as. Pushing that would
  // park the page at the origin at zero size and restore it a frame later, which
  // reads as a flash.
  const r = render(t, { measurable: false })
  r.paint()
  assert.deepEqual(r.bounds, [])
})

test('no tab means nothing to position', (t) => {
  const r = render(t)
  r.paint({ tabs: [], activeTabId: undefined })
  assert.deepEqual(r.bounds, [])
})

test('a lane with no tabs hides the page the last lane showed', (t) => {
  const r = render(t)
  r.paint()
  r.paint({ lane: '2', activeTabId: undefined })
  assert.deepEqual(r.bounds.at(-1), { tabId: 't1', rect: HOLE_RECT, visible: false })
})

test('a blank new tab hides the page it replaces on screen', (t) => {
  const r = render(t)
  r.paint()
  r.paint({
    tabs: [tab({ tabId: 't1', lane: '1', url: 'https://example.com/a' }), tab({ tabId: 't2', lane: '1' })],
    activeTabId: 't2',
  })
  assert.deepEqual(r.bounds.slice(1), [
    { tabId: 't1', rect: HOLE_RECT, visible: false },
    { tabId: 't2', rect: HOLE_RECT, visible: false },
  ])
})

test('disposing hides the page rather than leaving it floating over the window', (t) => {
  const r = render(t)
  r.paint()
  r.view.dispose()
  assert.deepEqual(r.bounds.at(-1), { tabId: 't1', rect: HOLE_RECT, visible: false })
  // And it stops listening: a measure after dispose must not push again.
  r.view.measure()
  assert.equal(r.bounds.length, 2)
})

// --- the strip and the address row ----------------------------------------------------

test('only the active lane’s tabs are drawn, with the active one marked', (t) => {
  const r = render(t)
  r.paint({
    tabs: [
      tab({ tabId: 't1', lane: '1', title: '一' }),
      tab({ tabId: 't2', lane: '2', title: '二' }),
      tab({ tabId: 't3', lane: '1', title: '三' }),
    ],
    activeTabId: 't3',
  })
  const rows = r.stub.inspect(r.nodes.tabs).children
  // Two rows for lane 1, plus the strip's own `＋`.
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.slice(0, 2).map((row) => row.text.replace('✕', '')), ['一', '三'])
  assert.equal(rows[0]!.classes.includes('active'), false)
  assert.equal(rows[1]!.classes.includes('active'), true)
})

test('a tab taken over by the user is marked as such', (t) => {
  const r = render(t)
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', title: '一', takenOver: true })] })
  assert.equal(r.stub.inspect(r.nodes.tabs).children[0]!.classes.includes('taken-over'), true)
})

test('clicking a row selects it and its ✕ closes it, without selecting', (t) => {
  const r = render(t)
  r.paint()
  const row = r.stub.inspect(r.nodes.tabs).children[0]!
  r.stub.click(row.node)
  assert.deepEqual(r.selected, ['t1'])

  // By class, not by index: the row's first element child is the label span,
  // and an index here would silently start asserting about the wrong node the
  // moment the row grows a favicon.
  const close = row.children.find((child) => child.classes.includes('browser-tab-close'))
  assert.ok(close, 'every row carries its own close control')
  r.stub.click(close.node)
  assert.deepEqual(r.closed, ['t1'])
  assert.deepEqual(r.selected, ['t1'])
})

test('every row carries one icon slot, whichever of the three things is in it', (t) => {
  const r = render(t)
  r.paint({
    tabs: [
      tab({ tabId: 't1', lane: '1', title: '一', favicon: 'data:image/png;base64,AA' }),
      tab({ tabId: 't2', lane: '1', title: '二', loading: true }),
      tab({ tabId: 't3', lane: '1', title: '三' }),
    ],
  })
  const slots = r.stub.inspect(r.nodes.tabs).children
    .slice(0, 3)
    .map((row) => row.children.find((child) => child.classes.includes('browser-tab-icon'))!)
  assert.equal(slots.length, 3, 'a tab without an icon still holds the slot, so nothing shifts')
  assert.equal(slots[0]!.attributes.get('src'), 'data:image/png;base64,AA')
  assert.equal(slots[1]!.classes.includes('loading'), true)
  // The placeholder is the bare slot: no source, and not the spinner.
  assert.equal(slots[2]!.attributes.get('src'), undefined)
  assert.equal(slots[2]!.classes.includes('loading'), false)
})

test('the ✕ sits after the label, at the end of the tab', (t) => {
  const r = render(t)
  r.paint()
  const row = r.stub.inspect(r.nodes.tabs).children[0]!
  assert.deepEqual(
    row.children.map((child) => child.classes[0]),
    ['browser-tab-icon', 'browser-tab-label', 'browser-tab-close'],
  )
})

// --- the hole's own page ---------------------------------------------------------

test('a tab that has never navigated says so, and the page stops painting under it', (t) => {
  const r = render(t)
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1' })] })
  const blank = r.stub.inspect(r.nodes.hole).children.find((child) => child.classes.includes('browser-blank'))!
  assert.equal(blank.hidden, false)
  assert.equal(blank.text, '在上方输入网址开始浏览')
  // A WebContentsView is above this document: a hint drawn under a painting
  // page is a hint nobody sees.
  assert.equal(r.bounds.at(-1)?.visible, false)

  r.paint()
  assert.equal(r.stub.inspect(r.nodes.hole).children[0]!.hidden, true)
  assert.equal(r.bounds.at(-1)?.visible, true)
})

test('a failed navigation draws the address, the reason, and a retry', (t) => {
  const r = render(t)
  r.paint({
    tabs: [
      tab({
        tabId: 't1',
        lane: '1',
        url: 'https://example.com/a',
        error: 'ERR_NAME_NOT_RESOLVED',
        errorUrl: 'https://nope.invalid/x',
      }),
    ],
  })
  const failure = r.stub.inspect(r.nodes.hole).children.find((child) => child.classes.includes('browser-error'))!
  assert.equal(failure.hidden, false)
  assert.match(failure.text, /https:\/\/nope\.invalid\/x/)
  assert.match(failure.text, /域名找不到/)
  assert.equal(r.bounds.at(-1)?.visible, false)

  // Retry reloads the address that failed — not the page still committed
  // underneath, and without the user retyping anything.
  const retry = failure.children.find((child) => child.classes.includes('browser-error-retry'))!
  r.stub.click(retry.node)
  assert.deepEqual(r.navigated, [{ tabId: 't1', url: 'https://nope.invalid/x' }])

  // And the bar stayed on what was typed, not on the page behind the error.
  const field = r.stub.inspect(r.nodes.address).children
    .find((child) => child.classes.includes('browser-url'))!.node as HTMLInputElement
  assert.equal(field.value, 'nope.invalid')
})

test('the address field is built once and survives every repaint', (t) => {
  const r = render(t)
  r.paint()
  // By class: the row ends with the 接管 button, and an index here would start
  // asserting about that the moment the row grows another control.
  const field = () => r.stub.inspect(r.nodes.address).children.find((child) => child.classes.includes('browser-url'))!
  const first = field().node
  // This row repaints on every title update of a loading page; rebuilding the
  // input would drop the caret mid-word.
  for (let i = 0; i < 5; i += 1) r.paint({ tabs: [tab({ tabId: 't1', lane: '1', title: `载入中 ${i}` })] })
  assert.equal(field().node, first)
})

test('Enter in the address bar navigates, and refuses what is not an address', (t) => {
  const r = render(t)
  r.paint()
  const field = r.stub.inspect(r.nodes.address).children
    .find((child) => child.classes.includes('browser-url'))!.node as HTMLInputElement

  field.value = 'example.com/x'
  const accepted = r.stub.dispatch(field, 'keydown', { key: 'Enter' })
  assert.deepEqual(r.navigated, [{ tabId: 't1', url: 'https://example.com/x' }])
  // Stopped here: Enter in an address bar is a navigation, never a composer submit.
  assert.equal(accepted.defaultPrevented, true)

  field.value = 'file:///etc/passwd'
  r.stub.dispatch(field, 'keydown', { key: 'Enter' })
  assert.equal(r.navigated.length, 1, 'a non-http address is not a navigation')
})

test('Escape in the address bar takes back what was typed, then leaves the field', (t) => {
  const r = render(t)
  r.paint()
  const field = r.stub.inspect(r.nodes.address).children
    .find((child) => child.classes.includes('browser-url'))!.node as HTMLInputElement
  const shown = field.value
  r.stub.focus(field)

  field.value = 'half-typed.example'
  const first = r.stub.dispatch(field, 'keydown', { key: 'Escape' })
  assert.equal(field.value, shown, 'the current address is back')
  assert.equal(r.stub.activeElement(), field, 'the first Escape keeps the field')
  assert.equal(first.defaultPrevented && first.propagationStopped, true, 'and never interrupts the turn')

  r.stub.dispatch(field, 'keydown', { key: 'Escape' })
  assert.equal(r.stub.activeElement(), undefined, 'with nothing to take back it leaves')
  assert.deepEqual(r.navigated, [])
})

test('back and forward are disabled until the page says otherwise', (t) => {
  const r = render(t)
  r.paint()
  const [back, forward] = r.stub.inspect(r.nodes.address).children
  assert.equal(back!.disabled, true)
  assert.equal(forward!.disabled, true)

  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', canGoBack: true })] })
  assert.equal(r.stub.inspect(r.nodes.address).children[0]!.disabled, false)
})

test('the control takes the tab over, then hands it back', (t) => {
  const r = render(t)
  const control = () =>
    r.stub.inspect(r.nodes.address).children.find((child) => child.classes.includes('browser-takeover'))!

  // A tab a session has driven: there is something to take.
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', agentActive: true })] })
  assert.equal(control().disabled, false)
  r.stub.click(control().node)
  assert.deepEqual(r.tookOver, ['t1'])

  // And back: the same button, now saying the other thing. One control rather
  // than two, so「已接管」cannot sit beside a tab that is no longer taken.
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', agentActive: true, takenOver: true })] })
  assert.match(control().attributes.get('aria-label') ?? '', /交还/)
  assert.equal(control().disabled, false)
  r.stub.click(control().node)
  assert.deepEqual(r.released, ['t1'])
  assert.deepEqual(r.tookOver, ['t1'], 'the press reports a hand-back, not a second takeover')
})

test('a tab no agent is driving says so instead of swallowing the press', (t) => {
  const r = render(t)
  // What「＋」opens: nobody has driven it, so a takeover has nothing to interrupt.
  r.paint()
  const control = () =>
    r.stub.inspect(r.nodes.address).children.find((child) => child.classes.includes('browser-takeover'))!
  assert.equal(control().disabled, true)
  assert.equal(control().attributes.get('aria-label'), '当前没有 agent 在操作此标签页')

  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', agentActive: true })] })
  assert.equal(control().disabled, false)
})

test('the banner shows while the agent drives the tab, and not once the user holds it', (t) => {
  const r = render(t)
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1' })] })
  assert.equal(r.stub.inspect(r.nodes.banner).hidden, true)

  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', agentActive: true })] })
  assert.equal(r.stub.inspect(r.nodes.banner).hidden, false)
  assert.match(r.stub.inspect(r.nodes.banner).text, /agent 正在操作/)

  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', agentActive: false, takenOver: true })] })
  assert.equal(r.stub.inspect(r.nodes.banner).hidden, true)
})

test('a title update repaints the row in place instead of rebuilding the strip', (t) => {
  // A loading page reports its title many times a second. A rebuilt strip took
  // the keyboard focus off the tab and restarted the spinner on every report.
  const r = render(t)
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', title: '一', loading: true })] })
  const before = r.stub.inspect(r.nodes.tabs).children[0]!
  const spinner = before.children.find((child) => child.classes.includes('browser-tab-icon'))!
  r.paint({ tabs: [tab({ tabId: 't1', lane: '1', title: '一二', loading: true })] })
  const after = r.stub.inspect(r.nodes.tabs).children[0]!
  assert.equal(after.node, before.node, 'the same row')
  assert.equal(after.children.find((child) => child.classes.includes('browser-tab-icon'))!.node, spinner.node, 'the same spinner')
  assert.ok(after.text.includes('一二'))
})

test('the tab strip is one Tab stop and the arrows walk it', (t) => {
  const r = render(t)
  r.paint({
    tabs: [tab({ tabId: 't1', lane: '1', title: '一' }), tab({ tabId: 't2', lane: '1', title: '二' })],
    activeTabId: 't1',
  })
  const rows = r.stub.inspect(r.nodes.tabs).children.slice(0, 2)
  assert.deepEqual(rows.map((row) => (row.node as unknown as { tabIndex: number }).tabIndex), [0, -1])
  ;(rows[0]!.node as unknown as { focus(): void }).focus()
  const event = r.stub.dispatch(r.nodes.tabs, 'keydown', { key: 'ArrowRight', target: rows[0]!.node })
  assert.deepEqual(r.selected, ['t2'])
  assert.equal(event.defaultPrevented, true)
  ;(rows[1]!.node as unknown as { focus(): void }).focus()
  r.stub.dispatch(r.nodes.tabs, 'keydown', { key: 'Delete', target: rows[1]!.node })
  assert.deepEqual(r.closed, ['t2'])
})
