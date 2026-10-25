/**
 * What happens when the renderer dies and the window is still there.
 *
 * A crashed renderer is not a closed window: `closed` never fires, so the
 * ordinary "reopen from the Dock" path does not apply, and every lane's
 * transport is dead while the main process — turns, tools, projects — keeps
 * running. The window that is left draws nothing at all, which is why the app
 * has to offer a way back instead of waiting for the user to guess.
 *
 * The state machine is small on purpose:
 *
 * - **One recovery at a time.** A second crash report while a rebuild is
 *   running is a log line, not a second rebuild: two windows over one set of
 *   projects is the failure this guards. The flag is cleared when the run
 *   ends, success or failure, so a later crash still gets an answer.
 * - **The user decides.** A native dialog offers to rebuild the window. The
 *   hang of an auto-restart loop and a permanently dead window are both worse
 *   than one question.
 * - **Retry is bounded.** A rebuild that throws is reported once with the
 *   choice to try again; the second failure ends the process rather than
 *   leaving a window that will never paint.
 * - **Nothing is restored that was never written.** The lanes come in already
 *   filtered to sessions the store can resolve; a draft whose first message
 *   never landed has no record to reopen, and pretending otherwise would invent
 *   a session that did not exist.
 *
 * Quitting wins every time: during `before-quit` the teardown owns the window,
 * and a recovery racing it would build a window on the way out.
 */

/** The `details` of Electron's `render-process-gone`. */
export interface RendererGoneDetails {
  reason: string
  exitCode: number
}

/** A lane that was on screen, in the order it was opened. */
export interface RestorableLane {
  cwd: string
  sessionId: string
  /** Opened through the coordination entry rather than the ordinary one. */
  coordination: boolean
}

export interface RendererRecoveryOptions {
  /** Already leaving: the teardown owns the window, so there is nothing here to do. */
  isQuitting: () => boolean
  /** Asks the user. `false` means quit instead of rebuilding. */
  confirm: (details: RendererGoneDetails) => Promise<boolean>
  /** Read before the dead window goes: what can be reopened, and nothing else. */
  captureLanes: () => Promise<readonly RestorableLane[]>
  /** Destroys the dead window, waits for what it owned to settle, rebuilds it, reopens the lanes. */
  rebuild: (lanes: readonly RestorableLane[]) => Promise<void>
  /** A failed rebuild. `retry` runs it again; `quit` ends the process. */
  reportFailure: (error: unknown, attempt: number) => Promise<'retry' | 'quit'>
  quit: () => void
  log?: (message: string) => void
}

/** One retry: a second consecutive failure is a broken install, not a hiccup. */
export const RENDERER_RECOVERY_ATTEMPTS = 2

export class RendererRecovery {
  private inFlight: Promise<void> | undefined

  constructor(private readonly options: RendererRecoveryOptions) {}

  /** True while a rebuild is running — the caller may want to skip unrelated work. */
  isRecovering(): boolean {
    return this.inFlight !== undefined
  }

  /**
   * Handles one `render-process-gone`. Never rejects: every failure ends in
   * either a retry, a quit, or a log line, and an unhandled rejection here would
   * take down the very process that is trying to come back.
   */
  handle(details: RendererGoneDetails): Promise<void> {
    if (this.inFlight !== undefined) {
      this.log(`渲染进程再次退出（${details.reason}/${details.exitCode}），上一次恢复尚未结束，忽略`)
      return this.inFlight
    }
    const run = this.run(details).finally(() => {
      this.inFlight = undefined
    })
    this.inFlight = run
    return run
  }

  private async run(details: RendererGoneDetails): Promise<void> {
    const { options } = this
    if (options.isQuitting()) {
      this.log(`渲染进程退出（${details.reason}/${details.exitCode}），应用正在退出`)
      return
    }
    this.log(`渲染进程意外退出：reason=${details.reason} exitCode=${details.exitCode}`)

    let lanes: readonly RestorableLane[] = []
    try {
      lanes = await options.captureLanes()
    } catch (error) {
      // Worth a log, not worth blocking the question: a window that paints with
      // no lane is still better than a white one.
      this.log(`读取待恢复会话失败：${describe(error)}`)
    }

    let decision: boolean
    try {
      decision = await options.confirm(details)
    } catch (error) {
      this.log(`恢复询问失败：${describe(error)}`)
      options.quit()
      return
    }
    if (options.isQuitting()) return
    if (!decision) {
      this.log('用户选择关闭窗口')
      options.quit()
      return
    }

    for (let attempt = 1; attempt <= RENDERER_RECOVERY_ATTEMPTS; attempt++) {
      if (options.isQuitting()) return
      try {
        await options.rebuild(lanes)
        this.log(lanes.length === 0 ? '窗口已重建，没有可恢复的会话' : `窗口已重建，恢复了 ${lanes.length} 个会话`)
        return
      } catch (error) {
        this.log(`第 ${attempt} 次恢复失败：${describe(error)}`)
        let verdict: 'retry' | 'quit'
        try {
          verdict = await options.reportFailure(error, attempt)
        } catch (reportError) {
          this.log(`恢复失败提示无法显示：${describe(reportError)}`)
          verdict = 'quit'
        }
        if (attempt >= RENDERER_RECOVERY_ATTEMPTS || verdict === 'quit') {
          this.log('放弃恢复，退出应用')
          options.quit()
          return
        }
      }
    }
  }

  private log(message: string): void {
    this.options.log?.(`[hanekawa] ${message}`)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
