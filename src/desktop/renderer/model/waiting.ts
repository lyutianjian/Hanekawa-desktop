import {
  formatWorkedDuration,
  type ActivityRun,
  type TranscriptEntry,
  type TranscriptItem,
  type TurnPhase,
} from './transcript.js'
import { thoughtLiveLabel } from './thinking.js'
import { batchPhrase, callPhrase, type CallStep } from './toolPhrases.js'
import { markSpecFor, type MarkSpec } from './workingMark.js'

/**
 * What the turn is doing **right now**, and where that is said.
 *
 * The live status is the transcript's **last line**, for the whole turn, because
 * that is where the reader is looking. It is carried by whatever is last:
 *
 * - an activity run — its summary line turns into the status (`live`): what the
 *   running calls do, the latest sentence of the thought in progress, or 「正在思考」
 *   in the gap between two tools;
 * - otherwise a line of its own (`row`) reading 「正在思考」 — the gap before the first
 *   step, or after the model finished a paragraph and is deciding what next.
 *
 * A wait no record shows — an automatic compaction, a retry backoff — outranks
 * both (`phaseLabel`) and always gets the line of its own. And never a second
 * voice beside a growing draft: if the last loose item is visibly arriving, the
 * text itself is the status.
 *
 * DOM-free, like every other `model/` unit: the clock lives in the view, and
 * `startedAt` is only carried through so a test can pin the contents without one.
 */

/** 「正在思考」 — the label for 「the model is deciding」, wherever it is shown. */
export const WAITING_LABEL = '正在思考'

const ASKING_LABEL = '正在提问'

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
}

export interface WaitingRow {
  readonly label: string
  readonly startedAt: number | undefined
}

export interface TurnActivity {
  /** The run whose summary line carries the live status, and what it reads. */
  readonly live: { readonly runId: string; readonly label: string; readonly startedAt: number | undefined } | undefined
  /** The status line of its own, when no run can carry it. */
  readonly row: WaitingRow | undefined
  /** What the working mark beside the status shows; `undefined` exactly when there is no status. */
  readonly mark: MarkSpec | undefined
}

const IDLE: TurnActivity = { live: undefined, row: undefined, mark: undefined }

/**
 * How long the wait has to last before the counter is worth showing: a turn that
 * answers in two seconds does not need to be timed, and a number that appears and
 * is gone again before it can be read is noise next to the label.
 */
export const WAITING_CLOCK_AFTER_MS = 5_000

/**
 * What the counter reads at `elapsedMs` — the empty string while the wait is
 * still short, which is how the view says 「no counter yet」 without a second
 * piece of state.
 */
export function waitingElapsedLabel(elapsedMs: number): string {
  return elapsedMs < WAITING_CLOCK_AFTER_MS ? '' : formatWorkedDuration(elapsedMs)
}

/**
 * Which run is live, and what the status reads, for this paint.
 *
 * `ActivityRun.status` is deliberately not consulted for liveness: it reads
 * 「done」 the moment the last tool result merges in, which happens several times
 * inside a turn that is still very much running; the session's own `isStreaming`
 * is the only honest source for 「the turn is over」. The run must also belong to
 * the turn in flight — a new turn that has not produced a record yet owns none.
 */
export function turnActivity(entries: readonly TranscriptEntry[], input: WaitingInput): TurnActivity {
  if (!input.isStreaming) return IDLE
  const plain = markSpecFor(undefined)
  if (input.phase) return { live: undefined, row: { label: phaseLabel(input.phase), startedAt: input.startedAt }, mark: plain }
  const asking = input.asking === undefined ? undefined : `${ASKING_LABEL} · ${input.asking}`
  const last = entries[entries.length - 1]
  if (last?.kind === 'run' && last.run.status !== 'aborted' && input.turnId !== undefined && last.run.turnId === input.turnId) {
    return {
      live: { runId: last.run.id, label: asking ?? runActivity(last.run), startedAt: input.startedAt },
      row: undefined,
      mark: asking === undefined ? markSpecFor(last.run) : plain,
    }
  }
  if (last?.kind === 'item' && isArriving(last.item)) return IDLE
  return { live: undefined, row: { label: asking ?? WAITING_LABEL, startedAt: input.startedAt }, mark: plain }
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

/**
 * The live run's label: what the running calls do, in words — 「读取 waiting.ts」,
 * 「运行 npm test」 — else the thought in progress, else 「正在思考」.
 *
 * A call the user still has to allow outranks all of them: the turn is waiting
 * on the reader, not on the tool.
 */
export function runActivity(run: ActivityRun): string {
  const running = run.steps.filter(isRunningCall)
  const waiting = running.filter((step) => step.tool.awaitingApproval === true).at(-1)
  if (waiting) return `等待确认 · ${callPhrase(waiting)}`
  if (running.length > 0) return batchPhrase(running)
  const last = run.steps[run.steps.length - 1]
  if (last?.kind === 'thinking' && last.pending === true) return thoughtLiveLabel(last.text)
  return WAITING_LABEL
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
