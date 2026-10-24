/**
 * The quit state machine: `idle` → `draining` → `ready`.
 *
 * Electron does not await an async `before-quit` handler. The old single
 * `quitting` flag marked "draining" and "released" alike, so a second request
 * during the drain was let through; only `ready` may now release a quit.
 */
export type QuitPhase = 'idle' | 'draining' | 'ready'

export interface QuitCoordinatorOptions {
  /** Called exactly once. */
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

  /** True when the caller must `preventDefault()`: every request until `ready`. */
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
      this.options.onError?.(error)
    }
  }
}
