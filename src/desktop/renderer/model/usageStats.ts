import type { WireUsageDay } from '../../shellProtocol.js'
import { modelName } from './modelNames.js'

export type UsageRange = 'all' | '30d' | '7d'

/** Roughly one volume of 《三体》: ~300k characters at ~1.3 tokens each. */
export const TOKENS_PER_BOOK = 400_000

const RANGE_DAYS: Record<UsageRange, number | null> = { all: null, '30d': 30, '7d': 7 }
/**
 * Heatmap width in weeks, whatever the range: enough to fill the widest card
 * (560px of 10px cells and 3px gaps). The stylesheet fixes the cell size and
 * clips from the left, so a narrower card simply shows fewer of them.
 */
const HEATMAP_WEEKS = 42

export interface UsageHeatCell {
  day: string
  turns: number
  tokens: number
  /** 0 (no activity) to 4, relative to the busiest day shown. */
  level: 0 | 1 | 2 | 3 | 4
}

export interface UsageModelShare {
  model: string
  tokens: number
  share: number
}

export interface UsageStats {
  sessions: number
  messages: number
  tokens: number
  activeDays: number
  /** Local hour 0-23 with the most turns; the earliest wins a tie. */
  peakHour: number | null
  /** The model with the most tokens; the first by name wins a tie. */
  topModel: string | null
  /** Columns are weeks (Sunday first), rows are weekdays; `null` is a day in the future. */
  heatmap: (UsageHeatCell | null)[][]
  modelShares: UsageModelShare[]
  /** Tokens expressed in books, to one decimal. */
  books: number
}

function dayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)
}

function heatmapOf(days: Map<string, WireUsageDay>, today: Date): UsageStats['heatmap'] {
  const weeks = HEATMAP_WEEKS
  const start = addDays(today, -today.getDay() - (weeks - 1) * 7)
  const columns: (UsageHeatCell | null)[][] = []
  let busiest = 0
  for (let week = 0; week < weeks; week += 1) {
    const column: (UsageHeatCell | null)[] = []
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(start, week * 7 + row)
      if (date > today) {
        column.push(null)
        continue
      }
      const key = dayKey(date)
      const entry = days.get(key)
      const turns = entry?.turns ?? 0
      busiest = Math.max(busiest, turns)
      column.push({ day: key, turns, tokens: entry?.tokens ?? 0, level: 0 })
    }
    columns.push(column)
  }
  for (const cell of columns.flat()) {
    if (cell && cell.turns > 0) cell.level = Math.ceil((cell.turns / busiest) * 4) as UsageHeatCell['level']
  }
  return columns
}

export function computeUsageStats(allDays: readonly WireUsageDay[], range: UsageRange, now: Date): UsageStats {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const span = RANGE_DAYS[range]
  const cutoff = span === null ? null : dayKey(addDays(today, 1 - span))
  const heatSource = new Map(allDays.map((day) => [day.day, day]))
  const days = allDays.filter((day) => cutoff === null || day.day >= cutoff)

  const hours = new Array<number>(24).fill(0)
  const models = new Map<string, number>()
  let sessions = 0
  let messages = 0
  let tokens = 0
  for (const day of days) {
    sessions += day.sessions
    messages += day.turns
    tokens += day.tokens
    day.hours.forEach((count, hour) => {
      hours[hour]! += count
    })
    for (const [id, count] of Object.entries(day.models)) {
      const model = modelName(id)
      models.set(model, (models.get(model) ?? 0) + count)
    }
  }

  const peak = Math.max(...hours)
  const modelShares = [...models]
    .map(([model, count]) => ({ model, tokens: count, share: tokens > 0 ? count / tokens : 0 }))
    .sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))

  return {
    sessions,
    messages,
    tokens,
    activeDays: days.filter((day) => day.turns > 0).length,
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    topModel: modelShares[0]?.model ?? null,
    heatmap: heatmapOf(heatSource, today),
    modelShares,
    books: Math.round((tokens / TOKENS_PER_BOOK) * 10) / 10,
  }
}
