import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolContext } from '../src/harness/types.js'
import { createWebSearchTool } from '../src/tools/WebSearchTool/WebSearchTool.js'
import {
  defaultSearchProviders,
  hasRelevantHit,
  orderedProviders,
  keepDomains,
  parseBaidu,
  parseBing,
  parseDuckDuckGo,
  parseSearxngHtml,
  queryTokens,
  rankHits,
  scopedQuery,
  SearchProviderError,
  unwrapBingUrl,
  unwrapDuckDuckGoUrl,
  urlDepth,
  type SearchHit,
  type SearchProvider,
} from '../src/tools/WebSearchTool/providers.js'

function context(): ToolContext {
  return { cwd: process.cwd(), sessionId: 's1', readFiles: new Set(), readFileState: new Map() } as ToolContext
}

function hit(url: string, title = 'A page', snippet = ''): SearchHit {
  return { title, url, snippet }
}

function provider(id: string, search: SearchProvider['search']): SearchProvider {
  return { id, label: id, search }
}

function answers(id: string, hits: SearchHit[]): SearchProvider {
  return provider(id, async () => hits)
}

function fails(id: string, error: SearchProviderError): SearchProvider {
  return provider(id, async () => {
    throw error
  })
}

// --- parsers --------------------------------------------------------------

test('DuckDuckGo blocks are parsed one result at a time, ads excluded', () => {
  const html = `
    <div class="result result--ad ">
      <a class="result__a" href="//duckduckgo.com/y.js?ad=1">Buy now</a>
      <a class="result__snippet">An advertisement</a>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>docs</b></a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">A &amp; B snippet</a>
    </div>`

  const hits = parseDuckDuckGo(html)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.url, 'https://example.com/docs')
  assert.equal(hits[0]!.title, 'Example docs')
  assert.equal(hits[0]!.snippet, 'A & B snippet')
})

test('a DuckDuckGo redirect is unwrapped, and a bare URL is left alone', () => {
  assert.equal(
    unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x'),
    'https://example.com/a?b=1',
  )
  assert.equal(unwrapDuckDuckGoUrl('https://example.com/plain'), 'https://example.com/plain')
})

