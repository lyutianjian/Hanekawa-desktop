/**
 * How many panes stay resident, and which ones go when there are too many.
 *
 * Clicking a session in the sidebar opens it as a lane and *keeps it alive* —
 * that is the whole point of the single-window design: a background pane keeps
 * streaming and its prompts keep parking until the user comes back. Which means
 * a long afternoon of browsing history would otherwise accumulate one
 * `SessionHost`, one `AgentLoop` and one `FileHistoryService` per session
 * clicked. This module is the cap.
 *
 * Pure and free of both DOM and Electron, for the same reason `model/` is: the
 * decision is what has to be tested, and the application of it (`closePane` on
 * the chosen lane's client) is two lines in `app.ts`.
 *
 * Eviction is not closing a session — the session stays on disk and reopening it
 * costs a fresh pane. It is releasing the *runtime*, which is why nothing here
 * asks whether the session has unsaved anything.
 */

/** Resident panes. Four is enough to keep a comparison alive without a fleet of loops. */
export const DEFAULT_PANE_LIMIT = 4

export interface PaneBudgetEntry {
  readonly lane: string
  /** The pane on screen. Evicting it would blank the window. */
  readonly active: boolean
  /** A turn is in flight. Evicting it would kill work the user is waiting for. */
  readonly streaming: boolean
  /** Initial state is still loading, or messages are waiting to start a turn. */
  readonly pending: boolean
  /**
   * A blocking request is waiting for an answer.
   *
   * Load-bearing rather than polite: `ToolRunner.run` does not pass its abort
   * signal into `PermissionGate.approve`, so a parked prompt is not released by
   * interrupting. Evicting the pane holding it would tear down the only UI that
   * could answer — and the pane's teardown drains the bridge with a *denial*, so
   * the user's tool silently fails instead of asking.
   */
  readonly blocked: boolean
  /**
   * A background process the loop started is still running. Evicting the
   * project's last pane shuts the project down, which kills it.
   */
  readonly processes: boolean
  /** The lane owns browser tabs, which die with the lane. */
  readonly tabs: boolean
  /**
   * The project's coordinator. Evicting it orphans its threads' coordination
   * (they report back to a pane that no longer exists), so it stays resident
   * even when idle — a thread is still evictable.
   */
  readonly coordinator: boolean
  /** The window's unsent new session, kept so its typed prompt survives switching away. */
  readonly draft: boolean
  /**
   * When this pane was last activated, as a monotonic counter rather than a
   * clock: `Date.now()` ties are real (two activations inside a millisecond) and
   * a test that has to sleep to order its fixtures is a test that will flake.
   */
  readonly lastActiveTick: number
}

export interface PaneBudgetInput {
  readonly entries: readonly PaneBudgetEntry[]
  readonly limit: number
}

/**
 * The lanes to release, oldest first, to bring the resident count down to
 * `limit`.
 *
 * A pane is *pinned* when it is active, streaming, loading or queued, holding an unanswered blocking
 * request, running a background process, owning browser tabs, being a
 * project's coordinator, or being the unsent new session — every state whose teardown loses something. Pinned
 * panes are never returned, and when everything left is pinned this deliberately returns **fewer** lanes than the limit demands: going
 * over budget costs memory, and killing a running turn costs the user their
 * work. Budget loses that argument every time.
 *
 * Order within the result is oldest-activated first, so a caller that applies
 * only part of the list still evicts the coldest panes.
 */
export function selectEvictions(input: PaneBudgetInput): string[] {
  const limit = Math.max(0, input.limit)
  const excess = input.entries.length - limit
  if (excess <= 0) return []

  const evictable = input.entries
    .filter((entry) => !isPinned(entry))
    // Stable by lane on a tick tie: a never-activated pane and its neighbour
    // must not swap between runs, or "the coldest one goes" stops being a fact.
    .sort((a, b) => a.lastActiveTick - b.lastActiveTick || compareLanes(a.lane, b.lane))

  return evictable.slice(0, excess).map((entry) => entry.lane)
}

/** Whether this pane is exempt from eviction, and why is in the field docs above. */
export function isPinned(entry: PaneBudgetEntry): boolean {
  return (
    entry.active ||
    entry.streaming ||
    entry.pending ||
    entry.blocked ||
    entry.processes ||
    entry.tabs ||
    entry.coordinator ||
    entry.draft
  )
}

/**
 * Lane keys are minted as decimal counters (`ShellHost.nextLaneKey`), so a
 * numeric comparison is the one that agrees with open order; anything
 * non-numeric falls back to a string compare rather than to `NaN`.
 */
function compareLanes(a: string, b: string): number {
  const left = Number(a)
  const right = Number(b)
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right
  return a < b ? -1 : a > b ? 1 : 0
}
