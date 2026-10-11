import type { WireUsageDay } from '../../shellProtocol.js'
import {
  USAGE_NO_MODELS,
  USAGE_RANGES,
  USAGE_TABS,
  usageCardView,
  type UsageCardView,
  type UsageTab,
} from '../model/usageCard.js'
import type { UsageRange } from '../model/usageStats.js'
import { button } from './controls.js'
import { el, replace } from './dom.js'

/**
 * The home page's usage card.
 *
 * Owns its own tab, range and data: switching either is renderer-local, and the
 * welcome view only tells it when fresh data has arrived. The two segmented
 * groups are built once so a focused button survives the repaint its own click
 * causes; only the body underneath is replaced.
 */
export interface UsageCardDom {
  element: HTMLElement
  /** `undefined` draws the skeleton; an array (possibly empty) draws the numbers. */
  setDays(days: readonly WireUsageDay[] | undefined): void
}

export function createUsageCard(now: () => Date = () => new Date()): UsageCardDom {
  let days: readonly WireUsageDay[] | undefined
  let tab: UsageTab = 'overview'
  let range: UsageRange = 'all'

  const body = el('div', 'usage-body')
  const segments: { active(): boolean; node: HTMLElement }[] = []
  const group = <T extends string>(
    label: string,
    options: readonly { id: T; label: string }[],
    current: () => T,
    set: (id: T) => void,
  ): HTMLElement => {
    const root = el('div', 'usage-segments')
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', label)
    for (const option of options) {
      const node = button('usage-segment', option.label, option.label, () => {
        set(option.id)
        paint()
      })
      segments.push({ active: () => current() === option.id, node })
      root.appendChild(node)
    }
    return root
  }
  const head = el(
    'div',
    'usage-head',
    group('统计视图', USAGE_TABS, () => tab, (id) => { tab = id }),
    group('统计范围', USAGE_RANGES, () => range, (id) => { range = id }),
  )
  const element = el('section', 'usage-card', head, body)
  element.setAttribute('aria-label', '使用统计')

  const overview = (view: UsageCardView): HTMLElement[] => [
    el('div', 'usage-cells', ...view.cells.map((cell) =>
      el('div', 'usage-cell', el('div', 'usage-value', cell.value), el('div', 'usage-label', cell.label)))),
    el('div', 'usage-heatmap', ...view.heatmap.map((column) =>
      el('div', 'usage-heat-col', ...column.map((cell) => {
        const node = el('span', `usage-heat level-${cell?.level ?? 0}${cell ? '' : ' future'}`)
        if (cell) node.title = cell.title
        return node
      })))),
    el('div', 'usage-footnote', view.footnote),
  ]

  const models = (view: UsageCardView): HTMLElement[] =>
    view.shares.length === 0
      ? [el('div', 'usage-empty', USAGE_NO_MODELS)]
      : [el('div', 'usage-shares', ...view.shares.map((share) => {
          const bar = el('progress', 'usage-share-bar')
          bar.setAttribute('max', '100')
          bar.setAttribute('value', String(share.width))
          return el(
            'div',
            'usage-share',
            el('div', 'usage-share-head',
              el('span', 'usage-share-model', share.model),
              el('span', 'usage-share-figures', `${share.tokens} · ${share.percent}`)),
            bar,
          )
        }))]

  function paint(): void {
    const view = usageCardView(days, tab, range, now())
    element.classList.toggle('loading', view.loading)
    for (const segment of segments) {
      const active = segment.active()
      segment.node.classList.toggle('active', active)
      segment.node.setAttribute('aria-pressed', String(active))
    }
    replace(body, ...(tab === 'overview' ? overview(view) : models(view)))
  }
  paint()

  return {
    element,
    setDays(next) {
      days = next
      paint()
    },
  }
}
