import { Marked } from 'marked'
import type { Rules, Token, TokenizerAndRendererExtension, TokenizerThis, Tokens } from 'marked'

/**
 * Markdown as data: `marked`'s lexer folded into a small union the DOM layer can
 * walk with `el()`.
 *
 * The lexer, never `marked.parse()`. The parser's whole output is an HTML string,
 * and the renderer has no way to put one on the page — `innerHTML` is banned
 * outright (see `dom/dom.ts`: model-authored text under `script-src 'self'` still
 * gets to run an `onerror=` attribute). So the HTML string is never produced in
 * the first place, and the three unsafe constructs are downgraded *here*, at parse
 * time, rather than filtered later:
 *
 *  - an `html` token becomes literal text, so no path exists that treats a tag in
 *    model output as a tag;
 *  - a link whose href is not `http:`/`https:`/`mailto:` loses the link wrapper and
 *    keeps only its text (`textContent` does nothing about `<a href="javascript:">`);
 *  - an image becomes `alt (url)` text rather than an `<img>` — the CSP's
 *    `img-src 'self' data:` would block a remote one anyway, and a remote fetch
 *    from a transcript is an exfiltration beacon.
 *
 * TeX is the one construct the lexer does not know about, so it is added back as
 * a pair of extensions (see `MATH_EXTENSIONS`). They only *find* the maths and
 * hand the source string on untouched; typesetting is `dom/markdownView.ts`'s
 * job, because it needs KaTeX and a `document`.
 *
 * DOM-free on purpose: `test/` imports this, which compiles it in the base tsconfig
 * program, and that program has no DOM lib. `HTMLElement` lives in
 * `dom/markdownView.ts`.
 */

export type MdInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly MdInline[] }
  | { readonly kind: 'em'; readonly children: readonly MdInline[] }
  | { readonly kind: 'del'; readonly children: readonly MdInline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly kind: 'break' }
  /**
   * TeX source, verbatim. `display` is KaTeX's `displayMode`: `$$…$$` and
   * `\[…\]` set it even when they turn up mid-paragraph, which is the common
   * case — a model writes a lead-in line and the equation under it without the
   * blank line that would make it a block of its own.
   */
  | { readonly kind: 'math'; readonly tex: string; readonly display: boolean }

export interface MdListItem {
  readonly blocks: readonly MdBlock[]
  /** A GFM task item; `undefined` for an ordinary one. */
  readonly checked?: boolean
}

export type MdBlock =
  | { readonly kind: 'paragraph'; readonly inline: readonly MdInline[] }
  | { readonly kind: 'heading'; readonly level: number; readonly inline: readonly MdInline[] }
  | { readonly kind: 'code'; readonly lang: string | undefined; readonly text: string }
  | {
      readonly kind: 'list'
      readonly ordered: boolean
      readonly start: number
      readonly items: readonly MdListItem[]
    }
  | { readonly kind: 'quote'; readonly blocks: readonly MdBlock[] }
  | {
      readonly kind: 'table'
      readonly header: readonly (readonly MdInline[])[]
      readonly rows: readonly (readonly (readonly MdInline[])[])[]
    }
  | { readonly kind: 'rule' }
  /** A display equation standing alone between blank lines. */
  | { readonly kind: 'math'; readonly tex: string }

// ── TeX ──
//
// Four delimiter pairs, the set every model actually emits: `$$…$$` and `\[…\]`
// for display, `$…$` and `\(…\)` for inline.
//
// `\(` and `\[` are the reason this cannot be left to a post-pass over the
// rendered text. CommonMark says a backslash before ASCII punctuation is an
// escape, so the lexer already eats those delimiters — `\(x_1\)` reaches the
// screen as `(x_1)`, with no way left to tell it from parentheses somebody
// typed. An extension tokenizer runs *before* the built-in `escape`, which is
// the only place the distinction still exists.
//
// `$…$` is the delimiter that has to be defended against prose, because a
// dollar sign is also a dollar sign. Three conditions, together enough for
// "$5 and $10 buys $15 of it" to stay text:
//
//   - the opener is not followed by a space (`$ x$` is not maths),
//   - the closer is not preceded by one (`$x $` is not either),
//   - the closer is not followed by a digit, which is what rejects the price
//     pair above — `$5 and $` would otherwise close on the second dollar.
//
// Content may not span a blank line, so an unclosed `$` costs at most the rest
// of the paragraph rather than swallowing the document. Nothing matches without
// its closing delimiter at all: mid-stream, half an equation shows as its own
// source for one frame and settles once the rest arrives.

const MATH_BLOCK_PATTERNS = [
  /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/,
  /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/,
] as const

