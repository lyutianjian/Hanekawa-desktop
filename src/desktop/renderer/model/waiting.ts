import {
  formatWorkedDuration,
  type ActivityRun,
  type ActivityStep,
  type DraftCall,
  type TranscriptEntry,
  type TranscriptItem,
  type TranscriptState,
  type TurnPhase,
} from './transcript.js'
import { callPhrase, type CallStep } from './toolPhrases.js'
import { EDIT_TOOLS } from './thinking.js'
import { markSpecFor, peekField, type MarkSpec } from './workingMark.js'
import type { TaskCard } from './tasks.js'

/**
 * What the turn is doing **right now**: one status line, the transcript's last,
 * for the whole turn — whatever the steps above it are.
 *
 * Its words, by priority: a wait no record shows (compaction, retry backoff) >
 * a pending question > a call awaiting approval > the running calls > the thought
 * in progress > a call whose arguments are streaming (「正在编写 a.ts」) > a draft
 * arriving (「正在输出」) > 「处理中」, the gap between steps.
 *
 * DOM-free, like every other `model/` unit: the clock and the timers live in the view.
 */

/** 「正在思考」 — only while a thought is actually streaming. */
export const WAITING_LABEL = '正在思考'
/** Any other wait: the request is out, or the model is between steps. */
export const PROCESSING_LABEL = '处理中'

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
  readonly outputTokenTurnId?: string
  /** A wait no record shows (`TranscriptState.phase`); outranks what the steps say. */
  readonly phase?: TurnPhase
  /** The `header` of the question the user is being asked, while one is pending. */
  readonly asking?: string
  /** The live UI queue contains a permission request, including a sub-agent's. */
  readonly awaitingApproval?: boolean
  /** Background tasks still running; the status line keeps a button for them, turn or no turn. */
  readonly backgroundTasks?: number
  /** The tool call whose arguments are streaming in (`TranscriptState.draftCall`). */
  readonly draftCall?: DraftCall
  /** The checklist card drawn above the status line; absent between turns. */
  readonly taskCard?: TaskCard
}

export interface WaitingRow {
  readonly label: string
  readonly startedAt: number | undefined
  readonly timing: 'tool' | 'gap' | 'immediate'
  /** Set while the model is thinking: when that began, for `thinkingPhaseLabel` to escalate from. */
  readonly thinkingSince?: number
}

