import {
  BROWSER_USER_AGENT,
  decodeHtmlBytes,
  decodeHtmlEntities,
  hasCjk,
  hostOf,
  htmlToText,
  singleLine,
  timeoutSignal,
} from '../webText.js'

/**
 * Search backends, one per engine, each returning the same hit shape.
 *
 * No single free endpoint is dependable: DuckDuckGo answers a datacenter or
 * censored network with an HTTP 202 challenge page (which is *not* an error
 * status, so the old code read it as "no results"), Bing without a region
 * cookie can serve a page of results that ignores the query, and from mainland
 * China both are unreliable while Baidu answers in 300ms. So the tool tries
 * engines in turn and reports which one answered — the fallback chain, not any
 * one engine, is what makes the tool dependable.
 */

export interface SearchQuerySpec {
  q: string
  /** Only results from the last N days, where the engine supports it. */
  recencyDays?: number
  /** Restrict results to these domains. */
  domains?: string[]
  /** Drop results from these domains. Applied after the engine answers. */
  blockedDomains?: string[]
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** The engine's own date for the page, when it gave one. */
  published?: string
}

export interface SearchRequestContext {
  signal?: AbortSignal
  maxResults: number
}

export interface SearchProvider {
  readonly id: string
  readonly label: string
  search(spec: SearchQuerySpec, context: SearchRequestContext): Promise<SearchHit[]>
}

export type SearchFailureKind = 'blocked' | 'http' | 'network' | 'parse'

export class SearchProviderError extends Error {
  constructor(readonly kind: SearchFailureKind, message: string) {
    super(message)
    this.name = 'SearchProviderError'
  }
}

/**
 * One engine's timeout. Short on purpose: the chain's job is to reach a working
 * engine quickly, and an engine that has not answered in this long is usually a
 * blocked host rather than a slow one. DDG answers in ~1.5s, Baidu in ~1.4s.
 */
const PROVIDER_TIMEOUT_MS = 5_000
/** A whole query's budget. Two unreachable engines came in well under this. */
export const QUERY_DEADLINE_MS = 18_000
const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

async function httpGet(
  url: string,
  context: SearchRequestContext,
  options: { accept?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  try {
    return await fetch(url, {
      signal: timeoutSignal(context.signal, PROVIDER_TIMEOUT_MS),
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        'accept': options.accept ?? ACCEPT_HTML,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...options.headers,
      },
      redirect: 'follow',
    })
  } catch (error) {
    if (context.signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new SearchProviderError('network', message)
  }
}

async function bodyText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  return decodeHtmlBytes(bytes, response.headers.get('content-type') ?? '').text
}

function requireOk(response: Response, url: string): void {
  if (response.ok) return
  throw new SearchProviderError('http', `HTTP ${response.status} from ${hostOf(url) ?? url}`)
}

/** Scope a query to the requested domains. Engines weight `site:` differently. */
export function scopedQuery(spec: SearchQuerySpec): string {
  const domains = (spec.domains ?? []).map((domain) => domain.trim()).filter((domain) => domain !== '')
  if (domains.length === 0) return spec.q
  const scope = domains.length === 1
    ? `site:${domains[0]}`
    : `(${domains.map((domain) => `site:${domain}`).join(' OR ')})`
  return `${spec.q} ${scope}`
}

/** Keep only hits on the requested domains; engines honour `site:` loosely. */
export function keepDomains(hits: SearchHit[], spec: SearchQuerySpec): SearchHit[] {
  const allowed = (spec.domains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, ''))
    .filter((domain) => domain !== '')
  if (allowed.length === 0) return hits
  return hits.filter((hit) => {
    const host = hostOf(hit.url)
    return host !== undefined && allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))
  })
}

function ddgDateRange(days: number): string {
  if (days <= 1) return 'd'
  if (days <= 7) return 'w'
  if (days <= 31) return 'm'
  return 'y'
}

function searxTimeRange(days: number): string {
  if (days <= 1) return 'day'
  if (days <= 7) return 'week'
  if (days <= 31) return 'month'
  return 'year'
}

function braveFreshness(days: number): string {
  if (days <= 1) return 'pd'
  if (days <= 7) return 'pw'
  if (days <= 31) return 'pm'
  return 'py'
}

