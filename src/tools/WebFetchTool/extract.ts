import { createDocument, type DomDocument, type DomElement } from '@mixmark-io/domino'
import { collapseWhitespace, resolveHttpUrl } from '../webText.js'

/**
 * HTML to readable markdown.
 *
 * Turndown alone converts the *whole* document, and a documentation page is
 * mostly not documentation: navigation, the theme switcher's `<script>`, the
 * cookie banner's markup, forty related links. On a real page that is 30–70%
 * of the tokens, and it arrives in place of the text the tool was called for.
 * So the page is parsed first — the parser is the one Turndown already bundles
 * for Node — and only the article goes to the converter.
 */

type TurndownCtor = typeof import('turndown')

let turndownInstance: InstanceType<TurndownCtor> | undefined

export interface ExtractedPage {
  /** The document's `<title>`, collapsed; absent when the page has none. */
  title?: string
  markdown: string
}

/** Elements that never carry prose: they are script, style, or controls. */
const DROPPED_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas',
  'iframe', 'object', 'embed', 'form', 'button', 'input', 'select',
  'textarea', 'dialog', 'link', 'meta', 'video', 'audio', 'source', 'track',
]

/** Chrome that is not prose wherever it appears, including inside an article. */
const CHROME_SELECTORS = [
  '[aria-hidden="true"]',
  '[hidden]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '.sr-only',
  '.visually-hidden',
  '.screen-reader-text',
  '.skip-link',
  '[class*="skip"]',
  '[class*="a11y"]',
  '[id*="skip"]',
  'nav',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '.breadcrumb',
  '.breadcrumbs',
  '.pagination',
  '.pager',
  '.toc',
  '#toc',
  '.table-of-contents',
  '.document-toc',
  '.document-toc-container',
  '.sidebar',
  '#sidebar',
  '.share',
  '.share-buttons',
  '.social-share',
  '.related',
  '.related-posts',
  '.comments',
  '#comments',
  '.newsletter',
  '.subscribe',
  '.cookie',
  '.cookie-banner',
  '.advert',
  '.advertisement',
]

/**
 * Where an article tends to live, in the order a page is likely to mean it.
 * The winner is chosen by how much text it holds, not by which selector
 * matched first, because a page that has both `<main>` and `<article>` holds
 * the same prose twice.
 */
const MAIN_SELECTORS = [
  'main',
  '[role="main"]',
  '#main',
  '#content',
  '#main-content',
  '[itemprop="articleBody"]',
  'article',
  '.markdown-body',
  '.md-content',
  '.doc-content',
  '.document',
  '.article-body',
  '.post-content',
  '.entry-content',
]

/** A candidate holding less than this is a blurb, not the article. */
const MIN_MAIN_TEXT = 200
/** A candidate must hold at least this share of the body to win. */
const MAIN_SHARE = 0.25
/** Two candidates this close in size are siblings in a list, not one article. */
const SIBLING_SHARE = 0.6

export async function extractReadable(html: string, url: string): Promise<ExtractedPage> {
  const doc = createDocument(html)
  const title = collapseWhitespace(doc.title ?? '')

  dropNoise(doc)

  const root = pickMain(doc)
  stripChrome(root, root === doc.body || root === doc.documentElement)
  absolutize(root, url)

  const turndown = await getTurndown()
  const markdown = tidyMarkdown(turndown.turndown(root.outerHTML))

  return { ...(title ? { title } : {}), markdown }
}

// --- selection ------------------------------------------------------------

function dropNoise(doc: DomDocument): void {
  dropMatching(doc, [...DROPPED_TAGS, ...CHROME_SELECTORS].join(', '))
  // Comments are invisible to the reader, and some sites carry paragraphs of
  // build metadata in them.
  removeCommentNodes(doc.documentElement)
}

