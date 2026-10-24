import katex from 'katex'

import type { MdBlock, MdInline, MdListItem } from '../model/markdown.js'
import { parseMarkdownBlocks, parseMarkdownSegments } from '../model/markdown.js'
import { REDUCED_MOTION_QUERY } from '../model/reducedMotion.js'
import { isShellLang } from '../model/syntax.js'
import { el, append } from './dom.js'
import { button } from './controls.js'
import { copyText } from './clipboard.js'
import { copyButton } from './copyButton.js'
import { icon } from './icons.js'
import { shellNodes } from './syntaxView.js'

/**
 * `MdBlock[]` to nodes. Every decision — what is a link, what is literal text —
 * was already made by the parser, so this file is nothing but element building,
 * and it uses `el()` exclusively: no `innerHTML`, no `insertAdjacentHTML`.
 *
 * Shell fences are coloured by `dom/syntaxView.ts`; every other language only
 * gets its name as a label.
 *
 * Maths is the one exception to "nothing but element building", and it is not a
 * hole in the rule above: `katex.render()` clears its target with `textContent`
 * and appends a tree it built through `createElement`, so the string form
 * (`renderToString`) — the one this file could not use — is never produced. See
 * `mathNode` for the options that keep it that way.
 */
export function markdownNode(content: string, className = 'md'): HTMLElement {
  return el('div', className, ...markdownChildren(content))
}

/**
 * The same blocks without a wrapper, for a caller that already owns the node they
 * go into — the transcript reuses its nodes by id (T7), so it refills an element
 * it kept rather than building a new one around the blocks.
 */
// Owned by the particular message element, never by a session id or shared
// source key. Removing that element releases its block cache as well.
const keptBlocks = new WeakMap<HTMLElement, Map<string, { signature: string; node: HTMLElement }>>()

export function markdownChildren(content: string, owner?: HTMLElement): HTMLElement[] {
  if (!owner) return parseMarkdownBlocks(content).map(blockNode)
  const previous = keptBlocks.get(owner)
  const next = new Map<string, { signature: string; node: HTMLElement }>()
  // A repaint of an owner that already holds blocks is a stream growing: text
  // past what the previous paint showed fades in. A first paint (history, a
  // rebuilt row) and a reduced-motion preference paint plain.
  const fade = previous !== undefined && !prefersReducedMotion()
  let faded = false
  const nodes = parseMarkdownSegments(content).map((segment) => {
    const cached = previous?.get(segment.id)
    let entry = cached
    if (cached?.signature !== segment.signature) {
      entry = { signature: segment.signature, node: blockNode(segment.block) }
      if (fade && fadeNewText(entry.node, cached?.node.textContent ?? '')) faded = true
    }
    next.set(segment.id, entry!)
    return entry!.node
  })
  keptBlocks.set(owner, next)
  if (faded) watchFades(owner)
  return nodes
}

const FADE_CLASS = 'md-fade'
/** Longer than the CSS animation; only a backstop for an `animationend` that never fires. */
const FADE_SWEEP_MS = 600
const fadeWatch = new WeakMap<HTMLElement, { timer: ReturnType<typeof setTimeout> | undefined }>()

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true
}

function isText(node: Node): node is Text {
  return typeof (node as Text).data === 'string'
}

/**
 * Wraps the text of `block` that lies past its common prefix with `before` (the
 * same block's text on the previous paint) in `.md-fade` spans. Maths is left
 * alone: KaTeX owns that subtree and wrapping inside it would corrupt the
 * typeset tree (an equation appears whole when its closing delimiter arrives).
 * Code and link text are wrapped like any other.
 */
