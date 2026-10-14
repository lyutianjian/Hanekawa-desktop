import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyProbeError, probeEndpoint } from '../src/config/providers/probe.js'

async function serve(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** An OpenAI-compatible gateway that lists two models under `/v1/models` for one key. */
function openaiGateway(req: IncomingMessage, res: ServerResponse): void {
  if (req.url !== '/v1/models') return json(res, 404, { error: { message: 'not found' } })
  if (req.headers.authorization !== 'Bearer sk-good') return json(res, 401, { error: { message: 'bad key' } })
  json(res, 200, {
    object: 'list',
    data: [
      { id: 'zeta', object: 'model' },
      { id: 'alpha', object: 'model', context_length: 128000, architecture: { input_modalities: ['text', 'image'] } },
    ],
  })
}

test('a working OpenAI-compatible endpoint answers its models, sorted, with what the gateway reported', async (t) => {
  const base = await serve(t, openaiGateway)
  const result = await probeEndpoint({ provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-good' })
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.deepEqual(result.models, [
    { id: 'alpha', contextWindow: 128000, imageInput: true },
    { id: 'zeta' },
  ])
  assert.equal(result.baseUrl, undefined, 'the address given was right')
})

test('a wrong key is an auth failure, not a connection failure', async (t) => {
  const base = await serve(t, openaiGateway)
  const result = await probeEndpoint({ provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-bad' })
  assert.deepEqual({ ok: result.ok, reason: !result.ok && result.reason, status: !result.ok && result.status }, {
    ok: false,
    reason: 'auth',
    status: 401,
  })
})

test('an address one /v1 off is answered with the address that worked', async (t) => {
  const base = await serve(t, openaiGateway)
  const result = await probeEndpoint({ provider: 'openai', baseUrl: base, apiKey: 'sk-good' })
  assert.ok(result.ok)
  assert.equal(result.baseUrl, `${base}/v1`)
})

test('a wrong key behind an address one /v1 off is reported as the key, not the path', async (t) => {
  const base = await serve(t, openaiGateway)
  const result = await probeEndpoint({ provider: 'openai', baseUrl: base, apiKey: 'sk-bad' })
  assert.equal(!result.ok && result.reason, 'auth')
})

test('an Anthropic endpoint reports context, output and image capability per model', async (t) => {
  const base = await serve(t, (req, res) => {
    if (!req.url?.startsWith('/v1/models')) return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'x' } })
    if (req.headers['x-api-key'] !== 'sk-ant') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'x' } })
    json(res, 200, {
      data: [{
        type: 'model',
        id: 'claude-x',
        display_name: 'Claude X',
        created_at: '2026-01-01T00:00:00Z',
        max_input_tokens: 200000,
        max_tokens: 64000,
        capabilities: { image_input: { supported: true } },
      }],
      has_more: false,
      first_id: 'claude-x',
      last_id: 'claude-x',
    })
  })
  const result = await probeEndpoint({ provider: 'anthropic', baseUrl: base, apiKey: 'sk-ant' })
  assert.ok(result.ok)
  assert.deepEqual(result.models, [
    { id: 'claude-x', name: 'Claude X', contextWindow: 200000, maxOutputTokens: 64000, imageInput: true },
  ])
})

test('a website answering 200 with a page is not an API', async (t) => {
  const base = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Home</title>')
  })
  for (const provider of ['openai', 'anthropic'] as const) {
    const result = await probeEndpoint({ provider, baseUrl: base, apiKey: 'sk' })
    assert.equal(!result.ok && result.reason, 'not-api', provider)
  }
})

test('only a 401 on the guessed /v1 path outranks the first answer', async (t) => {
  const base = await serve(t, (req, res) => json(res, req.url === '/v1/models' ? 403 : 404, {}))
  const result = await probeEndpoint({ provider: 'openai', baseUrl: base, apiKey: 'sk' })
  assert.equal(!result.ok && result.reason, 'not-found')
})

test('nothing listening is unreachable; a malformed address is rejected before any request', async () => {
  const refused = await probeEndpoint({ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk' })
  assert.equal(!refused.ok && refused.reason, 'unreachable')
  const malformed = await probeEndpoint({ provider: 'openai', baseUrl: 'api.example.com', apiKey: 'sk' })
  assert.equal(!malformed.ok && malformed.reason, 'bad-url')
})

test('errors are classified by status first, then by the network code underneath', () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error('x'), { status: 403 }), 'forbidden'],
    [Object.assign(new Error('x'), { status: 429 }), 'rate-limit'],
    [Object.assign(new Error('x'), { status: 503 }), 'server'],
    [Object.assign(new Error('x'), { status: 400 }), 'other'],
    [new Error('fetch failed', { cause: Object.assign(new Error('y'), { code: 'CERT_HAS_EXPIRED' }) }), 'tls'],
    [new Error('fetch failed', { cause: Object.assign(new Error('y'), { code: 'ENOTFOUND' }) }), 'unreachable'],
    [new Error('Missing credentials. Please pass an `apiKey`, or set the `OPENAI_API_KEY` environment variable.'), 'no-key'],
    [new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.'), 'no-key'],
  ]
  for (const [error, reason] of cases) assert.equal(classifyProbeError(error).reason, reason, String(error))
})
