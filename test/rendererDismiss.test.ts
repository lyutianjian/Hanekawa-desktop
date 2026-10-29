import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub } from './helpers/domStub.js'
import {
  closeAllDismissables,
  closeTopDismissable,
  dismissable,
  hasOpenDismissable,
  onPressOutside,
} from '../src/desktop/renderer/dom/dismiss.js'
import { focusByKey, followPointer, heldFocusKey, rovingFocus, trapTab } from '../src/desktop/renderer/dom/focus.js'
import { createImageViewerView } from '../src/desktop/renderer/dom/imageViewerView.js'
import { openImageViewer } from '../src/desktop/renderer/model/imageViewer.js'

/**
 * `dom/dismiss.ts` and `dom/focus.ts`: the two primitives every menu, popover
 * and modal layer is built on. The views' own tests assert what each one asks of
 * them; this file asserts the primitives themselves.
 *
 * Not in the base TypeScript program; see `tsconfig.domtest.json`.
 */

function mount(t: { after(fn: () => void): void }): { stub: DomStub; menu: HTMLElement; page: HTMLElement } {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const menu = stub.createContainer('menu')
  const page = stub.createContainer('page')
  return { stub, menu, page }
}

/** The pointer's whole gesture on `target`: press, release, and the browser's click. */
function press(
  stub: DomStub,
  target: unknown,
  t: { mock: { timers: { tick(ms: number): void } } },
) {
  const down = stub.dispatchDocument('pointerdown', { target })
  const mousedown = stub.dispatchDocument('mousedown', { target })
  const up = stub.dispatchDocument('pointerup', { target })
  t.mock.timers.tick(0)
  return { down, mousedown, up }
}

test('a dismissing press is swallowed for the whole gesture, and only for it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  let open = true
  onPressOutside([menu], () => {
    const was = open
    open = false
    return was
  })

  const down = stub.dispatchDocument('pointerdown', { target: page })
  assert.equal(down.propagationStopped, true, 'the pointerdown never reaches what was under the pointer')
  assert.equal(stub.dispatchDocument('mousedown', { target: page }).defaultPrevented, true, 'focus stays where it was')
  stub.dispatchDocument('pointerup', { target: page })
  for (const type of ['mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
    const result = stub.dispatchDocument(type, { target: page })
    assert.equal(result.defaultPrevented, true, `${type} is cancelled`)
    assert.equal(result.propagationStopped, true, `${type} is stopped`)
  }

  t.mock.timers.tick(0)
  const next = stub.dispatchDocument('click', { target: page })
  assert.equal(next.defaultPrevented, false, 'the next gesture is the page’s again')
  assert.equal(next.propagationStopped, false)
})

test('the swallow leaves nothing behind when no click follows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  let open = true
  onPressOutside([menu], () => {
    const was = open
    open = false
    return was
  })

  // A pointercancel (a touch turned into a scroll) ends it just as a pointerup does.
  stub.dispatchDocument('pointerdown', { target: page })
  stub.dispatchDocument('pointercancel', { target: page })
  t.mock.timers.tick(0)

  assert.equal(stub.dispatchDocument('click', { target: page }).defaultPrevented, false)
})

test('a press that never released does not eat the next gesture', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  let open = true
  onPressOutside([menu], () => {
    const was = open
    open = false
    return was
  })

  // The pointerup was lost (a drag released outside the window): without a
  // release the one-shot eaters would stay armed for the whole session.
  stub.dispatchDocument('pointerdown', { target: page })
  const fresh = stub.dispatchDocument('pointerdown', { target: page })

  assert.equal(fresh.propagationStopped, false, 'a fresh press is not part of the stale swallow')
  assert.equal(stub.dispatchDocument('click', { target: page }).defaultPrevented, false)
})

test('only a handler that answers true swallows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  const calls: string[] = []
  onPressOutside([menu], () => { calls.push('void') })
  onPressOutside([menu], () => { calls.push('false'); return false })

  const { down, mousedown } = press(stub, page, t)

  assert.deepEqual(calls.slice(0, 2), ['void', 'false'])
  assert.equal(down.propagationStopped, false)
  assert.equal(mousedown.defaultPrevented, false)
  assert.equal(stub.dispatchDocument('click', { target: page }).defaultPrevented, false)
})