function fadeNewText(block: HTMLElement, before: string): boolean {
  const after = block.textContent ?? ''
  let prefix = 0
  const limit = Math.min(before.length, after.length)
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++
  if (prefix >= after.length) return false

  const found: Array<{ node: Text; cut: number }> = []
  let offset = 0
  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (isText(child)) {
        const end = offset + child.data.length
        if (end > prefix) found.push({ node: child, cut: Math.max(0, prefix - offset) })
        offset = end
      } else if (!(child as HTMLElement).className?.includes?.('md-math')) {
        walk(child)
      } else {
        offset += child.textContent?.length ?? 0
      }
    }
  }
  walk(block)
  for (const { node, cut } of found) {
    const parent = node.parentNode!
    const span = el('span', FADE_CLASS, node.data.slice(cut))
    if (cut === 0) {
      parent.insertBefore(span, node)
      parent.removeChild(node)
    } else {
      node.data = node.data.slice(0, cut)
      parent.insertBefore(span, parent.childNodes[Array.prototype.indexOf.call(parent.childNodes, node) + 1] ?? null)
    }
  }
  return found.length > 0
}

/** Back to a plain text node, merged into its neighbours so the tree does not grow. */
function unwrapFade(span: Node): void {
  const parent = span.parentNode
  if (!parent) return
  const siblings = Array.from(parent.childNodes)
  const at = siblings.indexOf(span as ChildNode)
  const before = siblings[at - 1]
  const after = siblings[at + 1]
  let text = span.firstChild as Text
  parent.insertBefore(text, span)
  parent.removeChild(span)
  if (before && isText(before)) {
    before.data += text.data
    parent.removeChild(text)
    text = before
  }
  if (after && isText(after)) {
    text.data += after.data
    parent.removeChild(after)
  }
}

function watchFades(owner: HTMLElement): void {
  let watch = fadeWatch.get(owner)
  if (!watch) {
    watch = { timer: undefined }
    fadeWatch.set(owner, watch)
    owner.addEventListener('animationend', (event) => {
      const target = event.target as HTMLElement
      if (target.className === FADE_CLASS) unwrapFade(target)
    })
  }
  // One pending sweep per owner, pushed back while the stream keeps painting.
  clearTimeout(watch.timer)
  watch.timer = setTimeout(() => {
    for (const span of Array.from(owner.querySelectorAll(`.${FADE_CLASS}`))) unwrapFade(span)
  }, FADE_SWEEP_MS)
}

function blockNode(block: MdBlock): HTMLElement {
  switch (block.kind) {
    case 'paragraph':
      return el('p', undefined, ...inlineNodes(block.inline))

    case 'heading': {
      const tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[block.level - 1] ?? 'h6'
      return el(tag, undefined, ...inlineNodes(block.inline))
    }

    case 'code': {
      // `bare`: no label line for the copy button to sit on, so the code makes room.
      const wrapper = el('div', block.lang ? 'md-code' : 'md-code bare')
      if (block.lang) wrapper.appendChild(el('div', 'md-code-lang', block.lang))
      const code = isShellLang(block.lang) ? el('code', undefined, ...shellNodes(block.text)) : el('code', undefined, block.text)
      wrapper.appendChild(el('pre', undefined, code))
      wrapper.appendChild(codeCopyButton(block.text))
      return wrapper
    }

    case 'list': {
      const list = block.ordered ? el('ol') : el('ul')
      if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start))
      for (const item of block.items) list.appendChild(listItemNode(item))
      return list
    }

    case 'quote':
      return el('blockquote', undefined, ...block.blocks.map(blockNode))

    case 'table':
      return tableNode(block)

    case 'rule':
      return el('hr')

    case 'math':
      return mathNode(block.tex, true)
  }
}