// --- DuckDuckGo -----------------------------------------------------------

/**
 * DuckDuckGo's no-JavaScript results page. It is the best free index when it
 * answers, and an anti-bot page when it does not — an answer that has to be
 * recognised, because it arrives as 202 (a success status).
 */
function duckDuckGoProvider(): SearchProvider {
  return {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    async search(spec, context) {
      const params = new URLSearchParams({ q: spec.q, kl: 'wt-wt' })
      if (spec.recencyDays) params.set('df', ddgDateRange(spec.recencyDays))
      const url = `https://html.duckduckgo.com/html/?${params.toString()}`
      const response = await httpGet(url, context)
      if (response.status === 202) {
        throw new SearchProviderError('blocked', 'answered with an anti-bot challenge (HTTP 202)')
      }
      requireOk(response, url)
      const html = await bodyText(response)
      if (/anomaly-modal|bots use DuckDuckGo too|complete the following challenge/i.test(html)) {
        throw new SearchProviderError('blocked', 'answered with an anti-bot challenge')
      }
      const hits = parseDuckDuckGo(html)
      if (hits.length === 0) throw new SearchProviderError('parse', 'returned a page with no results in it')
      return hits.slice(0, context.maxResults)
    },
  }
}

/** `result__a` may sit before or after `href`, and ads are marked in the block. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const blocks = html.split(/(?=<div[^>]+class="result )/).filter((block) => /class="result /.test(block))
  const hits: SearchHit[] = []
  for (const block of blocks) {
    if (/result--ad|result--ad--small/.test(block)) continue
    const anchor = matchAnchor(block, 'result__a')
    if (!anchor) continue
    const title = htmlToText(anchor.body)
    if (!title) continue
    const snippet = matchAnchor(block, 'result__snippet')
    hits.push({
      title,
      url: unwrapDuckDuckGoUrl(anchor.href),
      snippet: snippet ? singleLine(htmlToText(snippet.body)) : '',
    })
  }
  return hits
}

function matchAnchor(block: string, className: string): { href: string; body: string } | undefined {
  const patterns = [
    new RegExp(`<a[^>]*class="[^"]*${className}[^"]*"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)</a>`),
    new RegExp(`<a[^>]*href="([^"]+)"[^>]*class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)</a>`),
  ]
  for (const pattern of patterns) {
    const match = block.match(pattern)
    if (match?.[1]) return { href: decodeHtmlEntities(match[1]), body: match[2] ?? '' }
  }
  return undefined
}

/** DuckDuckGo wraps every result in a `/l/?uddg=` redirect. */
export function unwrapDuckDuckGoUrl(raw: string): string {
  const match = raw.match(/[?&]uddg=([^&]+)/)
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return raw
    }
  }
  return raw.startsWith('//') ? `https:${raw}` : raw
}

// --- Bing -----------------------------------------------------------------

/**
 * Bing's HTML results page. The RSS endpoint is deliberately not used: from
 * some regions it answers every query with the same stale, query-independent
 * feed, which reads as "ten results" while answering nothing.
 */
function bingProvider(): SearchProvider {
  return {
    id: 'bing',
    label: 'Bing',
    async search(spec, context) {
      const params = new URLSearchParams({ q: scopedQuery(spec), count: String(Math.max(context.maxResults, 10)) })
      const url = `https://www.bing.com/search?${params.toString()}`
      const response = await httpGet(url, context)
      requireOk(response, url)
      const html = await bodyText(response)
      const hits = parseBing(html)
      if (hits.length === 0 && /captcha|challenge|verify you are a human/i.test(html)) {
        throw new SearchProviderError('blocked', 'answered with a challenge page')
      }
      if (hits.length === 0) throw new SearchProviderError('parse', 'returned a page with no results in it')
      return hits.slice(0, context.maxResults)
    },
  }
}