test('a click on its own is answered but never swallowed', (t) => {
  // `click` is only the fallback for a press something upstream ate; a
  // keyboard-activated click must still reach its button.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  let closed = 0
  onPressOutside([menu], () => { closed += 1; return true })

  const click = stub.dispatchDocument('click', { target: page })

  assert.equal(closed, 1)
  assert.equal(click.defaultPrevented, false)
  assert.equal(stub.dispatchDocument('click', { target: page }).defaultPrevented, false)
})

test('a press inside the kept subtree, by selector or by node, is not outside', (t) => {
  const { stub, menu, page } = mount(t)
  const trigger = stub.createContainer('trigger')
  const item = document.createElement('button')
  menu.appendChild(item)
  let heard = 0
  onPressOutside(['.trigger', menu], () => { heard += 1; return true })

  stub.dispatchDocument('pointerdown', { target: item })
  stub.dispatchDocument('pointerdown', { target: trigger })
  assert.equal(heard, 0)

  stub.dispatchDocument('pointerdown', { target: page })
  assert.equal(heard, 1)
})

test('the unsubscribe removes every listener, including the swallow', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  let heard = 0
  const stop = onPressOutside([menu], () => { heard += 1; return true })

  stub.dispatchDocument('pointerdown', { target: page })
  stub.dispatchDocument('pointerup', { target: page })
  t.mock.timers.tick(0)
  assert.equal(heard, 1)

  stop()
  stub.dispatchDocument('pointerdown', { target: page })
  stub.dispatchDocument('click', { target: page })
  assert.equal(heard, 1)
})

test('dismissable closes only what is open, and swallows only then', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { stub, menu, page } = mount(t)
  let open = false
  let closes = 0
  const stop = dismissable([menu], { isOpen: () => open, close: () => { open = false; closes += 1 } })

  const idle = press(stub, page, t)
  assert.equal(closes, 0)
  assert.equal(idle.down.propagationStopped, false, 'a closed popover is not in the way of a press')

  open = true
  const live = press(stub, page, t)
  assert.equal(closes, 1)
  assert.equal(live.down.propagationStopped, true)
  assert.equal(open, false)
  stop()
})

test('Escape reaches the topmost open popover first, wherever focus is', (t) => {
  const { menu } = mount(t)
  const state = { lower: true, upper: true, closed: [] as string[] }
  const stops = [
    dismissable([menu], { isOpen: () => state.lower, close: () => { state.lower = false; state.closed.push('lower') } }),
    dismissable([menu], { isOpen: () => state.upper, close: () => { state.upper = false; state.closed.push('upper') } }),
  ]

  assert.equal(hasOpenDismissable(), true)
  assert.equal(closeTopDismissable(), true)
  assert.deepEqual(state.closed, ['upper'], 'the later registration is the one drawn on top')
  assert.equal(closeTopDismissable(), true)
  assert.deepEqual(state.closed, ['upper', 'lower'])
  assert.equal(hasOpenDismissable(), false)
  assert.equal(closeTopDismissable(), false, 'nothing open means the key is the turn’s')

  for (const stop of stops) stop()
})

test('closeAllDismissables clears every open popover, and an unsubscribed one is forgotten', (t) => {
  const { menu } = mount(t)
  const open = { a: true, b: true, gone: true }
  const stops = [
    dismissable([menu], { isOpen: () => open.a, close: () => { open.a = false } }),
    dismissable([menu], { isOpen: () => open.b, close: () => { open.b = false } }),
    dismissable([menu], { isOpen: () => open.gone, close: () => { open.gone = false } }),
  ]
  stops[2]!()

  closeAllDismissables()

  assert.deepEqual(open, { a: false, b: false, gone: true })
  stops[0]!()
  stops[1]!()
})

