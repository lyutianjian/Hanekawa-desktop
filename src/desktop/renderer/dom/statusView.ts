import type { SessionControllerSnapshot } from '../../../runtime/sessionController.js'
import {
  statusUsageView,
  type StatusUsageView,
  type UsageMetric,
  type UsageRateView,
} from '../model/usage.js'
import { el, replace } from './dom.js'
import { createHoverCard } from './hoverCard.js'
import { icon, type IconName } from './icons.js'

/**
 * The status bar: what the session has spent; the hover adds what it cost.
 *
 * Split out of `composerView.ts` in 4e, when the composer grew its action bar
 * and the one file stopped being one thing. Three fields have since left it,
 * all for the same reason — one field, one place, or they drift:
 *
 * - the model, to the composer's chip beside the effort level it is read with;
 * - the permission mode (5e), to the composer's pill, beside the message it
 *   governs; and the session name, to the canvas header, which owns identity;
 * - the 生成中 label, to nowhere: the transcript and the stop button both say a
 *   turn is running, and this strip is for the numbers.
 *
 * `document.title` still happens here rather than in the header: it means "a
 * `hello()` came back" only as long as it is written on the pane's path rather
 * than off the lane list.
 */

export interface StatusView {
  render(snapshot: SessionControllerSnapshot): void
  renderSession(session: { id: string; title?: string; messageCount?: number }): void
}

export function createStatusView(els: {
  usage: HTMLElement
}): StatusView {
  /** The last title written. `renderSession` runs on every snapshot tick. */
  let lastTitle: string | undefined
  /**
   * The last readout painted, keyed by the hover's full text: the chips
   * abbreviate, so a cost or an exact count can move while they read the same.
   * `render` is reached from the snapshot tick — an unguarded repaint would
   * rebuild four elements and three SVGs per streamed chunk.
   */
  let lastUsage: string | undefined
  // The split — input, cache writes, cache hits, output and both rates — in the
  // app's own hover card rather than in a `title` attribute, which appears about
  // a second late and is painted by the OS in a style nothing here controls.
  const card = createHoverCard(els.usage, 'usage-card')
  return {
    render(snapshot) {
      // No 生成中 field: it said what the transcript above it was already
      // saying, in the one place on screen reserved for what the turn cost —
      // and the readout beside it moves per completed request now
      // (`SessionController.handleRequestUsage`), so the strip is live during a
      // turn without a label announcing that it is.
      //
      // One total and a rate: `model/usage.ts` owns which numbers and how they
      // read. The hover carries the split unabbreviated, and so does the
      // accessible name — the chip on screen is a glyph plus a figure, which is
      // not a sentence a screen reader can make sense of. Both halves of the
      // usage go in: the count is the session's, the rate the last request's.
      const usage = statusUsageView(snapshot.usage.total, snapshot.usage.lastRequest)
      if (usage.title !== lastUsage) {
        lastUsage = usage.title
        if (usage.text) {
          card.set({
            title: '本会话累计',
            lead: usage.metrics[0]?.value ?? '',
            rows: usage.breakdown.map((row) => [row.label, row.value] as const),
            note: [usage.costNote, '本轮命中是最近一次请求；会话累计的分母是输入 + 写入 + 命中'].filter(Boolean).join('。'),
          })
          // The card rides inside the readout, so it is part of what `replace`
          // writes — and it is left out while the line is empty.
          replace(els.usage, ...usageChips(usage), card.node)
          els.usage.setAttribute('aria-label', `${usage.text}。${usage.title.replace(/\n/g, '；')}`)
        } else {
          card.set(undefined)
          replace(els.usage)
          els.usage.removeAttribute('aria-label')
        }
      }
    },

    renderSession(session) {
      const name = session.title ?? session.id
      // The window title is also the desktop shell's end-to-end proof: it is only
      // set after `hello()` returns, so reading it from outside the process shows
      // the whole chain worked.
      const title = `Hanekawa — ${name}`
      // Written only when it moved: this is reached from the snapshot tick, so
      // an unguarded assignment is a document-title write per streamed chunk.
      if (title === lastTitle) return
      lastTitle = title
      document.title = title
    },
  }
}

/** One glyph per count, keyed by kind so the model never names a drawing. */
const METRIC_ICONS: Record<UsageMetric['kind'], IconName> = {
  total: 'database',
}

/**
 * The chips with `·` between them.
 *
 * The separator is a node rather than a flex gap because the two fields either
 * side of it are different kinds of thing — an absolute count and a ratio — and
 * whitespace alone reads as one run of figures. It is the same `·` the
 * accessible `text` joins with, so the line sounds like it looks.
 */
function usageChips(usage: StatusUsageView): (HTMLElement | undefined)[] {
  const chips: HTMLElement[] = usage.metrics.map(metricChip)
  if (usage.rate) chips.push(rateChip(usage.rate))
  return chips.flatMap((chip, index) => (index === 0 ? [chip] : [separator(), chip]))
}

function separator(): HTMLElement {
  const dot = el('span', 'usage-separator', '·')
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

/** A glyph and a figure. The label lives in the readout's accessible name. */
function metricChip(metric: UsageMetric): HTMLElement {
  return el(
    'span',
    `usage-metric ${metric.kind}`,
    icon(METRIC_ICONS[metric.kind], 'icon usage-glyph'),
    el('span', 'usage-value', metric.value),
  )
}

/**
 * The cache hit rate, written out.
 *
 * No mark: it was a swept ring, which is the context indicator's shape, and two
 * ratio dials of the same shape on one screen read as one idea repeated rather
 * than as two different numbers.
 */
function rateChip(rate: UsageRateView): HTMLElement {
  return el(
    'span',
    'usage-metric rate',
    el('span', 'usage-label', rate.label),
    el('span', 'usage-value', rate.percent),
  )
}
