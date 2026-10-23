import type { WireUsageDay } from '../../shellProtocol.js'
import {
  USAGE_NO_MODELS,
  USAGE_RANGES,
  USAGE_UNAVAILABLE,
  USAGE_TABS,
  heatCellLabel,
  heatStep,
  usageCardView,
  type UsageCardView,
  type UsageCell,
  type UsageHeatCellView,
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
  /** The read failed: the body says so, with 重试 — never zeros, which would read as an empty history. */
  setUnavailable(retry: () => void): void
}

export function createUsageCard(now: () => Date = () => new Date()): UsageCardDom {
  let days: readonly WireUsageDay[] | undefined
  let retry: (() => void) | undefined
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

  const cells = (className: string, list: readonly UsageCell[]): HTMLElement =>
    el('div', className, ...list.map((cell) =>
      el('div', 'usage-cell', el('div', 'usage-value', cell.value), el('div', 'usage-label', cell.label))))

  // One tip for the whole grid, moved onto the hovered day: the OS `title`
  // tooltip waits about a second and ignores the theme (see `hoverCard.ts`).
  const tipDay = el('span', 'usage-tip-day')
  const tipTokens = el('strong', 'usage-tip-tokens')
  const tipMessages = el('span', 'usage-tip-messages')
  const tip = el('div', 'usage-tip', tipDay, tipTokens, tipMessages)
  tip.setAttribute('role', 'tooltip')
  const showTip = (node: HTMLElement, cell: UsageHeatCellView): void => {
    tipDay.textContent = cell.day
    tipTokens.textContent = `${cell.tokens} token`
    tipMessages.textContent = `${cell.messages} 条消息`
    const from = body.getBoundingClientRect()
    const at = node.getBoundingClientRect()
    tip.style.setProperty('--usage-tip-x', `${at.left - from.left + at.width / 2}px`)
    tip.style.setProperty('--usage-tip-y', `${at.top - from.top}px`)
    tip.classList.add('open')
  }
  const hideTip = (): void => { tip.classList.remove('open') }

  const overview = (view: UsageCardView): HTMLElement[] => {
    // One Tab stop for the whole grid, on today; the arrows walk it (see
    // `heatStep`) and the focused day shows the same tip as a hovered one.
    const nodes: (HTMLElement | undefined)[][] = []
    let current: { col: number; row: number } | undefined
    const heatmap = el('div', 'usage-heatmap', ...view.heatmap.map((column, col) => {
      nodes[col] = []
      return el('div', 'usage-heat-col', ...column.map((cell, row) => {
        const node = el('span', `usage-heat level-${cell?.level ?? 0}${cell ? '' : ' future'}`)
        if (cell && !view.loading) {
          node.addEventListener('mouseenter', () => showTip(node, cell))
          node.setAttribute('role', 'img')
          node.setAttribute('aria-label', heatCellLabel(cell))
          node.tabIndex = -1
          node.addEventListener('focus', () => showTip(node, cell))
          node.addEventListener('blur', hideTip)
          nodes[col]![row] = node
          current = { col, row }
        }
        return node
      }))
    }))
    if (current) nodes[current.col]![current.row]!.tabIndex = 0
    heatmap.addEventListener('keydown', (event) => {
      if (!current) return
      const next = heatStep(view.heatmap, current, event.key)
      if (!next) return
      event.preventDefault()
      event.stopPropagation()
      nodes[current.col]![current.row]!.tabIndex = -1
      current = next
      const node = nodes[next.col]![next.row]!
      node.tabIndex = 0
      node.focus()
    })
    heatmap.addEventListener('mouseleave', hideTip)
    if (!view.loading) {
      heatmap.setAttribute('role', 'group')
      heatmap.setAttribute('aria-label', '每日用量，方向键逐日查看')
    }
    return [cells('usage-cells', view.cells), heatmap, el('div', 'usage-footnote', view.footnote), tip]
  }

  const models = (view: UsageCardView): HTMLElement[] =>
    view.shares.length === 0
      ? [el('div', 'usage-empty', USAGE_NO_MODELS)]
      : [cells('usage-facts', view.facts), el('div', 'usage-shares', ...view.shares.map((share) => {
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
    element.classList.toggle('loading', view.loading && retry === undefined)
    for (const segment of segments) {
      const active = segment.active()
      segment.node.classList.toggle('active', active)
      segment.node.setAttribute('aria-pressed', String(active))
    }
    hideTip()
    if (retry !== undefined) {
      replace(body, el('div', 'usage-empty', USAGE_UNAVAILABLE, button('usage-retry', '重试', '重新读取使用统计', retry)))
      return
    }
    replace(body, ...(tab === 'overview' ? overview(view) : models(view)))
  }
  paint()

  return {
    element,
    setDays(next) {
      days = next
      retry = undefined
      paint()
    },
    setUnavailable(onRetry) {
      days = undefined
      retry = onRetry
      paint()
    },
  }
}