function pickMain(doc: DomDocument): DomElement {
  const body = doc.body ?? doc.documentElement
  const bodyText = textLength(body)

  const found: DomElement[] = []
  for (const selector of MAIN_SELECTORS) {
    let list: ReturnType<DomDocument['querySelectorAll']>
    try {
      list = doc.querySelectorAll(selector)
    } catch {
      continue
    }
    for (let index = 0; index < list.length && index < 20; index += 1) {
      const element = list[index]
      if (element) found.push(element)
    }
  }

  const scored = found
    .map((element) => ({ element, length: textLength(element) }))
    .filter((candidate) => candidate.length >= MIN_MAIN_TEXT)
  if (scored.length === 0) return body

  // A `<main>` that contains the `<article>` is one candidate, not two.
  const outermost = scored.filter((candidate) =>
    !scored.some((other) => other !== candidate && other.length >= candidate.length && contains(other.element, candidate.element)))
  outermost.sort((left, right) => right.length - left.length)

  const [best, ...rest] = outermost
  if (!best) return body
  // Several unrelated blocks of the same size: an index page. The body keeps
  // all of them, and the chrome pass still removes what surrounds them.
  if (rest.some((candidate) => candidate.length >= best.length * SIBLING_SHARE)) return body
  // One candidate among much larger surroundings is a sidebar blurb.
  if (best.length < bodyText * MAIN_SHARE) return body
  return best.element
}

/**
 * Remove what surrounds the prose inside the chosen root.
 *
 * A `header` that is the root's first child survives when the root is an
 * article, because that is where a documentation page keeps its title and
 * byline. When the root is the whole body, a header is the site's masthead and
 * goes with the rest of the chrome.
 */
function stripChrome(root: DomElement, rootIsWholeBody: boolean): void {
  dropMatching(root, CHROME_SELECTORS.join(', '))

  for (const header of toArray(root.querySelectorAll('header'))) {
    if (!rootIsWholeBody && root.firstElementChild === header) continue
    header.parentNode?.removeChild(header)
  }
}

function contains(outer: DomElement, inner: DomElement): boolean {
  let node = inner.parentNode
  while (node) {
    if (node === outer) return true
    node = node.parentNode
  }
  return false
}

function textLength(element: DomElement): number {
  return collapseWhitespace(element.textContent ?? '').length
}

function dropMatching(root: DomElement | DomDocument, selector: string): void {
  let matches: DomElement[]
  try {
    matches = toArray(root.querySelectorAll(selector))
  } catch {
    // A selector this parser cannot express is skipped, never fatal: losing a
    // noise element costs tokens, failing the fetch costs the page.
    return
  }
  for (const element of matches) element.parentNode?.removeChild(element)
}

function removeCommentNodes(root: DomElement): void {
  const stack: DomElement[] = [root]
  while (stack.length > 0) {
    const element = stack.pop()!
    const children = toArray(element.childNodes as unknown as { length: number; [index: number]: DomElement })
    for (const child of children) {
      if (child.nodeType === 8) element.removeChild(child)
      else if (child.nodeType === 1) stack.push(child)
    }
  }
}

/** Turn a page's relative links into absolute ones the model can fetch next. */
function absolutize(root: DomElement, baseUrl: string): void {
  for (const anchor of toArray(root.querySelectorAll('a[href]'))) {
    const resolved = resolveHttpUrl(anchor.getAttribute('href') ?? '', baseUrl)
    if (resolved) anchor.setAttribute('href', resolved)
    else anchor.removeAttribute('href')
  }
  for (const image of toArray(root.querySelectorAll('img'))) {
    const source = image.getAttribute('src') ?? image.getAttribute('data-src') ?? ''
    const resolved = resolveHttpUrl(source, baseUrl)
    if (resolved) image.setAttribute('src', resolved)
    else image.removeAttribute('src')
  }
}

function toArray<T>(list: { length: number; [index: number]: T }): T[] {
  const items: T[] = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (item !== undefined && item !== null) items.push(item)
  }
  return items
}

// --- conversion -----------------------------------------------------------

async function getTurndown(): Promise<InstanceType<TurndownCtor>> {
  if (turndownInstance) return turndownInstance
  const module = await import('turndown')
  const Turndown = (module as unknown as { default: TurndownCtor }).default
  const service = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
  })
  addRules(service)
  turndownInstance = service
  return service
}

