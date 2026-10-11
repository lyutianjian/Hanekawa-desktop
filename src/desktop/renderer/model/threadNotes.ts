/**
 * Thread notes as data: the coordinator's wake message and mid-turn
 * coordination update are model-facing text, and the transcript draws their
 * notes as cards instead of a wall of quoted reports.
 *
 * Mirror of `formatWakeMessage`, `formatCoordinationUpdate` and `wrapThreadNote`
 * (`src/runtime/coordination/messages.ts`) and `formatReportNote`
 * (`src/utils/reportSanitizer.ts`). The renderer may not import `runtime/`, so
 * the format is duplicated here; the tests feed it the real formatters' output.
 *
 * Forgery: the sanitizer turns every angle bracket and quote in a title or
 * report into `'`, so a thread cannot write a `<thread-note>` tag. The wake
 * parser additionally insists on the fixed header, and a user's own typing
 * never reaches `parseCoordinationUpdate` (it is only called for the durable
 * `coordination_update` record type).
 */

export type WakeReason = 'question' | 'converged'

export interface ThreadNoteCard {
  /** Absent when the tag carried no well-formed thread id. */
  readonly threadId?: string
  /** The raw `[status]` text; the view maps it to a label when it is known. */
  readonly status: string
  readonly title: string
  /** One line, `⏎` read as a space, cut to {@link REPORT_PREVIEW_MAX}. */
  readonly report?: string
}

export interface ThreadNotesData {
  /** The opening instruction older coordinator sessions start with: not drawn. */
  readonly opening?: true
  readonly wake?: { readonly count: number; readonly limit: number; readonly reason: WakeReason }
  readonly cards: readonly ThreadNoteCard[]
}

export const REPORT_PREVIEW_MAX = 160
import { OPENING_HEAD } from '../../../runtime/protocol/coordinationHost.js'

const WAKE_HEAD_RE = /^This is an automatic wake \((\d+) of (\d+)\)\. (A thread is waiting for an answer\.|Your threads have finished\.)/
const NOTE_RE = /<thread-note(?: thread="(thr_[0-9a-f]{12})")?>\n([\s\S]*?)\n<\/thread-note>/g
const NOTE_HEAD_RE = /^\[([^\]]*)\] (.*)$/

/** A wake message with at least one note, or the opening instruction; else `undefined` (not a card). */
export function parseThreadNoteMessage(text: string): ThreadNotesData | undefined {
  if (text.startsWith(OPENING_HEAD)) return { opening: true, cards: [] }
  const head = WAKE_HEAD_RE.exec(text)
  if (!head) return undefined
  const cards = parseCards(text)
  if (cards.length === 0) return undefined
  return {
    wake: {
      count: Number(head[1]),
      limit: Number(head[2]),
      reason: head[3]!.startsWith('A thread') ? 'question' : 'converged',
    },
    cards,
  }
}

/**
 * The notes of a `coordination_update` record's content. The record type is the
 * trust boundary, so no header is required; the snapshot part is not drawn.
 */
export function parseCoordinationUpdate(content: string): ThreadNotesData | undefined {
  const cards = parseCards(content)
  return cards.length === 0 ? undefined : { cards }
}

function parseCards(text: string): ThreadNoteCard[] {
  const cards: ThreadNoteCard[] = []
  for (const match of text.matchAll(NOTE_RE)) {
    const lines = match[2]!.split('\n')
    const head = NOTE_HEAD_RE.exec(lines[0]!)
    if (!head) continue
    const reportLine = lines.find((line) => line.startsWith('Report: '))
    const report = reportLine === undefined ? undefined : preview(reportLine.slice('Report: '.length))
    cards.push({
      ...(match[1] === undefined ? {} : { threadId: match[1] }),
      status: head[1]!,
      title: head[2]!,
      ...(report ? { report } : {}),
    })
  }
  return cards
}

function preview(report: string): string {
  const flat = report.replace(/⏎/g, ' ').replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  return points.length <= REPORT_PREVIEW_MAX ? flat : `${points.slice(0, REPORT_PREVIEW_MAX - 1).join('')}…`
}
