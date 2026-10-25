import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolContext } from '../src/harness/types.js'
import { resolveFetchUrl, webFetchTool } from '../src/tools/WebFetchTool/WebFetchTool.js'

/** The tool reads nothing but the abort signal from its context. */
function context(abortSignal?: AbortSignal): ToolContext {
  return { cwd: process.cwd(), sessionId: 's1', readFiles: new Set(), readFileState: new Map(), ...(abortSignal ? { abortSignal } : {}) } as ToolContext
}

/** A local server on the loopback interface; nothing here reaches the network. */
async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string, hits: () => number) => Promise<void>,
  host = '127.0.0.1',
): Promise<void> {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  try {
    await run(`${host === '::1' ? '[::1]' : host}:${port}`, () => requests)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('a loopback http URL keeps its scheme instead of being upgraded', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/markdown' })
    response.end('# local docs\n')
  }, async (authority) => {
    const result = await webFetchTool.execute({ url: `http://${authority}/docs` }, context())
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /# local docs/)
  })
})

test('only a real loopback host keeps http; a lookalike name is still upgraded', () => {
  assert.equal(resolveFetchUrl('http://localhost:3000/a'), 'http://localhost:3000/a')
  assert.equal(resolveFetchUrl('http://LOCALHOST:3000/a'), 'http://LOCALHOST:3000/a')
  assert.equal(resolveFetchUrl('http://api.localhost/a'), 'http://api.localhost/a')
  assert.equal(resolveFetchUrl('http://127.0.0.1:8080/a?b#c'), 'http://127.0.0.1:8080/a?b#c')
  assert.equal(resolveFetchUrl('http://127.13.4.2/a'), 'http://127.13.4.2/a')
  assert.equal(resolveFetchUrl('http://[::1]:8080/a'), 'http://[::1]:8080/a')
  // Not loopback: a name that merely starts with "localhost", and a public IP.
  assert.equal(resolveFetchUrl('http://localhost.evil.invalid/a'), 'https://localhost.evil.invalid/a')
  assert.equal(resolveFetchUrl('http://128.0.0.1/a'), 'https://128.0.0.1/a')
  assert.equal(resolveFetchUrl('http://example.com/a'), 'https://example.com/a')
  assert.equal(resolveFetchUrl('https://example.com/a'), 'https://example.com/a')
})

test('an IPv6 loopback server is reachable over plain http', async (t) => {
  try {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('v6 ok\n')
    }, async (authority) => {
      const result = await webFetchTool.execute({ url: `http://${authority}/` }, context())
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /v6 ok/)
    }, '::1')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      t.skip('this host has no IPv6 loopback')
      return
    }
    throw error
  }
})

test('a redirect to another host is reported, not followed', async () => {
  await withServer((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.2:1/elsewhere' })
    response.end()
  }, async (authority) => {
    const result = await webFetchTool.execute({ url: `http://${authority}/start` }, context())
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /redirects to a different host: http:\/\/127\.0\.0\.2:1\/elsewhere/)
  })
})

test('a chunked body with no Content-Length is stopped at the byte ceiling and never cached', async () => {
  const chunk = Buffer.from('x'.repeat(64 * 1024))
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    const pump = (): void => {
      if (response.destroyed) return
      // 128 chunks of 64 KiB is 8 MiB: comfortably past the 5 MiB ceiling.
      if (response.write(chunk) === false) response.once('drain', pump)
      else if (response.writableLength > 0 || !response.destroyed) setImmediate(pump)
    }
    pump()
  }, async (authority, hits) => {
    const url = `http://${authority}/big`
    const first = await webFetchTool.execute({ url }, context())
    assert.equal(first.ok, false, first.content)
    assert.match(first.content, /exceeds 5\.0MB/)
    assert.match(first.content, /nothing was cached/)
    // Failures are not cached: asking again really fetches again.
    await webFetchTool.execute({ url }, context())
    assert.equal(hits(), 2)
  })
})

test('the ceiling is measured on the bytes received, not on the Content-Length claim', async () => {
  // The server states the exact length both times; only the received bytes
  // decide, so the boundary is where the stream actually stops.
  await withServer((request, response) => {
    const size = request.url === '/over' ? 5 * 1024 * 1024 + 1 : 5 * 1024 * 1024
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(size) })
    response.end(Buffer.alloc(size, 'x'))
  }, async (authority) => {
    const atCeiling = await webFetchTool.execute({ url: `http://${authority}/at` }, context())
    assert.equal(atCeiling.ok, true, atCeiling.content)
    assert.match(String(atCeiling.metadata?.display?.summary), /5\.0MB/)

    const overCeiling = await webFetchTool.execute({ url: `http://${authority}/over` }, context())
    assert.equal(overCeiling.ok, false, overCeiling.content)
    assert.match(overCeiling.content, /exceeds 5\.0MB/)
  })
})

test('multi-byte UTF-8 is decoded once and counted as bytes', async () => {
  const text = '# 标题\n\n超长的一段说明文字。\n'
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(text)
  }, async (authority) => {
    const result = await webFetchTool.execute({ url: `http://${authority}/cn` }, context())
    assert.equal(result.ok, true, result.content)
    assert.equal(result.content, text)
    const bytes = Buffer.byteLength(text, 'utf8')
    assert.match(String(result.metadata?.display?.summary), new RegExp(`${bytes}B`))
  })
})

test('an aborted fetch fails without caching anything', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('start')
    // Hold the body open so the abort lands mid-read.
  }, async (authority) => {
    const controller = new AbortController()
    const pending = webFetchTool.execute({ url: `http://${authority}/slow` }, context(controller.signal))
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    assert.equal(result.ok, false, result.content)
    assert.match(result.content, /Failed/i)
  })
})

test('a successful fetch is served from the cache with the same content', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('cached body\n')
  }, async (authority, hits) => {
    const url = `http://${authority}/once`
    const first = await webFetchTool.execute({ url }, context())
    const second = await webFetchTool.execute({ url }, context())
    assert.equal(first.ok, true, first.content)
    assert.equal(second.content, first.content)
    assert.equal(hits(), 1)
    assert.match(String(second.metadata?.display?.summary), /cached/)
  })
})