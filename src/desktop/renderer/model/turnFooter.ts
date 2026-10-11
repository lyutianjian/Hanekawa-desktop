import { formatWorkedDuration, type TranscriptEntry } from './transcript.js'
import { formatTokens } from './usage.js'

/** What the turn's last entry shows on hover beside its copy button. */
export interface TurnFooter {
  readonly durationMs: number
  /** The stamp the relative time counts from. */
  readonly createdAt?: string
  /** Output tokens of the turn, when the session still has them. */
  readonly tokens?: number
}

/**
 * Takes each turn's `duration` item out of the stream and hangs its time on the
 * entry before it (the turn's last), keyed by that entry's index in `entries`.
 * `tokens` belong to the newest turn only.
 */
export function splitTurnFooters(
  entries: readonly TranscriptEntry[],
  tokens?: number,
): { readonly entries: TranscriptEntry[]; readonly footers: Map<number, TurnFooter> } {
  const kept: TranscriptEntry[] = []
  const footers = new Map<number, TurnFooter>()
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.item.kind === 'duration') {
      const target = kept.at(-1)
      const { durationMs } = entry.item
      if (target === undefined || durationMs === undefined) continue
      const createdAt = (target.kind === 'item' ? target.item.createdAt : undefined) ?? entry.item.createdAt
      footers.set(kept.length - 1, { durationMs, ...(createdAt === undefined ? {} : { createdAt }) })
    } else kept.push(entry)
  }
  if (tokens !== undefined && tokens > 0 && footers.size > 0) {
    const last = Math.max(...footers.keys())
    footers.set(last, { ...footers.get(last)!, tokens })
  }
  return { entries: kept, footers }
}

/** 「刚刚」 · 「N 分钟前」 · 「今天 14:32」 · 「5月7日」. */
export function relativeTime(createdAt: string | undefined, now: number): string | undefined {
  const at = createdAt === undefined ? undefined : new Date(createdAt)
  if (at === undefined || Number.isNaN(at.getTime())) return undefined
  const minutes = Math.floor((now - at.getTime()) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const today = new Date(now)
  if (at.toDateString() === today.toDateString()) return `今天 ${clock(at)}`
  return `${at.getMonth() + 1}月${at.getDate()}日`
}

/** The hover title: 「2026-05-07 14:32」. */
export function absoluteTime(createdAt: string): string {
  const at = new Date(createdAt)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock(at)}`
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** `['用时 24m 0s', '3.2k tokens']`. */
export function footerFacts(footer: TurnFooter): string[] {
  return [
    `用时 ${formatWorkedDuration(footer.durationMs)}`,
    ...(footer.tokens === undefined ? [] : [`${formatTokens(footer.tokens)} tokens`]),
  ]
}
