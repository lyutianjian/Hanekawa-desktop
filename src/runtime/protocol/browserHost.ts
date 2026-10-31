/**
 * The contract between the `Browser` tool and whatever owns real tabs.
 *
 * It lives here, in the Electron-free protocol layer, because the two sides may
 * not see each other: `src/tools/` is shared with the TUI and must never import
 * Electron, and `src/desktop/browser/` is nothing but Electron. Types are the
 * only thing that crosses.
 *
 * Every call is scoped by a `BrowserCaller` — a session and its current turn — rather than by a lane. The tool knows
 * which conversation it is running in and nothing about the window's topology;
 * resolving a session to a lane — and, from phase 5, deciding whether that
 * session still holds the browser — belongs to the implementation.
 *
 * Failures are thrown, not returned: the implementation raises an error
 * carrying a `code` (and, for the ones worth retrying, `retryable: true`), and
 * the tool renders it. Nothing here imports that error class, so the shape is
 * read structurally.
 */

export interface BrowserTabState {
  tabId: string
  /** The committed URL, or `''` for a tab that has never navigated. */
  url: string
  title: string
  loading: boolean
  /** The last navigation failure, cleared when a new navigation starts. */
  error?: string
  /** The user took this tab back; from phase 5 that also blocks the agent. */
  takenOver?: boolean
  /** Downloads the page started, cancelled by the browser: their file names, oldest first. */
  blockedDownloads?: string[]
  /**
   * JavaScript errors this page logged that the caller has not been shown yet,
   * oldest first; each is reported once. A page whose console says why a click
   * did nothing is otherwise indistinguishable from one that ignored it.
   */
  consoleErrors?: string[]
  /** Only from `waitForLoad` until `networkidle`: whether the page then settled, in one line. */
  settle?: string
}

/** One page of a projection, already rendered. The tool passes it through. */
export interface BrowserSnapshot {
  text: string
  snapshotId: string
  /** Present only while there is more to read. Feed it back verbatim. */
  cursor?: string
  scanTruncated: boolean
  total: number
  /** Console errors not yet reported; see `BrowserTabState.consoleErrors`. */
  consoleErrors?: string[]
}

export interface BrowserScreenshot {
  bytes: Buffer
  name: string
  /** The image's pixel size. */
  width: number
  height: number
  /**
   * The viewport the image shows, in CSS pixels, when the page answered; the
   * space `page.click_at` takes. `width / cssWidth` is the capture's scale.
   */
  cssWidth?: number
  cssHeight?: number
  /** Whether the page had stopped moving when it was captured, in one line; absent when not waited for. */
  settle?: string
  /** Console errors not yet reported; see `BrowserTabState.consoleErrors`. */
  consoleErrors?: string[]
}

export interface BrowserScreenshotRequest {
  /** Wait for the page to stop moving first. Default true. */
  settle?: boolean
  signal?: AbortSignal
}

export interface BrowserElementsRequest {
  scope?: string
  role?: string
  text?: string
  interactiveOnly?: boolean
  visibleOnly?: boolean
  /** Add a `bounds` column: each visible row's viewport box, `x,y,w,h` in CSS pixels. */
  includeBounds?: boolean
  limit?: number
  maxChars?: number
}

export interface BrowserTextRequest {
  scope?: string
  visibleOnly?: boolean
  limit?: number
  maxChars?: number
}

/**
 * What an action points at: a `ref` from the latest element snapshot, or a CSS
 * selector. A ref wins when both are given — it names the element the model
 * actually read, while a selector is re-resolved against whatever matches now.
 */
export interface BrowserTarget {
  ref?: string
  selector?: string
}

export interface BrowserClickRequest extends BrowserTarget {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  signal?: AbortSignal
}

/** A press at a viewport point in CSS pixels, with no element resolved or hit-tested. */
export interface BrowserClickAtRequest {
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  signal?: AbortSignal
}

export interface BrowserTypeRequest extends BrowserTarget {
  text: string
  clear?: boolean
  submit?: boolean
  signal?: AbortSignal
}

/** No target means the keys go to whatever has focus. */
export interface BrowserPressKeyRequest extends BrowserTarget {
  keys: string[]
  signal?: AbortSignal
}

/** Exactly one of `value`, `label` and `index`. */
export interface BrowserSelectRequest extends BrowserTarget {
  value?: string
  label?: string
  index?: number
  signal?: AbortSignal
}

export interface BrowserSetCheckedRequest extends BrowserTarget {
  checked: boolean
  signal?: AbortSignal
}

/** Moves the pointer onto the element and leaves it there. */
export interface BrowserHoverRequest extends BrowserTarget {
  signal?: AbortSignal
}

export interface BrowserScrollRequest extends BrowserTarget {
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
  signal?: AbortSignal
}

/**
 * What `page.wait_for` asks of its selector or text. `attached`/`detached`
 * ignore rendering; `enabled`, `disabled`, `checked` and `unchecked` are one
 * element's own state and take a selector without text.
 */
export type BrowserWaitState =
  | 'visible'
  | 'hidden'
  | 'attached'
  | 'detached'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'unchecked'

/**
 * How far `tab.wait_for_load` waits: the parsed DOM, the full load, or the load
 * and then the page settling — network quiet, animations done, layout still.
 */
export type BrowserLoadState = 'domcontentloaded' | 'load' | 'networkidle'

