import { rewindActionToIntent } from '../model/rewindPanel.js'
import type { RewindIntent, RewindViewModel } from '../model/rewindPanel.js'
import { el, replace } from './dom.js'
import { createModalPresence } from './presence.js'
import { actionBar } from './actionBar.js'
import { focusByKey, heldFocusKey, trapTab } from './focus.js'

/**
 * The `/rewind` panel: a checkpoint list, then a confirm screen.
 *
 * Modal, drawn into its own container over the lane's canvas. A blocking
 * request that arrives while this is open is a card in the composer, which
 * stays above it.
 *
 * Every decision is already made in the view model. Rows and options are
 * clickable and hand back a `RewindIntent`, the same shape the key map produces,
 * so `app.ts` has one code path for both (`sidebarView.ts` does this too) — the
 * backdrop press below included, which is Escape with a mouse.
 *
 * No `innerHTML`, and **no markdown**: a checkpoint label is the user's own
 * message, and this dialog is asking them to confirm destroying work. It shows
 * the bytes, the way the permission dialog's command block does.
 *
 * Focus moves in on open and goes back where it came from on close, the way the
 * settings dialog does it: the panel used to open with focus still in the
 * composer behind the scrim, so a screen reader announced nothing and Tab walked
 * the hidden page. The keys still route here through the window keymap — focus
 * inside the layer is one of the places `ownedByTarget` gives them to the panel.
 * The checkpoint list is one focus stop that names its cursor row through
 * `aria-activedescendant`, the same arrangement the sidebar uses.
 */
export interface RewindPanel {
  render(view: RewindViewModel): void
  hide(): void
  isOpen(): boolean
}

export type RewindActivate = (intent: RewindIntent) => void

export function createRewindView(
  container: HTMLElement,
  panel: HTMLElement,
  onIntent: RewindActivate,
): RewindPanel {
  const presence = createModalPresence(container, panel, () => {
    replace(panel)
    painted = undefined
  })
  panel.setAttribute('tabindex', '-1')
  container.addEventListener('keydown', (event) => trapTab(panel, event))
  let open = false
  /** Where focus was when the panel opened, handed back on close. */
  let returnTo: HTMLElement | undefined
  /** Mid-decision: files are being reverted or a summary generated. */
  let busy = false
  /**
   * The checkpoint list as last painted, keyed by everything but the cursor.
   * Arrowing moves only the cursor, so it moves two classes on kept nodes
   * rather than rebuilding the panel per key press.
   */
  let painted: { signature: string; list: HTMLElement; rows: HTMLElement[] } | undefined

  // The scrim, and only the scrim: `event.target === container` is what tells a
  // press on the backdrop from one that started inside the card and bubbled.
  // Same verdict as Escape, including its guard — `rewindKeyToIntent` refuses
  // everything while a decision is in flight, and a backdrop that closed anyway
  // would abandon a running restore.
  container.addEventListener('pointerdown', (event) => {
    if (event.target !== container) return
    if (!open || busy) return
    onIntent({ kind: 'close' })
  })

  return {
    render(view) {
      busy = view.busyLabel !== undefined
      const opening = !open
      if (opening) {
        const active = document.activeElement
        returnTo = active instanceof HTMLElement && !container.contains(active) ? active : undefined
      }
      // A repaint replaces the focused list; put focus back on its successor,
      // or on the panel when the screen it lived on is gone.
      const signature = view.screen === 'select'
        ? JSON.stringify({ ...view, rows: view.rows.map(({ selected: _selected, ...row }) => row) })
        : undefined
      if (!opening && painted !== undefined && signature === painted.signature) {
        moveCursor(painted, view)
        return
      }
      const held = heldFocusKey(panel)
      const holding = opening || held !== undefined || document.activeElement === panel
      const rows = view.screen === 'select' ? selectScreen(view, onIntent) : undefined
      painted = rows && signature !== undefined ? { signature, list: rows.list, rows: rows.nodes } : undefined
      replace(
        panel,
        el('h2', 'title', view.title),
        view.subtitle.length > 0 && el('div', 'subtitle', view.subtitle),
        view.error !== undefined && el('div', 'error', view.error),
        view.emptyMessage !== undefined && el('div', 'subtitle', view.emptyMessage),
        rows?.list ?? confirmScreen(view),
        // The same bar the blocking dialogs end with, and the same rule: a slot
        // resolves through `view.options`, so a button cannot pick a decision
        // the number key would not.
        actionBar(
          view.actions,
          (action) => onIntent(rewindActionToIntent(action, view)),
          // Where the cursor is, so Enter's target is visible. `-1` on the list
          // screen, whose bar is a single non-slot button.
          view.options.findIndex((option) => option.selected),
        ),
      )
      presence.set(true)
      open = true
      if (holding && !focusByKey(panel, held ?? ROWS_FOCUS_KEY) && document.activeElement !== panel) {
        panel.focus({ preventScroll: true })
      }
      rows?.cursor?.scrollIntoView({ block: 'nearest' })
    },

    hide() {
      // Execution/close intent is already handled; the exit owns only pixels.
      const restore = returnTo
      returnTo = undefined
      const active = document.activeElement
      const focusInside = active === null || active === document.body || container.contains(active) || panel.contains(active)
      open = false
      busy = false
      presence.set(false)
      // A node that left the page meanwhile ignores `focus()`, which is the
      // right answer: there is nothing to go back to.
      if (focusInside) restore?.focus({ preventScroll: true })
    },

    isOpen() {
      return open
    },
  }
}

