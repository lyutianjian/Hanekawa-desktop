import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalUrl,
  collapseWhitespace,
  decodeHtmlBytes,
  decodeHtmlEntities,
  formatBytes,
  hasCjk,
  hostOf,
  htmlToText,
  looksBinary,
  resolveHttpUrl,
  singleLine,
  sniffCharset,
} from '../src/tools/webText.js'
import { extractReadable, tidyMarkdown } from '../src/tools/WebFetchTool/extract.js'

test('entities are decoded, and only the ones that are actually entities', () => {
  assert.equal(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), 'a & b <c> "d" \'e\'')
  assert.equal(decodeHtmlEntities('&#x4e2d;&#25991;'), '中文')
  assert.equal(decodeHtmlEntities('&#0; stays'), '&#0; stays')
  // A bare ampersand in prose is not an entity, and an unknown name is left
  // alone rather than guessed at.
  assert.equal(decodeHtmlEntities('AT&T and &nosuchentity;'), 'AT&T and &nosuchentity;')
  assert.equal(decodeHtmlEntities('no entities here'), 'no entities here')
})

test('whitespace collapses, including the exotic spaces HTML carries', () => {
  assert.equal(collapseWhitespace('  a\n\n b\tc\u00a0d\u3000e '), 'a b c d e')
  assert.equal(htmlToText('<p>a <b>bold</b></p>\n<p>b</p>'), 'a bold b')
})

test('singleLine cuts on a word boundary and marks the cut', () => {
  // The cut lands on the last space inside the limit, not mid-word.
  assert.equal(singleLine('one two three four five', 14), 'one two three…')
  assert.equal(singleLine('one two three four five', 10), 'one two…')
  assert.equal(singleLine('short', 14), 'short')
})

test('CJK text is recognised', () => {
  assert.equal(hasCjk('rust 异步编程'), true)
  assert.equal(hasCjk('Кириллица'), false)
  assert.equal(hasCjk('plain english'), false)
})

test('URL identity drops the fragment, tracking parameters and a trailing slash', () => {
  assert.equal(
    canonicalUrl('https://Example.com/docs/?utm_source=x&utm_medium=y&keep=1#section'),
    'https://example.com/docs?keep=1',
  )
  // A root path keeps its slash: `https://example.com/` and the origin are the same URL.
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/')
  assert.equal(canonicalUrl('not a url'), 'not a url')
  assert.equal(hostOf('https://Docs.Example.COM/a'), 'docs.example.com')
  assert.equal(hostOf('nonsense'), undefined)
})

test('only http(s) links survive resolution', () => {
  assert.equal(resolveHttpUrl('/docs', 'https://example.com/a/b'), 'https://example.com/docs')
  assert.equal(resolveHttpUrl('sub/page', 'https://example.com/a/'), 'https://example.com/a/sub/page')
  assert.equal(resolveHttpUrl('https://other.test/x', 'https://example.com/'), 'https://other.test/x')
  assert.equal(resolveHttpUrl('#section', 'https://example.com/'), undefined)
  assert.equal(resolveHttpUrl('javascript:alert(1)', 'https://example.com/'), undefined)
  assert.equal(resolveHttpUrl('data:text/plain,x', 'https://example.com/'), undefined)
  assert.equal(resolveHttpUrl('mailto:a@b.test', 'https://example.com/'), undefined)
  assert.equal(resolveHttpUrl('', 'https://example.com/'), undefined)
})

test('the charset comes from the BOM, then the response, then the document', () => {
  const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])
  assert.equal(sniffCharset(utf8Bom, 'text/html; charset=gbk'), 'utf-8')
  assert.equal(sniffCharset(Uint8Array.from([0x61]), 'text/html; charset=GB2312'), 'gbk')
  assert.equal(sniffCharset(Uint8Array.from([0x61]), 'text/html; charset="Shift_JIS"'), 'shift_jis')
  assert.equal(
    sniffCharset(Buffer.from('<meta charset="big5"><p>x</p>'), 'text/html'),
    'big5',
  )
  assert.equal(
    sniffCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=gbk">'), 'text/html'),
    'gbk',
  )
  assert.equal(sniffCharset(Buffer.from('<html>plain</html>'), 'text/html'), 'utf-8')
  // A label the platform does not know degrades to UTF-8 rather than failing.
  assert.equal(sniffCharset(Buffer.from('x'), 'text/html; charset=x-made-up'), 'x-made-up')
})

