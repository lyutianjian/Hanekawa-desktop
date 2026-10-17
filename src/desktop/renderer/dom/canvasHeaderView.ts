import type { CanvasHeaderMenuItem, CanvasHeaderView } from '../model/canvasHeader.js'
import { renameCommit } from '../model/canvasHeader.js'
import { append, el, reconcile, show } from './dom.js'
import { button } from './controls.js'
import { dismissable } from './dismiss.js'
import { followPointer, rovingFocus } from './focus.js'
import { createPresence } from './presence.js'

/**
 * The canvas header bar: session identity on the left, "open in editor" on the
 * right (`design_guidance.md` 三.1, minus the two items with no backend).
 *
 * Two things here are load-bearing rather than tidy:
 *
 * 1. **The rename input is a persistent node.** This header repaints on every
 *    `onShellChanged`, which includes every snapshot tick of a streaming turn —
 *    a field rebuilt inside `replace()` would lose the caret, and its value,
 *    mid-word. Same shape as the sidebar's search box (5b) and the settings
 *    screen's (5f): built once, moved in and out of the flow, and written back
 *    exactly once — on the idle→renaming transition.
 * 2. **The `⋯` menu closes three ways**: a press outside the menu itself
 *    (`dom/dismiss.ts`), focus leaving the header, and Escape. The first is what
 *    makes the other two enough — this header repaints the trigger out from
 *    under the click that opened the menu, so by the user's next click there is
 *    nothing focused inside to fire a `focusout` at all. Opening the menu also
 *    moves focus onto its first item, which is what puts the keyboard back in it.
 */

export interface CanvasHeaderDom {
  render(view: CanvasHeaderView): void
}

export interface CanvasHeaderActions {
  onToggleMenu: () => void
  onCloseMenu: () => void
  onMenuItem: (id: CanvasHeaderMenuItem['id']) => void
  /** The committed title, already trimmed and known to differ from the current one. */
  onRename: (title: string) => void
  onCancelRename: () => void
  onOpenLocation: () => void
  /** 「← 协调」 on a thread session. Optional so callers that have no coordination compile unchanged. */
  onBackToCoordinator?: () => void
  /** 停止 on a thread session that a stop applies to. */
  onStopThread?: () => void
}

