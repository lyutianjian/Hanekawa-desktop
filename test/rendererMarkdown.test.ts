import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarkdownBlocks,
  parseMarkdownSegments,
  resetMarkdownCache,
  safeHref,
} from '../src/desktop/renderer/model/markdown.js'
import type { MdBlock, MdInline } from '../src/desktop/renderer/model/markdown.js'

/**
 * The desktop transcript's markdown, as data.
 *
 * Everything interesting is asserted on the block union rather than on nodes,
 * because the DOM layer (`dom/markdownView.ts`) makes no decisions — and because
 * there is no DOM in the test runner. The three security properties (no HTML
 * passthrough, no unsafe href, no remote image) are decided at *parse* time
 * precisely so they can be pinned here.
 */

function blocks(markdown: string): MdBlock[] {
  // The parser is memoized; a shared cache across cases would hide a key bug.
  resetMarkdownCache()
  return parseMarkdownBlocks(markdown)
}

test('inline code preserves literal entity spelling while prose still decodes entities', () => {
  for (const literal of ['&lt;', '&amp;', '&#60;', '<', 'a &lt; b']) {
    const parsed = blocks('`' + literal + '`')
    assert.deepEqual(parsed, [{ kind: 'paragraph', inline: [{ kind: 'code', text: literal }] }])
  }
})

/** Flatten inline nodes to their visible text, the way `textContent` would. */
function textOf(inline: readonly MdInline[]): string {
  return inline
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text
        case 'strong':
        case 'em':
        case 'del':
          return textOf(node.children)
        case 'link':
          return textOf(node.children)
        case 'break':
          return '\n'
      }
    })
    .join('')
}

function only(markdown: string): MdBlock {
  const parsed = blocks(markdown)
  assert.equal(parsed.length, 1, `expected one block, got ${JSON.stringify(parsed)}`)
  return parsed[0]!
}

test('headings carry their level and their inline children', () => {
  const heading = only('## Some `code` and **bold**')
  assert.equal(heading.kind, 'heading')
  assert.equal(heading.kind === 'heading' && heading.level, 2)
  assert.equal(heading.kind === 'heading' && textOf(heading.inline), 'Some code and bold')
  assert.ok(
    heading.kind === 'heading' && heading.inline.some((node) => node.kind === 'code'),
    'the codespan must survive as a code node, not be flattened to text',
  )
})

test('a heading deeper than six clamps rather than producing an h7', () => {
  const heading = only('####### too deep')
  // marked itself stops at six; the clamp is belt and braces for a lexer change.
  if (heading.kind === 'heading') assert.ok(heading.level >= 1 && heading.level <= 6)
})

test('nested emphasis keeps its structure', () => {
  const paragraph = only('**bold with _em_ inside**')
  assert.equal(paragraph.kind, 'paragraph')
  const [strong] = paragraph.kind === 'paragraph' ? paragraph.inline : []
  assert.equal(strong?.kind, 'strong')
  assert.ok(
    strong?.kind === 'strong' && strong.children.some((child) => child.kind === 'em'),
    'the inner emphasis must remain a node',
  )
})

test('a fenced block keeps its language and its text verbatim', () => {
  const code = only('```ts\nconst a = 1\n\nconst b = 2\n```')
  assert.deepEqual(code, { kind: 'code', lang: 'ts', text: 'const a = 1\n\nconst b = 2' })
})

test('a fence with no language reports undefined rather than an empty string', () => {
  const code = only('```\nplain\n```')
  assert.equal(code.kind === 'code' && code.lang, undefined)
})

test('an unterminated fence mid-stream is a code block, not a crash', () => {
  // Every streamed token re-parses the draft, so half-written syntax is the
  // common case rather than the edge one.
  const code = only('```js\nconst half =')
  assert.deepEqual(code, { kind: 'code', lang: 'js', text: 'const half =' })
})

test('an unterminated bold marker degrades to text', () => {
  const paragraph = only('a **partially writ')
  assert.equal(paragraph.kind, 'paragraph')
  assert.equal(paragraph.kind === 'paragraph' && textOf(paragraph.inline), 'a **partially writ')
})

test('lists report ordering and start, and nest', () => {
  const list = only('1. one\n2. two\n   - inner')
  assert.equal(list.kind, 'list')
  if (list.kind !== 'list') return
  assert.equal(list.ordered, true)
  assert.equal(list.start, 1)
  assert.equal(list.items.length, 2)
  const nested = list.items[1]!.blocks.find((block) => block.kind === 'list')
  assert.ok(nested, 'the indented bullet must nest inside the second item')
  assert.equal(nested.kind === 'list' && nested.ordered, false)
})

