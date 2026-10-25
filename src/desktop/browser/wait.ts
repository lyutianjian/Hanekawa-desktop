/**
 * Waiting for the page to say something.
 *
 * `tab.wait_for_load` answers "is the navigation over"; this answers "is the
 * thing I need there yet", which is the question a single-page app actually
 * makes you ask — the load finished long before the list rendered.
 *
 * Electron-free, like `input.ts`, and for the same reason: everything
 * interesting here is the loop's behaviour at the edges, which needs a stub
 * evaluator and an injectable clock, not a window.
 *
 * Two decisions worth keeping:
 *
 * - **A timeout reports what it saw.** The last observation travels with the
 *   error, so "the button never appeared" can be told apart from "the page was
 *   still showing a spinner" without a second round trip. Before the first
 *   observation lands it says so in as many words.
 * - **`stableForMs` is continuous.** A poll that misses restarts the clock, and
 *   so does a document swap: stability on the page being left says nothing.
 * - **A navigation mid-wait is evidence, not a failure.** The condition is about
 *   the document the tab ends up on; a document swap is noted in the answer and
 *   the wait continues, because refusing would leave the model with nothing.
 */

import { withinBounds } from './bounds.js'
import type { ConditionOptions, ConditionResult, ConditionState } from './inject/bundle.js'
import { conditionScript, unwrap } from './inject/bundle.js'
import { BrowserHostError } from './errors.js'
import {
  FIELD_MAX_TEXT,
  SCAN_BUDGET_MS,
  SCAN_MAX_NODES,
  SENSITIVE_AUTOCOMPLETE,
  WAIT_POLL_INTERVAL_MS,
} from './limits.js'

export type UrlMatch = 'exact' | 'prefix' | 'contains'

export interface WaitCondition {
  selector?: string
  text?: string
  state?: ConditionState
  /**
   * The condition must hold on every poll for this long before the wait
   * returns, so a page still animating or re-rendering is not caught mid-way.
   */
  stableForMs?: number
  /** The tab's committed URL, compared by `urlMatch` (default `prefix`). */
  url?: string
  urlMatch?: UrlMatch
}