/**
 * One equation, typeset.
 *
 * The options are the load-bearing part:
 *
 *  - `trust` stays at its default `false`, which is what turns `\href`, `\url`
 *    and `\includegraphics` into errors rather than into a link or a remote
 *    fetch the transcript never asked for. Everything else here is model-authored
 *    text; this is the same call `safeHref` makes in the parser.
 *  - `maxSize` caps the lengths TeX can name, so `\rule{99999em}{99999em}` is
 *    clamped instead of pushing the transcript sideways. `maxExpand` is KaTeX's
 *    own macro-expansion limit and its default (1000) already covers the
 *    `\def`-recursion bomb.
 *  - `throwOnError` is on so the failure is *ours*: a bad expression shows as
 *    the source that produced it, in the code face, rather than through KaTeX's
 *    own red-source fallback.
 *  - `errorColor` covers the case that fallback cannot: a command that is
 *    *refused* rather than unparseable — `\href` under `trust: false` — is
 *    rendered by KaTeX as its own name and never reaches the `catch`. Its
 *    default paints that in a hard-coded red, which is exactly the thing
 *    `test/rendererStyleTokens.test.ts` exists to keep out of this renderer;
 *    `currentColor` hands the decision back to the stylesheet.
 */
function mathNode(tex: string, display: boolean): HTMLElement {
  const node = el('span', display ? 'md-math md-math-display' : 'md-math')
  try {
    katex.render(tex, node, {
      displayMode: display,
      throwOnError: true,
      maxSize: 24,
      errorColor: 'currentColor',
    })
  } catch {
    node.className = 'md-math md-math-raw'
    node.textContent = display ? `$$${tex}$$` : `$${tex}$`
  }
  return node
}

function listItemNode(item: MdListItem): HTMLElement {
  const node = el('li', item.checked === undefined ? undefined : 'md-task')
  // A real checkbox would be focusable and look editable; the state is a marker.
  // Drawn, not typed: `[x] ` in the reading face was source leaking into prose.
  // The marker is an image with a name, so the state still reads aloud.
  if (item.checked !== undefined) {
    const mark = el('span', item.checked ? 'md-check done' : 'md-check', icon(item.checked ? 'check-circle' : 'circle'))
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', item.checked ? '已完成' : '未完成')
    node.appendChild(mark)
  }
  // A single paragraph is the common case and reads better unwrapped, so tight
  // items do not gain a block of vertical margin each.
  const blocks = item.blocks
  if (blocks.length === 1 && blocks[0]!.kind === 'paragraph') {
    append(node, [...inlineNodes(blocks[0]!.inline)])
    return node
  }
  append(node, blocks.map(blockNode))
  return node
}

/** Copies the fence's text, with the shared tick-or-cross receipt. */
function codeCopyButton(text: string): HTMLButtonElement {
  return copyButton('md-code-copy', '复制代码', () => copyText(text))
}

function tableNode(block: Extract<MdBlock, { kind: 'table' }>): HTMLElement {
  const head = el('thead', undefined, el(
    'tr',
    undefined,
    ...block.header.map((cell) => el('th', undefined, ...inlineNodes(cell))),
  ))
  const body = el(
    'tbody',
    undefined,
    ...block.rows.map((row) => el(
      'tr',
      undefined,
      ...row.map((cell) => el('td', undefined, ...inlineNodes(cell))),
    )),
  )
  return el('table', 'md-table', head, body)
}

function inlineNodes(inline: readonly MdInline[]): Node[] {
  return inline.map(inlineNode)
}

function inlineNode(inline: MdInline): Node {
  switch (inline.kind) {
    case 'text':
      return document.createTextNode(inline.text)

    case 'code':
      return el('code', 'md-inline-code', inline.text)

    case 'strong':
      return el('strong', undefined, ...inlineNodes(inline.children))

    case 'em':
      return el('em', undefined, ...inlineNodes(inline.children))

    case 'del':
      return el('del', undefined, ...inlineNodes(inline.children))

    case 'link': {
      // `target="_blank"` so the click reaches `setWindowOpenHandler` in
      // `desktop/main.ts`, which denies the window and hands the URL to the OS
      // browser. Navigating this window would replace the whole UI, since the
      // renderer is a single `loadFile`.
      const anchor = el('a', undefined, ...inlineNodes(inline.children))
      anchor.href = inline.href
      anchor.target = '_blank'
      anchor.rel = 'noreferrer noopener'
      return anchor
    }

    case 'break':
      return el('br')

    case 'math':
      return mathNode(inline.tex, inline.display)
  }
}