const ROWS_FOCUS_KEY = 'rewind-rows'

function moveCursor(painted: { list: HTMLElement; rows: readonly HTMLElement[] }, view: RewindViewModel): void {
  let cursor: HTMLElement | undefined
  for (const [index, row] of view.rows.entries()) {
    const node = painted.rows[index]
    if (!node) continue
    node.classList.toggle('selected', row.selected)
    node.setAttribute('aria-selected', String(row.selected))
    if (row.selected) cursor = node
  }
  if (cursor) painted.list.setAttribute('aria-activedescendant', cursor.id)
  else painted.list.removeAttribute('aria-activedescendant')
  cursor?.scrollIntoView({ block: 'nearest' })
}

function selectScreen(
  view: RewindViewModel,
  onIntent: RewindActivate,
): { list: HTMLElement; cursor: HTMLElement | undefined; nodes: HTMLElement[] } {
  const list = el('div', 'rows')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', '检查点')
  list.setAttribute('tabindex', '0')
  list.dataset.focusKey = ROWS_FOCUS_KEY
  let cursor: HTMLElement | undefined
  const nodes: HTMLElement[] = []
  for (const [index, row] of view.rows.entries()) {
    const node = el('div', `row${row.selected ? ' selected' : ''}${row.isCurrent ? ' current' : ''}`)
    node.id = `rewind-row-${index}`
    if (row.selected) {
      list.setAttribute('aria-activedescendant', node.id)
      cursor = node
    }
    node.dataset.rowId = row.id
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', String(row.selected))
    node.appendChild(el('span', 'label', row.label))
    if (row.detail.length > 0) node.appendChild(el('span', 'value', row.detail))
    node.addEventListener('click', () => onIntent({ kind: 'select-row', id: row.id }))
    list.appendChild(node)
    nodes.push(node)
  }
  return { list, cursor, nodes }
}

function confirmScreen(view: RewindViewModel): HTMLElement {
  const body = el('div', 'confirm')
  body.appendChild(el('div', 'message', view.messagePreview))
  if (view.timeLabel.length > 0) body.appendChild(el('div', 'subtitle', view.timeLabel))
  body.appendChild(el('div', 'subtitle', view.codeEffect))

  if (view.busyLabel !== undefined) {
    // Options are withdrawn rather than disabled while a decision runs: the
    // panel is not accepting input at all, and leaving them clickable would say
    // otherwise. The view model empties `actions` for the same reason.
    body.appendChild(el('div', 'busy', view.busyLabel))
    return body
  }

  // The decisions themselves are the button bar below, not rows.
  if (view.warning !== undefined) body.appendChild(el('div', 'warning', view.warning))
  return body
}