export interface WaitDeps {
  evaluate: (script: string) => Promise<unknown>
  /** The tab's navigation generation, or `undefined` once its page is gone. */
  generation: () => number | undefined
  check: () => void
  /**
   * The tab's committed URL, or `undefined` while it has no page. Only read
   * when the condition names a URL. Committed means a navigation still in
   * flight keeps reporting the page it is leaving — which is exactly what a
   * wait for the new address needs not to be fooled by.
   */
  url?: () => string | undefined
  timeoutMs: number
  signal?: AbortSignal
  /** Monotonic. A clock adjustment must not end a wait early or hang it. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WaitOutcome {
  text: string
}

const NOT_OBSERVED = 'Not observed yet.'

/** States about one element, which a text match cannot answer. */
const ELEMENT_STATES: ReadonlySet<ConditionState> = new Set(['enabled', 'disabled', 'checked', 'unchecked'])

export async function waitForCondition(deps: WaitDeps, condition: WaitCondition): Promise<WaitOutcome> {
  const wantsUrl = (condition.url ?? '') !== ''
  const wantsPage = (condition.selector ?? '') !== '' || (condition.text ?? '') !== ''
  if (!wantsUrl && !wantsPage) {
    throw new BrowserHostError('INVALID_REQUEST', 'page.wait_for needs a "selector", a "text" or a "url".')
  }
  const state = condition.state ?? 'visible'
  if (ELEMENT_STATES.has(state) && ((condition.selector ?? '') === '' || (condition.text ?? '') !== '')) {
    throw new BrowserHostError('INVALID_REQUEST', `page.wait_for with state "${state}" needs a "selector" and no "text".`)
  }
  const stableForMs = Math.max(0, condition.stableForMs ?? 0)
  const urlMatch = condition.urlMatch ?? 'prefix'
  const options: ConditionOptions = {
    state,
    maxNodes: SCAN_MAX_NODES,
    budgetMs: SCAN_BUDGET_MS,
    segmentMax: FIELD_MAX_TEXT,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
  }
  if (condition.selector !== undefined) options.selector = condition.selector
  if (condition.text !== undefined) options.text = condition.text

  const now = deps.now ?? (() => performance.now())
  const sleep = deps.sleep ?? defaultSleep
  const script = conditionScript(options)
  const startGeneration = deps.generation()
  const deadline = now() + deps.timeoutMs
  let lastObserved = NOT_OBSERVED
  let documentChanged = false
  /** When the condition started holding without a break, or `undefined` while it does not. */
  let heldSince: number | undefined
  let heldGeneration: number | undefined

  for (;;) {
    deps.check()
    if (deps.signal?.aborted === true) {
      throw new BrowserHostError('OPERATION_ABORTED', 'The wait was cancelled.')
    }

    // The URL is asked first and without the page: a wait for an address has
    // to keep working while the navigation to it has no document to ask.
    let urlSeen: string | undefined
    let urlOk = true
    if (wantsUrl) {
      urlSeen = deps.url?.()
      urlOk = urlSeen !== undefined && urlMatches(urlSeen, condition.url as string, urlMatch)
      lastObserved = `url=${urlSeen ?? '(no page)'}`
    }

    let result: ConditionResult | undefined
    if (wantsPage && urlOk) {
      // Bounded by what is left of the caller's wait, so a page that stops
      // answering mid-wait cannot outlive the wait that asked: the poll comes
      // back as "not observed yet" and the loop's own deadline ends it with the
      // last thing it did see.
      const budget = Math.max(1, deadline - now())
      try {
        result = unwrap<ConditionResult>(
          await withinBounds(
            { ...(deps.signal === undefined ? {} : { signal: deps.signal }), timeoutMs: budget },
            'checking the page',
            () => deps.evaluate(script),
          ),
        )
      } catch (error) {
        // `retryable` is the whole distinction: a page that is navigating cannot
        // answer yet and will, while a bad selector or a closed tab never will.
        if (!isRetryable(error)) throw error
        lastObserved = error instanceof Error ? error.message : String(error)
      }
      deps.check()
    }
    if (deps.generation() !== startGeneration) documentChanged = true

    const note = documentChanged ? ' (the document changed while waiting)' : ''
    let success: string | undefined
    if (!wantsPage && urlOk) {
      success = `url ${describeUrlMatch(urlMatch)} ${condition.url}${note}. url=${urlSeen}`
    }
    if (result !== undefined) {
      lastObserved = wantsUrl ? `url=${urlSeen}; ${result.observed}` : result.observed
      if (result.matched) {
        const prefix = wantsUrl ? `url ${describeUrlMatch(urlMatch)} ${condition.url}, and ` : ''
        success = `${prefix}${result.observed}${note}. url=${result.url} title=${result.title}`
      }
    }

    let waitMs = WAIT_POLL_INTERVAL_MS
    if (success === undefined) {
      heldSince = undefined
    } else {
      const generation = deps.generation()
      const at = now()
      if (heldSince === undefined || heldGeneration !== generation) {
        heldSince = at
        heldGeneration = generation
      }
      const held = at - heldSince
      if (held >= stableForMs) {
        return { text: stableForMs > 0 ? `${success} (held for ${Math.round(held)}ms)` : success }
      }
      lastObserved = `${lastObserved} (held ${Math.round(held)}ms of the ${stableForMs}ms asked for)`
      waitMs = Math.min(waitMs, stableForMs - held)
    }

    if (now() >= deadline) {
      throw Object.assign(
        new BrowserHostError(
          'WAIT_TIMEOUT',
          `The condition was not met within ${deps.timeoutMs}ms. Last seen: ${lastObserved}`,
        ),
        { lastObserved },
      )
    }
    await sleep(Math.max(1, Math.min(waitMs, deps.timeoutMs)))
  }
}

export function urlMatches(actual: string, wanted: string, how: UrlMatch): boolean {
  if (how === 'exact') return actual === wanted
  if (how === 'contains') return actual.includes(wanted)
  return actual.startsWith(wanted)
}

function describeUrlMatch(how: UrlMatch): string {
  return how === 'exact' ? 'is' : how === 'contains' ? 'contains' : 'starts with'
}

function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === true
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
