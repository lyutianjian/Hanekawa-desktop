/**
 * What each page said on its own console.
 *
 * A handler that throws leaves the screen exactly as it was, so the agent sees a
 * click that did nothing and a control that ignored it. The page's console is
 * the only place that says why — and it says it once: errors are collected here
 * and *taken* by the next thing the agent reads, so a broken page reports each
 * line once instead of repeating it in every snapshot.
 *
 * Electron-free, like `network.ts`, so the bookkeeping is tested without a
 * session. Keyed by `webContents.id`; a page that goes away is forgotten.
 */

/** How many errors one page keeps. A page in an error loop fills this; the newest win. */
export const CONSOLE_ERRORS_KEPT = 20
/** One line, clipped: a stack trace belongs in the console, not in a tool result. */
export const CONSOLE_ERROR_MAX_CHARS = 300
/** How much of a source path is kept beside its message. */
const SOURCE_MAX_CHARS = 80

interface Entry {
  text: string
  /** Already handed to the agent; kept so a repeat of the same error stays one line. */
  reported: boolean
}

export class ConsoleErrors {
  private readonly pages = new Map<number, Entry[]>()

  /**
   * One `console.error`, or an uncaught exception the renderer logged. Identical
   * text is recorded once: a page that throws on every frame would otherwise
   * bury every other error it has.
   */
  record(contentsId: number, message: string, sourceId: string, lineNumber: number): void {
    const text = describe(message, sourceId, lineNumber)
    if (text === '') return
    const entries = this.entries(contentsId)
    if (entries.some((entry) => entry.text === text)) return
    entries.push({ text, reported: false })
    if (entries.length > CONSOLE_ERRORS_KEPT) entries.shift()
  }

  /** The errors the agent has not been shown yet, oldest first; marks them shown. */
  take(contentsId: number): string[] {
    const entries = this.pages.get(contentsId)
    if (entries === undefined) return []
    const fresh = entries.filter((entry) => !entry.reported)
    for (const entry of fresh) entry.reported = true
    return fresh.map((entry) => entry.text)
  }

  /** The page is gone, or a new document replaced it: its errors went with it. */
  forget(contentsId: number): void {
    this.pages.delete(contentsId)
  }

  private entries(contentsId: number): Entry[] {
    let entries = this.pages.get(contentsId)
    if (entries === undefined) {
      entries = []
      this.pages.set(contentsId, entries)
    }
    return entries
  }
}

/** One line: the message, then where it came from when that is a web page. */
function describe(message: string, sourceId: string, lineNumber: number): string {
  const text = message.replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const where = location(sourceId, lineNumber)
  const line = where === '' ? text : `${text} (${where})`
  return clip(line, CONSOLE_ERROR_MAX_CHARS)
}

/**
 * `app.js:12` for a web source, and nothing for the rest: a `data:` or `blob:`
 * source has no path worth reading, and a non-web source is not the site's code.
 */
function location(sourceId: string, lineNumber: number): string {
  if (sourceId === '' || !Number.isFinite(lineNumber) || lineNumber <= 0) return ''
  let url: URL
  try {
    url = new URL(sourceId)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  const file = url.pathname.split('/').filter((part) => part !== '').pop() ?? url.hostname
  return clip(`${file}:${lineNumber}`, SOURCE_MAX_CHARS)
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}