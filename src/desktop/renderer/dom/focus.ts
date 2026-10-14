/**
 * Keyboard-focus helpers shared by the menus and the modal layers.
 */

/**
 * Arrow/Home/End movement across an open menu's items. Shared by every dropdown
 * and popover, which differ only in what a click does.
 *
 * Disabled items cannot take focus, so callers pass the enabled ones.
 */
export function rovingFocus(
  event: KeyboardEvent,
  items: readonly HTMLElement[],
  open: boolean,
  onOpen: () => void,
): void {
  const { key } = event
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
  if (!open) {
    // ArrowDown only opens: the menu does not exist yet, so focusing its first
    // item waits for the render this toggle causes. The trigger this keydown came
    // from is *replaced* by that render in some views, so focus would otherwise
    // fall to `<body>` and every later arrow key would miss the menu's listener.
    if (key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    onOpen()
    return
  }
  if (items.length === 0) return
  // `event.target` rather than `document.activeElement`: the keydown fires on
  // the focused item and bubbles here, so the target *is* the position.
  const at = items.indexOf(event.target as HTMLElement)
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : at < 0
          ? key === 'ArrowDown'
            ? 0
            : items.length - 1
          : (at + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  event.preventDefault()
  event.stopPropagation()
  items[next]?.focus()
}

/**
 * Moves focus to the menu item under a moving pointer.
 *
 * A menu has two ways to point at a row, the pointer and the arrow keys, and
 * they used to paint two highlights: a resting pointer kept its `:hover` fill
 * while the keyboard moved on. With the pointer carrying focus, the row under it
 * *is* the focused one, and the stylesheet's `:has(:focus-visible)` rule keeps a
 * resting pointer from painting beside a keyboard row. `mousemove`, not
 * `mouseenter`: a pointer resting on a row that the keyboard left must be able to
 * take it back with the slightest movement.
 */
export function followPointer(menu: HTMLElement, item: string): void {
  menu.addEventListener('mousemove', (event) => {
    const target = event.target
    const row = target instanceof Element ? target.closest(item) : null
    if (!(row instanceof HTMLElement) || row === document.activeElement) return
    if ((row as HTMLButtonElement).disabled) return
    row.focus({ preventScroll: true })
  })
}

/**
 * Keeps Tab inside a modal layer: forward from the last control wraps to the
 * first, backward from the first wraps to the last, and focus that is on the
 * layer itself or has strayed outside it is pulled onto a control.
 */
export function trapTab(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const stops = Array.from(container.querySelectorAll<HTMLElement>('button, [tabindex]'))
    .filter((node) => !(node as HTMLButtonElement).disabled && node.getAttribute('tabindex') !== '-1')
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return
  }
  const at = document.activeElement
  const outside = at === container || !container.contains(at)
  if (event.shiftKey ? at === first || outside : at === last || outside) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}

/**
 * Focus survival across a repaint that rebuilds the focused node.
 *
 * Chromium fires no `blur` for a focused node that is *removed*; focus is simply
 * back on `<body>`, where the next Escape reaches the global key handler. A view
 * that rebuilds controls tags them with `data-focus-key`, reads
 * {@link heldFocusKey} before the repaint and, if focus was lost, puts it back
 * with {@link focusByKey} on the node that took the old one's place.
 */
export function heldFocusKey(root: HTMLElement): string | undefined {
  const active = document.activeElement
  return active instanceof HTMLElement && root.contains(active) ? active.dataset.focusKey : undefined
}

/** Focuses the descendant of `root` tagged `key`; false when the repaint dropped it. */
export function focusByKey(root: HTMLElement, key: string): boolean {
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.dataset.focusKey === key) {
      child.focus()
      return true
    }
    if (focusByKey(child, key)) return true
  }
  return false
}