export function parseBing(html: string): SearchHit[] {
  const blocks = html.match(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[\s\S]*?(?=<li[^>]+class="[^"]*\bb_algo\b|<\/ol>|<\/ul>)/g) ?? []
  const hits: SearchHit[] = []
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!anchor?.[1]) continue
    const title = htmlToText(anchor[2] ?? '')
    if (!title) continue
    const paragraph = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]
      ?? block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
      ?? ''
    hits.push({
      title,
      url: unwrapBingUrl(decodeHtmlEntities(anchor[1])),
      snippet: singleLine(htmlToText(paragraph)),
    })
  }
  return hits
}

/** Bing wraps a result in `bing.com/ck/a?...&u=a1<base64url>` when it wants a click through. */
export function unwrapBingUrl(raw: string): string {
  const absolute = raw.startsWith('/') ? `https://www.bing.com${raw}` : raw
  if (!/bing\.com\/ck\/a/i.test(absolute)) return absolute
  const encoded = absolute.match(/[?&]u=([^&]+)/)?.[1]
  if (!encoded) return absolute
  const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded
  try {
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return decoded.startsWith('http') ? decoded : absolute
  } catch {
    return absolute
  }
}

// --- Baidu ----------------------------------------------------------------

/**
 * Baidu, for Chinese queries. It answers fast from anywhere in China and it
 * respects the query, which neither DuckDuckGo nor Bing's China endpoint
 * reliably does there — but its markup mixes results, ads and interactive
 * modules, and it wraps organic links in a redirect that has to be resolved
 * one request at a time before the URL can be cited.
 */
function baiduProvider(): SearchProvider {
  return {
    id: 'baidu',
    label: 'Baidu',
    async search(spec, context) {
      const params = new URLSearchParams({ wd: spec.q, ie: 'utf-8', rn: '20' })
      const url = `https://www.baidu.com/s?${params.toString()}`
      const response = await httpGet(url, context)
      requireOk(response, url)
      const html = await bodyText(response)
      const hits = parseBaidu(html)
      if (hits.length === 0) throw new SearchProviderError('parse', 'returned a page with no results in it')
      const limited = hits.slice(0, context.maxResults)
      return resolveBaiduLinks(limited, context)
    },
  }
}

const BAIDU_HOSTS = new Set(['www.baidu.com', 'baidu.com', 'm.baidu.com'])

export function parseBaidu(html: string): SearchHit[] {
  const blocks = html.match(/<div[^>]+class="[^"]*c-container[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*c-container|<\/body)/g) ?? []
  const hits: SearchHit[] = []
  for (const block of blocks) {
    // Ads and interactive modules ("video gallery", "related searches") carry a
    // placeholder link and no article behind it.
    if (/data-tuiguang|class="[^"]*ec_ads|nourl\.ubs\.baidu\.com|recommend_list\.baidu\.com/.test(block)) continue
    const anchor = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!anchor?.[1]) continue
    const title = htmlToText(anchor[2] ?? '')
    if (!title) continue
    const href = decodeHtmlEntities(anchor[1])
    if (/^\/sf\/|baidu\.php\?/.test(href)) continue
    const mu = block.match(/\smu="(https?:\/\/[^"]+)"/)?.[1]
    const candidate = mu ? decodeHtmlEntities(mu) : absoluteUrl(href, 'https://www.baidu.com')
    if (candidate === undefined) continue
    if (BAIDU_HOSTS.has(hostOf(candidate) ?? '') && !/\/link\?url=/.test(candidate)) continue
    const snippet = block.match(/class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/)?.[1]
      ?? block.match(/<span[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1]
      ?? block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
      ?? ''
    hits.push({ title, url: candidate, snippet: singleLine(htmlToText(snippet)) })
  }
  return hits
}

/** `link?url=` and `baidu.php?url=` answer with a 302 to the real page. */
async function resolveBaiduLinks(hits: SearchHit[], context: SearchRequestContext): Promise<SearchHit[]> {
  const pending = hits.filter((hit) => /\/link\?url=|baidu\.php\?url=/.test(hit.url))
  if (pending.length === 0) return hits
  const resolved = new Map<string, string>()
  await mapWithConcurrency(pending, 4, async (hit) => {
    try {
      const response = await fetch(hit.url, {
        signal: timeoutSignal(context.signal, 6000),
        headers: { 'user-agent': BROWSER_USER_AGENT },
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      if (!location) return
      const target = absoluteUrl(location, hit.url)
      if (target) resolved.set(hit.url, target)
    } catch {
      // A link that will not resolve keeps its redirect URL: the result is
      // still worth reporting, the model just cannot cite the destination.
    }
  })
  return hits.map((hit) => {
    const target = resolved.get(hit.url)
    return target ? { ...hit, url: target } : hit
  })
}

async function mapWithConcurrency<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await run(items[index]!)
    }
  })
  await Promise.all(workers)
}

