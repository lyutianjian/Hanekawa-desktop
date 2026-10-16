import type { SessionRecord, TaskDisplayCounts, TaskDisplayItem, TaskDisplaySnapshot } from '../../../harness/types.js'
import { messageText } from './transcript.js'

/** The location feedback token plus event-delivery slack. */
export const TASK_LOCATE_FALLBACK_MS = 660

/** The most rows the task card draws; the rest is summarised above and below. */
export const TASK_CARD_ROWS = 12

/**
 * The model's checklist as data, for the card at the transcript's tail.
 *
 * The source is a snapshot rather than an accumulation: the newest
 * `tool_result.display.taskSnapshot` is the whole truth. What the snapshot
 * cannot say is whether a new request has begun since — the rule
 * `src/tools/taskState.ts` replays: a request starts with the first user record
 * of a turn that is not only system reminders. Messages steered in mid-turn
 * amend the request; a turn woken by notifications carries it on.
 *
 * `transcript-reset` needs no special case here: the caller hands this the new
 * record list, and an empty list has no snapshot.
 *
 * DOM-free on purpose — `test/` imports this, and that puts it in the base
 * tsconfig program, which has no DOM lib.
 */

export interface TaskListItem {
  readonly id: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  /** What the row reads: `activeForm` while running, the subject otherwise. */
  readonly label: string
}

export interface TaskListState {
  readonly tasks: readonly TaskListItem[]
  readonly counts: TaskDisplayCounts
  readonly allDone: boolean
  /** A new request has begun since the list was written: it is the plan from before. */
  readonly stale: boolean
  /** The turn of the newest record that touched the list; a user record from it is steering. */
  readonly turnId?: string
}

/** `paused`: the current step, set aside while the turn waits on the user or a new request supersedes it. */
export type TaskRowStatus = TaskListItem['status'] | 'paused'

export interface TaskCardRow {
  readonly id: string
  readonly status: TaskRowStatus
  readonly label: string
}

/** What the card draws: a window of at most `TASK_CARD_ROWS` rows around the current one. */
export interface TaskCard {
  readonly rows: readonly TaskCardRow[]
  readonly hiddenBefore: number
  /** Unfinished rows past the window; finished ones there are not worth a mention. */
  readonly openAfter: number
}

/**
 * The checklist's state, or `undefined` when there is none — no snapshot yet, an
 * empty checklist, or a finished one a new request has moved past. An
 * unfinished list outlives its request as a stale plan.
 */
export function taskListState(records: readonly SessionRecord[]): TaskListState | undefined {
  return records.reduce<TaskListState | undefined>((state, record) => advanceTaskList(state, record), undefined)
}

/**
 * The checklist after one more record. A pane sees records one at a time and
 * folds them through this; `taskListState` is the same fold over a whole list,
 * so the two paths that meet on every pane switch cannot disagree.
 */
export function advanceTaskList(current: TaskListState | undefined, record: SessionRecord): TaskListState | undefined {
  if (record.type === 'tool_result') {
    const snapshot = record.display?.taskSnapshot
    return snapshot ? projectSnapshot(snapshot, record.turnId) : current
  }
  if (!current || record.type !== 'message' || record.role !== 'user') return current
  if (record.turnId !== undefined && record.turnId === current.turnId) return current
  const moved = record.turnId === undefined ? current : { ...current, turnId: record.turnId }
  return isSystemReminderBlock(messageText(record)) ? moved : staleTaskList(moved)
}

/**
 * `turn-start` is the user record's moment seen a beat earlier — the record only
 * lands after the turn's first I/O — so the pane stales the list here too, by the
 * same rule; the record that follows changes nothing more.
 */
export function taskListAtTurnStart(current: TaskListState | undefined, displayInput: string): TaskListState | undefined {
  return isSystemReminderBlock(displayInput) ? current : staleTaskList(current)
}

/** A new request: a finished list retires, an unfinished one becomes the plan from before. */
export function staleTaskList(current: TaskListState | undefined): TaskListState | undefined {
  if (!current || current.allDone) return undefined
  return current.stale ? current : { ...current, stale: true }
}

/**
 * The card, only while a turn runs: between turns the checklist is history, and
 * the transcript's own task rows are where it is read.
 *
 * The current row is the one marked running, else the first unfinished one —
 * models often skip `in_progress` and mark a step done straight from pending, and
 * there is always a gap before the first update. It is drawn running, or paused
 * on a plan a new request has superseded until the model writes the list again.
 * The window opens one row before it, so the step just finished stays in view.
 */
export function taskCard(state: TaskListState | undefined, isStreaming: boolean): TaskCard | undefined {
  if (!state || !isStreaming) return undefined
  const running = state.tasks.findIndex((task) => task.status === 'in_progress')
  const current = running >= 0 ? running : state.tasks.findIndex((task) => task.status !== 'completed')
  const active: TaskRowStatus = state.stale ? 'paused' : 'in_progress'
  const tasks = state.tasks.map((task, index): TaskCardRow =>
    index === current || task.status === 'in_progress' ? { ...task, status: active } : task)
  const start = Math.max(0, Math.min((current >= 0 ? current : tasks.length) - 1, tasks.length - TASK_CARD_ROWS))
  const after = tasks.slice(start + TASK_CARD_ROWS)
  return {
    rows: tasks.slice(start, start + TASK_CARD_ROWS),
    hiddenBefore: start,
    openAfter: after.filter((task) => task.status !== 'completed').length,
  }
}

/** The card while the turn waits on the user — a question or an approval: the running step is paused. */
export function pausedTaskCard(card: TaskCard): TaskCard {
  return { ...card, rows: card.rows.map((row): TaskCardRow => row.status === 'in_progress' ? { ...row, status: 'paused' } : row) }
}

function projectSnapshot(snapshot: TaskDisplaySnapshot, turnId: string | undefined): TaskListState | undefined {
  // `deleted` tasks ride along in the snapshot and are counted in its `total`
  // but nowhere else, so the list counts its own rows instead of trusting
  // `snapshot.counts`.
  const tasks = snapshot.tasks.filter(isListTask).map(toListItem)
  if (tasks.length === 0) return undefined
  const counts = countListItems(tasks)
  return { tasks, counts, allDone: counts.completed === counts.total, stale: false, ...(turnId ? { turnId } : {}) }
}

function isSystemReminderBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}

function isListTask(task: TaskDisplayItem): boolean {
  return task.status === 'pending' || task.status === 'in_progress' || task.status === 'completed'
}

function toListItem(task: TaskDisplayItem): TaskListItem {
  const status = task.status as TaskListItem['status']
  return {
    id: task.id,
    status,
    label: status === 'in_progress' && task.activeForm ? task.activeForm : task.subject,
  }
}

function countListItems(tasks: readonly TaskListItem[]): TaskDisplayCounts {
  const pending = tasks.filter((task) => task.status === 'pending').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return {
    total: tasks.length,
    remaining: pending + inProgress,
    pending,
    inProgress,
    completed,
  }
}