/** The bits of a converter node these rules read; `@types/turndown` says `HTMLElement`. */
interface NodeLike {
  nodeName?: string
  textContent?: string | null
  getAttribute?(name: string): string | null
  querySelectorAll?(selector: string): { length: number; [index: number]: NodeLike }
}

function tagOf(node: unknown): string {
  return (node as NodeLike).nodeName?.toUpperCase() ?? ''
}

function textOf(node: unknown): string {
  return collapseWhitespace((node as NodeLike).textContent ?? '')
}

function attrOf(node: unknown, name: string): string | undefined {
  return (node as NodeLike).getAttribute?.(name) ?? undefined
}

function childrenOf(node: unknown, selector: string): NodeLike[] {
  const list = (node as NodeLike).querySelectorAll?.(selector)
  if (!list) return []
  return toArray(list)
}

function addRules(service: InstanceType<TurndownCtor>): void {
  // An anchor with no text is an icon, a permalink hash or a skip target:
  // `[](https://example.com/)` is pure noise in the transcript.
  service.addRule('emptyAnchor', {
    filter: (node) => tagOf(node) === 'A' && textOf(node) === '',
    replacement: () => '',
  })

  // An in-page anchor (`href="#section"`) is a table-of-contents link: its text
  // names a section, its target cannot be fetched. Keep the words, drop the
  // dead link.
  service.addRule('fragmentAnchor', {
    filter: (node: unknown) => tagOf(node) === 'A' && (attrOf(node, 'href') ?? '').startsWith('#'),
    replacement: (content: string) => content,
  } as unknown as Parameters<InstanceType<TurndownCtor>['addRule']>[1])

  // Images keep their caption and lose their pixels: a `data:` URI is a whole
  // file inline, and an `<img>` with no source says nothing.
  service.addRule('image', {
    filter: 'img',
    replacement: (_content: string, node: unknown) => {
      const alt = collapseWhitespace(attrOf(node, 'alt') ?? '')
      const source = attrOf(node, 'src') ?? ''
      if (!source || source.startsWith('data:')) return alt ? `[${alt}]` : ''
      return `![${alt}](${source})`
    },
  } as unknown as Parameters<InstanceType<TurndownCtor>['addRule']>[1])

  // Turndown has no table support: it flattens a row into one line of cells
  // run together, which is unreadable for the comparison tables API docs are
  // full of. GFM pipe tables survive the model reading them back.
  service.addRule('gfmTable', {
    filter: 'table',
    replacement: (_content: string, node: unknown) => markdownTable(node),
  } as unknown as Parameters<InstanceType<TurndownCtor>['addRule']>[1])
}

function markdownTable(node: unknown): string {
  const rows = childrenOf(node, 'tr')
    .map((row) => childrenOf(row, 'th,td').map((cell) => textOf(cell).replace(/\|/g, '\\|')))
    .filter((cells) => cells.length > 0)
  if (rows.length === 0) return ''
  if (rows.length === 1) {
    const only = rows[0]!
    return only.some((cell) => cell !== '') ? `\n\n${only.join(' | ')}\n\n` : ''
  }

  const width = Math.max(...rows.map((cells) => cells.length))
  const pad = (cells: string[]): string[] =>
    [...cells, ...Array.from({ length: width - cells.length }, () => '')]
  const [header, ...body] = rows
  const lines = [
    `| ${pad(header!).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${pad(cells).join(' | ')} |`),
  ]
  return `\n\n${lines.join('\n')}\n\n`
}

// --- tidying --------------------------------------------------------------

const EMPTY_MARKDOWN_LINE = /^(?:[-*+>]\s*)?(?:!?\[[^\]]*\]\([^)]*\)|#{1,6})?$/

/**
 * Markdown that a model will read, rather than the converter's raw output:
 * trailing spaces gone, runs of blank lines collapsed, lines that survived
 * conversion as an empty link or an empty heading dropped.
 */
export function tidyMarkdown(markdown: string): string {
  const kept: string[] = []
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '')
    if (line.trim() === '') {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('')
      continue
    }
    if (EMPTY_MARKDOWN_LINE.test(line.trim())) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}