export interface BrowserWaitRequest {
  selector?: string
  text?: string
  state?: BrowserWaitState
  /** The condition must hold continuously for this long before the wait returns. */
  stableForMs?: number
  /** The committed URL to wait for; `urlMatch` defaults to `prefix`. */
  url?: string
  urlMatch?: 'exact' | 'prefix' | 'contains'
  timeoutMs: number
  signal?: AbortSignal
}

export type BrowserEmulatePreset = 'iphone' | 'ipad' | 'desktop'

/**
 * A device for the tab to pretend to be: a preset, with any explicit field
 * laid over it, or explicit `width` and `height`. `reset` clears it and takes
 * nothing else.
 */
export interface BrowserEmulateRequest {
  preset?: BrowserEmulatePreset
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  userAgent?: string
  reset?: boolean
  signal?: AbortSignal
}

/**
 * What an action did, in one line the transcript keeps.
 *
 * Deliberately not a page projection: an action's answer is evidence about the
 * action, and reading the result is a separate, explicit snapshot. Nothing here
 * ever carries the text that was typed.
 */
export interface BrowserActionResult {
  text: string
}

/**
 * Who is calling, and on which turn.
 *
 * The turn is half of the address, not decoration: a takeover blocks a session
 * only until its next turn, so the implementation has to be able to tell one
 * turn from the next. It is optional because a caller outside a turn (a probe,
 * a test) still has a session, and the arbitration reads "no turn" as "nothing
 * has changed" rather than inventing one.
 */
export interface BrowserCaller {
  sessionId: string
  turnId?: string
}

/** The tab's own history buttons: the three navigations that need no URL. */
export type BrowserHistoryAction = 'back' | 'forward' | 'reload'

/**
 * A page on disk, opened through the app's own loopback server.
 *
 * The tool never names a `file:` URL: the browser refuses those on purpose, so
 * the host reads the bytes under `root` and hands the page plain http.
 */
export interface BrowserLocalPageRequest {
  /** Absolute path of the document. */
  path: string
  /** The directory the document may read besides itself: its workspace, or its own directory. */
  root: string
  /** Replaces this tab's document; without it the page opens in a new tab. */
  tabId?: string
}

export interface BrowserHost {
  listTabs(caller: BrowserCaller): Promise<BrowserTabState[]>
  createTab(caller: BrowserCaller, url?: string): Promise<BrowserTabState>
  /** Opens a document on disk in its own tab, or in `tabId` when one is named. */
  openLocal(caller: BrowserCaller, request: BrowserLocalPageRequest): Promise<BrowserTabState>
  closeTab(caller: BrowserCaller, tabId: string): Promise<void>
  navigate(caller: BrowserCaller, tabId: string, url: string): Promise<BrowserTabState>
  /** Refuses a back or forward with nowhere to go rather than doing nothing. */
  history(caller: BrowserCaller, tabId: string, action: BrowserHistoryAction): Promise<BrowserTabState>
  /**
   * Resolves once the tab's *current* navigation finished loading. A navigation
   * that starts while this is waiting replaces what it is waiting for — the
   * answer is always about the document the tab ends up on.
   */
  waitForLoad(
    caller: BrowserCaller,
    tabId: string,
    options: { timeoutMs: number; until?: BrowserLoadState; signal?: AbortSignal },
  ): Promise<BrowserTabState>
  elements(caller: BrowserCaller, tabId: string, request: BrowserElementsRequest): Promise<BrowserSnapshot>
  text(caller: BrowserCaller, tabId: string, request: BrowserTextRequest): Promise<BrowserSnapshot>
  /** Reads the next page of a snapshot already taken. Never touches the page. */
  readSnapshot(caller: BrowserCaller, tabId: string, cursor: string, maxChars?: number): Promise<BrowserSnapshot>
  /** Waits for the page to settle first unless told not to, and says whether it did. */
  screenshot(caller: BrowserCaller, tabId: string, request?: BrowserScreenshotRequest): Promise<BrowserScreenshot>
  click(caller: BrowserCaller, tabId: string, request: BrowserClickRequest): Promise<BrowserActionResult>
  /** A press at a viewport point; reports what it landed on rather than refusing a covered one. */
  clickAt(caller: BrowserCaller, tabId: string, request: BrowserClickAtRequest): Promise<BrowserActionResult>
  type(caller: BrowserCaller, tabId: string, request: BrowserTypeRequest): Promise<BrowserActionResult>
  pressKey(caller: BrowserCaller, tabId: string, request: BrowserPressKeyRequest): Promise<BrowserActionResult>
  selectOption(caller: BrowserCaller, tabId: string, request: BrowserSelectRequest): Promise<BrowserActionResult>
  /** Clicks only when the control is not already in the asked-for state. */
  setChecked(caller: BrowserCaller, tabId: string, request: BrowserSetCheckedRequest): Promise<BrowserActionResult>
  /** Moves the pointer onto the element, for menus and tooltips that open on hover. */
  hover(caller: BrowserCaller, tabId: string, request: BrowserHoverRequest): Promise<BrowserActionResult>
  scroll(caller: BrowserCaller, tabId: string, request: BrowserScrollRequest): Promise<BrowserActionResult>
  /** Polls a condition about the page's contents, not about its load state. */
  waitFor(caller: BrowserCaller, tabId: string, request: BrowserWaitRequest): Promise<BrowserActionResult>
  /** Sets or clears the tab's device emulation, which lasts until reset or the tab closes. */
  emulate(caller: BrowserCaller, tabId: string, request: BrowserEmulateRequest): Promise<BrowserActionResult>
}