test('Bing results are parsed and a click-through wrapper is decoded', () => {
  const target = 'https://example.com/deep/page?x=1'
  const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`
  const html = `
    <ol id="b_results">
      <li class="b_algo"><h2><a href="${wrapped.replace(/&/g, '&amp;')}">Example <strong>Page</strong></a></h2>
        <div class="b_caption"><p>A snippet &amp; more</p></div></li>
      <li class="b_algo b_algoBorder"><h2><a href="https://other.test/x">Other</a></h2></li>
    </ol>`

  const hits = parseBing(html)
  assert.equal(hits.length, 2)
  assert.equal(hits[0]!.url, target)
  assert.equal(hits[0]!.title, 'Example Page')
  assert.equal(hits[0]!.snippet, 'A snippet & more')
  assert.equal(hits[1]!.url, 'https://other.test/x')
  assert.equal(unwrapBingUrl('https://example.com/plain'), 'https://example.com/plain')
})

test('Baidu prefers the real target in `mu` and drops ad modules', () => {
  const html = `
    <div class="result c-container xpath-log new-pmd">
      <h3 class="c-title t"><a href="http://www.baidu.com/link?url=abc">Rust <em>异步</em>编程</a></h3>
      <span class="content-right_8Zs40">一段摘要</span>
      <div mu="https://example.com/real"></div>
    </div>
    <div class="result c-container" data-tuiguang="1">
      <h3 class="t"><a href="https://www.baidu.com/baidu.php?url=ad">广告</a></h3>
      <div mu="http://nourl.ubs.baidu.com/61344"></div>
    </div>`

  const hits = parseBaidu(html)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.url, 'https://example.com/real')
  assert.equal(hits[0]!.title, 'Rust 异步编程')
  assert.equal(hits[0]!.snippet, '一段摘要')
})

test('SearXNG HTML is parsed when the instance has the JSON API turned off', () => {
  const html = `
    <article class="result result-default">
      <h3><a href="https://example.com/a" class="url_header">Result A</a></h3>
      <p class="content">Text A</p>
    </article>`

  const hits = parseSearxngHtml(html)
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0], { title: 'Result A', url: 'https://example.com/a', snippet: 'Text A' })
})

// --- relevance and scope --------------------------------------------------

test('query tokens keep the words that carry intent', () => {
  assert.deepEqual(queryTokens('How do I stream backpressure in Node.js'), ['stream', 'backpressure', 'node'])
  // A query of nothing but stopwords asks for nothing specific.
  assert.deepEqual(queryTokens('how to do it'), [])
})

test('a result set is relevant when it mentions the query, not merely when it is non-empty', () => {
  const tokens = queryTokens('nodejs stream backpressure')
  assert.equal(hasRelevantHit([hit('https://nodejs.org/api/stream.html', 'Backpressure in streams')], tokens), true)
  // The failure this guards: an engine answering a query it ignored.
  assert.equal(hasRelevantHit([hit('https://www.doubao.com/chat/', '豆包 - AI 智能助手')], tokens), false)
  // One term is enough for a short query, so a deep page is not rejected for
  // not repeating every word of it.
  const short = queryTokens('tokio select macro')
  assert.equal(hasRelevantHit([hit('https://tokio.rs/', 'Tokio - An asynchronous Rust runtime')], short), true)
})

test('ranking puts the page that mentions more of the query first', () => {
  const tokens = queryTokens('tokio select macro')
  const ranked = rankHits([
    hit('https://tokio.rs/', 'Tokio - An asynchronous Rust runtime'),
    hit('https://tokio.rs/tokio/tutorial/select', 'Select | Tokio', 'select! macro'),
  ], tokens)
  assert.equal(ranked[0]!.url, 'https://tokio.rs/tokio/tutorial/select')
})

test('URL depth separates a page from a site root and from a language landing page', () => {
  assert.equal(urlDepth('https://nodejs.org/'), 0)
  // A localized front page is a front page.
  assert.equal(urlDepth('https://nodejs.org/zh-cn'), 0)
  assert.equal(urlDepth('https://example.com/en-US/'), 0)
  assert.equal(urlDepth('https://example.com/docs/'), 0)
  assert.equal(urlDepth('https://nodejs.org/api/stream.html'), 2)
  assert.equal(urlDepth('https://example.com/docs/latest/intro'), 1)
  assert.equal(urlDepth('https://example.com/a?b=1'), 2)
})

test('domains are scoped into the query and enforced on the hosts', () => {
  assert.equal(scopedQuery({ q: 'streams', domains: ['nodejs.org'] }), 'streams site:nodejs.org')
  assert.equal(
    scopedQuery({ q: 'streams', domains: ['nodejs.org', 'developer.mozilla.org'] }),
    'streams (site:nodejs.org OR site:developer.mozilla.org)',
  )
  assert.equal(scopedQuery({ q: 'streams' }), 'streams')

  const hits = [hit('https://nodejs.org/api/stream.html'), hit('https://evilnodejs.org/x')]
  assert.deepEqual(keepDomains(hits, { q: 'streams', domains: ['nodejs.org'] }).map((entry) => entry.url), [
    'https://nodejs.org/api/stream.html',
  ])
})

// --- the chain ------------------------------------------------------------

test('a blocked engine falls through to the next one', async () => {
  const tool = createWebSearchTool({
    providers: [
      fails('duckduckgo', new SearchProviderError('blocked', 'answered with an anti-bot challenge (HTTP 202)')),
      answers('bing', [hit('https://nodejs.org/api/stream.html', 'Backpressure in streams', 'stream backpressure')]),
    ],
  })

  const result = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /from bing/)
  assert.match(result.content, /https:\/\/nodejs\.org\/api\/stream\.html/)
})

test('an engine that ignored the query loses to one that answered it', async () => {
  const tool = createWebSearchTool({
    providers: [
      // What cn.bing.com serves for a query it does not like: plausible results
      // about something else entirely.
      answers('bing', [hit('https://www.doubao.com/chat/', '豆包 - AI 智能助手')]),
      answers('baidu', [hit('https://nodejs.org/api/stream.html', 'Stream backpressure', 'nodejs stream')]),
    ],
  })

  const result = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /from baidu/)
  assert.doesNotMatch(result.content, /doubao/)
})

test('a shallow answer is replaced by a deeper one from the next engine', async () => {
  const tool = createWebSearchTool({
    providers: [
      // Relevant, but only reaches the site's front page.
      answers('bing', [hit('https://nodejs.org/', 'Node.js', 'Node.js stream backpressure')]),
      answers('baidu', [hit('https://nodejs.org/api/stream.html', 'Stream backpressure', 'nodejs stream')]),
    ],
  })

  const result = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /from baidu/)
  assert.match(result.content, /https:\/\/nodejs\.org\/api\/stream\.html/)
})

test('when nothing is relevant the closest answer comes back, labelled', async () => {
  const tool = createWebSearchTool({
    providers: [answers('bing', [hit('https://example.com/unrelated', 'Unrelated page')])],
  })

  const result = await tool.execute({ queries: ['zzqqxx nonexistent'], maxResults: 3 }, context())
  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /https:\/\/example\.com\/unrelated/)
  assert.match(result.content, /no engine returned results that mention the query/i)
})

test('a total failure names every engine and what it said', async () => {
  const tool = createWebSearchTool({
    providers: [
      fails('duckduckgo', new SearchProviderError('blocked', 'answered with an anti-bot challenge (HTTP 202)')),
      fails('bing', new SearchProviderError('network', 'fetch failed')),
    ],
  })

  const result = await tool.execute({ queries: ['anything'] }, context())
  assert.equal(result.ok, false)
  assert.match(result.content, /no engine returned results/)
  assert.match(result.content, /duckduckgo: blocked/)
  assert.match(result.content, /bing: unreachable/)
  assert.match(result.content, /HANEKAWA_SEARCH_URL/)
})

test('several queries are answered in one call, each under its own heading', async () => {
  const seen: string[] = []
  const tool = createWebSearchTool({
    providers: [
      provider('engine', async (spec) => {
        seen.push(spec.q)
        return [hit(`https://example.com/${encodeURIComponent(spec.q)}`, `${spec.q} answer`, spec.q)]
      }),
    ],
  })

  const result = await tool.execute({ queries: ['first query', 'second query'] }, context())
  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /Search results for "first query"/)
  assert.match(result.content, /Search results for "second query"/)
  assert.deepEqual(seen.sort(), ['first query', 'second query'])
})