export interface TurnActivity {
  /** The status; `undefined` exactly when the turn is not running. */
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

/** `['14 秒', '396 token']`: the seconds once they are worth showing, the tokens only beside them. */
export function statusMeta(elapsedMs: number, tokens: number | undefined): string[] {
  const seconds = waitingElapsedLabel(elapsedMs)
  if (seconds === '') return []
  return tokens !== undefined && tokens > 0 ? [seconds, `${formatTokens(tokens)} token`] : [seconds]
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/**
 * There is no last rung: 「快想好了」 promised an end the app cannot see, and
 * a thought past a minute has no better claim to being nearly done.
 */
const THINKING_PHASES: readonly (readonly [number, string])[] = [
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
 * The activity to draw for a turn whose records are read back from a file — a
 * thread's page, or a sub-agent's own transcript — where no session snapshot says
 * whether a turn is in flight. The caller's knowledge of whether the run is still
 * going is that flag: live keeps the turn open and puts the status line at the
 * end (the words above the fold stay as they are), settled closes it and draws its
 * footers instead.
 *
 * A state built from records carries no `turnId` of its own, so the turn in flight
 * is the newest stamped one — the last the file has. Naming it is what lets the
 * status line read the run's own work (「运行 1 个命令」), rather than
 * falling back to a word that fits every turn equally well. `startedAt` then comes
 * from that turn's first record, as the live snapshot's does, so the counter reads
 * from the turn's own beginning rather than from the paint.
 */
export function replayActivity(state: TranscriptState, running: boolean, startedAt?: number): WaitingInput {
  if (!running) return { isStreaming: false, startedAt: undefined, turnId: undefined }
  const turnId = state.turnId ?? lastStamped(state.items)
  const start = state.items.find((item) => turnId !== undefined && item.turnId === turnId)?.createdAt
  return { isStreaming: true, startedAt: start === undefined ? startedAt : Date.parse(start), turnId }
}

/** The turn id of the transcript's newest stamped item — its turn in flight. */
function lastStamped(items: TranscriptState['items']): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turnId = items[index]?.turnId
    if (turnId !== undefined) return turnId
  }
  return undefined
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
  const row = (label: string, extra?: Partial<WaitingRow>): WaitingRow => ({ label, startedAt: input.startedAt, timing: 'gap', ...extra })
  if (input.phase) return { row: row(phaseLabel(input.phase), { timing: input.phase.kind === 'retrying' ? 'immediate' : 'gap' }), mark: PLAIN }
  const asking = input.asking === undefined ? undefined : `${ASKING_LABEL} · ${input.asking}`
  const last = entries[entries.length - 1]
  // A run at the tail is this turn's even before its `turnId` is stamped: the turn's
  // first records arrive before the id that names them, and a new turn always puts
  // its user message after the previous turn's work.
  const run = last?.kind === 'run' && last.run.status !== 'aborted'
    && (last.run.turnId === undefined || last.run.turnId === input.turnId)
    ? last.run
    : undefined
  if (asking !== undefined) return { row: row(asking, { timing: 'immediate' }), mark: { body: 'default', state: 'blocked' } }
  const mark = markSpecFor(run ?? latestRun(entries, input.turnId), input.draftCall)
  const calls = run?.steps.filter(isRunningCall) ?? []
  const waiting = calls.filter((step) => step.tool.awaitingApproval === true).at(-1)
  if (waiting || input.awaitingApproval === true) {
    const label = waiting ? `等待你确认 · ${callPhrase(waiting, true)}` : '等待你确认'
    return { row: row(label, { timing: 'immediate' }), mark: { ...mark, state: 'blocked' } }
  }
  if (run) {
    if (calls.length > 0) return { row: row(callPhrase(calls.at(-1)!), { timing: 'tool' }), mark }
    const thought = run.steps[run.steps.length - 1]
    if (thought?.kind === 'thinking' && thought.pending === true) {
      return { row: row(WAITING_LABEL, { thinkingSince: thought.startedAt ?? input.startedAt }), mark }
    }
  }
  if (input.draftCall !== undefined) {
    const label = draftLabel(input.draftCall)
    return { row: row(label, { timing: label === PROCESSING_LABEL ? 'gap' : 'tool' }), mark }
  }
  if (last?.kind === 'item' && isArriving(last.item)) return { row: row(WRITING_LABEL), mark }
  const step = run?.steps.at(-1)
  const failed = step !== undefined && (step.kind === 'tool' || step.kind === 'task') && (step.status === 'failed' || step.status === 'interrupted')
  const interrupted = last?.kind === 'item' && (last.item.interrupt === true || last.item.kind === 'turn-failure')
  return { row: row(PROCESSING_LABEL, { timing: failed || interrupted ? 'immediate' : 'gap' }), mark }
}

/** The normal turn-end feedback; errors and interruptions keep their existing presentation. */
export function completedRow(entries: readonly TranscriptEntry[], input: WaitingInput): WaitingRow | undefined {
  let lastStep: ActivityStep | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    const turnId = entry.kind === 'run' ? entry.run.turnId : entry.item.turnId
    if (turnId !== undefined && turnId !== input.turnId) break
    if (entry.kind === 'run') {
      if (entry.run.status === 'aborted') return undefined
      lastStep ??= entry.run.steps.at(-1)
    } else {
      if (entry.item.interrupt === true || entry.item.kind === 'turn-failure' || entry.item.kind === 'error') return undefined
      if (entry.item.kind === 'user') break
    }
  }
  if (lastStep && 'status' in lastStep && (lastStep.status === 'failed' || lastStep.status === 'interrupted')) return undefined
  const label = lastStep?.kind === 'thinking' && lastStep.durationMs !== undefined
    ? `思考了 ${Math.max(1, Math.round(lastStep.durationMs / 1000))} 秒`
    : '已完成'
  return { label, startedAt: input.startedAt, timing: 'immediate' }
}

/** A call the model is still writing: 「正在编写 a.ts」 for an edit, 「正在准备命令」 for the shell. */
function draftLabel(draft: DraftCall): string {
  if (draft.name === 'Bash') return '正在准备命令'
  if (!EDIT_TOOLS.has(draft.name)) return PROCESSING_LABEL
  const path = peekField(draft.input, 'filePath') ?? peekField(draft.input, 'file_path') ?? peekField(draft.input, 'notebook_path')
  return path === undefined ? '正在编写文件' : `正在编写 ${path.split(/[\\/]/).pop()}`
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

/** Let a new phase settle before replacing the readable description. */
export const LABEL_DEBOUNCE_MS = 250
/** Includes the text transition, leaving ample time to read each activity. */
export const LABEL_MIN_SHOWN_MS = 2_000

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
  timing: WaitingRow['timing'],
): { readonly gate: LabelGate; readonly label: string; readonly recheckAt?: number } {
  if (!gate || gate.epoch !== epoch) return { gate: { shown: want, shownAt: now, epoch }, label: want }
  if (want === gate.shown) return { gate: { ...gate, pending: undefined }, label: gate.shown }
  if (timing === 'immediate') return { gate: { shown: want, shownAt: now, epoch }, label: want }
  const pending = gate.pending?.label === want ? gate.pending : { label: want, since: now }
  const at = Math.max(pending.since + LABEL_DEBOUNCE_MS, gate.shownAt + LABEL_MIN_SHOWN_MS)
  if (now >= at) return { gate: { shown: want, shownAt: now, epoch }, label: want }
  return { gate: { ...gate, pending }, label: gate.shown, recheckAt: at }
}
