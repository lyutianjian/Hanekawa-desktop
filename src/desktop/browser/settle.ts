/**
 * Waiting for the page to stop moving: the network quiet, no animation that
 * will end still running, fonts in, and the layout the same on two polls.
 *
 * The point is the report as much as the wait. A screenshot taken while a
 * drawer is still sliding is not a bug in the drawer, and a model shown one
 * without being told will go and "fix" it. So the answer always says whether
 * the page settled — and when it did not, what was still going on.
 *
 * Never a failure: a page that stays busy (a ticking clock, a beacon every
 * second) runs into the cap and the caller carries on with what it has. The
 * one exception is the caller's own abort or a takeover, raised by `check`.
 *
 * Electron-free like `wait.ts`, and for the same reason.
 */

import { withinBounds } from './bounds.js'
import type { SettleProbe } from './inject/bundle.js'
import { settleScript, unwrap } from './inject/bundle.js'
import { LONG_REQUEST_MS, NETWORK_QUIET_MS, SCAN_MAX_NODES, WAIT_POLL_INTERVAL_MS } from './limits.js'
import type { NetworkState } from './network.js'

export interface SettleDeps {
  evaluate: (script: string) => Promise<unknown>
  network: () => NetworkState
  /** The tab's navigation generation; a document swap restarts the stability clock. */
  generation: () => number | undefined
  check: () => void
  timeoutMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface SettleReport {
  settled: boolean
  waitedMs: number
  /** What was still going on at the cap; when settled, the long requests it stopped waiting for. */
  busy: string[]
}

/** How many elements the layout hash reads. The top of the page is what a screenshot shows. */
const LAYOUT_ELEMENTS = 400
const URLS_NAMED = 3

export async function waitForSettle(deps: SettleDeps): Promise<SettleReport> {
  const now = deps.now ?? (() => performance.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const script = settleScript(Math.min(LAYOUT_ELEMENTS, SCAN_MAX_NODES))
  const started = now()
  let previous: { layout: number; generation: number | undefined } | undefined

  for (;;) {
    deps.check()
    const busy: string[] = []
    let probe: SettleProbe | undefined
    // Stability needs two looks, so the first poll can never settle on its own.
    let steady = false
    try {
      // A poll is bounded by what is left of the settle window, so a page that
      // stopped answering reads as "could not be read" and the report goes out on
      // time: settling is a courtesy, and its cap is the promise it makes.
      probe = unwrap<SettleProbe>(
        await withinBounds(
          { timeoutMs: Math.max(1, deps.timeoutMs - (now() - started)) },
          'checking whether the page settled',
          () => deps.evaluate(script),
        ),
      )
    } catch {
      busy.push('the page could not be read (navigating?)')
    }
    deps.check()
    const generation = deps.generation()

    if (probe !== undefined) {
      if (probe.readyState === 'loading') busy.push('the document is still parsing')
      if (probe.animations > 0) busy.push(`${probe.animations} animation${probe.animations === 1 ? '' : 's'} running`)
      if (probe.fontsLoading) busy.push('fonts loading')
      if (previous !== undefined) {
        steady = previous.layout === probe.layout && previous.generation === generation
        if (!steady) busy.push('the layout is still changing')
      }
      previous = { layout: probe.layout, generation }
    }

    const network = deps.network()
    const active = network.pending.filter((request) => request.ageMs < LONG_REQUEST_MS)
    const long = network.pending.filter((request) => request.ageMs >= LONG_REQUEST_MS)
    if (active.length > 0) busy.push(`${active.length} request${active.length === 1 ? '' : 's'} in flight: ${nameUrls(active)}`)
    else if (network.quietMs < NETWORK_QUIET_MS) busy.push('the network went quiet only just now')

    const waitedMs = Math.round(now() - started)
    if (busy.length === 0 && steady) {
      return {
        settled: true,
        waitedMs,
        busy: long.length > 0 ? [`${long.length} long-running request${long.length === 1 ? '' : 's'} not waited for: ${nameUrls(long)}`] : [],
      }
    }
    if (now() - started >= deps.timeoutMs) {
      if (long.length > 0) busy.push(`${long.length} long-running request${long.length === 1 ? '' : 's'}: ${nameUrls(long)}`)
      return { settled: false, waitedMs, busy }
    }
    await sleep(Math.max(1, Math.min(WAIT_POLL_INTERVAL_MS, deps.timeoutMs - (now() - started))))
  }
}

/** The one line a screenshot or an action carries about it. */
export function describeSettle(report: SettleReport): string {
  if (report.settled) {
    const extra = report.busy.length > 0 ? ` (${report.busy.join('; ')})` : ''
    return `The page was settled after ${report.waitedMs}ms${extra}.`
  }
  return `The page was still changing after ${report.waitedMs}ms: ${report.busy.join('; ')}. What it shows may be mid-transition.`
}

function nameUrls(requests: readonly { url: string }[]): string {
  const named = requests.slice(0, URLS_NAMED).map((request) => shortUrl(request.url))
  return requests.length > URLS_NAMED ? `${named.join(', ')} and ${requests.length - URLS_NAMED} more` : named.join(', ')
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 60 ? `${parsed.pathname.slice(0, 57)}...` : parsed.pathname
    return `${parsed.host}${path}`
  } catch {
    return url.slice(0, 80)
  }
}
