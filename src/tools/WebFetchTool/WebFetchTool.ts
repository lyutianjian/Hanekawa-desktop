import { isIP } from 'node:net'
import { z } from 'zod/v3'
import type { Tool, ToolContext, ToolErrorCode, ToolResult } from '../../harness/types.js'
import {
  BROWSER_USER_AGENT,
  canonicalUrl,
  decodeHtmlBytes,
  formatBytes,
  hostOf,
  looksBinary,
  timeoutSignal,
} from '../webText.js'
import { extractReadable } from './extract.js'
import { DESCRIPTION } from './prompt.js'

// --- Constants ---
const MAX_URL_LENGTH = 2000
const FETCH_TIMEOUT_MS = 30_000
/** Ceiling on the bytes actually received, counted before anything is decoded. */
const MAX_BODY_BYTES = 5 * 1024 * 1024
/**
 * What one call hands the model. A whole documentation page is 2–3× this, and
 * a tool result that large is spilled to disk (see `requestPrep`) and replaced
 * by a 40-line preview — so paging beats dumping: the rest stays reachable
 * with `offset`.
 */
const MAX_OUTPUT_CHARS = 40_000
/** The most markdown kept in memory per page, which bounds the cache. */
const MAX_PAGE_CHARS = 1_000_000
const MAX_REDIRECTS = 5
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_ENTRIES = 50
/** Below this, an HTML page yielded nothing a reader would call text. */
const MIN_READABLE_TEXT = 200
const MAX_PATTERNS = 6
const MAX_MATCHES = 24
const MATCH_CONTEXT_LINES = 2
const MAX_FIND_CHARS = 12_000

/**
 * One fetched page, after decoding and conversion. The cache holds this rather
 * than the formatted answer, so `offset` and `pattern` can read parts of a page
 * that an earlier call did not print.
 */
interface PageDocument {
  /** The URL that was asked for. */
  url: string
  /** The URL that answered, which differs when same-host redirects were followed. */
  finalUrl: string
  title?: string
  /** Markdown for HTML, the decoded body for text, pretty-printed JSON for JSON. */
  markdown: string
  kind: 'html' | 'text' | 'json'
  /** True when `markdown` was cut at `MAX_PAGE_CHARS`, which `offset` cannot reach past. */
  pageTruncated: boolean
  status: number
  contentType: string
  bytes: number
  fetchedAt: number
}

interface CachedPage extends PageDocument {
  cached: boolean
}

const urlCache = new Map<string, PageDocument>()

function getCached(url: string): PageDocument | undefined {
  const key = canonicalUrl(url)
  const entry = urlCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    urlCache.delete(key)
    return undefined
  }
  return entry
}

function setCache(page: PageDocument): void {
  const key = canonicalUrl(page.url)
  if (urlCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [candidate, entry] of urlCache) {
      if (entry.fetchedAt < oldestTime) {
        oldestTime = entry.fetchedAt
        oldestKey = candidate
      }
    }
    if (oldestKey) urlCache.delete(oldestKey)
  }
  urlCache.set(key, page)
}

/** Exposed for tests and for a session that knows its network moved. */
export function clearWebFetchCache(): void {
  urlCache.clear()
}

/** A failure that already reads as the tool result it should become. */
class FetchFailure extends Error {
  constructor(readonly content: string, readonly code: ToolErrorCode) {
    super(content)
    this.name = 'FetchFailure'
  }
}

/**
 * A successful call whose answer is an instruction rather than page text: a
 * redirect the permission gate did not approve landing on. It is not an error —
 * the model has exactly what it needs to make the next, separately approved
 * request.
 */
class FetchNotice extends Error {
  constructor(readonly content: string) {
    super(content)
    this.name = 'FetchNotice'
  }
}

// --- URL validation ---
function validateURL(url: string): { valid: false; error: string } | { valid: true; parsed: URL } {
  if (url.length > MAX_URL_LENGTH) {
    return { valid: false, error: `URL exceeds ${MAX_URL_LENGTH} characters` }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, error: `Invalid URL format: "${url}"` }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with embedded credentials are not allowed' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Unsupported protocol: ${parsed.protocol}. Only http: and https: are supported.` }
  }
  return { valid: true, parsed }
}

