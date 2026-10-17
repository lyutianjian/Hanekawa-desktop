import type { DiffRow, PreviewView } from '../model/diffRows.js'
import { fileBadge } from '../model/turnEdits.js'
import { el, replace } from './dom.js'
import { icon } from './icons.js'

/** Renders a `PreviewView` — a line diff with a gutter, or the message form. */
/**
 * A permission request's file preview: the diff, or the message a degraded
 * preview carries. No heading — the request's title and path block above it
 * already name the operation and the file.
 */
export function previewNode(view: PreviewView): HTMLElement {
  if (view.kind === 'message') return el('div', 'block', view.message)
  return diffNode(view.rows)
}

/**
 * The rows alone — the shared body under the permission preview and, since T13,
 * an editing tool's step. One diff look everywhere: the same gutters, the same
 * add/del paints, the same dashed elision rule.
 */
export function diffNode(rows: readonly DiffRow[]): HTMLElement {
  const diff = el('div', 'diff')
  replace(diff, ...rows.map(rowNode))
  return diff
}

function rowNode(row: DiffRow): HTMLElement {
  const node = el('div', `diff-row ${row.kind}`)
  // An elided row is not a line of the file: no gutter, and the elision itself
  // is a CSS dashed rule rather than a `⋯` glyph (§3 — no character states).
  if (row.kind === 'elided') {
    node.appendChild(el('span', 'rule'))
    node.appendChild(el('span', 'text', row.text))
    return node
  }
  node.appendChild(el('span', 'gutter', gutter(row)))
  node.appendChild(el('span', 'text', row.text))
  return node
}

function gutter(row: DiffRow): string {
  const left = row.oldLine === undefined ? '' : String(row.oldLine)
  const right = row.newLine === undefined ? '' : String(row.newLine)
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  return `${left.padStart(3)} ${right.padStart(3)} ${sign}`
}

/** The little extension tile in front of a file name: `TS`, `CSS`, or a page outline when there is none. */
export function fileBadgeNode(name: string): HTMLElement {
  const text = fileBadge(name)
  const badge = el('span', `file-badge${text.length > 2 ? ' wide' : ''}`, text.length > 0 ? text : undefined)
  badge.dataset.ext = text.toLowerCase()
  if (text.length === 0) badge.appendChild(icon('file'))
  badge.setAttribute('aria-hidden', 'true')
  return badge
}

/** `+12 −3`, green and red; nothing when an old capped patch left the counts short. */
export function diffStatNode(added: number | undefined, deleted: number | undefined): HTMLElement | undefined {
  if (added === undefined || deleted === undefined) return undefined
  return el('span', 'diff-stat', el('span', 'diff-stat-add', `+${added}`), el('span', 'diff-stat-del', `−${deleted}`))
}
