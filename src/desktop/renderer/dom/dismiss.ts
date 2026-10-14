/**
 * "Click outside closes it", as one primitive.
 *
 * Every menu and popover in this renderer used to close on its container's
 * `focusout` alone, and that has a hole the views document one by one: a click
 * on an unfocusable decoration — the transcript's background, the canvas gutter
 * — moves no focus, so no `focusout` fires and the menu stays open. Worse, most
 * of these triggers are rebuilt by the very repaint that opens the menu, and
 * Chromium fires no `blur` for a focused node that is *removed*: focus is back
 * on `<body>` before the user's second click, so the container has nothing left
 * to lose focus from and `focusout` never fires again at all.
 *
 * So this listens where the click actually lands. Five things are load-bearing:
 *
 * 1. **Capture phase, on `document`.** Several subtrees stop propagation on
 *    their own pointer events — `controls.ts`'s `button()` stops every `click`
 *    it handles — and a bubbling listener would never hear those.
 * 2. **`keep` is the popover *and* its trigger, not the bar they sit in.** A
 *    press on the trigger of an open menu has to reach the trigger's own toggle
 *    as a close; answering it here would close the menu and let the `click` that
 *    follows re-open it, and the toggle would stop working. Everything else —
 *    including the rest of the header, the rest of the title bar, the rest of
 *    the rail — is *outside*, which is what makes a press on the blank space
 *    beside a menu dismiss it. Scoping to the whole container is why it did not.
 * 3. **Selectors, not nodes.** These menus are rebuilt by every repaint, and a
 *    streaming turn repaints per token; a captured node reference would be
 *    stale by the user's next click. An element may still be passed where the
 *    anchor really is persistent (the welcome hero's row, the composer's form).
 * 4. **Four event types, and `handler` must be idempotent.** `pointerdown` is
 *    the one the user reads as "I pressed somewhere else", and it precedes
 *    `click`, so a menu item still receives its own activation. `mousedown` and
 *    `click` follow it because a popover that will not close is worse than one
 *    told to close three times, and `contextmenu` because a right-click
 *    elsewhere is also "somewhere else". Every caller already answers an
 *    unchanged state without repainting — the rule `app.ts` spells out at
 *    `closeHeaderMenu` — so one gesture costs one close and two no-ops.
 * 5. **A dismissing press is only a dismissal.** When `handler` answers `true` —
 *    it closed something — the rest of that gesture is swallowed: the
 *    `pointerdown` never reaches its target (so the sidebar's resizer does not
 *    start dragging), `mousedown` is default-prevented (focus stays where it
 *    was), and the `mouseup`, `click`, `dblclick`, `auxclick` and `contextmenu`
 *    behind it are cancelled. Without it the press that closed a menu also
 *    clicked whatever lay under the menu, and the repaint the close caused had
 *    already rebuilt that node under the pointer, so the outcome depended on a
 *    race. A handler that answers anything but `true` (a hover card, which is
 *    not a popover) leaves the press alone.
 *
 *    The swallow lasts one gesture. It ends a tick after `pointerup` /
 *    `pointercancel` — the browser dispatches the `click` in the same task —
 *    and a fresh `pointerdown` ends a stale one, so a press that never produced
 *    a click (a drag released elsewhere, a lost `pointerup`) cannot eat the next
 *    one.
 *
 * `dismissable` is the form to reach for: it also registers the popover for
 * Escape. A focused popover handles its own Escape, but focus falls to `<body>`
 * when a repaint destroys the focused node, and Escape then reaches the global
 * key handler, which used to read it as "interrupt the turn". The registry lets
 * that handler close what is open first.
 *
 * This does not replace the `focusout` and Escape exits; keyboard users never
 * generate a press at all.
 */

/** A popover's own subtree: a CSS selector, or a node when the anchor is persistent. */
export type DismissAnchor = string | HTMLElement

