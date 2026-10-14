/**
 * The browser panel's decisions, as data.
 *
 * Everything here is pure: which of the window's tabs belong to the lane on
 * screen, which one of those is active, whether the native view should be
 * painting at all, and what a typed address bar means. The view
 * (`dom/browserPanelView.ts`) turns these answers into nodes and geometry
 * pushes; it makes none of them itself.
 *
 * DOM-free like the rest of `model/` — these functions are compiled into the
 * base tsconfig program by their tests, which has no DOM lib.
 */

import type { WireBrowserTabInfo } from '../../shellProtocol.js'
import type { SideMode } from './sidePanel.js'

// --- the panel's width --------------------------------------------------------
//
// Stored and clamped exactly the way `model/sidebarWidth.ts` stores the rail's,
// because it is the same kind of thing: a local view preference that never rides
// the wire and never enters project state. Each mode keeps its own: the browser
// needs room for a site's desktop layout, the overview only a column of text.
//
// No stored width means the stylesheet's default — for the browser a share of
// the window rather than a number, so it is not written from here at all.

export const SIDE_WIDTH_STORAGE_KEYS: Readonly<Record<SideMode, string>> = {
  browser: 'hanekawa.browserPanelWidth.v3',
  overview: 'hanekawa.overviewPanelWidth.v1',
}

/** The CSS custom properties the panel rule reads, one per mode. */
export const SIDE_WIDTH_VARIABLES: Readonly<Record<SideMode, string>> = {
  browser: '--browser-panel-width',
  overview: '--overview-panel-width',
}

/** Under this the address bar cannot show a host *and* its controls. */
export const SIDE_WIDTH_MIN = 240
/**
 * The wide end. Past this the transcript, not the panel, is the cramped
 * column — the same reasoning `SIDEBAR_WIDTH_MAX` uses, from the other side.
 */
export const SIDE_WIDTH_MAX = 900

export function clampSideWidth(px: number): number {
  return Math.round(Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, px)))
}

/** A stored width, or `undefined` for the default. Takes the raw `localStorage` string, `null` included. */
export function parseSideWidth(raw: string | null): number | undefined {
  const px = raw === null ? Number.NaN : Number.parseFloat(raw)
  return Number.isFinite(px) ? clampSideWidth(px) : undefined
}

// --- which tabs, and which one --------------------------------------------------

/**
 * The tabs belonging to one lane, in the order the host announced them (which is
 * the order they were opened).
 *
 * A lane of `undefined` has no tabs rather than all of them: before the first
 * `activate` event there is no active pane, and answering with every lane's tabs
 * would draw another session's browser.
 */
export function tabsForLane(
  tabs: readonly WireBrowserTabInfo[],
  lane: string | undefined,
): readonly WireBrowserTabInfo[] {
  if (lane === undefined) return []
  return tabs.filter((tab) => tab.lane === lane)
}

/**
 * The lane's tabs that `known` has never seen.
 *
 * This is the whole of "the agent is asking you to look at something": a tab
 * appearing is a request, while a tab *changing* — finishing a load, renaming
 * itself, navigating, failing — is not. A panel the user closed stays closed
 * through all of the latter, which it could not if arrival were inferred from
 * "this lane has tabs".
 */
export function newTabsForLane(
  tabs: readonly WireBrowserTabInfo[],
  lane: string | undefined,
  known: ReadonlySet<string>,
): readonly WireBrowserTabInfo[] {
  return tabsForLane(tabs, lane).filter((tab) => !known.has(tab.tabId))
}

/**
 * The tab to draw, given what the user last picked.
 *
 * `preferred` wins when it still exists in this lane; otherwise the last tab
 * does, which is what makes "close the active tab" land on its neighbour instead
 * of on nothing. Returns `undefined` only when the lane genuinely has no tabs.
 */
export function resolveActiveTab(
  tabs: readonly WireBrowserTabInfo[],
  lane: string | undefined,
  preferred: string | undefined,
): string | undefined {
  const own = tabsForLane(tabs, lane)
  if (own.length === 0) return undefined
  if (preferred !== undefined && own.some((tab) => tab.tabId === preferred)) return preferred
  return own[own.length - 1]!.tabId
}

/**
 * Whether the native view should be on screen.
 *
 * Four conditions, and the last two are the ones that are easy to forget: a
 * `WebContentsView` is not part of the document, so nothing the stylesheet does
 * — another panel covering the hole, the window being hidden behind another
 * app — stops it painting. It has to be told.
 */
export function shouldShowBrowserView(input: {
  /** The user opened the panel (or the agent opened a tab, which opens it). */
  open: boolean
  /** There is a tab to draw for the active lane. */
  hasActiveTab: boolean
  /** Something in the document covers the hole — the settings screen, a modal. */
  occluded: boolean
  /** `document.visibilityState === 'hidden'`. */
  windowHidden: boolean
  /** The panel is drawing its own page into the hole — see `browserOverlay`. */
  overlaid: boolean
}): boolean {
  return (
    input.open && input.hasActiveTab && !input.occluded && !input.windowHidden && !input.overlaid
  )
}

// --- what the hole shows when the page cannot speak for itself -------------------

/**
 * The panel's own page, for the two moments the site has nothing to draw.
 *
 * Both are cases where the native view would otherwise be a white rectangle the
 * user has to interpret: a tab that has never navigated, and a navigation that
 * failed. The view draws these into the hole *and* tells the page to stop
 * painting — a `WebContentsView` sits above the document, so an overlay under a
 * visible page would never be seen.
 */
export type BrowserOverlay =
  | { kind: 'none' }
  | { kind: 'blank' }
  | { kind: 'error'; url: string; reason: string }

