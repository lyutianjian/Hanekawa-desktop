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

/** Whether an entry closes the reply before it: someone's message, or its end marker. */
function endsReply(entry: TranscriptEntry): boolean {
  if (entry.kind !== 'item') return false
  return entry.item.kind === 'user' || entry.item.kind === 'thread-notes'
    || entry.item.kind === 'turn-failure' || entry.item.interrupt === true
}

/**
 * Takes each turn's `duration` item out of the stream and hangs its time on the
 * entry the reply ends with, keyed by that entry's index in `entries`.
 *
 * A wake turn has no input of its own — a background task's report starts it —
 * so the reply before it was not finished, just paused. Its time joins the
 * pending footer instead of settling one mid-answer, and the merged footer lands
 * after the last turn that ran before the next input. A still-streaming turn's
 * first entry settles the footer before it: that answer is no longer the end of
 * what the reader is looking at. `tokens` belong to the newest turn only.
 */
export function splitTurnFooters(
  entries: readonly TranscriptEntry[],
  tokens?: number,
  tokenTurnId?: string,
  openTurnId?: string,
): { readonly entries: TranscriptEntry[]; readonly footers: Map<number, TurnFooter> } {
  const kept: TranscriptEntry[] = []
  const footers = new Map<number, TurnFooter>()
  let pending: TurnFooter | undefined
  const settle = (): void => {
    if (pending === undefined || kept.length === 0) return
    footers.set(kept.length - 1, pending)
    pending = undefined
  }
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.item.kind === 'duration') {
      const target = kept.at(-1)
      const { durationMs } = entry.item
      if (target === undefined || durationMs === undefined) continue
      const createdAt = (target.kind === 'item' ? target.item.createdAt : undefined) ?? entry.item.createdAt
      pending = {
        durationMs: (pending?.durationMs ?? 0) + durationMs,
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(tokens !== undefined && tokens > 0 && tokenTurnId !== undefined && entry.item.turnId === tokenTurnId ? { tokens } : {}),
      }
      continue
    }
    if (endsReply(entry) || (openTurnId !== undefined && entry.kind === 'item' && entry.item.turnId === openTurnId)) settle()
    kept.push(entry)
  }
  settle()
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
