import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { markdownChildren, markdownNode } from '../src/desktop/renderer/dom/markdownView.js'
import { reconcile } from '../src/desktop/renderer/dom/dom.js'

/**
 * The typesetting half of TeX support; `test/markdownMath.test.ts` is the other
 * half and covers what counts as maths in the first place.
 *
 * A DOM test rather than a model one because the thing worth asserting *is* the
 * tree: KaTeX is the one dependency this renderer lets build nodes for it, and
 * the terms of that — a DOM tree and not an HTML string, no anchor out of
 * `\href`, a legible fallback instead of KaTeX's own red source — are all
 * properties of what lands under the container.
 *
 * See `test/rendererWelcomeView.test.ts` for why this file is excluded from the
 * base TypeScript program and checked by `tsconfig.domtest.json` instead.
 */

let stub: DomStub
test.beforeEach(() => { stub = installDomStub() })
test.afterEach(() => stub.uninstall())

/** Every node in the subtree, depth first, the root included. */
function descendants(view: StubView): StubView[] {
  return [view, ...view.children.flatMap(descendants)]
}

function render(content: string): StubView {
  return stub.inspect(markdownNode(content))
}

function find(view: StubView, className: string): StubView[] {
  return descendants(view).filter((node) => node.classes.includes(className))
}

/**
 * A fence with no language has no label row, so its copy button floats over the
 * first code line; the `bare` class is what lets the stylesheet clear room for it.
 */
test('a fence without a language marks its wrapper bare', () => {
  const [bare] = find(render('```\nplain\n```'), 'md-code')
  assert.deepEqual(bare!.classes, ['md-code', 'bare'])
  const [labelled] = find(render('```ts\nlet a = 1\n```'), 'md-code')
  assert.ok(!labelled!.classes.includes('bare'))
})

for (const [name, growing, closed] of [
  ['fence', '```ts\nlet a =', '```ts\nlet a = 1\n```'],
  ['list', '- one\n- tw', '- one\n- two\n\nAfter'],
  ['table', '| a |\n| - |\n| par', '| a |\n| - |\n| part |\n\nAfter'],
  ['math', '$$x^', '$$x^2$$'],
]) {
  test(`streaming ${name} closure preserves its settled neighbours`, () => {
    const owner = stub.createContainer()
    const paint = (tail: string): void => reconcile(owner, markdownChildren(`Read me first.\n\n${tail}`, owner))
    paint(growing!)
    const before = stub.inspect(owner).children
    paint(closed!)
    const after = stub.inspect(owner).children
    assert.equal(after[0]!.node, before[0]!.node)
    assert.notEqual(after[1]!.node, before[1]!.node)
    paint(closed!)
    assert.equal(stub.inspect(owner).children[1]!.node, after[1]!.node)
    paint(`${closed}\n\nMore text`)
    assert.equal(stub.inspect(owner).children[0]!.node, before[0]!.node)
  })
}

test('a late reference definition updates the affected block while keeping unrelated prose', () => {
  const owner = stub.createContainer()
  reconcile(owner, markdownChildren('Unchanged.\n\n[link][ref]', owner))
  const first = stub.inspect(owner).children[0]!.node
  reconcile(owner, markdownChildren('Unchanged.\n\n[link][ref]\n\n[ref]: https://example.com', owner))
  assert.equal(stub.inspect(owner).children[0]!.node, first)
  assert.equal(descendants(stub.inspect(owner)).find((node) => node.tagName === 'A')?.text, 'link')
})

test('an inline equation is typeset into a KaTeX tree, not a string of markup', () => {
  const view = render('the value $x^2$ here')
  const math = find(view, 'md-math')
  assert.equal(math.length, 1)
  assert.deepEqual(math[0]!.classes, ['md-math'])

  // `.katex` only exists if `render()` walked its own tree into our node. The
  // string form (`renderToString`) could not have got here: `dom/dom.ts` bans
  // `innerHTML`, and the stub has no HTML parser to have run it through.
  assert.ok(find(view, 'katex').length === 1, 'expected a typeset KaTeX subtree')

  // The `<math>` branch is what a screen reader gets; without it the equation is
  // a pile of positioned glyphs and nothing else.
  const mathml = descendants(view).filter((node) => node.tagName === 'MATH')
  assert.equal(mathml.length, 1)
  assert.match(mathml[0]!.text, /x\^2/, 'the MathML annotation carries the source')
})

test('a display equation is marked as one, wherever it came from', () => {
  // Both the standalone block and the mid-paragraph form the parser produces for
  // a lead-in line without a blank after it. Same class either way — the
  // stylesheet is what makes it a centred line of its own.
  for (const source of ['$$a^2 + b^2$$', 'Average height\n$$a^2 + b^2$$']) {
    const view = render(source)
    const display = find(view, 'md-math-display')
    assert.equal(display.length, 1, `expected one display equation in ${JSON.stringify(source)}`)
    assert.ok(find(view, 'katex').length === 1, 'a display equation is still typeset')
  }
})