/**
 * The presses that dismiss. `pointerdown` first — the rest only matter when
 * something upstream ate it, which is the failure this list exists to survive.
 */
const PRESS_EVENTS = ['pointerdown', 'mousedown', 'contextmenu', 'click'] as const

/** What the rest of a swallowed gesture would have delivered. */
const SWALLOWED_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const

/** The gesture being swallowed, if any: one at a time, since there is one pointer. */
let swallowing: { readonly press: Event; end(): void } | undefined

function swallow(press: Event): void {
  press.stopPropagation()
  if (press.type === 'mousedown') press.preventDefault()
  if (swallowing) return
  const eat = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const release = (): void => {
    setTimeout(end, 0)
  }
  const end = (): void => {
    for (const type of SWALLOWED_EVENTS) document.removeEventListener(type, eat, true)
    document.removeEventListener('pointerup', release, true)
    document.removeEventListener('pointercancel', release, true)
    swallowing = undefined
  }
  for (const type of SWALLOWED_EVENTS) document.addEventListener(type, eat, true)
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  swallowing = { press, end }
}

/**
 * Calls `handler` for every press outside `keep`. Answer `true` when it closed
 * something, so the press is swallowed (point 5 above).
 */
export function onPressOutside(
  keep: readonly DismissAnchor[],
  handler: () => boolean | void,
): () => void {
  const selector = keep.filter((anchor): anchor is string => typeof anchor === 'string').join(',')
  const nodes = keep.filter((anchor): anchor is HTMLElement => typeof anchor !== 'string')

  const inside = (target: unknown): boolean => {
    for (const node of nodes) {
      if (target instanceof Node && node.contains(target)) return true
    }
    // `closest` walks up from the pressed node, so a press on a menu item's own
    // label — a text node's parent `<span>` — is still inside the menu.
    return selector !== '' && target instanceof Element && target.closest(selector) !== null
  }

  const listener = (event: Event): void => {
    if (swallowing && event.type === 'pointerdown' && swallowing.press !== event) swallowing.end()
    if (inside(event.target)) return
    const closed = handler() === true
    // Only the two presses that start a gesture can swallow it: `contextmenu` and
    // `click` are the fallbacks for a press something upstream ate, and a
    // keyboard-activated `click` must still reach its button.
    if (closed && (event.type === 'pointerdown' || event.type === 'mousedown')) swallow(event)
  }

  for (const type of PRESS_EVENTS) document.addEventListener(type, listener, true)
  return () => {
    for (const type of PRESS_EVENTS) document.removeEventListener(type, listener, true)
  }
}

/** A popover the window can close without knowing what it is. */
export interface Dismissable {
  /** On screen right now — not merely a state flag a hidden view left behind. */
  isOpen(): boolean
  /** Idempotent. */
  close(): void
}

/** Registration order, which is the stacking order: a later popover sits above an earlier one. */
const registry = new Set<Dismissable>()

/**
 * A popover that closes on a press outside `keep` and on Escape from anywhere
 * (`closeTopDismissable`). `isOpen` is what makes the press a swallowed
 * dismissal rather than a no-op.
 */
export function dismissable(keep: readonly DismissAnchor[], popover: Dismissable): () => void {
  registry.add(popover)
  const stop = onPressOutside(keep, () => {
    if (!popover.isOpen()) return false
    popover.close()
    return true
  })
  return () => {
    stop()
    registry.delete(popover)
  }
}

export function hasOpenDismissable(): boolean {
  for (const popover of registry) if (popover.isOpen()) return true
  return false
}

/** Closes the topmost open popover; false when none was open. */
export function closeTopDismissable(): boolean {
  for (const popover of [...registry].reverse()) {
    if (!popover.isOpen()) continue
    popover.close()
    return true
  }
  return false
}

/** For a screen that replaces the window's content: nothing may stay open behind it. */
export function closeAllDismissables(): void {
  for (const popover of [...registry]) if (popover.isOpen()) popover.close()
}
