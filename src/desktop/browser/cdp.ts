/**
 * The one place the projection actually touches Electron.
 *
 * Everything else in this directory below `tabs.ts` is pure: the collectors are
 * source text, the cache and the encoder are arithmetic. This file is the seam,
 * and it stays thin so the rest can be tested in a plain `node:test` process.
 *
 * Automation runs in isolated world 1001 — not the page's world. The page cannot
 * see the collectors, cannot shadow the globals they read through anything but
 * the DOM itself, and cannot intercept the result on its way out. Combined with
 * the tab host's missing preload, that is the whole security story: the page has
 * no host capability to reach, and the automation has no page script to trip over.
 */

import { withinBounds, type CallBounds } from './bounds.js'
import { cdpSessionFor } from './cdpSession.js'
import { BrowserHostError } from './errors.js'
import type { BrowserPage } from './tabs.js'
import { AUTOMATION_WORLD_ID } from './limits.js'

export type PageEvaluator = (script: string) => Promise<unknown>
export type CdpSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * Runs a built script in the tab's automation world.
 *
 * Failures come back as `PAGE_NOT_READY` with `retryable: true` on purpose: at
 * this layer the difference between "navigating right now", "renderer restarted"
 * and "frame detached mid-call" is not observable, and all three are answered by
 * waiting and asking again. A genuinely absent tab is `TAB_NOT_FOUND`, and that
 * decision is made above, by whoever looked the tab up.
 *
 * Both entry points also carry the caller's `CallBounds`: a page that never
 * answers — an `alert()`, a script looping in its own event loop, a renderer
 * that stopped replying — ends the call instead of holding the tab's queue and
 * its CDP lease forever. See `bounds.ts` for what that does and does not claim.
 */
export function pageEvaluator(page: BrowserPage, bounds?: CallBounds): PageEvaluator {
  return (script: string) => withinBounds(bounds, 'reading the page', async () => {
    const contents = page.contents
    if (contents.isDestroyed()) {
      throw new BrowserHostError('PAGE_NOT_READY', 'The page is gone. Reload the tab and try again.', true)
    }
    try {
      // On `WebContents`, not on `mainFrame`: the frame-level overload is the
      // renderer-side `webFrame` API, and this process only has the other one.
      return await contents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD_ID, [
        { code: script, url: 'hanekawa://automation' },
      ])
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new BrowserHostError('PAGE_NOT_READY', `The page could not be read: ${detail}`, true)
    }
  })
}

/**
 * The input channel: raw CDP, through the tab's counted attachment.
 *
 * Input is the one thing that cannot be done from the automation world. A
 * synthesized `click()` or `KeyboardEvent` carries `isTrusted: false`, skips the
 * browser's own focus and hover bookkeeping, and is ignored outright by anything
 * that checks — so presses and keystrokes go in through the debugger instead,
 * where Chromium treats them as it treats the user's.
 *
 * Attaching, detaching and stepping aside for DevTools are `cdpSession.ts`'s.
 */
export function cdpSender(page: BrowserPage, bounds?: CallBounds): CdpSender {
  return (method, params) => withinBounds(
    bounds,
    `sending the input command ${method}`,
    () => cdpSessionFor(page.contents).send(method, params),
  )
}

/** A lease on the tab's attachment, held for the length of one action. */
export function cdpLease(page: BrowserPage): () => () => void {
  return () => cdpSessionFor(page.contents).acquire()
}

/**
 * The page behind a tab, or the reason there isn't one.
 *
 * `TAB_NOT_FOUND` and `PAGE_NOT_READY` are kept apart because the model's next
 * move differs: the first means the tab id is wrong — list the tabs — and the
 * second means wait for the load.
 */
export function requirePage(page: BrowserPage | undefined, tabId: string): BrowserPage {
  if (page === undefined) {
    throw new BrowserHostError('TAB_NOT_FOUND', `No such browser tab: ${tabId}. Call browser.get_state for the list.`)
  }
  if (!page.domReady) {
    throw new BrowserHostError(
      'PAGE_NOT_READY',
      'The page has not finished loading. Wait for the load and try again.',
      true,
    )
  }
  return page
}