/**
 * A loopback host serves plain HTTP: upgrading it to https would fail against
 * every local dev server. Anything that merely *looks* loopback — a name like
 * `localhost.example.com` — keeps the usual upgrade.
 */
function isLoopbackHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // RFC 6761 reserves `.localhost` for the loopback interface.
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  // 127.0.0.0/8, in dotted quad form only.
  if (isIP(bare) === 4) return Number(bare.split('.')[0]) === 127
  return false
}

/** The URL actually requested: https for the public web, as given for loopback. */
export function resolveFetchUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || isLoopbackHost(parsed)) return url
  return `https://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
}

// --- Reading the body -----------------------------------------------------

/**
 * The body, bounded by bytes as they arrive. `Content-Length` is a claim, and
 * for a chunked response there is none at all, so the limit is enforced on what
 * the stream really delivers; `response.arrayBuffer()` would have buffered the
 * whole thing first.
 */
async function readBoundedBody(
  response: Response,
  url: string,
): Promise<{ bytes: Uint8Array; length: number } | { error: string }> {
  if (!response.body) return { bytes: new Uint8Array(0), length: 0 }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return {
          error: `Response body exceeds ${formatBytes(MAX_BODY_BYTES)} (received at least ${formatBytes(bytes)}) from ${url}; nothing was cached.`,
        }
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    return { error: `Failed while reading the response body from ${url}: ${message}` }
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, length: bytes }
}

type BodyKind = 'html' | 'text' | 'json' | 'pdf' | 'binary'

/**
 * What a response body is, judged by its declared type and then by its bytes.
 * A server that sends a PDF as `application/octet-stream` still gets a clear
 * answer instead of a megabyte of decoded binary in the transcript.
 */
function classifyBody(contentType: string, bytes: Uint8Array): BodyKind {
  const type = contentType.toLowerCase()
  if (type.includes('pdf')) return 'pdf'
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html'
  if (type.includes('json')) return 'json'
  if (type.startsWith('text/') || type.includes('xml') || type.includes('javascript') || type.includes('csv')) return 'text'

  if (looksBinary(bytes)) return 'binary'
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<') && (head.startsWith('<!doctype html') || head.startsWith('<html'))) return 'html'
  return 'text'
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

// --- Loading a page -------------------------------------------------------

async function loadPage(url: string, context: ToolContext): Promise<CachedPage> {
  const validation = validateURL(url)
  if (!validation.valid) throw new FetchFailure(validation.error, 'invalid_input')
  const { parsed } = validation

  const cached = getCached(url)
  if (cached) return { ...cached, cached: true }

  // Upgrade http to https, except for a loopback host that only speaks http.
  const fetchUrl = resolveFetchUrl(url)

  // Redirects are followed by hand and only within the host that was approved;
  // a hop elsewhere goes back to the model as a new request, which is a new
  // permission decision.
  let response: Response | undefined
  let currentUrl = fetchUrl
  for (let hops = 0; ; hops++) {
    response = await requestWithRetry(currentUrl, context)
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (!location) break
    const target = new URL(location, currentUrl)
    if (target.hostname !== new URL(currentUrl).hostname) {
      throw new FetchNotice(
        `The URL redirects to a different host: ${target.href}\nMake a new WebFetch request with that URL to follow it.`,
      )
    }
    if (hops >= MAX_REDIRECTS) throw new FetchFailure(`Too many redirects starting at ${fetchUrl}`, 'execution_failed')
    currentUrl = target.href
  }

  if (!response.ok) throw new FetchFailure(httpFailure(response, currentUrl), 'execution_failed')

  const body = await readBoundedBody(response, currentUrl)
  if ('error' in body) throw new FetchFailure(body.error, 'execution_failed')

  const contentType = response.headers.get('content-type') ?? ''
  const kind = classifyBody(contentType, body.bytes)
  if (kind === 'pdf' || kind === 'binary') {
    throw new FetchFailure(unreadableBody(currentUrl, kind, body.length, contentType), 'precondition_failed')
  }

  const { text } = decodeHtmlBytes(body.bytes, contentType)
  let markdown: string
  let title: string | undefined
  if (kind === 'html') {
    const page = await extractReadable(text, currentUrl)
    markdown = page.markdown
    title = page.title
    if (markdown.length < MIN_READABLE_TEXT) {
      // A shell of an app, a consent wall, a `curl`-blocked page: the fetch
      // worked and there is still nothing to read. Say why, so the next step
      // is a browser rather than the same request again.
      throw new FetchFailure(
        [
          `${currentUrl} returned ${formatBytes(body.length)} of HTML but almost no readable text${title ? ` (title: ${title})` : ''}.`,
          'The page is most likely rendered by JavaScript, or it shows a consent or bot wall to non-browser clients.',
          'The Browser tool runs a real browser and reads the rendered page; use it for this URL.',
        ].join('\n'),
        'precondition_failed',
      )
    }
  } else if (kind === 'json') {
    markdown = prettyJson(text)
  } else {
    markdown = text
  }

  const pageTruncated = markdown.length > MAX_PAGE_CHARS
  const page: PageDocument = {
    url,
    finalUrl: currentUrl,
    ...(title ? { title } : {}),
    markdown: pageTruncated ? markdown.slice(0, MAX_PAGE_CHARS) : markdown,
    kind,
    pageTruncated,
    status: response.status,
    contentType,
    bytes: body.length,
    fetchedAt: Date.now(),
  }
  setCache(page)
  return { ...page, cached: false }
}

/**
 * One GET, retried once on a transport failure. Mobile and censored networks
 * reset connections often enough that a single `fetch failed` is a bad reason
 * to report the page as unreachable — but an abort is the user's decision and
 * is never retried.
 */
async function requestWithRetry(url: string, context: ToolContext): Promise<Response> {
  const signal = context.abortSignal
    ? timeoutSignal(context.abortSignal, FETCH_TIMEOUT_MS)
    : AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, {
        signal,
        headers: {
          'accept': 'text/html, application/xhtml+xml, text/markdown, text/plain, application/json;q=0.9, */*;q=0.8',
          'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
          'user-agent': BROWSER_USER_AGENT,
        },
        redirect: 'manual',
      })
    } catch (error) {
      lastError = error
      if (context.abortSignal?.aborted || signal.aborted) break
    }
  }
  if (context.abortSignal?.aborted) throw new FetchFailure('The request was aborted.', 'aborted')
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new FetchFailure(`Failed to fetch URL: ${message}`, 'execution_failed')
}

function httpFailure(response: Response, url: string): string {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  const retryAfter = response.headers.get('retry-after')
  const hint = response.status === 401 || response.status === 403
    ? 'The site refused an unauthenticated client: it may require a login, or it blocks automated requests. The Browser tool can carry a session and run the page\'s JavaScript.'
    : response.status === 404 || response.status === 410
      ? 'The page does not exist at that URL. Check the path, or search for the current location.'
      : response.status === 429
        ? 'The site is rate limiting this client; wait before retrying.'
        : response.status >= 500
          ? 'The site failed to serve the page; retrying later may work.'
          : 'The request was rejected.'
  return `HTTP ${status} for ${url}\n${hint}${retryAfter ? `\nRetry-After: ${retryAfter}` : ''}`
}

function unreadableBody(url: string, kind: 'pdf' | 'binary', bytes: number, contentType: string): string {
  const type = contentType || 'no content type'
  if (kind === 'pdf') {
    return [
      `${url} is a PDF (${formatBytes(bytes)}, ${type}). WebFetch reads HTML, text and JSON, so it cannot extract PDF text.`,
      'Either fetch an HTML version of the same document, or download it with Bash (`curl -L -o /tmp/doc.pdf "<url>"`) and extract the text with `pdftotext` where that is installed.',
    ].join('\n')
  }
  return `${url} returned binary data (${formatBytes(bytes)}, ${type}); there is no text to read. Check that the URL points at a page rather than a download.`
}

// --- Rendering ------------------------------------------------------------

/**
 * The page from `offset` on, up to `MAX_OUTPUT_CHARS`, with the line range that
 * was printed. `offset` is 1-based and counted in lines of the markdown, which
 * is what the footer's "continue with offset=N" refers to.
 */
function paginate(page: PageDocument, offset: number | undefined): {
  body: string
  start: number
  end: number
  total: number
  more: boolean
} {
  const lines = page.markdown.split('\n')
  const total = lines.length
  const start = Math.max(1, Math.min(offset ?? 1, total + 1))
  const selected: string[] = []
  let chars = 0
  let end = start - 1
  for (let index = start - 1; index < total; index++) {
    const line = lines[index]!
    if (selected.length > 0 && chars + line.length + 1 > MAX_OUTPUT_CHARS) break
    selected.push(line)
    chars += line.length + 1
    end = index + 1
  }
  return { body: selected.join('\n'), start, end, total, more: end < total }
}

interface FindOutcome {
  content: string
  matches: number
}

/**
 * The lines that mention `patterns`, with two lines of context — the codex
 * `find` operation, which is what makes a 3,000-line reference page usable: the
 * answer is the six lines that mention `backpressure`, not the whole chapter
 * around them.
 *
 * Matching is a case-insensitive substring, not a regex: a model writing
 * `createServer(` as a pattern and a regex engine disagreeing about the
 * parenthesis turns a lookup into a silent miss.
 */
function findInPage(page: PageDocument, patterns: string[]): FindOutcome {
  const needles = patterns.map((pattern) => pattern.toLowerCase()).filter((pattern) => pattern !== '')
  const lines = page.markdown.split('\n')
  const hits: number[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.toLowerCase()
    if (needles.some((needle) => line.includes(needle))) hits.push(index)
  }

  if (hits.length === 0) {
    return {
      matches: 0,
      content: [
        `No line of ${page.finalUrl} matches ${quotePatterns(patterns)} (${lines.length} lines of markdown).`,
        page.title ? `The page fetched cleanly: "${page.title}".` : 'The page fetched cleanly.',
        'Try a shorter or more specific pattern, or read the page in order with `offset`.',
      ].join('\n'),
    }
  }

  const windows: Array<[number, number]> = []
  for (const hit of hits.slice(0, MAX_MATCHES)) {
    const from = Math.max(0, hit - MATCH_CONTEXT_LINES)
    const to = Math.min(lines.length - 1, hit + MATCH_CONTEXT_LINES)
    const last = windows[windows.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else windows.push([from, to])
  }

  const rendered: string[] = []
  let chars = 0
  let printed = 0
  for (const [from, to] of windows) {
    if (chars > MAX_FIND_CHARS) break
    if (rendered.length > 0) rendered.push('…')
    for (let index = from; index <= to; index++) {
      const line = `${String(index + 1).padStart(6, ' ')}\t${lines[index]!}`
      rendered.push(line)
      chars += line.length + 1
      printed += 1
    }
  }

  const header = `${hits.length} line${hits.length === 1 ? '' : 's'} of ${page.finalUrl} match ${quotePatterns(patterns)} (line numbers shown):`
  const shown = printed < lines.length && (chars > MAX_FIND_CHARS || hits.length > MAX_MATCHES)
    ? `\n\n[showing ${Math.min(hits.length, MAX_MATCHES)} of ${hits.length} matching lines; narrow the pattern for the rest]`
    : ''
  return { matches: hits.length, content: `${header}\n\n${rendered.join('\n')}${shown}` }
}

function quotePatterns(patterns: string[]): string {
  return patterns.map((pattern) => `"${pattern}"`).join(' or ')
}

function normalizePatterns(pattern: string | string[] | undefined): string[] {
  if (pattern === undefined) return []
  const list = Array.isArray(pattern) ? pattern : [pattern]
  return list
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .slice(0, MAX_PATTERNS)
}

function cacheSummary(page: CachedPage): string {
  return page.cached ? `cached, ${formatBytes(page.bytes)}` : formatBytes(page.bytes)
}

function pageResult(page: CachedPage, offset: number | undefined): ToolResult {
  const host = hostOf(page.finalUrl) ?? page.finalUrl
  const range = paginate(page, offset)

  if (range.end < range.start) {
    return {
      ok: true,
      content: `offset ${range.start} is past the end of ${page.finalUrl}: the page has ${range.total} lines of markdown.`,
      metadata: { display: { summary: `Fetched ${host} (${cacheSummary(page)})` } },
    }
  }

  const notes: string[] = []
  if (page.finalUrl !== page.url) notes.push(`(redirected to ${page.finalUrl})`)
  if (range.more) {
    notes.push(`[lines ${range.start}–${range.end} of ${range.total}; continue with offset=${range.end + 1}]`)
  }
  if (page.pageTruncated) {
    notes.push(`[the page was cut at ${formatBytes(MAX_PAGE_CHARS)} of markdown; the rest is not cached]`)
  }
  // A text body that was read whole is returned exactly as it arrived — the
  // `text/plain` case that tools and tests read byte for byte.
  const content = notes.length === 0
    ? range.body
    : `${range.body.replace(/\n+$/, '')}\n\n${notes.join('\n')}`

  const summary = range.more
    ? `Fetched ${host} (${cacheSummary(page)}, lines ${range.start}–${range.end} of ${range.total})`
    : `Fetched ${host} (${cacheSummary(page)})`
  return { ok: true, content, metadata: { display: { summary } } }
}

export interface WebFetchInput {
  url: string
  pattern?: string | string[]
  offset?: number
}

// --- Main tool ---
export const webFetchTool: Tool = {
  name: 'WebFetch',
  description: DESCRIPTION,
  searchHint: 'fetch url web page content markdown',
  inputSchema: z.object({
    url: z.string().describe('Absolute URL to fetch, including the scheme, e.g. "https://example.com/docs".'),
    pattern: z.union([z.string(), z.array(z.string())])
      .describe('Return only lines containing one of these substrings (case-insensitive, at most 6), each with its line number and two lines of context.')
      .optional(),
    offset: z.number()
      .int()
      .positive()
      .describe('1-based line to start from, for continuing a page whose previous answer ended with "continue with offset=N".')
      .optional(),
  }).strict(),
  // Not `safe`: only the preapproved documentation hosts are auto-approved
  // (`utils/permissions/webFetchDomains.ts`); every other host prompts, and
  // "don't ask again" writes a `WebFetch(domain:...)` rule.
  riskLevel: 'confirm',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName: () => 'Fetch',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const { url, pattern } = input as { url?: unknown; pattern?: unknown }
    if (typeof url !== 'string') return null
    const host = hostOf(url) ?? url
    const patterns = normalizePatterns(pattern as string | string[] | undefined)
    return patterns.length > 0 ? `${host} · ${quotePatterns(patterns)}` : host
  },
  getActivityDescription(input) {
    const url = (typeof input === 'object' && input !== null)
      ? (input as { url?: string }).url
      : undefined
    if (!url) return 'Fetching URL'
    return `Fetching ${hostOf(url) ?? url}`
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { url, pattern, offset } = input as WebFetchInput
    try {
      const page = await loadPage(url, context)
      const patterns = normalizePatterns(pattern)
      if (patterns.length > 0) {
        const found = findInPage(page, patterns)
        const host = hostOf(page.finalUrl) ?? page.finalUrl
        return {
          ok: true,
          content: found.content,
          metadata: {
            display: {
              summary: found.matches > 0
                ? `Fetched ${host} (${found.matches} matching line${found.matches === 1 ? '' : 's'})`
                : `Fetched ${host} (no match)`,
            },
          },
        }
      }
      return pageResult(page, offset)
    } catch (error) {
      if (error instanceof FetchNotice) {
        return {
          ok: true,
          content: error.content,
          metadata: { display: { summary: 'Redirect to another host' } },
        }
      }
      if (error instanceof FetchFailure) {
        return { ok: false, content: error.content, errorCode: error.code }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: `Failed to fetch URL: ${message}`, errorCode: 'execution_failed' }
    }
  },
}