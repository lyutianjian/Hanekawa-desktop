/**
 * Every tunable the projection layer has, in one table.
 *
 * They are gathered here because they are not independent: the in-page result
 * cap and the cache's entry size bound the same array from two ends, and the
 * per-field truncation is what keeps a 2,000-row snapshot from being 16 MB.
 * Changing one in isolation is how the pair stops adding up.
 */

/** Snapshots are read once, front to back, so the cache is FIFO rather than LRU. */
export const SNAPSHOT_CACHE_MAX_BYTES = 16 * 1024 * 1024
export const SNAPSHOT_CACHE_MAX_ENTRIES = 32
export const SNAPSHOT_CACHE_TTL_MS = 120_000

/** The isolated world automation runs in. The page's own scripts live in world 0. */
export const AUTOMATION_WORLD_ID = 1001

/** What one call may return, and what a caller may ask for. */
export const MAX_CHARS_MIN = 2048
export const MAX_CHARS_MAX = 24_000
export const MAX_CHARS_ELEMENTS = 8000
export const MAX_CHARS_TEXT = 12_000
/** Room kept for the header and the cursor footer inside `maxChars`. */
export const PAGE_OVERHEAD_RESERVE = 240

export const DEFAULT_LIMIT = 100

/**
 * The three in-page budgets. Whichever trips first ends the scan.
 *
 * They exist because the collector runs inside the page's own event loop: an
 * unbounded walk of a hostile or merely enormous DOM freezes the tab the user is
 * looking at.
 */
export const SCAN_BUDGET_MS = 100
export const SCAN_MAX_NODES = 10_000
export const SCAN_MAX_RESULTS = 2000

/**
 * Waiting for a condition: the poll, and the two bounds on how long.
 *
 * The poll is a wall-clock interval rather than a mutation observer because the
 * condition is evaluated by a fresh script each time: a script that installed an
 * observer would have to survive in the page between calls, and a page that
 * navigates mid-wait would take it with it.
 */
export const WAIT_POLL_INTERVAL_MS = 100
export const WAIT_FOR_DEFAULT_MS = 10_000
export const WAIT_FOR_MAX_MS = 30_000

/**
 * How long `capturePage()` gets before the screenshot is called off.
 *
 * Observed on macOS: with the window hidden the promise never settles — no
 * error, no blank image, nothing. A capture of a view that is on screen returns
 * in well under a second, so anything past this is the hang, not a slow page.
 */
export const SCREENSHOT_TIMEOUT_MS = 5000

/**
 * How long one call into the page gets before it is taken for a hung one.
 *
 * The in-page collectors bound their own scans (`SCAN_BUDGET_MS`), so a call
 * that outlives this is not a slow page: it is an `alert()`, a script looping
 * forever in the page's own event loop, or a renderer that stopped answering.
 * Generous on purpose — the reply also carries a large snapshot — because
 * ending a working call early costs a retry, while waiting forever costs the
 * turn.
 */
export const AUTOMATION_CALL_TIMEOUT_MS = 15_000

/** One `page.type` call. Long enough for a paragraph, short of a paste bomb. */
export const TYPE_TEXT_MAX = 10_000

/** A `page.scroll` step, when the caller names no amount: most of a screen. */
export const SCROLL_VIEWPORT_FRACTION = 0.9

/** Per-field truncation, applied in the page so the oversize never crosses. */
export const FIELD_MAX_NAME = 500
export const FIELD_MAX_TEXT = 1000

/**
 * Fields whose contents must not be projected at all.
 *
 * An `autocomplete` token is the reliable signal — a password manager needs it,
 * so pages that hide their password field from every other heuristic still set
 * it. `input[type=password]` is checked separately, by tag.
 */
export const SENSITIVE_AUTOCOMPLETE = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
]

/**
 * What counts as interactive before the `cursor: pointer` heuristic runs.
 *
 * `[tabindex]` and `[role]` are in the list on purpose even though both are
 * frequently noise: a div that opted into the accessibility tree is a div whose
 * author meant it to be operable.
 */
export const INTERACTIVE_SELECTOR =
  'a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex],[onclick]'

/**
 * How long a tab's debugger stays attached after its last lease is returned.
 * Long enough that a run of actions reuses one attachment, short enough that an
 * idle tab hands the channel back before the user reaches for DevTools.
 */
export const CDP_IDLE_DETACH_MS = 30_000

/**
 * Waiting for the page to stop moving before a screenshot or a press.
 *
 * Both caps are short on purpose: settling is a courtesy, not a condition. A
 * page that never goes quiet (analytics beacons, a ticking clock) still gets
 * its picture taken — with a line saying what was still moving — rather than a
 * timeout the model has to route around.
 */
export const SETTLE_SCREENSHOT_MS = 3000
export const SETTLE_ACTION_MS = 1500
/** How long the network must have had nothing starting or finishing. */
export const NETWORK_QUIET_MS = 500
/**
 * A request older than this is taken for a stream or a long poll and no longer
 * holds the page up: it may never finish, and waiting on it is waiting forever.
 */
export const LONG_REQUEST_MS = 2000
