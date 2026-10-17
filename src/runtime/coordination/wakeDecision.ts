// Pure decision logic for auto-waking the coordinator session. No I/O.

export const AUTO_WAKE_LIMIT = 20

export type ParentStatus = 'idle' | 'running' | 'stopping'

export interface WakeParentState {
  status: ParentStatus
  lastTurnOutcome: 'completed' | 'interrupted' | 'failed' | 'none'
  /** A permission prompt is waiting. */
  pendingApproval: boolean
  /** Another blocking UI request is open. */
  pendingDialog: boolean
  /** Threads being created right now. */
  startingThreads: number
}

/** A thread dispatched by the coordinator. */
export interface WakeChild {
  threadId: string
  running: boolean
}

export interface WakeNote {
  threadId: string
  kind: 'report' | 'question'
  userDriven: boolean
}

export interface WakeInput {
  parent: WakeParentState
  children: readonly WakeChild[]
  notes: readonly WakeNote[]
  autoWakeCount: number
  limit?: number
}

export type NoWakeReason =
  | 'no-wakeable-notes'
  | 'limit-reached'
  | 'parent-running'
  | 'parent-stopping'
  | 'parent-interrupted'
  | 'parent-failed'
  | 'awaiting-approval'
  | 'dialog-open'
  | 'threads-starting'

export type WakeVerdict =
  /** `progress`: some threads reported while others still run. */
  | { wake: true; reason: 'question' | 'progress' | 'converged' }
  | { wake: false; reason: NoWakeReason; retryLater: boolean }

const no = (reason: NoWakeReason, retryLater: boolean): WakeVerdict => ({ wake: false, reason, retryLater })

export function decideWake(input: WakeInput): WakeVerdict {
  const { parent, children, notes, autoWakeCount } = input
  const limit = input.limit ?? AUTO_WAKE_LIMIT
  const wakeable = notes.filter((n) => !n.userDriven)
  // 1. Nothing to act on: no notes, or only notes from threads the user drove directly (those just queue).
  if (wakeable.length === 0) return no('no-wakeable-notes', false)
  // 2. Auto-wake budget spent; waits for the user to speak in the coordinator (which resets the count).
  if (autoWakeCount >= limit) return no('limit-reached', false)
  // 3. Parent mid-turn: notes are injected before its next step instead.
  if (parent.status === 'running') return no('parent-running', false)
  // 4. Parent is winding down; try again once it settles.
  if (parent.status === 'stopping') return no('parent-stopping', true)
  // 5. Don't wake after the user stopped it or it errored; notes wait for the user.
  if (parent.lastTurnOutcome === 'interrupted') return no('parent-interrupted', false)
  if (parent.lastTurnOutcome === 'failed') return no('parent-failed', false)
  // 6. A blocking prompt is open; retry once it is settled.
  if (parent.pendingApproval) return no('awaiting-approval', true)
  if (parent.pendingDialog) return no('dialog-open', true)
  // 7. A question wakes immediately, regardless of running children.
  if (wakeable.some((n) => n.kind === 'question')) return { wake: true, reason: 'question' }
  // 8. Threads still being created: the batch is not complete yet.
  if (parent.startingThreads > 0) return no('threads-starting', true)
  // 9. Reports wake at once; the reason says whether other threads still run.
  return { wake: true, reason: children.some((c) => c.running) ? 'progress' : 'converged' }
}

export interface WakeLockState {
  locked: boolean
  suppressed: boolean
}

export const initialWakeLock: WakeLockState = { locked: false, suppressed: false }

/** A wake is wanted: proceed if unlocked, otherwise remember that one was suppressed. */
export function requestWake(s: WakeLockState): { state: WakeLockState; proceed: boolean } {
  if (!s.locked) return { state: { locked: true, suppressed: false }, proceed: true }
  return { state: { locked: true, suppressed: true }, proceed: false }
}

/** The woken turn started/settled: unlock; replay=true if a request was suppressed meanwhile. */
export function releaseWake(s: WakeLockState): { state: WakeLockState; replay: boolean } {
  return { state: { locked: false, suppressed: false }, replay: s.suppressed }
}

export function nextAutoWakeCount(count: number, event: 'auto-wake' | 'user-message-in-coordinator'): number {
  return event === 'auto-wake' ? count + 1 : 0
}
