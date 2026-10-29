/**
 * Text helpers shared by the two network tools.
 *
 * `WebFetch` turns a page into markdown and `WebSearch` turns a results page
 * into a list of hits. Both need the same entity decoding, whitespace
 * collapsing, charset sniffing and URL identity, so those live here — at the
 * tools root — rather than in either tool, and neither imports the other.
 */

/**
 * Search engines and most documentation sites answer a bot-shaped client with
 * a challenge page and a real browser with the page it asked for, so both
 * tools present themselves as a browser. `utils/userAgent.ts` holds the
 * identities used for *model* APIs, which is a different question.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The subset of named entities that shows up in snippets and `<title>`s. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  para: '¶',
  sect: '§',
  dagger: '†',
  permil: '‰',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  iexcl: '¡',
  iquest: '¿',
}

const ENTITY_PATTERN = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g
const NUMERIC_ENTITY = /^#/

/**
 * Decode the entities a search snippet or a page title carries. An entity this
 * table does not know is left exactly as it was: a stray `&` in prose
 * ("AT&T; not") must not turn into a guess.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(ENTITY_PATTERN, (match: string, body: string) => {
    if (NUMERIC_ENTITY.test(body)) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Every run of whitespace, including the exotic spaces, as one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/[\s\u00a0\u3000\u200b]+/g, ' ').trim()
}

/**
 * Inline emphasis, which search engines wrap around the query terms they
 * matched. Removing it must not leave a space behind: `异步<em>编程</em>` is one
 * word, and a space in the middle of a Chinese title is corruption.
 */
const INLINE_TAGS = /<\/?(?:em|b|strong|i|u|s|span|font|mark|small|sup|sub|code|abbr|cite|q|del|ins|time)\b[^>]*>/gi

/** HTML fragment to one line of text: tags gone, entities decoded. */
export function htmlToText(html: string): string {
  const inlineStripped = html.replace(INLINE_TAGS, '')
  return collapseWhitespace(decodeHtmlEntities(inlineStripped.replace(/<[^>]*>/g, ' ')))
}

/** One line of at most `maxChars`, cut on a word boundary where there is one. */
export function singleLine(text: string, maxChars = 320): string {
  const line = collapseWhitespace(text)
  if (line.length <= maxChars) return line
  const head = line.slice(0, maxChars)
  const space = head.lastIndexOf(' ')
  return `${(space > maxChars * 0.6 ? head.slice(0, space) : head).trimEnd()}…`
}

const CJK_PATTERN = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** Whether the text is written in CJK, which decides which engines to try first. */
export function hasCjk(text: string): boolean {
  return CJK_PATTERN.test(text)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** The hostname of a URL, lowercased, or undefined when it does not parse. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^msclkid$/i, /^igshid$/i, /^spm$/i, /^ref_src$/i]

/**
 * The identity of a page, for de-duplication: no fragment, no tracking
 * parameters, no trailing slash. The same article reached by two queries is
 * then printed once.
 */
export function canonicalUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) url.searchParams.delete(key)
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
  return url.href
}

/** `href` resolved against `base`, when the result is a page a tool can fetch. */
export function resolveHttpUrl(href: string, base: string): string | undefined {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || /^(?:javascript|data|mailto|tel):/i.test(trimmed)) return undefined
  try {
    const url = new URL(trimmed, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Charset labels that browsers treat as one encoding. A page that says
 * `gb2312` is served as `gbk`; `iso-8859-1` is decoded as `windows-1252`
 * because that is what the WHATWG encoding table — and therefore every
 * browser, and therefore Node's `TextDecoder` — does.
 */
const CHARSET_ALIASES: Record<string, string> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'utf-16': 'utf-16le',
  gb2312: 'gbk',
  'gb_2312': 'gbk',
  'gb_2312-80': 'gbk',
  csgb2312: 'gbk',
  'x-gbk': 'gbk',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  'big5-hkscs': 'big5',
  'x-x-big5': 'big5',
  shift_jis: 'shift_jis',
  'shift-jis': 'shift_jis',
  sjis: 'shift_jis',
  'x-sjis': 'shift_jis',
  ms_kanji: 'shift_jis',
  'windows-31j': 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  'windows-949': 'euc-kr',
  'iso-8859-1': 'windows-1252',
  latin1: 'windows-1252',
  l1: 'windows-1252',
  'us-ascii': 'windows-1252',
  ascii: 'windows-1252',
  'windows-1252': 'windows-1252',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-15': 'iso-8859-15',
  'windows-1251': 'windows-1251',
  'koi8-r': 'koi8-r',
  'windows-874': 'windows-874',
  'tis-620': 'windows-874',
}

function normalizeCharset(label: string | undefined): string | undefined {
  const key = label?.trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!key) return undefined
  return CHARSET_ALIASES[key] ?? key
}

function latin1Head(bytes: Uint8Array, limit: number): string {
  return Buffer.from(bytes.subarray(0, Math.min(limit, bytes.length))).toString('latin1')
}

/**
 * The encoding of a response body, decided the way a browser decides it: a
 * byte-order mark first, then the `charset` the response declared, then the
 * one the document declares about itself, then UTF-8.
 *
 * This is what keeps a GBK news site from arriving as mojibake: `fetch` would
 * decode the bytes as UTF-8 and the Chinese text would be replacement
 * characters that no amount of markdown conversion can recover.
 */
export function sniffCharset(bytes: Uint8Array, contentType?: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'

  const declared = normalizeCharset(contentType?.match(/charset\s*=\s*([^;\s]+)/i)?.[1])
  if (declared) return declared

  const head = latin1Head(bytes, 4096)
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1]
    ?? head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i)?.[1]
  return normalizeCharset(meta) ?? 'utf-8'
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Decode a body with the encoding it declares. A label `TextDecoder` does not
 * know falls back to UTF-8, which is what the bytes would have been read as
 * before — a bad guess degrades, it does not fail the call.
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType?: string): { text: string; charset: string } {
  const charset = sniffCharset(bytes, contentType)
  try {
    return { text: stripBom(new TextDecoder(charset).decode(bytes)), charset }
  } catch {
    return { text: stripBom(new TextDecoder('utf-8').decode(bytes)), charset: 'utf-8' }
  }
}

const BINARY_SNIFF_BYTES = 8192

/**
 * Whether a body is binary rather than text. `Content-Type` is a claim, and
 * plenty of servers answer a URL with a download and no type at all; a NUL
 * byte in the first few kilobytes is the reliable tell.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return false
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

/** A timeout that also honours the caller's abort signal. */
export function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}