test('an ordered list starting elsewhere keeps its start', () => {
  const list = only('7. seven\n8. eight')
  assert.equal(list.kind === 'list' && list.start, 7)
})

test('task items carry their checked state and drop the checkbox token', () => {
  const list = only('- [ ] todo\n- [x] done')
  assert.equal(list.kind, 'list')
  if (list.kind !== 'list') return
  assert.equal(list.items[0]!.checked, false)
  assert.equal(list.items[1]!.checked, true)
  // The `[x] ` marker must not also survive as literal text in the body.
  const body = list.items[1]!.blocks[0]!
  assert.equal(body.kind === 'paragraph' && textOf(body.inline), 'done')
})

test('a plain list item has no checked field at all', () => {
  const list = only('- plain')
  assert.equal(list.kind === 'list' && 'checked' in list.items[0]!, false)
})

test('blockquotes recurse into blocks', () => {
  const quote = only('> outer\n>\n> ```\n> code\n> ```')
  assert.equal(quote.kind, 'quote')
  if (quote.kind !== 'quote') return
  assert.equal(quote.blocks[0]!.kind, 'paragraph')
  assert.equal(quote.blocks[1]!.kind, 'code')
})

test('a horizontal rule is a rule', () => {
  assert.deepEqual(only('***'), { kind: 'rule' })
})

test('tables split into header cells and row cells', () => {
  const table = only('| a | **b** |\n|---|---|\n| 1 | 2 |')
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.header.map(textOf), ['a', 'b'])
  assert.deepEqual(table.rows.map((row) => row.map(textOf)), [['1', '2']])
})

test('a link with an http target keeps its anchor', () => {
  const paragraph = only('see [docs](https://example.com/x?y=1)')
  const link = paragraph.kind === 'paragraph'
    ? paragraph.inline.find((node) => node.kind === 'link')
    : undefined
  assert.ok(link && link.kind === 'link')
  assert.equal(link.href, 'https://example.com/x?y=1')
  assert.equal(textOf(link.children), 'docs')
})

test('a javascript: link loses the anchor and keeps only its words', () => {
  // `textContent` is no defence here: clicking an <a href="javascript:…"> runs it.
  const paragraph = only('[click me](javascript:alert(1))')
  assert.equal(paragraph.kind, 'paragraph')
  if (paragraph.kind !== 'paragraph') return
  assert.equal(
    paragraph.inline.some((node) => node.kind === 'link'),
    false,
    'no link node may survive an unsafe protocol',
  )
  assert.equal(textOf(paragraph.inline), 'click me')
})

test('safeHref admits only http, https and mailto', () => {
  assert.equal(safeHref('https://a.b/c'), 'https://a.b/c')
  assert.equal(safeHref('http://a.b'), 'http://a.b')
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(safeHref('HTTPS://a.b'), 'HTTPS://a.b')
  assert.equal(safeHref('javascript:alert(1)'), undefined)
  assert.equal(safeHref('  JaVaScRiPt:alert(1)'), undefined)
  assert.equal(safeHref('data:text/html,<script>'), undefined)
  assert.equal(safeHref('file:///etc/passwd'), undefined)
  assert.equal(safeHref('./relative.md'), undefined)
  assert.equal(safeHref('#anchor'), undefined)
})