test('a GBK page decodes as Chinese instead of replacement characters', () => {
  // "中文" in GBK; decoded as UTF-8 these four bytes are not text at all.
  const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(decodeHtmlBytes(gbk, 'text/html; charset=gbk').text, '中文')
  assert.equal(decodeHtmlBytes(gbk, 'text/html; charset=gbk').charset, 'gbk')
  // A body that declares nothing still gets its `<meta>` honoured.
  const withMeta = Buffer.concat([Buffer.from('<meta charset="gbk">'), Buffer.from(gbk)])
  assert.equal(decodeHtmlBytes(new Uint8Array(withMeta), 'text/html').text, '<meta charset="gbk">中文')
  assert.equal(decodeHtmlBytes(Uint8Array.from(Buffer.from('中文', 'utf8')), 'text/plain').text, '中文')
})

test('binary bodies are recognised by their NUL bytes, text is not', () => {
  assert.equal(looksBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])), true)
  assert.equal(looksBinary(Buffer.from('plain text')), false)
  // UTF-16 text has NUL bytes but a BOM that says what it is.
  assert.equal(looksBinary(Uint8Array.from([0xff, 0xfe, 0x61, 0x00])), false)
  assert.equal(looksBinary(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), false)
})

test('byte counts read as sizes', () => {
  assert.equal(formatBytes(512), '512B')
  assert.equal(formatBytes(2048), '2.0KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0MB')
})

const ARTICLE = `<!doctype html>
<html><head><title>Streams | Docs</title></head>
<body>
  <nav><a href="/menu">Menu</a></nav>
  <header><h1>Site masthead</h1></header>
  <main>
    <h1>Backpressure</h1>
    <p>${'Real content about streams and backpressure. '.repeat(8)}</p>
    <table><tr><th>Method</th><th>Returns</th></tr><tr><td>write()</td><td>boolean</td></tr></table>
    <p><a href="/deep/page">deep link</a> and <a href="#top">jump</a> and <a href="/empty"></a></p>
    <script>var junk = 'should not appear'</script>
    <style>.junk { color: red }</style>
    <div class="cookie-banner">Accept cookies</div>
    <div class="sr-only">Invisible helper text</div>
  </main>
  <footer>Site footer</footer>
  <aside>Related links</aside>
</body></html>`

test('extraction keeps the article and drops the chrome around it', async () => {
  const page = await extractReadable(ARTICLE, 'https://example.com/api/stream.html')
  assert.equal(page.title, 'Streams | Docs')

  assert.match(page.markdown, /Backpressure/)
  assert.match(page.markdown, /Real content about streams/)

  // Script and style text used to arrive as prose; it is the bulk of a page.
  assert.doesNotMatch(page.markdown, /should not appear/)
  assert.doesNotMatch(page.markdown, /color: red/)
  // Chrome, widgets and screen-reader helpers.
  assert.doesNotMatch(page.markdown, /Menu/)
  assert.doesNotMatch(page.markdown, /masthead/)
  assert.doesNotMatch(page.markdown, /Site footer/)
  assert.doesNotMatch(page.markdown, /Related links/)
  assert.doesNotMatch(page.markdown, /Accept cookies/)
  assert.doesNotMatch(page.markdown, /Invisible helper text/)
})

test('extraction absolutes links, flattens dead ones and keeps tables as tables', async () => {
  const page = await extractReadable(ARTICLE, 'https://example.com/api/stream.html')

  assert.match(page.markdown, /\[deep link\]\(https:\/\/example\.com\/deep\/page\)/)
  // An in-page anchor keeps its words and loses its unusable target.
  assert.match(page.markdown, /jump/)
  assert.doesNotMatch(page.markdown, /\]\(#top\)/)
  // An anchor with no text carries nothing.
  assert.doesNotMatch(page.markdown, /\[\]\(/)

  assert.match(page.markdown, /\| Method \| Returns \|/)
  assert.match(page.markdown, /\| --- \| --- \|/)
  assert.match(page.markdown, /\| write\(\) \| boolean \|/)
})

test('a page of sibling articles keeps every article', async () => {
  const body = (title: string) => `<article><h2>${title}</h2><p>${`${title} body text. `.repeat(20)}</p></article>`
  const listing = `<html><head><title>Index</title></head><body>
    <nav>Nav</nav>
    ${body('First')}
    ${body('Second')}
    ${body('Third')}
    <footer>Footer</footer>
  </body></html>`

  const page = await extractReadable(listing, 'https://example.com/blog')
  // One article being larger must not make the others disappear.
  assert.match(page.markdown, /First body text/)
  assert.match(page.markdown, /Second body text/)
  assert.match(page.markdown, /Third body text/)
  assert.doesNotMatch(page.markdown, /^Nav$/m)
})

test('markdown tidying collapses the converter\'s blank runs', () => {
  assert.equal(tidyMarkdown('a\n\n\n\nb\n   \n\nc\n'), 'a\n\nb\n\nc')
  assert.equal(tidyMarkdown('\n\ntext\n\n'), 'text')
  // Lines that survived conversion as an empty link or an empty heading go.
  assert.equal(tidyMarkdown('text\n[](https://example.com/x)\n##\nmore'), 'text\nmore')
})