test('per-query filters reach the engine, and string queries take the call-wide ones', async () => {
  const specs: Array<{ q: string; recencyDays?: number; domains?: string[] }> = []
  const tool = createWebSearchTool({
    providers: [
      provider('engine', async (spec) => {
        specs.push({ q: spec.q, ...(spec.recencyDays ? { recencyDays: spec.recencyDays } : {}), ...(spec.domains ? { domains: spec.domains } : {}) })
        return [hit(`https://example.com/${spec.q}`, `${spec.q} answer`, spec.q)]
      }),
    ],
  })

  await tool.execute({
    queries: ['plain query', { q: 'own filters', recencyDays: 30, domains: ['a.test'] }],
    recencyDays: 7,
    domains: ['b.test'],
  }, context())

  assert.deepEqual(specs[0], { q: 'plain query', recencyDays: 7, domains: ['b.test'] })
  assert.deepEqual(specs[1], { q: 'own filters', recencyDays: 30, domains: ['a.test'] })
})

test('results are capped, de-duplicated and filtered by blocked domains', async () => {
  const tool = createWebSearchTool({
    providers: [
      answers('engine', [
        hit('https://example.com/a', 'Doc a', 'doc'),
        hit('https://example.com/a?utm_source=x', 'Doc a again', 'doc'),
        hit('https://spam.test/b', 'Doc b', 'doc'),
        hit('https://example.com/c', 'Doc c', 'doc'),
      ]),
    ],
  })

  const result = await tool.execute({
    queries: ['doc'],
    maxResults: 2,
    blockedDomains: ['spam.test'],
  }, context())

  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /2 results/)
  assert.match(result.content, /https:\/\/example\.com\/a\n/)
  assert.doesNotMatch(result.content, /spam\.test/)
  // The tracking-parameter copy of the first result is the same page.
  assert.doesNotMatch(result.content, /Doc a again/)
})

test('a call without queries is rejected without pretending to search', async () => {
  const tool = createWebSearchTool({ providers: [] })
  assert.equal((await tool.execute({}, context())).errorCode, 'invalid_input')
  assert.equal((await tool.execute({ queries: [] }, context())).errorCode, 'invalid_input')
  assert.equal((await tool.execute({ queries: ['   '] }, context())).errorCode, 'invalid_input')
})
// --- ordering and the reachability memo -----------------------------------