test('a raw HTML block stays literal text', () => {
  // The parse-time half of the no-innerHTML rule. If this ever yields anything
  // but text, model output can put an attribute on the page.
  const paragraph = only('<img src=x onerror=alert(1)>')
  assert.equal(paragraph.kind, 'paragraph')
  if (paragraph.kind !== 'paragraph') return
  assert.deepEqual(paragraph.inline, [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
})

test('inline HTML inside a paragraph stays literal too', () => {
  const paragraph = only('before <b onmouseover=alert(1)>after</b>')
  assert.equal(paragraph.kind, 'paragraph')
  if (paragraph.kind !== 'paragraph') return
  assert.equal(textOf(paragraph.inline), 'before <b onmouseover=alert(1)>after</b>')
  assert.equal(paragraph.inline.every((node) => node.kind === 'text'), true)
})

test('an image becomes alt text plus its url, never an img node', () => {
  const paragraph = only('![a cat](https://example.com/cat.png)')
  assert.equal(paragraph.kind, 'paragraph')
  if (paragraph.kind !== 'paragraph') return
  assert.deepEqual(paragraph.inline, [
    { kind: 'text', text: 'a cat (https://example.com/cat.png)' },
  ])
})

test('entities are decoded, because textContent has no parser to do it', () => {
  const paragraph = only('a &amp; b &lt;c&gt; &#65; &#x42;')
  assert.equal(paragraph.kind === 'paragraph' && textOf(paragraph.inline), 'a & b <c> A B')
})

test('an unknown entity is left alone rather than mangled', () => {
  const paragraph = only('&notanentity; stays')
  assert.equal(paragraph.kind === 'paragraph' && textOf(paragraph.inline), '&notanentity; stays')
})

test('a link reference definition renders nothing', () => {
  assert.deepEqual(blocks('[ref]: https://example.com'), [])
})

test('empty input is an empty document', () => {
  assert.deepEqual(blocks(''), [])
  assert.deepEqual(blocks('\n\n  \n'), [])
})

test('the cache returns the same blocks for the same content', () => {
  resetMarkdownCache()
  const first = parseMarkdownBlocks('# same')
  const second = parseMarkdownBlocks('# same')
  assert.equal(first, second, 'a cache hit must return the identical array')
})

test('two documents whose 32-bit hashes collide do not share a cache entry', () => {
  // Not a hypothetical: `79d` and `zvne27` have the same FNV-1a 32-bit hash
  // (0x6add9d3b), found by search. The key appends the length and the hit is
  // re-checked against it, so the collision resolves — drop *both* guards and the
  // second message renders the first one's text.
  resetMarkdownCache()
  const first = parseMarkdownBlocks('79d')
  const second = parseMarkdownBlocks('zvne27')
  assert.equal(first[0]!.kind === 'paragraph' && textOf(first[0]!.inline), '79d')
  assert.equal(second[0]!.kind === 'paragraph' && textOf(second[0]!.inline), 'zvne27')
})

test('a growing draft parses to the document it currently is', () => {
  // What streaming actually does: the same prefix re-parsed on every token.
  resetMarkdownCache()
  const full = '# Title\n\nSome **text** and a list:\n\n- one\n- two\n'
  for (let end = 1; end <= full.length; end++) {
    const parsed = parseMarkdownBlocks(full.slice(0, end))
    assert.ok(Array.isArray(parsed), `prefix of length ${end} must parse`)
  }
  const final = parseMarkdownBlocks(full)
  assert.deepEqual(final.map((block) => block.kind), ['heading', 'paragraph', 'list'])
})

test('stream segments keep source keys and distinguish a growing tail from a closed block', () => {
  const first = parseMarkdownSegments('First paragraph.\n\nSecond')
  const next = parseMarkdownSegments('First paragraph.\n\nSecond paragraph.\n\n')
  assert.equal(first[0]!.closed, true)
  assert.equal(first[1]!.closed, false)
  assert.equal(next[0]!.id, first[0]!.id)
  assert.equal(next[0]!.signature, first[0]!.signature)
  assert.equal(next[1]!.id, first[1]!.id)
  assert.equal(next[1]!.closed, true)
  for (const source of ['```ts\nlet a = 1', '- one\n- two', '| a |\n| - |\n| b |', '$$x^2']) {
    assert.equal(parseMarkdownSegments(source).at(-1)!.closed, false, source)
    assert.equal(parseMarkdownSegments(source, true).at(-1)!.closed, true, source)
  }
  assert.equal(parseMarkdownSegments('```ts\nlet a = 1\n```').at(-1)!.closed, true)
  assert.equal(parseMarkdownSegments('$$x^2$$').at(-1)!.closed, true)
})

test('a streamed draft lexed from its resume point matches a full parse at every chunk', () => {
  const doc = [
    '# Title\n\nIntro with **bold** and a [link](https://a.example).\n\n',
    '- one\n- two\n\n  still two\n\n- three\n\nAfter the list.\n\n',
    '```ts\nconst a = 1\n\nconst b = 2\n```\n\n    indented\n\n    still code\n\n',
    '> quoted\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$x^2$$\n\n---\n\n',
    'See [ref][r] here.\n\n[r]: https://r.example\n\nTail paragraph',
  ].join('')
  const prefixes = Array.from({ length: doc.length }, (_, index) => doc.slice(0, index + 1))
  const fresh = prefixes.map((prefix) => {
    resetMarkdownCache()
    return parseMarkdownSegments(prefix)
  })
  resetMarkdownCache()
  for (const [index, prefix] of prefixes.entries()) {
    assert.deepEqual(parseMarkdownSegments(prefix), fresh[index], JSON.stringify(prefix))
  }
})
