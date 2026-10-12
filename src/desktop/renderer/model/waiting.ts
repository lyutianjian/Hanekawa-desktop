import {
  formatWorkedDuration,
  isAgentCall,
  toStep,
  type ActivityRun,
  type DraftCall,
  type TranscriptEntry,
  type TranscriptItem,
  type TurnPhase,
} from './transcript.js'
import { batchPhrase, callPhrase, type CallStep } from './toolPhrases.js'
import { markSpecFor, type MarkSpec } from './workingMark.js'

/**
 * What the turn is doing **right now**: one status line, the transcript's last,
 * for the whole turn — whatever the steps above it are.
 *
 * Its words, by priority: a wait no record shows (compaction, retry backoff) >
 * a pending question > a call awaiting approval > the running calls > the thought
 * in progress > a draft arriving (「正在输出」) > 「正在思考」, the gap between steps.
 *
 * DOM-free, like every other `model/` unit: the clock and the timers live in the view.
 */

/** 「正在思考」 — the label for 「the model is deciding」, wherever it is shown. */
export const WAITING_LABEL = '正在思考'

const ASKING_LABEL = '正在提问'
const WRITING_LABEL = '正在输出'

export interface WaitingInput {
  /** The session snapshot's own flag: a turn is in flight. */
  readonly isStreaming: boolean
  /** When this turn started, epoch ms. The view counts up from it. */
  readonly startedAt: number | undefined
  /** The turn whose records are arriving (`TranscriptState.turnId`). */
  readonly turnId: string | undefined
  /** Output tokens this turn has reported so far; absent until the first response. */
  readonly outputTokens?: number
  /** A wait no record shows (`TranscriptState.phase`); outranks what the steps say. */
  readonly phase?: TurnPhase
  /** The `header` of the question the user is being asked, while one is pending. */
  readonly asking?: string
  /** Background tasks still running; the status line keeps a button for them, turn or no turn. */
  readonly backgroundTasks?: number
  /** The tool call whose arguments are streaming in (`TranscriptState.draftCall`). */
  readonly draftCall?: DraftCall
}

export interface WaitingRow {
  readonly label: string
  readonly startedAt: number | undefined
  /** Set while the model is thinking: when that began, for `thinkingPhaseLabel` to escalate from. */
  readonly thinkingSince?: number
}

export interface TurnActivity {
  /** The status line; `undefined` exactly when the turn is not running. */
  readonly row: WaitingRow | undefined
  /** What the working mark beside the status shows; `undefined` exactly when there is no status. */
  readonly mark: MarkSpec | undefined
}

const IDLE: TurnActivity = { row: undefined, mark: undefined }
const PLAIN: MarkSpec = { body: 'default', state: 'working' }

/** How long the wait has to last before the counter is worth showing. */
export const WAITING_CLOCK_AFTER_MS = 2_000

/** What the counter reads at `elapsedMs`; empty while the wait is still short. */
export function waitingElapsedLabel(elapsedMs: number): string {
  return elapsedMs < WAITING_CLOCK_AFTER_MS ? '' : formatWorkedDuration(elapsedMs)
}