test('the best free engine is tried first, with Bing behind it as the fallback', () => {
  const ids = defaultSearchProviders({}).map((entry) => entry.id)
  assert.deepEqual(ids, ['duckduckgo', 'bing', 'baidu', 'wikipedia'])
  // A configured instance or key outranks every built-in engine.
  const configured = defaultSearchProviders({ HANEKAWA_SEARCH_URL: 'https://searx.test', HANEKAWA_BRAVE_API_KEY: 'k' })
    .map((entry) => entry.id)
  assert.deepEqual(configured.slice(0, 2), ['searxng', 'brave'])
})

test('a Chinese query moves Baidu up among the free engines, but not above a configured one', () => {
  const providers = defaultSearchProviders({ HANEKAWA_SEARCH_URL: 'https://searx.test' })
  assert.deepEqual(orderedProviders(providers, 'rust 异步编程').map((entry) => entry.id), [
    'searxng', 'baidu', 'duckduckgo', 'bing', 'wikipedia',
  ])
  assert.deepEqual(orderedProviders(providers, 'rust async').map((entry) => entry.id), [
    'searxng', 'duckduckgo', 'bing', 'baidu', 'wikipedia',
  ])
})

test('an unreachable engine is skipped on the following call instead of costing another timeout', async () => {
  let attempts = 0
  const tool = createWebSearchTool({
    providers: [
      provider('duckduckgo', async () => {
        attempts += 1
        throw new SearchProviderError('network', 'fetch failed')
      }),
      answers('bing', [hit('https://nodejs.org/api/stream.html', 'Stream backpressure', 'nodejs stream')]),
    ],
  })

  const first = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(first.ok, true, first.content)
  assert.match(first.content, /from bing/)
  // A successful answer only names the engine that answered; the failure is
  // reported in the empty/failed answer, not stapled onto every result.
  assert.doesNotMatch(first.content, /duckduckgo/)
  assert.equal(attempts, 1)

  // Second call: Bing answers and the dead engine is not touched again.
  const second = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(second.ok, true, second.content)
  assert.match(second.content, /from bing/)
  assert.equal(attempts, 1, 'the unreachable engine was retried immediately')
})

test('the skip expires, so turning a proxy on is picked up without a restart', async () => {
  let clock = 1_000
  let attempts = 0
  const tool = createWebSearchTool({
    now: () => clock,
    providers: [
      provider('duckduckgo', async () => {
        attempts += 1
        if (attempts === 1) throw new SearchProviderError('network', 'fetch failed')
        return [hit('https://nodejs.org/api/stream.html', 'Stream backpressure', 'nodejs stream')]
      }),
      answers('bing', [hit('https://nodejs.org/api/stream.html', 'Fallback', 'nodejs stream')]),
    ],
  })

  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 1)

  // Inside the window the engine is skipped.
  clock += 60_000
  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 1)

  // Past it, the engine is tried again and this time it answers.
  clock += 120_000
  const result = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 2)
  assert.match(result.content, /from duckduckgo/)
})

test('a bot challenge is remembered too, and shorter than an unreachable host', async () => {
  let clock = 1_000
  let attempts = 0
  const tool = createWebSearchTool({
    now: () => clock,
    providers: [
      provider('duckduckgo', async () => {
        attempts += 1
        throw new SearchProviderError('blocked', 'answered with an anti-bot challenge (HTTP 202)')
      }),
      answers('bing', [hit('https://nodejs.org/api/stream.html', 'Stream backpressure', 'nodejs stream')]),
    ],
  })

  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 1)
  clock += 30_000
  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 1, 'a challenge inside the window should not be re-probed')
  clock += 40_000
  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 2, 'the challenge window is shorter than the unreachable one')
})

test('an engine that answers clears its skip, even when the answer is judged irrelevant', async () => {
  let clock = 1_000
  let attempts = 0
  const tool = createWebSearchTool({
    now: () => clock,
    providers: [
      provider('duckduckgo', async () => {
        attempts += 1
        if (attempts === 1) throw new SearchProviderError('network', 'fetch failed')
        return [hit('https://example.com/unrelated', 'Unrelated page')]
      }),
      answers('bing', [hit('https://nodejs.org/api/stream.html', 'Stream backpressure', 'nodejs stream')]),
    ],
  })

  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  clock += 121_000
  await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 2)
  // It answered, so it is reachable again: the next call must not skip it.
  const result = await tool.execute({ queries: ['nodejs stream backpressure'] }, context())
  assert.equal(attempts, 3)
  assert.doesNotMatch(result.content, /skipped/)
})
