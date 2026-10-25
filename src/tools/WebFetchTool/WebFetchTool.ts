import { isIP } from 'node:net'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../../harness/types.js'
import { DESCRIPTION } from './prompt.js'

// --- Constants ---
const MAX_URL_LENGTH = 2000
const FETCH_TIMEOUT_MS = 30_000
const MAX_MARKDOWN_LENGTH = 100_000
/** Ceiling on the bytes actually received, counted before anything is decoded. */
const MAX_BODY_BYTES = 5 * 1024 * 1024
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_ENTRIES = 50

// --- Simple in-memory cache (Map + manual TTL, no external dependency) ---
interface CacheEntry {
  content: string
  bytes: number
  code: number
  contentType: string
  fetchedAt: number
}

const urlCache = new Map<string, CacheEntry>()

function getCached(url: string): CacheEntry | undefined {
  const entry = urlCache.get(url)
  if (!entry) return undefined
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    urlCache.delete(url)
    return undefined
  }
  return entry
}

function setCache(url: string, entry: CacheEntry): void {
  if (urlCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [k, v] of urlCache) {
      if (v.fetchedAt < oldestTime) {
        oldestTime = v.fetchedAt
        oldestKey = k
      }
    }
    if (oldestKey) urlCache.delete(oldestKey)
  }
  urlCache.set(url, entry)
}

// --- Turndown (lazy singleton to avoid import cost when tool isn't used) ---
type TurndownCtor = typeof import('turndown')
let turndownInstance: InstanceType<TurndownCtor> | undefined
async function getTurndown(): Promise<InstanceType<TurndownCtor>> {
  if (!turndownInstance) {
    const mod = await import('turndown')
    const Turndown = (mod as unknown as { default: TurndownCtor }).default
    turndownInstance = new Turndown({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
  }
  return turndownInstance
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

/**
 * The body, bounded by bytes as they arrive. `Content-Length` is a claim, and
 * for a chunked response there is none at all, so the limit is enforced on what
 * the stream really delivers; `response.text()` would have buffered the whole
 * thing first.
 */
async function readBoundedBody(response: Response, url: string): Promise<{ text: string; bytes: number } | { error: string }> {
  if (!response.body) return { text: '', bytes: 0 }
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
  // Bytes are the truth for the limit; the decoder handles multi-byte units
  // split across chunks.
  return { text: new TextDecoder('utf-8').decode(merged), bytes }
}

// --- HTML content detection ---
function isHtmlContent(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml')
}

// --- Main tool ---
export const webFetchTool: Tool = {
  name: 'WebFetch',
  description: DESCRIPTION,
  searchHint: 'fetch url web page content markdown',
  inputSchema: z.object({
    url: z.string().describe('Absolute URL to fetch, including the scheme, e.g. "https://example.com/docs".'),
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
    const url = (input as { url?: unknown }).url
    if (typeof url !== 'string') return null
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  },
  getActivityDescription(input) {
    const url = (typeof input === 'object' && input !== null)
      ? (input as { url?: string }).url
      : undefined
    if (!url) return 'Fetching URL'
    try {
      return `Fetching ${new URL(url).hostname}`
    } catch {
      return `Fetching ${url}`
    }
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { url } = input as { url: string }

    // Validate URL
    const validation = validateURL(url)
    if (!validation.valid) {
      return { ok: false, content: validation.error, errorCode: 'invalid_input' }
    }
    const { parsed } = validation

    // Check cache
    const cached = getCached(url)
    if (cached) {
      return {
        ok: true,
        content: cached.content,
        metadata: {
          display: { summary: `Fetched ${parsed.hostname} (cached, ${formatBytes(cached.bytes)})` },
        },
      }
    }

    // Upgrade http to https, except for a loopback host that only speaks http.
    const fetchUrl = resolveFetchUrl(url)

    // Fetch. Redirects are followed by hand and only within the host that was
    // approved; a hop elsewhere goes back to the model as a new request.
    let response: Response
    let currentUrl = fetchUrl
    try {
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS)
      for (let hops = 0; ; hops++) {
        response = await fetch(currentUrl, {
          signal,
          headers: {
            'Accept': 'text/html, text/markdown, text/plain, */*',
            'User-Agent': 'Hanekawa/0.1 (AI coding assistant)',
          },
          redirect: 'manual',
        })
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
        if (!location) break
        const target = new URL(location, currentUrl)
        if (target.hostname !== new URL(currentUrl).hostname) {
          return {
            ok: true,
            content: `The URL redirects to a different host: ${target.href}\nMake a new WebFetch request with that URL to follow it.`,
          }
        }
        if (hops >= 5) return { ok: false, content: 'Too many redirects', errorCode: 'execution_failed' }
        currentUrl = target.href
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        content: `Failed to fetch URL: ${message}`,
        errorCode: 'execution_failed',
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        content: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
        errorCode: 'execution_failed',
      }
    }

    // Read response body, bounded while it streams in.
    const body = await readBoundedBody(response, currentUrl)
    if ('error' in body) {
      return { ok: false, content: body.error, errorCode: 'execution_failed' }
    }
    const { text, bytes } = body
    const contentType = response.headers.get('content-type') ?? ''

    // Convert HTML to markdown, or use raw text
    let markdown: string
    if (isHtmlContent(contentType)) {
      try {
        const turndown = await getTurndown()
        markdown = turndown.turndown(text)
      } catch {
        // If turndown fails, return raw text
        markdown = text
      }
    } else {
      markdown = text
    }

    // Truncate if needed
    let truncated = false
    if (markdown.length > MAX_MARKDOWN_LENGTH) {
      markdown = markdown.slice(0, MAX_MARKDOWN_LENGTH)
      truncated = true
    }

    // Cache the result
    setCache(url, { content: markdown, bytes, code: response.status, contentType, fetchedAt: Date.now() })

    const suffix = truncated ? `\n\n[Content truncated at ${MAX_MARKDOWN_LENGTH} characters]` : ''
    return {
      ok: true,
      content: markdown + suffix,
      metadata: {
        display: { summary: `Fetched ${parsed.hostname} (${formatBytes(bytes)})` },
      },
    }
  },
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
