/**
 * How long one call into the page may take, and what a cancellation means.
 *
 * `executeJavaScriptInIsolatedWorld` and `debugger.sendCommand` both return
 * promises that can simply never settle: a page showing an `alert()` blocks its
 * own event loop, a page script that loops forever never yields, and a renderer
 * that went away takes the reply with it. The layers above check cancellation
 * *between* awaits, which is useless if the await never returns — so the shared
 * entry point gets a deadline, and a caller's abort settles it too.
 *
 * Two things this deliberately does not do:
 *
 * - **It cannot stop the page.** The script has already been handed to the
 *   renderer; racing it against a timer only stops *waiting*. Anything it did
 *   before it hung — a click that already landed, a form already submitted —
 *   stays done, which is why the timeout message says so instead of claiming the
 *   page was interrupted.
 * - **It cannot rescue the tab.** Recovery is the user's call: reloading or
 *   closing their tab on a timeout is a bigger intervention than a failed tool
 *   call, so a timeout is a retryable error and nothing else.
 *
 * Once settled, a late result from the page is dropped: nothing downstream can
 * see it, so no follow-up click, keystroke or navigation rides on a reply that
 * arrived after the action was cancelled.
 */

import { BrowserHostError } from './errors.js'
import { AUTOMATION_CALL_TIMEOUT_MS } from './limits.js'

export interface CallBounds {
  /**
   * The caller's cancel signal. When it fires the call settles as cancelled at
   * once, rather than at the next check the caller never reaches.
   */
  signal?: AbortSignal
  /** The deadline for this call. Defaults to `AUTOMATION_CALL_TIMEOUT_MS`. */
  timeoutMs?: number
}

/** The one cancellation error, matching what the host's `check()` raises. */
export function abortedError(): BrowserHostError {
  return new BrowserHostError('OPERATION_ABORTED', 'The browser action was cancelled.')
}

/**
 * The page stopped answering. Retryable on purpose: at this layer a hung script
 * and a renderer restarting look alike, and both are answered by trying again
 * once the page is usable — never by this layer reloading the tab itself.
 */
export function stuckError(what: string, timeoutMs: number): BrowserHostError {
  return new BrowserHostError(
    'PAGE_NOT_READY',
    `The page did not answer within ${timeoutMs}ms while ${what}: a dialog, a long-running script or the page's renderer is stuck. The wait was ended, but anything the action had already done to the page stays done. The tab was left as it is. If it stays unresponsive, reload it or ask the user to close the dialog.`,
    true,
  )
}

/**
 * Runs `start` with a deadline and a cancel signal, settling exactly once.
 *
 * The abort listener is installed before `start` so a cancel that lands during
 * the call — including one fired synchronously from `start` itself — is still
 * observed; the timer and the listener are both removed when the call settles,
 * so a hung page leaves no timer holding the process open.
 */
export function withinBounds<T>(
  bounds: CallBounds | undefined,
  what: string,
  start: () => Promise<T>,
): Promise<T> {
  const signal = bounds?.signal
  if (signal?.aborted === true) return Promise.reject(abortedError())
  const timeoutMs = bounds?.timeoutMs ?? AUTOMATION_CALL_TIMEOUT_MS

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      finish()
    }
    const timer = setTimeout(() => settle(() => reject(stuckError(what, timeoutMs))), timeoutMs)
    const onAbort = (): void => settle(() => reject(abortedError()))
    signal?.addEventListener('abort', onAbort, { once: true })

    let work: Promise<T>
    try {
      work = start()
    } catch (error) {
      settle(() => reject(error))
      return
    }
    // Handlers are attached whatever happens to the race, so a late rejection
    // from the page is consumed here rather than surfacing as unhandled.
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    )
  })
}