/** A keydown on `target`, delivered to the menu that listens for it: the stub does not bubble. */
const keydown = (stub: DomStub, menu: HTMLElement, target: unknown, key: string, shiftKey = false) =>
  stub.dispatch(menu, 'keydown', { key, shiftKey, target })

test('arrow keys rove an open menu, wrap, and claim the key', (t) => {
  const { stub, menu } = mount(t)
  const items = [1, 2, 3].map(() => menu.appendChild(document.createElement('button')))
  let opened = 0
  menu.addEventListener('keydown', (event) => rovingFocus(event, items, true, () => { opened += 1 }))

  stub.focus(items[0])
  const down = keydown(stub, menu, items[0], 'ArrowDown')
  assert.equal(stub.activeElement(), items[1])
  assert.equal(down.defaultPrevented, true)
  assert.equal(down.propagationStopped, true, 'the global key handler never sees it')

  keydown(stub, menu, items[1], 'ArrowDown')
  keydown(stub, menu, items[2], 'ArrowDown')
  assert.equal(stub.activeElement(), items[0], 'ArrowDown wraps')
  keydown(stub, menu, items[0], 'ArrowUp')
  assert.equal(stub.activeElement(), items[2], 'ArrowUp wraps')
  keydown(stub, menu, items[2], 'Home')
  assert.equal(stub.activeElement(), items[0])
  keydown(stub, menu, items[0], 'End')
  assert.equal(stub.activeElement(), items[2])

  const other = keydown(stub, menu, items[2], 'a')
  assert.equal(other.defaultPrevented, false)
  assert.equal(opened, 0)
})

test('focus that is on nothing in the menu enters it from the end the key points at', (t) => {
  const { stub, menu, page } = mount(t)
  const items = [1, 2, 3].map(() => menu.appendChild(document.createElement('button')))
  menu.addEventListener('keydown', (event) => rovingFocus(event, items, true, () => {}))

  keydown(stub, menu, page, 'ArrowUp')
  assert.equal(stub.activeElement(), items[2])
  keydown(stub, menu, page, 'ArrowDown')
  assert.equal(stub.activeElement(), items[0])
})

test('on a closed menu only ArrowDown asks to open it', (t) => {
  const { stub, menu } = mount(t)
  const trigger = menu.appendChild(document.createElement('button'))
  let opened = 0
  menu.addEventListener('keydown', (event) => rovingFocus(event, [], false, () => { opened += 1 }))

  const up = keydown(stub, menu, trigger, 'ArrowUp')
  assert.equal(opened, 0)
  assert.equal(up.defaultPrevented, false)
  const down = keydown(stub, menu, trigger, 'ArrowDown')
  assert.equal(opened, 1)
  assert.equal(down.defaultPrevented, true)
})

test('the pointer carries focus to the row it moves over, so there is one highlight', (t) => {
  const { stub, menu, page } = mount(t)
  const row = menu.appendChild(document.createElement('button'))
  row.className = 'row'
  const label = row.appendChild(document.createElement('span'))
  const off = menu.appendChild(document.createElement('button'))
  off.className = 'row'
  ;(off as HTMLButtonElement).disabled = true
  followPointer(menu, '.row')

  stub.dispatch(menu, 'mousemove', { target: label })
  assert.equal(stub.activeElement(), row, 'a move over the row’s own label counts')

  stub.focus(page)
  stub.dispatch(menu, 'mousemove', { target: off })
  assert.equal(stub.activeElement(), page, 'a disabled row cannot take focus')
  stub.dispatch(menu, 'mousemove', { target: menu })
  assert.equal(stub.activeElement(), page, 'the gap between rows is not a row')
})