function absoluteUrl(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href
  } catch {
    return undefined
  }
}

// --- SearXNG --------------------------------------------------------------

/**
 * A SearXNG instance the user runs (`HANEKAWA_SEARCH_URL`). It is tried first
 * because it is the one engine whose availability the user controls: a
 * self-hosted metasearch reaches Google, Bing and DuckDuckGo from a network
 * that blocks them.
 */
function searxngProvider(base: string): SearchProvider {
  return {
    id: 'searxng',
    label: 'SearXNG',
    async search(spec, context) {
      const url = new URL('/search', base.endsWith('/') ? base : `${base}/`)
      url.searchParams.set('q', scopedQuery(spec))
      url.searchParams.set('format', 'json')
      if (spec.recencyDays) url.searchParams.set('time_range', searxTimeRange(spec.recencyDays))
      const response = await httpGet(url.href, context, { accept: 'application/json, text/html;q=0.9' })
      requireOk(response, url.href)
      const text = await bodyText(response)
      if (text.trimStart().startsWith('{')) {
        const data = JSON.parse(text) as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }> }
        const hits = (data.results ?? [])
          .filter((result) => typeof result.url === 'string' && result.url !== '')
          .map((result) => ({
            title: htmlToText(result.title ?? result.url ?? ''),
            url: result.url!,
            snippet: singleLine(htmlToText(result.content ?? '')),
            ...(result.publishedDate ? { published: result.publishedDate } : {}),
          }))
        if (hits.length === 0) throw new SearchProviderError('parse', 'returned no results')
        return hits.slice(0, context.maxResults)
      }
      // Many instances turn the JSON API off; their HTML is still parseable.
      const hits = parseSearxngHtml(text)
      if (hits.length === 0) throw new SearchProviderError('parse', 'returned a page with no results in it')
      return hits.slice(0, context.maxResults)
    },
  }
}

export function parseSearxngHtml(html: string): SearchHit[] {
  const blocks = html.split(/(?=<article[^>]+class="[^"]*result|<div[^>]+class="[^"]*result)/)
  const hits: SearchHit[] = []
  for (const block of blocks) {
    const anchor = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!anchor?.[1]) continue
    const title = htmlToText(anchor[2] ?? '')
    if (!title) continue
    const snippet = block.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''
    hits.push({
      title,
      url: decodeHtmlEntities(anchor[1]),
      snippet: singleLine(htmlToText(snippet)),
    })
  }
  return hits
}

// --- Brave ----------------------------------------------------------------

/** Brave's search API (`HANEKAWA_BRAVE_API_KEY`): one key, real relevance. */
function braveProvider(apiKey: string): SearchProvider {
  return {
    id: 'brave',
    label: 'Brave',
    async search(spec, context) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', scopedQuery(spec))
      url.searchParams.set('count', String(Math.min(Math.max(context.maxResults, 5), 20)))
      if (spec.recencyDays) url.searchParams.set('freshness', braveFreshness(spec.recencyDays))
      const response = await httpGet(url.href, context, {
        accept: 'application/json',
        headers: { 'x-subscription-token': apiKey },
      })
      if (response.status === 401 || response.status === 403) {
        throw new SearchProviderError('blocked', 'rejected the Brave API key')
      }
      requireOk(response, url.href)
      const data = await response.json() as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> }
      }
      return (data.web?.results ?? [])
        .filter((result) => typeof result.url === 'string' && result.url !== '')
        .map((result) => ({
          title: htmlToText(result.title ?? result.url ?? ''),
          url: result.url!,
          snippet: singleLine(htmlToText(result.description ?? '')),
          ...(result.age ? { published: result.age } : {}),
        }))
        .slice(0, context.maxResults)
    },
  }
}

