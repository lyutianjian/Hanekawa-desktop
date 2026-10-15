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
 * `tool_result.display.taskSnapshot` is the whole truth, and recovering after a
 * pane switch or `/resume` is just a reverse scan of the records.
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
  /** The user has spoken since the list was written: it is a plan from an earlier turn. */
  readonly stale: boolean
}

/** What the card draws: a window of at most `TASK_CARD_ROWS` rows around the current one. */
export interface TaskCard {
  readonly rows: readonly TaskListItem[]
  readonly hiddenBefore: number
  /** Unfinished rows past the window; finished ones there are not worth a mention. */
  readonly openAfter: number
  readonly stale: boolean
}

/**
 * The checklist's state, or `undefined` when there is none — no snapshot yet, an
 * empty checklist, or a finished one the user has already moved past. An
 * unfinished list outlives its turn as a stale plan.
 */
export function taskListState(records: readonly SessionRecord[]): TaskListState | undefined {
  let userSpoke = false
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (!record) continue
    if (record.type === 'tool_result' && record.display?.taskSnapshot) {
      const state = projectSnapshot(record.display.taskSnapshot)
      return userSpoke ? staleTaskList(state) : state
    }
    userSpoke ||= isRetiringUserMessage(record)
  }
  return undefined
}

/**
 * The checklist after one more record — the live counterpart of `taskListState`.
 *
 * A pane sees records one at a time and never keeps the list, so the reverse
 * scan above is only affordable on the two paths that hand over a whole list
 * (`hello`, `transcript-reset`). Folding a session's records through this must
 * land on what `taskListState` says about the same records —
 * `test/rendererTasks.test.ts` asserts exactly that, because the two paths meet
 * on every pane switch.
 */
export function advanceTaskList(current: TaskListState | undefined, record: SessionRecord): TaskListState | undefined {
  if (record.type === 'tool_result') {
    const snapshot = record.display?.taskSnapshot
    return snapshot ? projectSnapshot(snapshot) : current
  }
  return current && isRetiringUserMessage(record) ? staleTaskList(current) : current
}

/**
 * The user starting something new: a finished list retires, an unfinished one
 * becomes the plan from before. `turn-start` is the same moment seen a beat
 * earlier — the user record only lands after the turn's first I/O — so the pane
 * applies this on both, and doing it twice changes nothing.
 */
export function staleTaskList(current: TaskListState | undefined): TaskListState | undefined {
  if (!current || current.allDone) return undefined
  return current.stale ? current : { ...current, stale: true }
}

/**
 * The card, only while a turn runs: between turns the checklist is history, and
 * the transcript's own task rows are where it is read.
 *
 * The window opens one row before the current one, so the step just finished
 * stays in view; with nothing running, the first unfinished row stands in.
 */
export function taskCard(state: TaskListState | undefined, isStreaming: boolean): TaskCard | undefined {
  if (!state || !isStreaming) return undefined
  const { tasks } = state
  const running = tasks.findIndex((task) => task.status === 'in_progress')
  const current = running >= 0 ? running : tasks.findIndex((task) => task.status !== 'completed')
  const start = Math.max(0, Math.min((current >= 0 ? current : tasks.length) - 1, tasks.length - TASK_CARD_ROWS))
  const after = tasks.slice(start + TASK_CARD_ROWS)
  return {
    rows: tasks.slice(start, start + TASK_CARD_ROWS),
    hiddenBefore: start,
    openAfter: after.filter((task) => task.status !== 'completed').length,
    stale: state.stale,
  }
}

function projectSnapshot(snapshot: TaskDisplaySnapshot): TaskListState | undefined {
  // `deleted` tasks ride along in the snapshot and are counted in its `total`
  // but nowhere else, so the list counts its own rows instead of trusting
  // `snapshot.counts`.
  const tasks = snapshot.tasks.filter(isListTask).map(toListItem)
  if (tasks.length === 0) return undefined
  const counts = countListItems(tasks)
  return { tasks, counts, allDone: counts.completed === counts.total, stale: false }
}

function isRetiringUserMessage(record: SessionRecord): boolean {
  if (record.type !== 'message' || record.role !== 'user') return false
  // A `<system-reminder>` user record is a model-facing nudge, not the user
  // starting something new — the transcript hides it, and so does this.
  return !isSystemReminderBlock(messageText(record))
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
