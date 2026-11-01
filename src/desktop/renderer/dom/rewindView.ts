import { rewindActionToIntent } from '../model/rewindPanel.js'
import type { RewindIntent, RewindViewModel } from '../model/rewindPanel.js'
import { el, replace } from './dom.js'
import { createModalPresence } from './presence.js'
import { actionBar } from './actionBar.js'
import { focusByKey, heldFocusKey, trapTab } from './focus.js'
import { pillSelect } from './controls.js'
import { onPressOutside } from './dismiss.js'
import { icon } from './icons.js'

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
  container.addEventListener('keydown', (event) => {
    trapTab(panel, event)
    const target = event.target
    // Buttons keep their own activation keys; Tab stays in the modal.
    if (event.key === 'Tab' || target instanceof HTMLElement && (
      target.tagName.toLowerCase() === 'button' && (event.key === 'Enter' || event.key === ' ')
    )) event.stopPropagation()
  })
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
  let disposeRange: (() => void) | undefined

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
      disposeRange?.()
      const rows = view.screen === 'select' ? selectScreen(view, onIntent) : undefined
      const confirm = rows === undefined ? confirmScreen(view, onIntent) : undefined
      disposeRange = confirm?.dispose
      painted = rows && signature !== undefined ? { signature, list: rows.list, rows: rows.nodes } : undefined
      panel.dataset.screen = view.screen
      const bar = actionBar(view.actions, (action) => onIntent(rewindActionToIntent(action, view)))
      for (const node of bar.querySelectorAll<HTMLElement>('button')) {
        node.dataset.focusKey = node.classList.contains('primary') ? 'rewind-confirm' : 'rewind-cancel'
      }
      replace(
        panel,
        el('h2', 'title', view.title),
        view.subtitle.length > 0 && el('div', 'subtitle', view.subtitle),
        view.error !== undefined && el('div', 'error', view.error),
        view.emptyMessage !== undefined && el('div', 'subtitle', view.emptyMessage),
        rows?.list ?? confirm?.body,
        bar,
      )
      presence.set(true)
      open = true
      const initialFocus = view.screen === 'select' ? ROWS_FOCUS_KEY : RANGE_FOCUS_KEY
      if (holding && !focusByKey(panel, held ?? initialFocus) && !focusByKey(panel, initialFocus) && document.activeElement !== panel) {
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
      disposeRange?.()
      disposeRange = undefined
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
const RANGE_FOCUS_KEY = 'rewind-range'

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

function confirmScreen(view: RewindViewModel, onIntent: RewindActivate): { body: HTMLElement; dispose(): void } {
  const body = el('div', 'confirm')
  const message = el('div', 'checkpoint-message', el('div', 'message', view.messagePreview))
  message.title = `${view.messagePreview}${view.timeLabel ? ` · ${view.timeLabel}` : ''}`
  body.appendChild(message)
  const selected = view.options.find((option) => option.selected)!
  const range = el('div', 'settings-menu-shell rewind-range')
  let rangeOpen = false
  function setRangeOpen(open: boolean): void {
    rangeOpen = open
    pillSelect({
      ariaLabel: '操作范围',
      value: selected.decision,
      choices: view.options.map((option) => ({ value: option.decision, label: option.label })),
      enabled: view.busyLabel === undefined,
      open,
      onToggle: () => setRangeOpen(!rangeOpen),
      onFirstItem: (item) => {
        range.querySelector<HTMLElement>('.settings-menu')?.scrollIntoView({ block: 'nearest' })
        ;(range.querySelector<HTMLElement>('.active') ?? item).focus({ preventScroll: true })
      },
      onCloseFocus: (trigger) => trigger.focus({ preventScroll: true }),
      onChange: (value) => {
        setRangeOpen(false)
        const option = view.options.find((entry) => entry.decision === value)
        if (option) onIntent({ kind: 'focus-option', decision: option.decision })
      },
    }, range)
    if (open) range.querySelector('.active')?.appendChild(icon('check', 'icon rewind-range-check'))
  }
  setRangeOpen(false)
  const trigger = range.querySelector<HTMLButtonElement>('button')!
  trigger.id = 'rewind-range'
  trigger.dataset.focusKey = RANGE_FOCUS_KEY
  trigger.setAttribute('aria-describedby', 'rewind-description')
  const stopOutside = onPressOutside([range], () => {
    if (!rangeOpen) return false
    setRangeOpen(false)
    return true
  })
  range.addEventListener('focusout', (event) => {
    if (!rangeOpen || event.relatedTarget === null) return
    if (event.relatedTarget instanceof Node && range.contains(event.relatedTarget)) return
    setRangeOpen(false)
  })
  range.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && rangeOpen) {
      event.preventDefault()
      event.stopPropagation()
      setRangeOpen(false)
      trigger.focus()
      return
    }
    if (event.key === 'Tab' && rangeOpen) setRangeOpen(false)
    const option = view.options.find((entry) => entry.hotkey === event.key)
    if (!option || trigger.disabled) return
    event.preventDefault()
    event.stopPropagation()
    onIntent({ kind: 'focus-option', decision: option.decision })
  })
  const label = el('label', 'range-label', '操作范围')
  label.setAttribute('for', trigger.id)
  const description = el('div', 'range-description', selected.description)
  description.id = 'rewind-description'
  description.hidden = true
  body.appendChild(el('div', 'range-field', label, range, description))
  const changes = view.codeChanges
  const counts = el('div', 'code-count', view.codeEffect,
    changes && el('span', 'code-added', `+${changes.additions}`),
    changes && el('span', 'code-removed', `−${changes.deletions}`),
  )
  if (changes?.files) counts.title = changes.files
  body.appendChild(el('div', 'code-effect',
    counts,
    view.warning && el('div', 'warning', icon('info'), el('span', 'warning-text', view.warning)),
  ))
  if (view.busyLabel !== undefined) {
    const status = el('div', 'busy', icon('spinner'), el('span', '', view.busyLabel))
    status.setAttribute('role', 'status')
    body.appendChild(status)
  }
  return { body, dispose: stopOutside }
}
