import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { closeTopDismissable, hasOpenDismissable } from '../src/desktop/renderer/dom/dismiss.js'
import { createTitleBarView } from '../src/desktop/renderer/dom/titleBarView.js'
import { bindWindowChrome } from '../src/desktop/renderer/dom/windowChrome.js'
import type { TitlebarArea } from '../src/desktop/renderer/model/windowChrome.js'
import {
  titleBarMenus,
  itemEnabled,
  toggleMenu,
  type TitleBarAction,
  type TitleBarView,
} from '../src/desktop/renderer/model/titleBar.js'

const TITLE_BAR_MENUS = titleBarMenus('win32')

/**
 * The frameless window's title bar (5g).
 *
 * The claim worth pinning is not that a menu opens — it is that **every item maps
 * to an action the app already had**. The bar exists because Electron's default
 * menu is English and the window has no frame to hang it on; if an item ever
 * grows behaviour of its own, this is the layer where two ways to do one thing
 * start disagreeing.
 *
 * Not in the base TypeScript program; see `tsconfig.domtest.json`.
 */

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly actions: TitleBarAction[]
  readonly menuRequests: Array<string | undefined>
  render(view: TitleBarView): void
  root(): StubView
  bar(): StubView
}

function viewOf(overrides: Partial<TitleBarView> = {}): TitleBarView {
  return {
    menus: TITLE_BAR_MENUS,
    openMenu: undefined,
    sidebarCollapsed: false,
    browserOpen: false,
    canCreate: true,
    ...overrides,
  }
}

function mount(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('titlebar')
  const actions: TitleBarAction[] = []
  const menuRequests: Array<string | undefined> = []
  const dom = createTitleBarView(
    container,
    (action) => actions.push(action),
    (id) => menuRequests.push(id),
  )
  return {
    stub,
    container,
    actions,
    menuRequests,
    render: (view) => dom.render(view),
    // The rail and the menus live in the lead group; the browser rail follows the header slot.
    root: () => stub.inspect(container).children[0]!,
    bar: () => stub.inspect(container),
  }
}

const shells = (root: StubView): readonly StubView[] =>
  root.children.filter((child) => child.classes.includes('titlebar-menu-shell'))

const openList = (root: StubView): StubView | undefined =>
  shells(root)
    .flatMap((shell) => shell.children)
    .find((child) => child.classes.includes('titlebar-menu') && !child.hidden && !child.classes.includes('presence-closing'))

test('the bar is the rail toggle and the two Chinese menus, in that order', (t) => {
  const { render, root, stub, actions } = mount(t)
  render(viewOf())

  const children = root().children
  assert.ok(children[0]?.classes.includes('titlebar-rail'))
  assert.deepEqual(
    shells(root()).map((shell) => shell.children[0]?.text),
    ['文件', '视图'],
  )

  stub.click(children[0]?.node)
  assert.deepEqual(actions, ['toggle-sidebar'])
})

test('a trigger reports the menu it wants open, and the view draws it on the next render', (t) => {
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf())

  assert.equal(openList(root()), undefined, 'a menu is drawn before anything asked for one')
  stub.click(shells(root())[0]?.children[0]?.node)
  assert.deepEqual(menuRequests, ['file'])

  render(viewOf({ openMenu: 'file' }))
  const items = openList(root())?.children ?? []
  assert.deepEqual(items.map((item) => item.text), [
    '新建会话Ctrl+T',
    '打开项目…Ctrl+Shift+O',
    '设置Ctrl+,',
  ])
})

test('choosing an item closes the menu before it acts', (t) => {
  // Several of these swap the whole canvas; a menu left open would hang over the
  // screen that replaced it. The order is the claim, so both lists are asserted.
  const { render, root, stub, actions, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'file' }))

  stub.click(openList(root())?.children[2]?.node)
  assert.deepEqual(menuRequests, [undefined])
  assert.deepEqual(actions, ['open-settings'])
})

test('the two items that open something are dead while a blocking dialog is up', (t) => {
  const { render, root } = mount(t)
  render(viewOf({ openMenu: 'file', canCreate: false }))

  assert.deepEqual(
    openList(root())?.children.map((item) => item.disabled),
    [true, true, false],
    'settings is window-level and stays reachable',
  )
})

