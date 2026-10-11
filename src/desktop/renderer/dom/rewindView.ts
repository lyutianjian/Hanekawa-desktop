import { rewindActionToIntent } from '../model/rewindPanel.js'
import type { RewindIntent, RewindViewModel } from '../model/rewindPanel.js'
import { el, replace } from './dom.js'
import { createModalPresence } from './presence.js'
import { actionBar } from './actionBar.js'

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
  const presence = createModalPresence(container, panel, () => replace(panel))
  let open = false
  /** Mid-decision: files are being reverted or a summary generated. */
  let busy = false

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
      replace(
        panel,
        el('div', 'title', view.title),
        view.subtitle.length > 0 && el('div', 'subtitle', view.subtitle),
        view.error !== undefined && el('div', 'error', view.error),
        view.emptyMessage !== undefined && el('div', 'subtitle', view.emptyMessage),
        view.screen === 'select' ? selectScreen(view, onIntent) : confirmScreen(view),
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
    },

    hide() {
      // Execution/close intent is already handled; the exit owns only pixels.
      open = false
      busy = false
      presence.set(false)
    },

    isOpen() {
      return open
    },
  }
}

function selectScreen(view: RewindViewModel, onIntent: RewindActivate): HTMLElement {
  const list = el('div', 'rows')
  list.setAttribute('role', 'listbox')
  for (const row of view.rows) {
    const node = el('div', `row${row.selected ? ' selected' : ''}${row.isCurrent ? ' current' : ''}`)
    node.dataset.rowId = row.id
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', String(row.selected))
    node.appendChild(el('span', 'label', row.label))
    if (row.detail.length > 0) node.appendChild(el('span', 'value', row.detail))
    node.addEventListener('click', () => onIntent({ kind: 'select-row', id: row.id }))
    list.appendChild(node)
  }
  return list
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