test('Tab stays inside a modal layer', (t) => {
  const { stub, menu, page } = mount(t)
  const first = menu.appendChild(document.createElement('button'))
  const hidden = menu.appendChild(document.createElement('button'))
  hidden.setAttribute('tabindex', '-1')
  const last = menu.appendChild(document.createElement('button'))
  const off = menu.appendChild(document.createElement('button'))
  ;(off as HTMLButtonElement).disabled = true
  menu.addEventListener('keydown', (event) => trapTab(menu, event))

  stub.focus(last)
  const wrap = keydown(stub, menu, last, 'Tab')
  assert.equal(wrap.defaultPrevented, true)
  assert.equal(stub.activeElement(), first, 'Tab off the last control wraps to the first')

  const back = keydown(stub, menu, first, 'Tab', true)
  assert.equal(back.defaultPrevented, true)
  assert.equal(stub.activeElement(), last, 'Shift+Tab off the first control wraps to the last')

  stub.focus(first)
  const inner = keydown(stub, menu, first, 'Tab')
  assert.equal(inner.defaultPrevented, false, 'a Tab between stops is the browser’s')

  stub.focus(page)
  keydown(stub, menu, page, 'Tab')
  assert.equal(stub.activeElement(), first, 'focus that strayed outside is pulled back in')
  stub.focus(menu)
  keydown(stub, menu, menu, 'Tab', true)
  assert.equal(stub.activeElement(), last, 'focus on the layer itself enters from the far end')

  const other = keydown(stub, menu, first, 'a')
  assert.equal(other.defaultPrevented, false)
})

test('a layer with nothing to focus swallows Tab instead of leaking it', (t) => {
  const { stub, menu } = mount(t)
  menu.addEventListener('keydown', (event) => trapTab(menu, event))

  assert.equal(stub.dispatch(menu, 'keydown', { key: 'Tab' }).defaultPrevented, true)
})

test('a focus key finds the rebuilt control that replaced the focused one', (t) => {
  const { stub, menu } = mount(t)
  const row = menu.appendChild(document.createElement('div'))
  const old = row.appendChild(document.createElement('button'))
  old.dataset.focusKey = 'c:s1'
  stub.focus(old)

  assert.equal(heldFocusKey(menu), 'c:s1')
  stub.focus(menu)
  assert.equal(heldFocusKey(menu), undefined, 'focus on the root itself holds no key')

  row.removeChild(old)
  const replacement = row.appendChild(document.createElement('button'))
  replacement.dataset.focusKey = 'd:s1'
  assert.equal(focusByKey(menu, 'c:s1'), false, 'a key the repaint dropped is reported, not guessed')
  assert.equal(focusByKey(menu, 'd:s1'), true)
  assert.equal(stub.activeElement(), replacement)
})

test('focus outside the root holds no key', (t) => {
  const { stub, menu, page } = mount(t)
  const elsewhere = page.appendChild(document.createElement('button'))
  elsewhere.dataset.focusKey = 'x'
  stub.focus(elsewhere)

  assert.equal(heldFocusKey(menu), undefined)
})

test('the image viewer keeps Tab inside itself and can take focus on its own face', (t) => {
  const { stub } = mount(t)
  const layer = stub.createContainer('lightbox')
  const closed: number[] = []
  const viewer = createImageViewerView(layer, { onZoom: () => {}, onClose: () => { closed.push(1) } })
  viewer.show(openImageViewer({
    imageId: 'img-1', name: 'a.png', dimensions: '1×1', width: 1, height: 1, zoom: 1, thumbUrl: 'data:,',
  }))

  assert.equal(layer.tabIndex, -1, 'a press on the picture leaves focus on the layer, not on <body>')

  const stops = [...stub.inspect(layer).children]
    .flatMap((child) => [child, ...child.children])
    .filter((node) => node.tagName === 'BUTTON')
  const first = stops[0]!
  const last = stops[stops.length - 1]!
  assert.equal(stub.activeElement(), stops.find((node) => node.classes.includes('lightbox-close'))!.node, 'opening focuses the close button')

  stub.focus(last.node)
  const forward = stub.dispatch(layer, 'keydown', { key: 'Tab', target: last.node })
  assert.equal(forward.defaultPrevented, true)
  assert.equal(stub.activeElement(), first.node)

  stub.dispatch(layer, 'keydown', { key: 'Tab', shiftKey: true, target: first.node })
  assert.equal(stub.activeElement(), last.node)
  viewer.close()
})