test('an equation KaTeX refuses degrades to its own source, and nothing throws', () => {
  const view = render('inline $\\nosuchmacro{q}$ and\n\n$$\\alsobad{r}$$')
  const raw = find(view, 'md-math-raw')
  assert.equal(raw.length, 2)
  // The delimiters come back with it, so the fallback reads as the thing that
  // was typed rather than as a mangled fragment of it.
  assert.equal(raw[0]!.text, '$\\nosuchmacro{q}$')
  assert.equal(raw[1]!.text, '$$\\alsobad{r}$$')
  // KaTeX's built-in fallback would have left `.katex-error` behind, coloured
  // from its own stylesheet. Ours replaces the node instead.
  assert.equal(find(view, 'katex-error').length, 0)
})

test('a bad equation does not take the prose around it with it', () => {
  const view = render('before $\\nosuchmacro{q}$ after')
  assert.match(view.text, /before/)
  assert.match(view.text, /after/)
})

test('`\\href` cannot smuggle a link out of a transcript', () => {
  // `trust: false` is KaTeX's default and the call site keeps it: this is
  // model-authored text, and the parser's own `safeHref` makes the same call for
  // markdown links. An untrusted `\href` is refused rather than failed — KaTeX
  // draws the command's own name — so the assertion is about what is *absent*.
  // The URL itself still appears in the MathML annotation, as the verbatim
  // source of every equation does; what must not exist is anything clickable.
  const view = render('$\\href{https://example.com}{click}$')
  const nodes = descendants(view)
  assert.equal(nodes.filter((node) => node.tagName === 'A').length, 0)
  for (const node of nodes) {
    assert.equal(node.attributes.has('href'), false, 'no node may carry an href')
  }
})

test('prose is untouched by the extension', () => {
  // The guard on the whole feature: a transcript with no maths in it must build
  // exactly the tree it built before.
  const view = render('It costs $5 and $10.\n\n- a `$PATH` item\n- **bold**')
  assert.equal(find(view, 'md-math').length, 0)
  assert.match(view.text, /It costs \$5 and \$10\./)
  assert.equal(descendants(view).filter((node) => node.tagName === 'STRONG').length, 1)
})

function fades(owner: StubView): StubView[] {
  return find(owner, 'md-fade')
}

function paintTo(owner: ReturnType<DomStub['createContainer']>, content: string): void {
  reconcile(owner, markdownChildren(content, owner))
}

test('streamed text fades in only past what was already shown', () => {
  const owner = stub.createContainer()
  paintTo(owner, 'Hello wor')
  assert.equal(fades(stub.inspect(owner)).length, 0)
  paintTo(owner, 'Hello world and more')
  const spans = fades(stub.inspect(owner))
  assert.deepEqual(spans.map((span) => span.text), ['ld and more'])
  assert.equal(stub.inspect(owner).text, 'Hello world and more')
  paintTo(owner, 'Hello world and more')
  assert.deepEqual(fades(stub.inspect(owner)).map((span) => span.text), ['ld and more'])
})

test('settled blocks are neither rebuilt nor re-wrapped; a new block fades whole', () => {
  const owner = stub.createContainer()
  paintTo(owner, 'First paragraph.\n\nSec')
  const first = stub.inspect(owner).children[0]!.node
  paintTo(owner, 'First paragraph.\n\nSecond one')
  assert.equal(stub.inspect(owner).children[0]!.node, first)
  assert.equal(fades(stub.inspect(first as never)).length, 0)
  paintTo(owner, 'First paragraph.\n\nSecond one\n\nThird')
  assert.deepEqual(fades(stub.inspect(owner)).map((span) => span.text), ['ond one', 'Third'])
})

test('animationend and the backstop sweep unwrap spans and merge text', async () => {
  const owner = stub.createContainer()
  paintTo(owner, 'Hello **bo')
  paintTo(owner, 'Hello **bold** and a [link](https://x.test/a) tail')
  const view = stub.inspect(owner)
  const before = view.text
  const spans = fades(view)
  assert.ok(spans.length >= 2)
  stub.dispatch(owner, 'animationend', { target: spans[0]!.node as never })
  assert.equal(fades(stub.inspect(owner)).length, spans.length - 1)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(fades(stub.inspect(owner)).length, 0)
  assert.equal(stub.inspect(owner).text, before)
  const p = stub.inspect(owner).children[0]!
  assert.ok(p.nodes.every((node, index, all) => typeof node !== 'string' || typeof all[index - 1] !== 'string'))
})

test('maths and code take the fade correctly: maths is skipped, code text wraps', () => {
  const owner = stub.createContainer()
  paintTo(owner, 'a $x')
  paintTo(owner, 'a $x^2$ then `co')
  paintTo(owner, 'a $x^2$ then `code` more')
  const view = stub.inspect(owner)
  assert.equal(descendants(view).filter((node) => node.classes.includes('md-fade') && node.classes.includes('katex')).length, 0)
  for (const span of fades(view)) assert.equal(span.classes.includes('md-math'), false)
  assert.ok(find(view, 'md-math').every((math) => fades(math).length === 0))
})

test('first paint, non-owner paint and reduced motion never wrap', () => {
  const owner = stub.createContainer()
  paintTo(owner, 'A whole settled message.')
  assert.equal(fades(stub.inspect(owner)).length, 0)
  assert.equal(fades(render('plain text')).length, 0)
  stub.setMedia('(prefers-reduced-motion: reduce)', true)
  const calm = stub.createContainer()
  paintTo(calm, 'abc')
  paintTo(calm, 'abc def ghi')
  assert.equal(fades(stub.inspect(calm)).length, 0)
})
