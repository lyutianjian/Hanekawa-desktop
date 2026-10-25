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
  tokenTurnId?: string,
): { readonly entries: TranscriptEntry[]; readonly footers: Map<number, TurnFooter> } {
  const kept: TranscriptEntry[] = []
  const footers = new Map<number, TurnFooter>()
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.item.kind === 'duration') {
      const target = kept.at(-1)
      const { durationMs } = entry.item
      if (target === undefined || durationMs === undefined) continue
      const createdAt = (target.kind === 'item' ? target.item.createdAt : undefined) ?? entry.item.createdAt
      footers.set(kept.length - 1, {
        durationMs, ...(createdAt === undefined ? {} : { createdAt }),
        ...(tokens !== undefined && tokens > 0 && tokenTurnId !== undefined && entry.item.turnId === tokenTurnId ? { tokens } : {}),
      })
    } else kept.push(entry)
  }
  return { entries: kept, footers }
}

export { absoluteTime, relativeTime } from './timeLabel.js'

/** `['用时 24 分 0 秒', '3.2k token']`. */
export function footerFacts(footer: TurnFooter): string[] {
  return [
    `用时 ${formatWorkedDuration(footer.durationMs)}`,
    ...(footer.tokens === undefined ? [] : [`${formatTokens(footer.tokens)} token`]),
  ]
}