const MATH_INLINE_PATTERNS: readonly (readonly [RegExp, boolean])[] = [
  [/^\$\$((?:[^$\n]|\n(?!\n))+?)\$\$/, true],
  [/^\\\[((?:[^\n]|\n(?!\n))+?)\\\]/, true],
  [/^\\\(((?:[^\n]|\n(?!\n))+?)\\\)/, false],
  [/^\$(?![\s$])((?:[^$\n]|\n(?!\n))+?)(?<!\s)\$(?!\d)/, false],
] as const

/** Where a delimiter *could* start, so `marked` stops its text run there. */
const MATH_START = /(?<!\\)\$|\\\(|\\\[/

interface MathToken extends Tokens.Generic {
  readonly tex: string
  readonly display: boolean
}

const MATH_EXTENSIONS: TokenizerAndRendererExtension[] = [
  {
    name: 'mathBlock',
    level: 'block',
    tokenizer(src) {
      for (const pattern of MATH_BLOCK_PATTERNS) {
        const match = pattern.exec(src)
        const tex = match?.[1]!.trim()
        // `$$   $$` is a row of punctuation somebody typed, not an equation;
        // KaTeX would render it as nothing at all and leave a gap in the answer.
        if (match && tex) return { type: 'mathBlock', raw: match[0], tex, display: true }
      }
      return undefined
    },
  },
  {
    name: 'mathInline',
    level: 'inline',
    start: (src) => MATH_START.exec(src)?.index,
    tokenizer(src) {
      for (const [pattern, display] of MATH_INLINE_PATTERNS) {
        const match = pattern.exec(src)
        const tex = match?.[1]!.trim()
        if (match && tex) return { type: 'mathInline', raw: match[0], tex, display }
      }
      return undefined
    },
  },
]

// ── bare URLs ──
//
// GFM's autolink runs to the next whitespace and then backpedals over trailing
// ASCII punctuation: right for English prose, wrong for Chinese, where a URL
// sits in the sentence with no space either side. `http://host/x）复刻了三行`
// became one anchor holding the rest of the paragraph, and its `href` — the
// whole paragraph — was what a click would have opened. A URL as people write
// one holds no raw CJK (a browser percent-encodes it), so the first such
// character ends the link and hands the remainder back to the lexer, which
// tokenizes it as the prose it is.
//
// The general punctuation block is there because Chinese prose marks a break
// with `——` and `“”` rather than with a space: `http://host/x——“页面”` stops at
// the dash, so the quotes around `页面` are not a URL either.

const BARE_URL_STOP =
  /[\u2013\u2014\u2018-\u201D\u2026\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/

/** marked's `url` tokenizer, cut at `BARE_URL_STOP`. */
function bareUrl(this: TokenizerThis, src: string): Tokens.Link | undefined {
  const { rules } = this as unknown as { rules: Rules }
  const match = rules.inline.url.exec(src)
  if (!match) return undefined
  if (match[2] === '@') return bareLink(match[0], `mailto:${match[0]}`)
  const stop = BARE_URL_STOP.exec(match[0])
  let text = stop ? match[0].slice(0, stop.index) : match[0]
  // marked's own backpedal, re-run: a comma or a closing paren is only trailing
  // punctuation once the cut has put it at the end.
  for (let previous = ''; previous !== text;) {
    previous = text
    text = rules.inline._backpedal.exec(text)?.[0] ?? ''
  }
  if (!text) return undefined
  return bareLink(text, match[1] === 'www.' ? `http://${text}` : text)
}

function bareLink(text: string, href: string): Tokens.Link {
  return { type: 'link', raw: text, href, text, tokens: [{ type: 'text', raw: text, text }] }
}

/**
 * A private lexer rather than `marked.use()`.
 *
 * `use` mutates the shared singleton, and `src/tui/markdown.ts` lexes with it in
 * the same process under `node --test`. Maths in a terminal is a separate
 * decision; it should not arrive as a side effect of importing this file.
 */
const lexer = new Marked({ extensions: MATH_EXTENSIONS, tokenizer: { url: bareUrl } })

/** Protocols a link may keep. Everything else degrades to its own text. */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:']

export function safeHref(href: string): string | undefined {
  const trimmed = href.trim()
  // A relative or fragment target has no protocol to vet, but it also has nowhere
  // useful to go from a `file://` renderer — drop it rather than ship a dead link.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  if (!match) return undefined
  return SAFE_PROTOCOLS.includes(match[1]!.toLowerCase() + ':') ? trimmed : undefined
}

// ── parse cache ──
//
// A deliberate second copy of `src/tui/markdown.ts`'s FNV-1a LRU: `tui/` is on the
// renderer's forbidden-import list (`test/rendererImports.test.ts`), so the module
// cannot be shared. The need is sharper here than in the TUI — `transcriptView`
// rebuilds the whole list on every streamed token, so without this a single answer
// re-parses every settled assistant message thousands of times. With it, only the
// draft (whose text actually changed) is parsed.

const TOKEN_CACHE_MAX = 500

interface ParsedMarkdown {
  blocks: MdBlock[]
  segments: MdSegment[]
  source: string
  /** Where a longer copy of `source` may start lexing again, and how many segments precede that point. */
  resume?: { at: number; segments: number }
}

const blockCache = new Map<string, ParsedMarkdown>()

/**
 * The last parse that missed the cache — while an answer streams, the draft.
 * Its next chunk is lexed from `resume` on, so a frame costs the tail of the
 * answer rather than all of it.
 */
let draft: ParsedMarkdown | undefined

/**
 * Blocks a blank line ends for good: nothing after it can reach back into them.
 * Lists and indented code are missing because both continue across blank lines,
 * and HTML because its end rules are its own.
 */
const SEALED_BY_BLANK = new Set(['paragraph', 'heading', 'hr', 'code', 'mathBlock', 'table', 'blockquote'])

/** A source-position key survives append-only streaming, including block closure. */
export interface MdSegment {
  readonly id: string
  readonly block: MdBlock
  readonly closed: boolean
  /** Includes resolved references: a later link definition may change an earlier block. */
  readonly signature: string
}

/** FNV-1a 32-bit, with the length appended: a 32-bit hash alone collides. */
function hashContent(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${hash >>> 0}:${value.length}`
}

export function parseMarkdownBlocks(content: string): MdBlock[] {
  return parsedMarkdown(content).blocks
}

export function parseMarkdownSegments(content: string, settled = false): readonly MdSegment[] {
  const segments = parsedMarkdown(content).segments
  return settled ? segments.map((segment) => segment.closed ? segment : { ...segment, closed: true }) : segments
}

function parsedMarkdown(content: string): ParsedMarkdown {
  const key = hashContent(content)
  const cached = blockCache.get(key)
  if (cached && cached.source === content) {
    blockCache.delete(key)
    blockCache.set(key, cached)
    return cached
  }

  const base = draft?.resume && content.startsWith(draft.source) ? draft : undefined
  const parsed = (base && lexFrom(content, base)) ?? lexFrom(content)!
  if (blockCache.size >= TOKEN_CACHE_MAX) blockCache.delete(blockCache.keys().next().value!)
  blockCache.set(key, parsed)
  draft = parsed
  return parsed
}

/**
 * Lexes `content`, or only what follows `base.resume` with `base`'s segments
 * before it. A link definition in the new text refuses the shortcut: it may
 * resolve a link in a block already kept.
 */
function lexFrom(content: string, base?: ParsedMarkdown): ParsedMarkdown | undefined {
  const at = base?.resume?.at ?? 0
  const tokens = lexer.lexer(at > 0 ? content.slice(at) : content)
  const hasDef = tokens.some((token) => token.type === 'def')
  if (base && hasDef) return undefined

  const segments = base ? base.segments.slice(0, base.resume!.segments) : []
  let resume = base?.resume
  let lastContent = -1
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'space' && token.type !== 'def') lastContent = index
  }
  let offset = at
  for (const [index, token] of tokens.entries()) {
    const sealed = tokens[index - 2]
    if (sealed && tokens[index - 1]!.type === 'space' && SEALED_BY_BLANK.has(sealed.type)
      && (sealed.type !== 'code' || closesItself(sealed, undefined))) {
      resume = { at: offset, segments: segments.length }
    }
    const closed = index < lastContent || closesItself(token, tokens[index + 1])
    for (const [part, block] of blockFrom(token).entries()) {
      segments.push({ id: `${offset}:${part}`, block, closed, signature: JSON.stringify(block) })
    }
    offset += token.raw.length
  }
  return {
    blocks: segments.map((segment) => segment.block),
    segments,
    source: content,
    ...(resume && !hasDef ? { resume } : {}),
  }
}

function closesItself(token: Token, next: Token | undefined): boolean {
  if (token.type === 'mathBlock') return true // The extension requires a closing delimiter.
  if (token.type === 'heading' || token.type === 'hr') return token.raw.endsWith('\n')
  if (token.type === 'code') {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1]
    if (!fence) return false
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    return token.raw.trimEnd().split('\n').slice(1).some((line) => closing.test(line))
  }
  // Lists and tables can grow across blank lines. A following block (above), or
  // the settled turn, closes them; a paragraph is bounded by its blank line.
  return token.type === 'paragraph' && /\n[ \t]*\n$/.test(token.raw + (next?.type === 'space' ? next.raw : ''))
}

/** Test seam; also useful if a session ever grows past the LRU's usefulness. */
export function resetMarkdownCache(): void {
  blockCache.clear()
  draft = undefined
}

function blockFrom(token: Token): MdBlock[] {
  switch (token.type) {
    case 'space':
    // A link reference definition renders nothing; its target is already folded
    // into the links that used it.
    case 'def':
      return []

    case 'heading': {
      const heading = token as Tokens.Heading
      return [{
        kind: 'heading',
        level: Math.min(Math.max(heading.depth, 1), 6),
        inline: inlineFrom(heading.tokens),
      }]
    }

    case 'code': {
      const code = token as Tokens.Code
      return [{ kind: 'code', lang: code.lang?.trim() || undefined, text: code.text }]
    }

    case 'blockquote': {
      const quote = token as Tokens.Blockquote
      return [{ kind: 'quote', blocks: quote.tokens.flatMap(blockFrom) }]
    }

    case 'list': {
      const list = token as Tokens.List
      return [{
        kind: 'list',
        ordered: list.ordered,
        start: typeof list.start === 'number' ? list.start : 1,
        items: list.items.map(listItemFrom),
      }]
    }

    case 'table': {
      const table = token as Tokens.Table
      return [{
        kind: 'table',
        header: table.header.map((cell) => inlineFrom(cell.tokens)),
        rows: table.rows.map((row) => row.map((cell) => inlineFrom(cell.tokens))),
      }]
    }

    case 'hr':
      return [{ kind: 'rule' }]

    case 'mathBlock':
      return [{ kind: 'math', tex: (token as MathToken).tex }]

    case 'html':
      // The whole point: a tag in model output is text, not markup.
      return [{ kind: 'paragraph', inline: [{ kind: 'text', text: (token as Tokens.HTML).raw }] }]

    case 'paragraph':
    case 'text': {
      const block = token as Tokens.Paragraph | Tokens.Text
      const inline = block.tokens ? inlineFrom(block.tokens) : [plainText(block.text)]
      return inline.length === 0 ? [] : [{ kind: 'paragraph', inline }]
    }

    default:
      // Anything the lexer grows later, or half a construct mid-stream. Showing
      // the raw source beats throwing inside a transcript render.
      return [{ kind: 'paragraph', inline: [plainText(token.raw)] }]
  }
}

function listItemFrom(item: Tokens.ListItem): MdListItem {
  // The `checkbox` token carries the state; the item's own `checked` agrees, and
  // the token itself must not fall through to the raw-text default.
  const tokens = item.tokens.filter((token) => token.type !== 'checkbox')
  const blocks = tokens.flatMap(blockFrom)
  return item.task ? { blocks, checked: item.checked === true } : { blocks }
}

function inlineFrom(tokens: readonly Token[]): MdInline[] {
  return tokens.flatMap(inlineOne)
}

function inlineOne(token: Token): MdInline[] {
  switch (token.type) {
    case 'text':
    case 'escape': {
      const text = token as Tokens.Text | Tokens.Escape
      // A `text` token can itself carry children (a list item's body does).
      const nested = (text as Tokens.Text).tokens
      return nested ? inlineFrom(nested) : [plainText(text.text)]
    }

    case 'codespan':
      return [{ kind: 'code', text: (token as Tokens.Codespan).text }]

    case 'strong':
      return [{ kind: 'strong', children: inlineFrom((token as Tokens.Strong).tokens) }]

    case 'em':
      return [{ kind: 'em', children: inlineFrom((token as Tokens.Em).tokens) }]

    case 'del':
      return [{ kind: 'del', children: inlineFrom((token as Tokens.Del).tokens) }]

    case 'br':
      return [{ kind: 'break' }]

    case 'mathInline': {
      const math = token as MathToken
      // TeX is not markdown and not HTML: it goes to KaTeX exactly as written,
      // so it skips `decodeEntities` along with everything else here.
      return [{ kind: 'math', tex: math.tex, display: math.display }]
    }

    case 'link': {
      const link = token as Tokens.Link
      const children = inlineFrom(link.tokens)
      const href = safeHref(link.href)
      // An unsafe target keeps the words and loses the anchor.
      return href === undefined ? children : [{ kind: 'link', href, children }]
    }

    case 'image': {
      const image = token as Tokens.Image
      const alt = image.text || 'image'
      return [plainText(image.href ? `${alt} (${image.href})` : alt)]
    }

    case 'html':
      // Inline markup, same rule as the block form.
      return [plainText(token.raw)]

    default:
      return [plainText(token.raw)]
  }
}

function plainText(text: string): MdInline {
  return { kind: 'text', text: decodeEntities(text) }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * The lexer leaves entities as written, because its consumer is normally an HTML
 * renderer that hands them to the browser's parser. `textContent` has no parser, so
 * `&amp;` would reach the screen as five characters. Decoding is safe precisely
 * because the result is only ever set as text.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}