export function createCanvasHeaderView(
  container: HTMLElement,
  actions: CanvasHeaderActions,
): CanvasHeaderDom {
  // Built once. `titleInput` is an `<input>` rather than `controls.ts`'s
  // `textField()` because that helper commits on `change` *and* on Enter, and
  // this one must also be cancellable with Escape — which `textField` leaves to
  // its container, and this container's Escape belongs to the menu.
  const titleInput = el('input', 'canvas-title-input')
  titleInput.type = 'text'
  titleInput.setAttribute('aria-label', '会话标题')
  const identity = el('div', 'canvas-identity')
  const rightControls = el('div', 'canvas-header-controls')
  append(container, [identity, rightControls])
  const title = el('span', 'canvas-title')
  const trigger = button('canvas-menu-trigger', '⋯', '会话操作', actions.onToggleMenu)
  trigger.setAttribute('aria-haspopup', 'menu')
  const menu = el('div', 'canvas-menu')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '会话操作')
  menu.hidden = true
  const menuPresence = createPresence(menu, { direction: 'drop' })
  const menuShell = el('div', 'canvas-menu-shell', trigger, menu)
  const menuItems = new Map<CanvasHeaderMenuItem['id'], { node: HTMLButtonElement; label: HTMLElement }>()
  const locationLabel = el('span', 'btn-label')
  const openLocation = button('canvas-open-location', '', '', actions.onOpenLocation, { icon: 'external' })
  openLocation.appendChild(locationLabel)
  // The thread crumb is persistent for the same reason the title input is: it
  // repaints with every snapshot. Its parts are built once and only updated.
  const crumb = el('div', 'canvas-breadcrumb')
  const backLabel = el('span', 'btn-label')
  const backButton = button('canvas-back-coordinator', '', '返回协调会话', () => actions.onBackToCoordinator?.())
  backButton.appendChild(backLabel)
  const crumbThread = el('span', 'canvas-breadcrumb-thread')
  const crumbStatus = el('span', 'canvas-status')
  const crumbSep = el('span', 'canvas-breadcrumb-sep', '·')
  const stopButton = button('canvas-stop-thread', '停止', '停止线程', () => actions.onStopThread?.())
  crumb.setAttribute('aria-label', '协调路径')
  let lastSignature: string | undefined

  /** The title the input was seeded from, so a no-op commit sends nothing. */
  let seededTitle: string | undefined
  /** Whether the last paint drew the menu, so focus moves on the edge only. */
  let menuWasOpen = false
  /** The current menu's first item; where the keyboard lands on opening. */
  let firstMenuItem: HTMLElement | undefined
  /**
   * Where focus goes when the item holding it is replaced by the next step of the
   * menu — the confirmation's first item is the destructive one, so it is the
   * non-danger item (取消), never the first.
   */
  let safeMenuItem: HTMLElement | undefined

  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      actions.onCancelRename()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    commit()
  })
  // Blur commits, matching `textField()`: leaving a field the user typed into
  // must not silently discard it. `renameCommit` is what makes that safe — an
  // unchanged or empty title resolves to "nothing to send".
  titleInput.addEventListener('blur', () => commit())

  // The menu's three exits. The press is scoped to the menu and its trigger,
  // *not* to the header: pressing the session title or 打开位置 beside an open
  // menu is "somewhere else" as far as the user is concerned, and a header-wide
  // scope left it standing there. The trigger stays inside so a press on the `⋯`
  // of an open menu reaches `onToggleMenu` as a close, instead of being closed
  // here and re-opened by the click that follows.
  //
  // Scoped to the persistent menu and its trigger, never the entire header.
  dismissable(['.canvas-menu', '.canvas-menu-trigger'], {
    isOpen: () => menuWasOpen,
    close: () => actions.onCloseMenu(),
  })
  menuShell.addEventListener('keydown', (event) => rovingFocus(
    event,
    Array.from(menu.children) as HTMLElement[],
    menuWasOpen,
    actions.onToggleMenu,
  ))
  followPointer(menu, '.canvas-menu-item')
  container.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    // `null` is focus going *nowhere*, which is this view's own repaint and not
    // the user leaving — the guard `sidebarView.ts` and `titleBarView.ts` each
    // spell out, and the one this header was missing. Without it the menu shut
    // itself in the act of opening: the paint that draws it destroys the trigger
    // the mouse is on, and the `firstMenuItem.focus()` below then fires a
    // `focusout` with no destination, *from inside `render()`*. That re-entered
    // `render()` with `menuOpen: false` — and the outer paint, still running,
    // then wrote its own menu-bearing subtree over the closed one. The menu
    // stayed on screen with the flag already false, so every later dismissal hit
    // `closeHeaderMenu`'s early return and only choosing an item could close it.
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    actions.onCloseMenu()
  })
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menuWasOpen) return
    // The rename field has its own Escape and stops propagation, so reaching
    // here means this press belongs to the open menu. Consume it before the
    // synchronous close: the shell must not also interrupt a streaming turn.
    event.preventDefault()
    event.stopPropagation()
    actions.onCloseMenu()
  })

  function commit(): void {
    const next = renameCommit(seededTitle ?? '', titleInput.value)
    if (next === undefined) {
      actions.onCancelRename()
      return
    }
    actions.onRename(next)
  }

  return {
    render(view) {
      const signature = JSON.stringify(view)
      if (signature === lastSignature) return
      lastSignature = signature
      show(container, view.visible)
      if (!view.visible) {
        // The subtree goes, not just the visibility: an empty window has no
        // session to name, and a stale title would be the last one it had.
        reconcile(identity, [])
        reconcile(rightControls, [])
        menuPresence.set(false, true)
        seededTitle = undefined
        menuWasOpen = false
        firstMenuItem = undefined
        safeMenuItem = undefined
        return
      }

      trigger.setAttribute('aria-expanded', view.menuOpen ? 'true' : 'false')
      const heldMenuFocus = view.menuOpen && menu.contains(document.activeElement)
      if (view.menuOpen) updateMenu(view.menuItems)
      const lostMenuFocus = heldMenuFocus && !menu.contains(document.activeElement)
      const returnFocus = !view.menuOpen && menu.contains(document.activeElement)
      menuPresence.set(view.menuOpen)
      if (title.textContent !== view.title) title.textContent = view.title
      // The field floats over the title instead of replacing it: the title keeps
      // its width, so the menu trigger and everything right of it stay put.
      identity.classList.toggle('renaming', view.renaming)
      const shown = view.breadcrumb ? crumb : title
      reconcile(identity, view.renaming ? [shown, titleInput, menuShell] : [shown, menuShell])

      const startingRename = view.renaming && seededTitle === undefined
      if (view.renaming) {
        // Written back exactly once, on the transition: a repaint mid-typing
        // would otherwise reset the field to the title on disk.
        if (seededTitle === undefined) {
          seededTitle = view.title
          titleInput.value = view.title
        }
      } else {
        seededTitle = undefined
      }

      locationLabel.textContent = view.openLocationLabel
      openLocation.title = view.openLocationTitle
      openLocation.setAttribute('aria-label', view.openLocationTitle)
      reconcile(rightControls, [openLocation])

      // The crumb replaces the title, never the rename field: a rename is about
      // the session title, and the input has to be where the caret was put.
      if (view.breadcrumb) {
        const b = view.breadcrumb
        if (backLabel.textContent !== b.backLabel) backLabel.textContent = b.backLabel
        if (crumbThread.textContent !== b.threadTitle) crumbThread.textContent = b.threadTitle
        crumbStatus.textContent = b.statusLabel
        crumbStatus.className = `canvas-status tone-${b.tone}`
        reconcile(crumb, [backButton, crumbSep, crumbThread, crumbStatus, b.canStop ? stopButton : undefined])
      }

      // Last, after every node this paint owns is in the page — `focus()` is the
      // one call here that runs other people's code. It fires `focusout` on
      // whatever held the caret, synchronously, and a handler that repaints in
      // answer re-enters this function; anything written after that point would
      // land on top of the newer paint and leave the DOM ahead of the state.
      // Being last makes the re-entrant paint the one that survives, which is
      // the only ordering that cannot lie.
      //
      // On the closed→open transition only, the way the seed above is written
      // once: this header repaints on every snapshot of a streaming turn, and
      // re-focusing per tick would take the caret out of whatever the user moved
      // to. Without it the menu is opened by a click that destroys the button it
      // landed on, and the keyboard is left on `<body>` with a menu on screen.
      const opening = view.menuOpen && !menuWasOpen
      menuWasOpen = view.menuOpen
      if (opening) firstMenuItem?.focus()
      else if (startingRename) titleInput.focus()
      else if (lostMenuFocus) safeMenuItem?.focus()
      else if (returnFocus) trigger.focus()
    },
  }

  function updateMenu(items: readonly CanvasHeaderMenuItem[]): void {
    firstMenuItem = undefined
    safeMenuItem = undefined
    const nodes = items.map((item) => {
      let kept = menuItems.get(item.id)
      if (!kept) {
        const node = button('canvas-menu-item', '', item.label, () => actions.onMenuItem(item.id))
        node.setAttribute('role', 'menuitem')
        const label = el('span', 'btn-label')
        node.appendChild(label)
        kept = { node, label }
        menuItems.set(item.id, kept)
      }
      kept.node.classList.toggle('danger', item.danger === true)
      kept.node.title = item.label
      kept.node.setAttribute('aria-label', item.label)
      if (kept.label.textContent !== item.label) kept.label.textContent = item.label
      firstMenuItem ??= kept.node
      if (item.danger !== true) safeMenuItem ??= kept.node
      return kept.node
    })
    reconcile(menu, nodes)
    for (const id of menuItems.keys()) {
      if (!items.some((item) => item.id === id)) menuItems.delete(id)
    }
  }
}