test('focus leaving the bar closes an open menu; focus moving inside does not', (t) => {
  const { render, root, container, stub, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'view' }))

  const inside = openList(root())?.children[0]?.node
  stub.dispatch(container, 'focusout', { relatedTarget: inside })
  assert.deepEqual(menuRequests, [], 'focus inside the bar closed the menu')

  // `null` is this view's own repaint destroying the focused node, not a
  // departure — the same carve-out `sidebarView.ts` makes.
  stub.dispatch(container, 'focusout', { relatedTarget: null })
  assert.deepEqual(menuRequests, [])

  stub.dispatch(container, 'focusout', { relatedTarget: stub.createContainer('elsewhere') })
  assert.deepEqual(menuRequests, [undefined])
})

test('a press outside the bar closes an open menu, and only then', (t) => {
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf())

  const elsewhere = stub.createContainer('canvas')
  stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(menuRequests, [], 'a press with nothing open must not cost a repaint')

  render(viewOf({ openMenu: 'view' }))
  stub.dispatchDocument('pointerdown', { target: openList(root())?.children[0]?.node })
  assert.deepEqual(menuRequests, [], 'a press on the menu itself is the user using it')

  stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(menuRequests, [undefined])
})

test('the bar’s own blank strip is outside the menu', (t) => {
  // The scope is each menu shell, not the strip they sit on: pressing the empty
  // space beside 帮助 while a menu hangs under 文件 is a dismissal, and a
  // bar-wide scope used to read it as a press inside the thing being dismissed.
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'view' }))

  stub.dispatchDocument('pointerdown', { target: root().node })
  assert.deepEqual(menuRequests, [undefined])
})

test('Escape closes an open menu and only then', (t) => {
  const { render, container, stub, menuRequests } = mount(t)
  render(viewOf())

  stub.dispatch(container, 'keydown', { key: 'Escape' })
  assert.deepEqual(menuRequests, [], 'Escape with nothing open must reach the app, not be eaten')

  render(viewOf({ openMenu: 'view' }))
  stub.dispatch(container, 'keydown', { key: 'Escape' })
  assert.deepEqual(menuRequests, [undefined])
})

test('the arrow keys open a menu and rove its enabled items, which hover then shares', (t) => {
  const { render, root, stub, menuRequests } = mount(t)
  render(viewOf({ canCreate: false }))
  const shell = shells(root())[0]!

  stub.dispatch(shell.node, 'keydown', { key: 'ArrowDown', target: shell.children[0]!.node })
  assert.deepEqual(menuRequests, ['file'], 'ArrowDown on the closed trigger asks to open it')

  render(viewOf({ openMenu: 'file', canCreate: false }))
  const items = openList(root())!.children
  assert.equal(stub.activeElement(), items[2]!.node, 'opening lands on the first item that can take focus')
  assert.equal(items[0]!.disabled, true)

  const down = stub.dispatch(shell.node, 'keydown', { key: 'ArrowDown', target: items[2]!.node })
  assert.equal(down.defaultPrevented, true)
  assert.equal(stub.activeElement(), items[2]!.node, 'the disabled items are skipped, so the only stop wraps onto itself')

  render(viewOf({ openMenu: 'file' }))
  stub.dispatch(shell.node, 'keydown', { key: 'End', target: items[2]!.node })
  stub.dispatch(shell.node, 'keydown', { key: 'ArrowDown', target: items[2]!.node })
  assert.equal(stub.activeElement(), items[0]!.node, 'ArrowDown wraps past the last item')

  // The pointer takes focus along, so a resting pointer and the keyboard cannot
  // each paint a row.
  stub.dispatch(openList(root())!.node, 'mousemove', { target: items[1]!.node })
  assert.equal(stub.activeElement(), items[1]!.node)
})

test('Escape closes an open menu from the document too, when focus has fallen to the body', (t) => {
  const { render, menuRequests } = mount(t)
  render(viewOf({ openMenu: 'view' }))

  assert.equal(hasOpenDismissable(), true)
  assert.equal(closeTopDismissable(), true)
  assert.deepEqual(menuRequests, [undefined])
})

test('every item names an action the model can enable, and toggling is idempotent', () => {
  // The model half, checked here because it is what the view's contract rests on.
  const view = viewOf({ canCreate: false })
  for (const menu of TITLE_BAR_MENUS) {
    for (const item of menu.items) {
      assert.equal(itemEnabled(item, view), item.needsProject !== true)
    }
  }
  assert.equal(toggleMenu('file', 'file'), undefined)
  assert.equal(toggleMenu('file', 'view'), 'view')
  assert.equal(toggleMenu(undefined, 'view'), 'view')
})