/** `['14s', '396 tokens']`: the seconds once they are worth showing, the tokens only beside them. */
export function statusMeta(elapsedMs: number, tokens: number | undefined): string[] {
  const seconds = waitingElapsedLabel(elapsedMs)
  if (seconds === '') return []
  return tokens !== undefined && tokens > 0 ? [seconds, `${formatTokens(tokens)} tokens`] : [seconds]
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

const THINKING_PHASES: readonly (readonly [number, string])[] = [
  [60_000, '快想好了'],
  [45_000, '再想一会'],
  [30_000, '还在想'],
  [15_000, '仍在思考'],
]

/** 「正在思考」, worded up the longer the thought runs. */
export function thinkingPhaseLabel(elapsedMs: number): string {
  return THINKING_PHASES.find(([from]) => elapsedMs >= from)?.[1] ?? WAITING_LABEL
}

/** The words the row shows at `now`: the escalating thought, else its fixed label. */
export function rowLabel(row: WaitingRow, now: number): string {
  return row.thinkingSince === undefined ? row.label : thinkingPhaseLabel(now - row.thinkingSince)
}

/**
 * The status for this paint.
 *
 * `ActivityRun.status` is deliberately not consulted for liveness: it reads
 * 「done」 the moment the last tool result merges in, which happens several times
 * inside a turn that is still very much running; the session's own `isStreaming`
 * is the only honest source for 「the turn is over」. The run must also belong to
 * the turn in flight — a new turn that has not produced a record yet owns none.
 */
export function turnActivity(entries: readonly TranscriptEntry[], input: WaitingInput): TurnActivity {
  if (!input.isStreaming) return IDLE
  const row = (label: string, extra?: Partial<WaitingRow>): WaitingRow => ({ label, startedAt: input.startedAt, ...extra })
  if (input.phase) return { row: row(phaseLabel(input.phase)), mark: PLAIN }
  const asking = input.asking === undefined ? undefined : `${ASKING_LABEL} · ${input.asking}`
  const last = entries[entries.length - 1]
  const run = last?.kind === 'run' && last.run.status !== 'aborted' && input.turnId !== undefined && last.run.turnId === input.turnId
    ? last.run
    : undefined
  if (asking !== undefined) return { row: row(asking), mark: { body: 'default', state: 'blocked' } }
  // A sub-agent is no run's step, so its own wait is named here.
  if (last?.kind === 'item' && last.item.pending === true && isAgentCall(last.item) && last.item.turnId === input.turnId) {
    const step = toStep(last.item) as CallStep
    return step.tool.awaitingApproval === true
      ? { row: row(`等待确认 · ${callPhrase(step)}`), mark: { body: 'default', state: 'blocked' } }
      : { row: row(callPhrase(step)), mark: PLAIN }
  }
  const mark = markSpecFor(run ?? latestRun(entries, input.turnId), input.draftCall)
  if (run) {
    const calls = run.steps.filter(isRunningCall)
    const waiting = calls.filter((step) => step.tool.awaitingApproval === true).at(-1)
    if (waiting) return { row: row(`等待确认 · ${callPhrase(waiting)}`), mark }
    if (calls.length > 0) return { row: row(batchPhrase(calls)), mark }
    const thought = run.steps[run.steps.length - 1]
    if (thought?.kind === 'thinking' && thought.pending === true) {
      return { row: row(WAITING_LABEL, { thinkingSince: thought.startedAt ?? input.startedAt }), mark }
    }
    return { row: row(WAITING_LABEL), mark }
  }
  if (last?.kind === 'item' && isArriving(last.item)) return { row: row(WRITING_LABEL), mark }
  return { row: row(WAITING_LABEL), mark }
}

/** The turn's newest run, for the mark to hold once text has followed it. */
function latestRun(entries: readonly TranscriptEntry[], turnId: string | undefined): ActivityRun | undefined {
  if (turnId === undefined) return undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.kind === 'run') return entry.run.turnId === turnId && entry.run.status !== 'aborted' ? entry.run : undefined
    if (entry.item.kind === 'user') return undefined
  }
  return undefined
}

const RETRY_REASONS: Record<Extract<TurnPhase, { kind: 'retrying' }>['reason'], string> = {
  rate_limit: '请求被限流',
  overload: '服务过载',
  server_error: '服务端出错',
  transient: '连接中断',
  auth: '认证失败',
  unknown: '请求失败',
}

/**
 * 「正在压缩上下文」, or 「服务过载 · 第 2 次重试」. The attempt that failed is
 * the retry's ordinal: attempt 1 failing is the first retry.
 */
export function phaseLabel(phase: TurnPhase): string {
  return phase.kind === 'compacting' ? '正在压缩上下文' : `${RETRY_REASONS[phase.reason]} · 第 ${phase.attempt} 次重试`
}

function isRunningCall(step: ActivityRun['steps'][number]): step is CallStep {
  return (step.kind === 'tool' || step.kind === 'task') && step.pending === true
}

/**
 * Whether the transcript's last loose item is visibly still coming.
 *
 * A pending message only says so once it has text: `text_delta` can open a draft
 * with an empty string, and an empty bubble is exactly the blank page the row
 * exists for.
 */
function isArriving(item: TranscriptItem): boolean {
  return item.pending === true && item.text.trim().length > 0
}

/** A new label shows once it has held this long... */
export const LABEL_DEBOUNCE_MS = 150
/** ...and the one it replaces has been up at least this long. */
export const LABEL_MIN_SHOWN_MS = 650

export interface LabelGate {
  readonly shown: string
  readonly shownAt: number
  /** A restart of the turn (its start time): the old words say nothing about the new one. */
  readonly epoch: number | undefined
  readonly pending?: { readonly label: string; readonly since: number }
}

/**
 * Keeps the words from flickering: `want` is what the status says now; the result
 * is what to show, the gate to carry to the next call, and when to call again
 * (`recheckAt`, epoch ms) if a switch is still waiting out its delay.
 */
export function settleLabel(
  gate: LabelGate | undefined,
  want: string,
  epoch: number | undefined,
  now: number,
): { readonly gate: LabelGate; readonly label: string; readonly recheckAt?: number } {
  if (!gate || gate.epoch !== epoch) return { gate: { shown: want, shownAt: now, epoch }, label: want }
  if (want === gate.shown) return { gate: { ...gate, pending: undefined }, label: gate.shown }
  const pending = gate.pending?.label === want ? gate.pending : { label: want, since: now }
  const at = Math.max(pending.since + LABEL_DEBOUNCE_MS, gate.shownAt + LABEL_MIN_SHOWN_MS)
  if (now >= at) return { gate: { shown: want, shownAt: now, epoch }, label: want }
  return { gate: { ...gate, pending }, label: gate.shown, recheckAt: at }
}