export function browserOverlay(tab: WireBrowserTabInfo | undefined): BrowserOverlay {
  if (tab === undefined) return { kind: 'none' }
  if (tab.error !== undefined) {
    return { kind: 'error', url: tab.errorUrl ?? tab.url, reason: failureReason(tab.error) }
  }
  // Loading is not blank: the first navigation of a fresh tab has begun and the
  // page is about to paint, so replacing it would be a flash of our own text.
  if (tab.url === '' && !tab.loading) return { kind: 'blank' }
  return { kind: 'none' }
}

/**
 * Chromium's `ERR_*` description as something to read.
 *
 * Three named causes cover nearly every failure a person will meet — the name
 * is wrong, nothing answered, nothing answered in time — and anything else
 * keeps its `ERR_` code rather than being flattened into 「其他」: an unmapped
 * code is still the only handle the user has for searching what went wrong.
 */
function failureReason(description: string): string {
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS/.test(description)) return '域名找不到'
  if (/CONNECTION_REFUSED/.test(description)) return '连接被拒'
  if (/TIMED_OUT|TIMEOUT/.test(description)) return '连接超时'
  return description
}

// --- who is driving --------------------------------------------------------------

/** What pressing the control means, `none` being "it cannot be pressed". */
export type BrowserControlAction = 'take-over' | 'release' | 'none'

export interface BrowserControlState {
  label: string
  /** The tooltip, and the button's accessible name. */
  title: string
  disabled: boolean
  action: BrowserControlAction
}

/**
 * The one button that says who is driving this tab, in all three of its states.
 *
 * The disabled one is the state worth spelling out: a tab the user opened with
 * 「＋」 has never been addressed by a session, so there is nobody to interrupt
 * and a press would do nothing at all. Saying so in the tooltip beats a control
 * that looks live and swallows the click.
 */
export function browserControlState(tab: WireBrowserTabInfo | undefined): BrowserControlState {
  if (tab?.takenOver === true) {
    return { label: '交还', title: '把此标签页交还给 agent', disabled: false, action: 'release' }
  }
  if (tab === undefined || tab.agentActive !== true) {
    return { label: '接管', title: '当前没有 agent 在操作此标签页', disabled: true, action: 'none' }
  }
  return {
    label: '接管',
    title: '接管此标签页，暂停 agent 的浏览器操作',
    disabled: false,
    action: 'take-over',
  }
}

/**
 * The line drawn above the page while the agent is driving it, or `undefined`.
 *
 * It is there so a press is not an accident: while it shows, touching the page
 * stops the agent's turn. Gone once the user holds the tab — the badge and
 *「交还」say that — and between turns, when the tab is the user's anyway.
 */
export function browserBanner(tab: WireBrowserTabInfo | undefined): string | undefined {
  if (tab?.agentActive !== true || tab.takenOver === true) return undefined
  return 'agent 正在操作此标签页 · 点击或输入会暂停它'
}

// --- the address bar -------------------------------------------------------------

/**
 * What a typed address means, or `undefined` when it means nothing.
 *
 * Three rules, in order:
 * - A bare `host/path` gets a scheme, because a browser address bar that
 *   demanded one would be the only one in existence: `http://` for a loopback
 *   or private-network host — a dev server almost never speaks TLS, and there
 *   is no fallback to rescue the guess — and `https://` for everything else.
 *   `localhost:3000` is a host and a port, not a `localhost:` scheme.
 * - Only `http:` and `https:` survive. `file:` is the one worth naming: the
 *   panel's partition is the agent's browsing context, and a `file://` tab there
 *   would read the user's disk with the page's own privileges.
 * - Anything that still will not parse is not an address.
 *
 * Deliberately *not* a search fallback: a typo would otherwise silently leave
 * the user's words with a search engine.
 */
export function normalizeAddress(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  // A scheme is letters then a colon — unless all that follows the colon is a
  // port, which makes the letters a host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(trimmed)
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return undefined
  }
  if (!hasScheme && isLocalHost(parsed.hostname)) parsed.protocol = 'http:'
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  // A host is what makes this an address rather than a scheme with a path.
  if (parsed.hostname === '') return undefined
  return parsed.href
}

/** Loopback and private-network hosts: where a typed address means plain http. */
function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '[::1]' || hostname === '0.0.0.0') return true
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname)
  if (ipv4 === null) return false
  const a = Number(ipv4[1])
  const b = Number(ipv4[2])
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * What the address bar shows when it does not have focus.
 *
 * The host alone, not the full URL: the panel is narrow, and the host is the
 * part that answers "what am I looking at". A tab that has never navigated shows
 * nothing rather than `about:blank`, so the field reads as empty and ready.
 *
 * A failed navigation never commits, so `url` is still the page the user left.
 * The bar shows the address they actually typed instead — the one the error page
 * beneath it is about, and the one they are most likely to want to edit.
 */
export function addressLabel(tab: WireBrowserTabInfo | undefined): string {
  if (tab === undefined) return ''
  const shown = tab.error !== undefined ? tab.errorUrl ?? tab.url : tab.url
  if (shown === '') return ''
  try {
    return new URL(shown).host
  } catch {
    return shown
  }
}

/**
 * A tab's label in the strip.
 *
 * The title once there is one, the host until then, and a placeholder for a tab
 * that has never navigated — a strip of identical `about:blank` rows would be
 * unusable, and this is the one moment where the tab has nothing to say for
 * itself.
 */
export function tabLabel(tab: WireBrowserTabInfo): string {
  if (tab.title !== '') return tab.title
  const host = addressLabel(tab)
  return host === '' ? '新标签页' : host
}
