import type { WireUsageDay } from '../../shellProtocol.js'
import { computeUsageStats, type UsageRange } from './usageStats.js'

export type UsageTab = 'overview' | 'models'

export const USAGE_TABS: readonly { id: UsageTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'models', label: '模型' },
]

export const USAGE_RANGES: readonly { id: UsageRange; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: '30d', label: '30 天' },
  { id: '7d', label: '7 天' },
]

export const USAGE_EMPTY = '—'
export const USAGE_NO_MODELS = '这段时间还没有使用记录'
/** The history could not be read: not the same thing as an empty one. */
export const USAGE_UNAVAILABLE = '无法读取使用统计'

export interface UsageCell {
  label: string
  value: string
}

export interface UsageHeatCellView {
  level: 0 | 1 | 2 | 3 | 4
  day: string
  tokens: string
  messages: string
}

export interface UsageShareView {
  model: string
  tokens: string
  percent: string
  /** 0-100, for the bar's width. */
  width: number
}

export interface UsageCardView {
  /** No data yet: the cells draw as skeletons. */
  loading: boolean
  /** The overview's one row of figures. */
  cells: UsageCell[]
  /** The model tab's extra facts, drawn above the shares; empty on the overview. */
  facts: UsageCell[]
  /** Columns are weeks, rows are weekdays; `null` is a day that has not happened. */
  heatmap: (UsageHeatCellView | null)[][]
  shares: UsageShareView[]
  footnote: string
}

/** 万 / 亿 with one decimal below 100 of the unit: 9,876 · 1.2 万 · 123 万 · 3.4 亿. */
export function formatTokens(count: number): string {
  const unit = (value: number, suffix: string): string => {
    const text = value < 100 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value).toLocaleString('en-US')
    return `${text} ${suffix}`
  }
  if (count >= 100_000_000) return unit(count / 100_000_000, '亿')
  if (count >= 10_000) return unit(count / 10_000, '万')
  return count.toLocaleString('en-US')
}

export function usageCardView(
  days: readonly WireUsageDay[] | undefined,
  tab: UsageTab,
  range: UsageRange,
  now: Date,
): UsageCardView {
  const stats = computeUsageStats(days ?? [], range, now)
  return {
    loading: days === undefined,
    cells: [
      { label: '总 token', value: formatTokens(stats.tokens) },
      { label: '会话数', value: String(stats.sessions) },
      { label: '活跃天数', value: String(stats.activeDays) },
    ],
    facts: tab === 'models'
      ? [
          { label: '高峰时段', value: stats.peakHour === null ? USAGE_EMPTY : `${stats.peakHour} 时` },
          { label: '常用模型', value: stats.topModel ?? USAGE_EMPTY },
        ]
      : [],
    heatmap: stats.heatmap.map((column) =>
      column.map((cell) => (cell
        ? { level: cell.level, day: cell.day, tokens: formatTokens(cell.tokens), messages: String(cell.turns) }
        : null)),
    ),
    shares: tab === 'models'
      ? stats.modelShares.map((share) => ({
          model: share.model,
          tokens: formatTokens(share.tokens),
          percent: `${Math.round(share.share * 100)}%`,
          width: Math.max(share.share * 100, 1),
        }))
      : [],
    footnote: `你用掉的 token 大约相当于 ${stats.books} 本《三体》`,
  }
}

/** What a heatmap day reads as to a screen reader, and on its keyboard tip. */
export function heatCellLabel(cell: UsageHeatCellView): string {
  return `${cell.day}：${cell.tokens} token，${cell.messages} 条消息`
}

/**
 * Where an arrow key moves the heatmap's one focusable day.
 *
 * Columns are weeks and rows weekdays, so ←/→ step a week and ↑/↓ a day; Home
 * and End go to the first and last day that happened. Days that have not
 * happened (`null`) are skipped over, never landed on. `undefined` means the
 * key is not the heatmap's, or there is nowhere to go.
 */
export function heatStep(
  grid: readonly (readonly (UsageHeatCellView | null)[])[],
  at: { col: number; row: number },
  key: string,
): { col: number; row: number } | undefined {
  const days: { col: number; row: number }[] = []
  grid.forEach((column, col) => column.forEach((cell, row) => { if (cell) days.push({ col, row }) }))
  if (days.length === 0) return undefined
  if (key === 'Home') return days[0]
  if (key === 'End') return days[days.length - 1]
  const delta = key === 'ArrowLeft' ? [-1, 0] : key === 'ArrowRight' ? [1, 0] : key === 'ArrowUp' ? [0, -1] : key === 'ArrowDown' ? [0, 1] : undefined
  if (!delta) return undefined
  let { col, row } = at
  for (;;) {
    col += delta[0]!
    row += delta[1]!
    const column = grid[col]
    if (!column || row < 0 || row >= column.length) return undefined
    if (column[row]) return { col, row }
  }
}