// --- Wikipedia ------------------------------------------------------------

/**
 * Wikipedia's search API, as the last resort. It is not a web index, but it is
 * never blocked, it answers in one request, and for the "what is X" and "when
 * did Y happen" questions that make up much of web search the alternative was
 * reporting that no engine worked.
 */
function wikipediaProvider(): SearchProvider {
  return {
    id: 'wikipedia',
    label: 'Wikipedia',
    async search(spec, context) {
      const language = hasCjk(spec.q) ? 'zh' : 'en'
      const url = new URL(`https://${language}.wikipedia.org/w/api.php`)
      url.searchParams.set('action', 'query')
      url.searchParams.set('list', 'search')
      url.searchParams.set('format', 'json')
      url.searchParams.set('srlimit', String(Math.min(context.maxResults, 20)))
      url.searchParams.set('srprop', 'snippet')
      url.searchParams.set('srsearch', spec.q)
      const response = await httpGet(url.href, context, { accept: 'application/json' })
      requireOk(response, url.href)
      const data = await response.json() as { query?: { search?: Array<{ title?: string; snippet?: string }> } }
      return (data.query?.search ?? [])
        .filter((result) => typeof result.title === 'string' && result.title !== '')
        .map((result) => ({
          title: result.title!,
          url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(result.title!.replace(/ /g, '_'))}`,
          snippet: singleLine(htmlToText(result.snippet ?? '')),
        }))
        .slice(0, context.maxResults)
    },
  }
}

// --- Relevance ------------------------------------------------------------

/**
 * Words that carry no search intent. Kept short on purpose: dropping a term a
 * page really would have matched turns a good result into a rejected one.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'how', 'what', 'why',
  'when', 'which', 'where', 'who', 'are', 'was', 'were', 'can', 'could', 'should', 'would',
  'will', 'you', 'your', 'about', 'into', 'over', 'after', 'before', 'not', 'but', 'then',
  'than', 'vs', 'versus', 'use', 'using', 'used', 'latest', 'new', 'best', 'guide', 'tutorial',
])

/**
 * The words a result has to mention for it to be an answer to this query.
 *
 * This is what separates "Bing answered" from "Bing answered *about the
 * query*". From mainland China, cn.bing.com serves its region-filtered feed to
 * queries it does not like: a nonsense query comes back as a page of unrelated
 * product results, which reads as a success while answering nothing. Checking
 * that results mention the query is the only way to tell those apart.
 */
export function queryTokens(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/)) {
    const token = raw.trim()
    if (token.length < 3 || STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)
  }
  return [...seen]
}

/**
 * Whether any hit mentions enough of the query.
 *
 * One term is enough for short queries: a snippet about `tokio.rs` may never
 * repeat "select" or "macro" while being exactly the page asked for. Longer
 * queries are held to two, which still separates a real answer from an engine's
 * query-independent fallback feed.
 */
export function hasRelevantHit(hits: SearchHit[], tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true
  const needed = tokens.length <= 3 ? 1 : 2
  return hits.some((hit) => {
    const text = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase()
    let matched = 0
    for (const token of tokens) {
      if (text.includes(token)) matched += 1
      if (matched >= needed) return true
    }
    return false
  })
}

/**
 * Order results by how much of the query they mention.
 *
 * On a degraded SERP a site's homepage and the page that actually answers the
 * question both "match", and the engine often lists the homepage first. A
 * stable sort by term overlap promotes the deep page without reordering two
 * results the engine rated the same.
 */
export function rankHits(hits: SearchHit[], tokens: readonly string[]): SearchHit[] {
  if (tokens.length === 0) return hits
  const scoreOf = (hit: SearchHit): number => {
    const text = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase()
    return tokens.reduce((count, token) => (text.includes(token) ? count + 1 : count), 0)
  }
  return hits
    .map((hit, index) => ({ hit, index, score: scoreOf(hit) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.hit)
}

/**
 * Path segments that place a visitor but name no content: a language or region
 * (`/zh-cn`, `/en-US`), or a documentation landing page. `nodejs.org/zh-cn` is
 * the homepage in another language, and counting it as a deep page is how a
 * shallow engine wins a comparison it should lose.
 */
const LANDING_SEGMENT = /^(?:[a-z]{2}(?:[-_][a-z]{2,4})?|docs|documentation|manual|reference|latest|index\.html?)$/i

/**
 * How specific a URL is: a site root is 0, and every content path segment and
 * query parameter adds one. A homepage is rarely the answer to a search, so a
 * result set that only reaches homepages ranks below one that reaches pages.
 */
export function urlDepth(raw: string): number {
  try {
    const url = new URL(raw)
    const segments = url.pathname
      .split('/')
      .filter((segment) => segment !== '' && !LANDING_SEGMENT.test(segment))
    return Math.min(segments.length, 3) + (url.search === '' ? 0 : 1)
  } catch {
    return 0
  }
}

/**
 * How good an engine's answer is: term overlap first, then whether its best
 * results are real pages rather than site roots.
 *
 * This is what lets a shallow engine lose. From some networks the index that
 * answers fastest replies with a site's homepage for every query — "relevant"
 * and useless — while a slower engine returns the article that answers the
 * question. Depth is the tiebreaker that prefers the article.
 */
export function resultQuality(hits: SearchHit[], tokens: readonly string[]): number {
  let best = 0
  for (const hit of hits.slice(0, 3)) {
    const text = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase()
    const matched = tokens.reduce((count, token) => (text.includes(token) ? count + 1 : count), 0)
    best = Math.max(best, matched * 2 + urlDepth(hit.url))
  }
  return best
}

// --- The chain ------------------------------------------------------------

/**
 * The engines this process can use, in the order they are tried. A configured
 * instance or key comes first; the free engines follow; Wikipedia catches what
 * they miss.
 */
export function defaultSearchProviders(env: NodeJS.ProcessEnv = process.env): SearchProvider[] {
  const providers: SearchProvider[] = []
  const searxng = env.HANEKAWA_SEARCH_URL?.trim()
  if (searxng) providers.push(searxngProvider(searxng))
  const braveKey = (env.HANEKAWA_BRAVE_API_KEY ?? env.BRAVE_API_KEY)?.trim()
  if (braveKey) providers.push(braveProvider(braveKey))
  // Best answers first, dependable fallbacks after. DuckDuckGo is the best free
  // index where it is reachable (behind a proxy, for instance); Bing is the one
  // that almost always answers; Baidu returns deep pages where Bing is shallow;
  // Wikipedia never blocks but only knows encyclopaedic subjects.
  providers.push(duckDuckGoProvider(), bingProvider(), baiduProvider(), wikipediaProvider())
  return providers
}

/**
 * The engines the user configured outrank the built-in ones: someone who set up
 * a SearXNG instance or bought a Brave key did it because they want that index.
 */
const CONFIGURED_IDS = new Set(['searxng', 'brave'])

/**
 * Chinese queries go to Baidu before the western engines: it is the one engine
 * that reliably returns query-specific Chinese results from a mainland
 * network, where DuckDuckGo is challenged and Bing's China endpoint answers
 * with a region-filtered feed.
 *
 * Only the order *among the free engines* changes. A configured instance stays
 * first, because reordering it would override the user's own choice.
 */
export function orderedProviders(providers: readonly SearchProvider[], query: string): SearchProvider[] {
  const configured = providers.filter((provider) => CONFIGURED_IDS.has(provider.id))
  const builtin = providers.filter((provider) => !CONFIGURED_IDS.has(provider.id))
  if (!hasCjk(query)) return [...configured, ...builtin]
  const baidu = builtin.filter((provider) => provider.id === 'baidu')
  const rest = builtin.filter((provider) => provider.id !== 'baidu')
  return [...configured, ...baidu, ...rest]
}

/** Why an engine produced nothing, in words the model and the user can act on. */
export function describeSearchFailure(error: unknown): string {
  if (error instanceof SearchProviderError) {
    switch (error.kind) {
      case 'blocked': return `blocked: ${error.message}`
      case 'http': return error.message
      case 'network': return `unreachable: ${error.message}`
      case 'parse': return error.message
    }
  }
  return error instanceof Error ? error.message : String(error)
}