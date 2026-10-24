/**
 * The quit state machine: `idle` → `draining` → `ready`.
 *
 * Electron does not await an async `before-quit` handler, so `main.ts` has to
 * cancel the quit itself, drain the process, and then ask again. The old single
 * `quitting` flag could not express the middle state: any further quit request
 * — the user pressing ⌘Q twice, `window-all-closed` firing while the drain is
 * still closing projects — saw `true` and was let through, exiting out from
 * under the drain it was waiting for.
 *
 * Only the `ready` state lets a quit through, and the only transition into it is
 * the one `drain()` makes after teardown settles. Electron-free so the wiring in
 * `main.ts` stays one line and this can be tested under plain node.
 */
export type QuitPhase = 'idle' | 'draining' | 'ready'

export interface QuitCoordinatorOptions {
  /** Lanes, window, then projects — called exactly once. */
  teardown: () => Promise<void>
  /** The single `app.quit()` after the drain settles, success or failure. */
  release: () => void
  /** A failed drain, reported before the forced release. */
  onError?: (error: unknown) => void
}

export class QuitCoordinator {
  private phase: QuitPhase = 'idle'

  constructor(private readonly options: QuitCoordinatorOptions) {}

  /** Draining and released both count: the process is already leaving. */
  isQuitting(): boolean {
    return this.phase !== 'idle'
  }

  /**
   * One `before-quit`. Returns true when the caller must `preventDefault()`:
   * every request until the drain has settled, and false only for the release.
   */
  onBeforeQuit(): boolean {
    if (this.phase === 'ready') return false
    if (this.phase === 'idle') {
      this.phase = 'draining'
      void this.drain()
    }
    return true
  }

  private async drain(): Promise<void> {
    try {
      await this.options.teardown()
    } catch (error) {
      this.options.onError?.(error)
    }
    this.phase = 'ready'
    try {
      this.options.release()
    } catch (error) {
      // Nothing is left to call after a failed release; reporting it is the
      // whole of what a drained process can do.
      this.options.onError?.(error)
    }
  }
}