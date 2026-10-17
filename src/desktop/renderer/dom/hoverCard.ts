import { onPressOutside } from './dismiss.js'
import { el, reconcile } from './dom.js'
import { createPresence } from './presence.js'

/**
 * The app's own hover card: a title, a lead figure, key-value rows and a note.
 *
 * Drawn rather than left to the `title` attribute because the OS tooltip is
 * wrong twice over — it waits about a second before it appears (long enough to
 * read as "nothing there"), and it is painted by the platform, so it is the one
 * surface in the window that ignores the theme. Both readouts that carry a
 * breakdown — the context ring and the token counts — use this instead.
 *
 * The rows are kept by label: a card is rebuilt on every snapshot tick while a
 * turn streams, and replacing the node under the pointer is what makes a hover
 * card flicker.
 */
export interface HoverCardContent {
  readonly title: string
  /** The one figure the card leads with, beside the title. */
  readonly lead?: string
  readonly rows: readonly (readonly [string, string])[]
  /** A caveat under a hairline. Absent means no rule and no line. */
  readonly note?: string
}

export interface HoverCard {
  readonly node: HTMLElement
  /** `undefined` takes the card away — there is nothing to say and hovering does nothing. */
  set(content: HoverCardContent | undefined): void
  /** Escape, or the anchor leaving the screen. */
  close(): void
  /** Closed with no outgoing animation — a pane switch must not paint over the next pane. */
  finish(): void
}

/**
 * Right-aligned to its anchor by default, a card is slid sideways just enough
 * to stay inside `#canvas`, which clips — a narrow canvas (the side panel open)
 * leaves too little room on either side. The left edge wins when neither fits.
 */
export function fitInCanvas(node: HTMLElement): void {
  node.style.setProperty('--canvas-shift', '0px')
  const canvas = node.closest('#canvas')?.getBoundingClientRect()
  if (!canvas) return
  const card = node.getBoundingClientRect()
  const margin = 8
  const shift = Math.max(canvas.left + margin - card.left, Math.min(0, canvas.right - margin - card.right))
  if (shift !== 0) node.style.setProperty('--canvas-shift', `${shift}px`)
}

/**
 * @param anchor the element hovering over which opens the card. It must be
 * positioned — the card is absolute inside it — and it becomes focusable, so
 * the keyboard reaches the same breakdown the pointer does.
 */
export function createHoverCard(anchor: HTMLElement, className = ''): HoverCard {
  const node = el('div', `hover-card ${className}`.trim())
  node.setAttribute('role', 'tooltip')
  node.setAttribute('aria-hidden', 'true')
  const lead = el('strong', 'hover-card-lead')
  const title = el('span', 'hover-card-title')
  const rows = el('dl', 'hover-card-rows')
  const note = el('p', 'hover-card-note')
  const kept = new Map<string, { row: HTMLElement; value: HTMLElement }>()

  let content: HoverCardContent | undefined
  let hovered = false
  let focused = false
  const presence = createPresence(node, { decorative: true })
  const sync = (): void => {
    const open = content !== undefined && (hovered || focused)
    const opening = open && presence.phase === 'closed'
    presence.set(open)
    if (opening) place()
  }
  const place = (): void => fitInCanvas(node)
  const close = (): void => {
    hovered = false
    focused = false
    sync()
  }

  anchor.tabIndex = 0
  anchor.addEventListener('mouseenter', () => { hovered = true; sync() })
  anchor.addEventListener('mouseleave', () => { hovered = false; sync() })
  anchor.addEventListener('focusin', () => { focused = true; sync() })
  // A null `relatedTarget` is the window losing focus, not the user leaving.
  anchor.addEventListener('focusout', (event) => {
    if (event.relatedTarget === null) return
    focused = false
    sync()
  })
  onPressOutside([anchor], close)
  anchor.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
  })

  return {
    node,
    set(next) {
      content = next
      if (!next) {
        close()
        presence.finish()
        return
      }
      title.textContent = next.title
      lead.textContent = next.lead ?? ''
      reconcile(
        rows,
        next.rows.map(([label, value]) => {
          let row = kept.get(label)
          if (!row) {
            const field = el('dd', 'hover-card-value')
            row = {
              row: el('div', 'hover-card-row', el('dt', 'hover-card-label', label), field),
              value: field,
            }
            kept.set(label, row)
          }
          if (row.value.textContent !== value) row.value.textContent = value
          return row.row
        }),
      )
      if (next.note) note.textContent = next.note
      reconcile(node, [
        el('div', 'hover-card-header', title, lead),
        rows,
        ...(next.note ? [note] : []),
      ])
      sync()
    },
    close,
    finish() {
      close()
      presence.finish()
    },
  }
}