test('macOS menus and the rail use the supplied Command labels, including on repaint', (t) => {
  const { render, root, stub, actions } = mount(t)
  render(viewOf({ openMenu: 'file' }))
  const macMenus = titleBarMenus('darwin')
  render(viewOf({ menus: macMenus, openMenu: 'file' }))
  assert.deepEqual(openList(root())?.children.map((item) => item.text), [
    '新建会话⌘T', '打开项目…⇧⌘O', '设置⌘,',
  ])
  assert.equal((root().children[0]?.node as HTMLElement).title, '收起侧栏（⌘B）')
  const item = openList(root())?.children[0]?.node
  render(viewOf({ menus: macMenus, openMenu: 'file', sidebarCollapsed: true }))
  assert.equal(openList(root())?.children[0]?.node, item, 'a shell repaint rebuilt the open menu')
  assert.equal((root().children[0]?.node as HTMLElement).title, '展开侧栏（⌘B）')
  stub.click(item)
  assert.deepEqual(actions, ['new-session'])
})

test('window chrome reserves space before measurement and follows resize/fullscreen until disposed', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const root = stub.documentElement() as HTMLElement
  const properties = (root.style as unknown as { properties: Map<string, string> }).properties
  const geometryListeners = new Set<() => void>()
  const resizeListeners = new Set<() => void>()
  const overlay = {
    visible: false,
    area: { x: 0, width: 0, height: 0 } as TitlebarArea,
    getTitlebarAreaRect() { return this.area },
    addEventListener(_event: 'geometrychange', listener: () => void) { geometryListeners.add(listener) },
    removeEventListener(_event: 'geometrychange', listener: () => void) { geometryListeners.delete(listener) },
  }
  const host = {
    innerWidth: 1080,
    addEventListener(_event: 'resize', listener: () => void) { resizeListeners.add(listener) },
    removeEventListener(_event: 'resize', listener: () => void) { resizeListeners.delete(listener) },
  }
  const dispose = bindWindowChrome(root, 'darwin', host, overlay)
  t.after(dispose)
  const insets = () => [properties.get('--titlebar-inset-left'), properties.get('--titlebar-inset-right')]
  assert.equal(root.dataset.platform, 'darwin')
  assert.deepEqual(insets(), ['80px', '0px'], 'an unready API must not remove the native safe area')
  for (const listener of resizeListeners) listener()
  assert.deepEqual(insets(), ['80px', '0px'])

  overlay.visible = true
  overlay.area = { x: 78, width: 1002, height: 40 }
  for (const listener of geometryListeners) listener()
  assert.deepEqual(insets(), ['78px', '0px'])

  host.innerWidth = 900
  overlay.area = { x: 78, width: 822, height: 40 }
  for (const listener of resizeListeners) listener()
  assert.deepEqual(insets(), ['78px', '0px'])

  overlay.visible = false
  overlay.area = { x: 0, width: 0, height: 0 }
  for (const listener of geometryListeners) listener()
  assert.deepEqual(insets(), ['0px', '0px'])
  overlay.visible = true
  overlay.area = { x: 80, width: 820, height: 40 }
  for (const listener of geometryListeners) listener()
  assert.deepEqual(insets(), ['80px', '0px'])

  dispose()
  assert.equal(geometryListeners.size, 0)
  assert.equal(resizeListeners.size, 0)
})

test('a renderer without the optional overlay API still paints a safe title bar', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const root = stub.documentElement() as HTMLElement
  const properties = (root.style as unknown as { properties: Map<string, string> }).properties
  const dispose = bindWindowChrome(root, 'win32', {
    innerWidth: 1080, addEventListener() {}, removeEventListener() {},
  }, undefined)
  t.after(dispose)
  assert.equal(properties.get('--titlebar-inset-left'), '0px')
  assert.equal(properties.get('--titlebar-inset-right'), '138px')
})

test('the browser rail sits at the far end and reports its state', (t) => {
  const r = mount(t)
  r.render(viewOf())

  // Last child, because the panel it opens is on that side: a control for it
  // beside the sidebar's rail would point the wrong way.
  const rail = r.bar().children.at(-1)!
  assert.ok(rail.classes.includes('titlebar-rail-end'), 'the browser rail is the strip\'s last control')
  assert.equal(rail.attributes.get('aria-label'), '显示浏览器')
  assert.equal(rail.attributes.get('aria-pressed'), 'false')

  r.stub.click(rail.node)
  assert.deepEqual(r.actions, ['toggle-browser'])

  r.render(viewOf({ browserOpen: true }))
  const open = r.bar().children.at(-1)!
  assert.equal(open.attributes.get('aria-label'), '隐藏浏览器')
  assert.equal(open.attributes.get('aria-pressed'), 'true')
  assert.ok(open.classes.includes('open'))
})
