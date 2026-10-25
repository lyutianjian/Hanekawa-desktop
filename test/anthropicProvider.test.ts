import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { AnthropicProvider, resetRejectedPromptCaching, streamWithTimeout } from '../src/config/providers/anthropicProvider.js'
import { buildAnthropicPayload } from '../src/config/providers.js'
import { collectCacheControlTelemetry } from '../src/config/providers/cacheControlTelemetry.js'
import { resetCacheBreakDetection } from '../src/harness/cacheBreakDetection.js'
import { resetCacheTTLEvaluation } from '../src/harness/cacheControl.js'
import { TurnImageBlockError } from '../src/harness/turnImages.js'
import type { ChatMessage, ModelContextItem, ModelRequest, RequestImageBytes, ToolResultBlockParam } from '../src/harness/types.js'
import type { ImageAttachmentRef, ImageMimeType } from '../src/media/types.js'

const cacheEnvironment = new Map(
  ['MYAGENT_DISABLE_PROMPT_CACHING', 'MYAGENT_DEBUG_PROVIDER'].map((key) => [key, process.env[key]]),
)

beforeEach(() => {
  resetCacheBreakDetection()
  resetRejectedPromptCaching()
  // The 1h TTL is latched per process; clear it so each test evaluates its own runtime.
  resetCacheTTLEvaluation()
  for (const key of cacheEnvironment.keys()) delete process.env[key]
})

afterEach(() => {
  for (const [key, previous] of cacheEnvironment) {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

type Message = Awaited<ReturnType<typeof streamWithTimeout>>

class FakeAnthropicStream {
  aborted = false
  private listeners = new Set<(...args: unknown[]) => void>()
  private resolveFinal!: (message: Message) => void
  private rejectFinal!: (error: Error) => void
  private final = new Promise<Message>((resolve, reject) => {
    this.resolveFinal = resolve
    this.rejectFinal = reject
  })

  finalMessage(): Promise<Message> {
    return this.final
  }

  abort(): void {
    this.aborted = true
  }

  on(event: 'streamEvent', listener: (...args: unknown[]) => void): this {
    if (event === 'streamEvent') this.listeners.add(listener)
    return this
  }

  off(event: 'streamEvent', listener: (...args: unknown[]) => void): this {
    if (event === 'streamEvent') this.listeners.delete(listener)
    return this
  }

  emitStreamEvent(): void {
    for (const listener of this.listeners) listener({ type: 'ping' })
  }

  emitTextDelta(text: string): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      })
    }
  }

  emitThinkingStart(index = 0): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking' },
      })
    }
  }

  emitThinkingDelta(thinking: string, index = 0): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'thinking_delta',
          thinking,
        },
      })
    }
  }

  emitThinkingStop(index = 0): void {
    for (const listener of this.listeners) {
      listener({
        type: 'content_block_stop',
        index,
      })
    }
  }

  finish(text = '', usage: Partial<Message['usage']> = { input_tokens: 1, output_tokens: 1 }): void {
    this.resolveFinal({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    } as unknown as Message)
  }

  finishWithContent(content: Array<Record<string, unknown>>): void {
    this.resolveFinal({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content,
      model: 'claude-sonnet',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Message)
  }

  fail(error: Error): void {
    this.rejectFinal(error)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

test('Anthropic stream timeout is reset by stream events', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const responsePromise = streamWithTimeout(stream, undefined, 100)
    let settled = false
    responsePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(stream.aborted, false)

    stream.emitStreamEvent()
    mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(stream.aborted, false)

    stream.finish()
    const response = await responsePromise
    assert.equal(response.id, 'msg_1')
    assert.equal(stream.aborted, false)
    assert.equal(stream.listenerCount(), 0)
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic stream emits text deltas through callback', async () => {
  const stream = new FakeAnthropicStream()
  const deltas: string[] = []
  const responsePromise = streamWithTimeout(
    stream,
    undefined,
    100,
    (delta) => deltas.push(delta),
  )

  stream.emitTextDelta('hello ')
  stream.emitTextDelta('world')
  stream.finish()

  await responsePromise
  assert.deepEqual(deltas, ['hello ', 'world'])
  assert.equal(stream.listenerCount(), 0)
})

test('Anthropic stream emits thinking events and resets idle timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const events: string[] = []
    const responsePromise = streamWithTimeout(
      stream,
      undefined,
      100,
      undefined,
      (event) => events.push(event.type),
      0,
    )
    let settled = false
    responsePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    mock.timers.tick(99)
    stream.emitThinkingStart()
    stream.emitThinkingDelta('still thinking')
    mock.timers.tick(99)
    await Promise.resolve()

    assert.equal(settled, false)
    assert.equal(stream.aborted, false)
    stream.emitThinkingStop()
    stream.finish()

    await responsePromise
    assert.deepEqual(events, ['thinking_start', 'thinking_delta', 'thinking_stop'])
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic stream names the tool whose arguments are streaming', async () => {
  const stream = new FakeAnthropicStream()
  const events: unknown[] = []
  const responsePromise = streamWithTimeout(stream, undefined, 1000, undefined, (event) => events.push(event), 0)
  const emit = (event: unknown) => (stream as unknown as { listeners: Set<(event: unknown) => void> }).listeners.forEach((listener) => listener(event))
  emit({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write' } })
  emit({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"filePath"' } })
  emit({ type: 'content_block_stop', index: 1 })
  emit({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'x' } })
  stream.finish()
  await responsePromise
  assert.deepEqual(events, [
    { type: 'tool_input_delta', index: 1, name: 'Write', partialJson: '{"filePath"' },
    { type: 'tool_input_delta', index: 1, partialJson: 'x' },
  ])
})

test('Anthropic stream idle warning does not abort the stream', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const events: string[] = []
    const responsePromise = streamWithTimeout(
      stream,
      undefined,
      500,
      undefined,
      (event) => events.push(event.type),
      100,
    )
    let settled = false
    responsePromise.then(
      () => { settled = true },
      () => { settled = true },
    )

    mock.timers.tick(100)
    await Promise.resolve()
    assert.deepEqual(events, ['idle_warning'])
    assert.equal(stream.aborted, false)
    assert.equal(settled, false)

    stream.finish('after warning')
    const response = await responsePromise
    assert.equal(response.id, 'msg_1')
    assert.equal(stream.aborted, false)
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic stream timeout aborts after an idle interval', async () => {
  mock.timers.enable({ apis: ['setTimeout'], now: 0 })
  try {
    const stream = new FakeAnthropicStream()
    const responsePromise = streamWithTimeout(stream, undefined, 100)
    const rejection = assert.rejects(responsePromise, /Stream idle timeout/)

    mock.timers.tick(100)

    await rejection
    assert.equal(stream.aborted, true)
    assert.equal(stream.listenerCount(), 0)
  } finally {
    mock.timers.reset()
  }
})

test('Anthropic provider retries streaming after stream idle timeout', async () => {
  const streams = [new FakeAnthropicStream(), new FakeAnthropicStream()]
  let streamCalls = 0
  let createCalls = 0
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
        create: (payload: Record<string, unknown>) => Promise<Message>
      }
    }
  }).client = {
    messages: {
      stream: () => {
        const stream = streams[streamCalls]
        streamCalls++
        if (!stream) throw new Error('unexpected extra stream call')
        return stream
      },
      create: async () => {
        createCalls++
        throw new Error('non-streaming fallback should not be called')
      },
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 1 },
  })

  streams[0]!.fail(new Error('Stream idle timeout'))
  await waitFor(() => streamCalls === 2)

  streams[1]!.finish('stream retry response')
  const response = await responsePromise
  assert.equal(streamCalls, 2)
  assert.equal(createCalls, 0)
  assert.equal(response.content, 'stream retry response')
})

test('Anthropic provider does not retry user aborts as idle timeouts', async () => {
  const stream = new FakeAnthropicStream()
  let streamCalls = 0
  let createCalls = 0
  const controller = new AbortController()
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
        create: (payload: Record<string, unknown>) => Promise<Message>
      }
    }
  }).client = {
    messages: {
      stream: () => {
        streamCalls++
        return stream
      },
      create: async () => {
        createCalls++
        throw new Error('non-streaming fallback should not be called')
      },
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 1, signal: controller.signal },
  })
  controller.abort()

  await assert.rejects(responsePromise, /aborted/i)
  assert.equal(stream.aborted, true)
  assert.equal(streamCalls, 1)
  assert.equal(createCalls, 0)
})

test('Anthropic provider keeps existing retry behavior for transient stream errors', async () => {
  const streams = [new FakeAnthropicStream(), new FakeAnthropicStream()]
  let streamCalls = 0
  let createCalls = 0
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
        create: (payload: Record<string, unknown>) => Promise<Message>
      }
    }
  }).client = {
    messages: {
      stream: () => {
        const stream = streams[streamCalls]
        streamCalls++
        if (!stream) throw new Error('unexpected extra stream call')
        return stream
      },
      create: async () => {
        createCalls++
        throw new Error('non-streaming fallback should not be called')
      },
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 1 },
  })

  streams[0]!.fail(new Error('stream ended unexpectedly'))
  await waitFor(() => streamCalls === 2)

  streams[1]!.finish('transient retry response')
  const response = await responsePromise
  assert.equal(streamCalls, 2)
  assert.equal(createCalls, 0)
  assert.equal(response.content, 'transient retry response')
})

test('Anthropic provider preserves final thinking blocks in the model response', async () => {
  const stream = new FakeAnthropicStream()
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  ;(provider as unknown as {
    client: {
      messages: {
        stream: () => FakeAnthropicStream
      }
    }
  }).client = {
    messages: {
      stream: () => stream,
    },
  }

  const responsePromise = provider.createMessage({
    model: 'claude-sonnet',
    messages: [],
    tools: [],
    cacheSource: 'agent:test',
    retry: { maxRetries: 0 },
  })

  stream.finishWithContent([
    { type: 'thinking', thinking: 'private reasoning', signature: 'sig-1' },
    { type: 'text', text: 'final answer' },
  ])

  const response = await responsePromise
  assert.equal(response.content, 'final answer')
  assert.deepEqual(response.thinkingBlocks, [{
    type: 'thinking',
    thinking: 'private reasoning',
    signature: 'sig-1',
  }])
  assert.match(response.thinkingSource ?? '', /^[a-f0-9]{64}$/)
})

test('a resumed or forked same-name model replays thinking only through its original endpoint', async () => {
  const signed = { type: 'thinking', thinking: 'private reasoning', signature: 'source-signature' }
  const redacted = { type: 'redacted_thinking', data: 'source-redacted' }
  const create = (baseUrl: string, apiKey = 'test-key') => {
    const payloads: Record<string, unknown>[] = []
    const provider = new AnthropicProvider({ provider: 'anthropic', model: 'claude-sonnet', apiKey, baseUrl })
    ;(provider as unknown as { client: { messages: { stream: (payload: Record<string, unknown>) => FakeAnthropicStream } } }).client = {
      messages: { stream: (payload) => {
        payloads.push(payload)
        const stream = new FakeAnthropicStream()
        stream.finishWithContent([signed, redacted, { type: 'text', text: 'answer' }])
        return stream
      } },
    }
    return { provider, payloads }
  }
  const original = create('https://source-a.example')
  const response = await original.provider.createMessage(cacheRequest())
  const history: ChatMessage = JSON.parse(JSON.stringify({
    id: 'from-a', role: 'assistant', content: response.content, model: 'claude-sonnet', createdAt: 'now',
    thinkingBlocks: response.thinkingBlocks, thinkingSource: response.thinkingSource,
  }))
  assert.doesNotMatch(JSON.stringify(history), /test-key|https:/, 'source metadata does not persist keys or URLs')
  for (const [baseUrl, model, keep] of [
    ['https://source-a.example/', 'claude-sonnet', true],
    ['https://source-b.example', 'claude-sonnet', false],
    ['https://source-a.example', 'different-model', false],
  ] as const) {
    const { provider, payloads } = create(baseUrl, 'rotated-key')
    await provider.createMessage(cacheRequest({
      model, messages: [history],
      thinkingSource: response.thinkingSource,
      contextItems: [
        { kind: 'message', message: history },
        { kind: 'tool_use', id: 'call', tool: 'Read', input: { filePath: 'file.txt' } },
        { kind: 'tool_result', toolUseId: 'call', tool: 'Read', content: 'file body', ok: true },
      ],
    }))
    const messages = payloads[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const blocks = messages.flatMap((message) => message.content)
    assert.deepEqual(blocks.filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking'), keep ? [signed, redacted] : [])
    assert.ok(blocks.some((block) => block.type === 'text' && block.text === 'answer'))
    assert.ok(blocks.some((block) => block.type === 'tool_use' && block.id === 'call'))
    assert.ok(blocks.some((block) => block.type === 'tool_result' && block.tool_use_id === 'call'))
  }
  assert.deepEqual(history.thinkingBlocks, [signed, redacted], 'changing the request never rewrites history')
})

function cacheRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-sonnet',
    system: 'Stable system instructions',
    messages: [{ id: 'user-1', role: 'user', content: 'Read the file', createdAt: '2026-09-06T00:00:00Z' }],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      inputSchema: z.object({ path: z.string() }),
      riskLevel: 'safe',
      execute: async () => ({ ok: true, content: '' }),
    }],
    cacheRuntime: { settings: { cache: { ttl1h: false } } },
    cacheSource: 'agent:cache-test',
    retry: { maxRetries: 0 },
    ...overrides,
  }
}

function captureRequests(
  provider: AnthropicProvider,
  respond: (index: number) => Partial<Message['usage']> | Error,
) {
  const requests: Array<{ payload: Record<string, unknown>; options?: { headers: Record<string, string> } }> = []
  ;(provider as unknown as {
    client: { messages: { stream: (payload: Record<string, unknown>, options?: { headers: Record<string, string> }) => FakeAnthropicStream } }
  }).client = {
    messages: {
      stream: (payload, options) => {
        requests.push({ payload, options })
        const stream = new FakeAnthropicStream()
        const result = respond(requests.length - 1)
        if (result instanceof Error) stream.fail(result)
        else stream.finish('answer', result)
        return stream
      },
    },
  }
  return requests
}

test('ordinary caching has the same defaults on official and compatible endpoints', async () => {
  for (const baseUrl of ['https://api.anthropic.com', 'https://proxy.example/v1']) {
    const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl })
    const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5_000 }))
    await provider.createMessage(cacheRequest())

    assert.deepEqual(collectCacheControlTelemetry(requests[0]!.payload).byLocation, {
      system: 1, tools: 1, messages: 1, other: 0,
    })
    assert.equal(requests[0]!.options, undefined)
    assert.equal('context_management' in requests[0]!.payload, false)
    assert.doesNotMatch(JSON.stringify(requests[0]!.payload), /cache_edits|cache_reference/)
  }
})

test('auto retries unsupported caching once and remembers it only for this endpoint and model', async () => {
  const config = { model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://rejecting-proxy.example/v1' }
  const provider = new AnthropicProvider(config)
  const rejected = Object.assign(new Error('cache_control is not supported for this model'), { status: 400 })
  const requests = captureRequests(provider, (index) => index === 0 ? rejected : { input_tokens: 10, output_tokens: 1 })
  const request = cacheRequest({ cacheRuntime: { settings: { cache: { ttl1h: true } } } })

  assert.equal((await provider.createMessage(request)).content, 'answer')
  await provider.createMessage(request)
  await provider.createMessage({ ...request, model: 'other-model' })

  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0, 0, 3])
  for (const { payload, options } of requests) {
    assert.deepEqual((payload.tools as Array<{ name: string }>).map((tool) => tool.name), ['Read'])
    assert.equal('context_management' in payload, false)
  }

  const otherEndpoint = new AnthropicProvider({ ...config, baseUrl: 'https://another-proxy.example/v1' })
  const otherRequests = captureRequests(otherEndpoint, () => ({ input_tokens: 10, output_tokens: 1 }))
  await otherEndpoint.createMessage(request)
  assert.equal(collectCacheControlTelemetry(otherRequests[0]!.payload).total, 3)

  // A provider is rebuilt per session, model switch, and subagent — the probe
  // must not be repeated (and re-fail) on every new instance.
  const rebuilt = new AnthropicProvider(config)
  const rebuiltRequests = captureRequests(rebuilt, () => ({ input_tokens: 10, output_tokens: 1 }))
  await rebuilt.createMessage(request)
  assert.deepEqual(rebuiltRequests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [0])
})

test('auto only records the rejection once the uncached retry succeeds', async () => {
  const config = { model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://echoing-proxy.example/v1' }
  // A proxy that echoes the request body reports an unrelated failure with
  // `cache_control` in the message; the uncached retry fails for the same reason.
  const unrelated = Object.assign(new Error('invalid request: {"cache_control":{"type":"ephemeral"}} is not supported here'), { status: 400 })
  const failing = new AnthropicProvider(config)
  const failingRequests = captureRequests(failing, () => unrelated)
  await assert.rejects(failing.createMessage(cacheRequest()), (error) => error === unrelated)
  assert.deepEqual(failingRequests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0])

  const recovered = new AnthropicProvider(config)
  const recoveredRequests = captureRequests(recovered, () => ({ input_tokens: 10, output_tokens: 1 }))
  await recovered.createMessage(cacheRequest())
  assert.deepEqual(recoveredRequests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3])
})

test('auto handles a compatible endpoint rejecting an extra cache_control field with HTTP 422', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  const rejected = Object.assign(new Error('messages.0.content.0.cache_control: Extra inputs are not permitted'), { status: 422 })
  const requests = captureRequests(provider, (index) => index === 0 ? rejected : { input_tokens: 10, output_tokens: 1 })

  await provider.createMessage(cacheRequest())
  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0])
})

test('auto does not retry a rejected uncached fallback', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key' })
  const rejected = Object.assign(new Error('cache_control is not supported'), { status: 400 })
  const requests = captureRequests(provider, () => rejected)

  await assert.rejects(provider.createMessage(cacheRequest()), (error) => error === rejected)
  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 0])
})

test('auto preserves unrelated API errors and existing retry policy', async () => {
  for (const [status, message] of [
    [400, 'max_tokens is invalid'],
    [400, 'At most 4 cache_control blocks are allowed'],
    [400, 'Unsupported beta header: advanced-tool-use-2025-11-20'],
    [401, 'cache_control is not supported'],
    [429, 'cache_control is not supported'],
    [500, 'cache_control is not supported'],
  ] as const) {
    const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key' })
    const rejected = Object.assign(new Error(message), { status })
    const requests = captureRequests(provider, () => rejected)
    await assert.rejects(provider.createMessage(cacheRequest()), (error) => error === rejected)
    assert.equal(requests.length, 1, `${status}: ${message}`)
  }
})

test('explicit off and the global kill switch omit cache markers', async () => {
  const off = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'off' })
  const offRequests = captureRequests(off, () => ({ input_tokens: 10, output_tokens: 1 }))
  await off.createMessage(cacheRequest())
  assert.equal(collectCacheControlTelemetry(offRequests[0]!.payload).total, 0)

  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const on = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'on' })
  const onRequests = captureRequests(on, () => ({ input_tokens: 10, output_tokens: 1 }))
  await on.createMessage(cacheRequest())
  assert.equal(collectCacheControlTelemetry(onRequests[0]!.payload).total, 0)
})

test('a one-shot request sends no cache markers even with caching explicitly on', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'on' })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  await provider.createMessage(cacheRequest({ promptCaching: false }))
  assert.equal(collectCacheControlTelemetry(requests[0]!.payload).total, 0)
})

test('explicit on reports unsupported caching instead of silently disabling it', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', promptCaching: 'on' })
  const rejected = Object.assign(new Error('Unknown parameter: cache_control'), { status: 400 })
  const requests = captureRequests(provider, () => rejected)

  await assert.rejects(provider.createMessage(cacheRequest()), (error) => error === rejected)
  assert.equal(requests.length, 1)
  assert.equal(collectCacheControlTelemetry(requests[0]!.payload).total, 3)
})

test('1h caching on a compatible endpoint does not add beta headers', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  await provider.createMessage(cacheRequest({ cacheRuntime: { settings: { cache: { ttl1h: true } } } }))

  const payload = requests[0]!.payload as { system: Array<{ cache_control: unknown }> }
  assert.deepEqual(payload.system[0]!.cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(requests[0]!.options, undefined)
})

test('compatible endpoints report cache breaks without interpreting zero hits as unsupported caching', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  const cacheReads = [0, 8_000, 0]
  const requests = captureRequests(provider, (index) => ({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: cacheReads[index] }))
  await provider.createMessage(cacheRequest())
  await provider.createMessage(cacheRequest())
  const result = await provider.createMessage(cacheRequest({ system: 'Changed system instructions' }))

  assert.equal(result.cacheBreak?.tokenDrop, 8_000)
  assert.ok(result.cacheBreak?.reasons.some((reason) => reason.startsWith('system_prompt_changed')))
  assert.deepEqual(requests.map(({ payload }) => collectCacheControlTelemetry(payload).total), [3, 3, 3])
})

test('missing cache usage does not report a false eviction or erase the previous baseline', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', baseUrl: 'https://proxy.example/v1' })
  captureRequests(provider, (index) => ({
    input_tokens: 20,
    output_tokens: 1,
    ...(index === 1 ? {} : { cache_read_input_tokens: index === 0 ? 8_000 : 0 }),
  }))
  await provider.createMessage(cacheRequest())
  const missing = await provider.createMessage(cacheRequest())
  const zero = await provider.createMessage(cacheRequest())

  assert.equal(missing.cacheBreak, undefined)
  assert.equal(zero.cacheBreak?.tokenDrop, 8_000)
  assert.deepEqual(zero.cacheBreak?.reasons, ['server_side'])
})

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(assertion(), true)
}

// --- Image payload mapping (S17, design §10.1) ---

const imageCreatedAt = '2026-09-08T00:00:00.000Z'

function imageRef(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id,
    ownerSessionId: 'session-image',
    name: `${id}.png`,
    mimeType: 'image/png',
    width: 64,
    height: 48,
    byteLength: 96,
    ...overrides,
  }
}

function imageBytesFor(bytes: Uint8Array, mimeType: ImageMimeType = 'image/png'): RequestImageBytes {
  return { bytes, mimeType }
}

function payloadMessagesOf(request: ModelRequest): Array<{ role: string; content: unknown }> {
  return buildAnthropicPayload(request).messages as unknown as Array<{ role: string; content: unknown }>
}

test('user messages map to text and base64 image blocks; pure-image messages survive the empty-text filter', () => {
  // Isolate block shape from the last-message cache breakpoint marker.
  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const shot = imageRef('img-shot', { name: 'shot.png' })
  const diagram = imageRef('img-diagram', { name: 'diagram.jpg', mimeType: 'image/jpeg' })
  const silent = imageRef('img-silent', { name: 'silent.png' })
  const shotBytes = new Uint8Array([1, 2, 3, 4])
  const diagramBytes = new Uint8Array([5, 6])

  const messages = payloadMessagesOf({
    model: 'claude-sonnet',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: '请分析这张截图', images: [shot, diagram], createdAt: imageCreatedAt },
      },
      {
        kind: 'message',
        message: { id: 'u2', role: 'user', content: '', images: [silent], createdAt: imageCreatedAt },
      },
    ],
    imageBytes: new Map([
      [shot.id, imageBytesFor(shotBytes)],
      [diagram.id, imageBytesFor(diagramBytes, 'image/jpeg')],
      [silent.id, imageBytesFor(new Uint8Array([9]))],
    ]),
  })

  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: '请分析这张截图' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from(shotBytes).toString('base64') },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(diagramBytes).toString('base64') },
      },
    ],
  })
  // A pure-image message must not be dropped as an "empty" message.
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from([9]).toString('base64') },
      },
    ],
  })
})

test('tool results carry image blocks with their tool_use_id and is_error; text-only results stay strings', () => {
  // Isolate block shape from the last-message cache breakpoint marker.
  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const saw = imageRef('img-saw')
  const failed = imageRef('img-failed', { name: 'failed.png' })

  const messages = payloadMessagesOf({
    model: 'claude-sonnet',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'checking', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'shot.png' } },
      { kind: 'tool_use', id: 'call-2', tool: 'Read', input: { filePath: 'broken.png' } },
      { kind: 'tool_use', id: 'call-3', tool: 'Grep', input: { pattern: 'x' } },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw it', images: [saw] },
      { kind: 'tool_result', toolUseId: 'call-2', tool: 'Read', ok: false, content: 'boom', images: [failed] },
      { kind: 'tool_result', toolUseId: 'call-3', tool: 'Grep', ok: true, content: '2 matches' },
    ],
    imageBytes: new Map([
      [saw.id, imageBytesFor(new Uint8Array([1]))],
      [failed.id, imageBytesFor(new Uint8Array([2]))],
    ]),
  })

  // Consecutive tool results merge into one user message, images included.
  assert.equal(messages.length, 2)
  const toolMessage = messages[1] as { role: string; content: Array<Record<string, unknown>> }
  assert.equal(toolMessage.role, 'user')
  assert.equal(toolMessage.content.length, 3)
  assert.deepEqual(toolMessage.content[0], {
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: [
      { type: 'text', text: 'saw it' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1]).toString('base64') },
      },
    ],
    is_error: false,
  })
  assert.equal((toolMessage.content[1] as { is_error: unknown }).is_error, true)
  assert.equal((toolMessage.content[1] as { tool_use_id: unknown }).tool_use_id, 'call-2')
  // A tool result without images keeps its string content exactly as before.
  assert.deepEqual(toolMessage.content[2], {
    type: 'tool_result',
    tool_use_id: 'call-3',
    content: '2 matches',
    is_error: false,
  })
})

test('a pure-image tool result sends an image-only content array', () => {
  // Isolate block shape from the last-message cache breakpoint marker.
  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const ref = imageRef('img-only')
  const bytes = new Uint8Array([7, 7, 7])

  const messages = payloadMessagesOf({
    model: 'claude-sonnet',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'shot.png' } },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: '', images: [ref] },
    ],
    imageBytes: new Map([[ref.id, imageBytesFor(bytes)]]),
  })

  const blocks = (messages[1]?.content as Array<Record<string, unknown>>)
  assert.deepEqual(blocks, [{
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(bytes).toString('base64') } },
    ],
    is_error: false,
  }])
})

test('an image ref without loaded bytes fails the payload build instead of silently dropping it', () => {
  const ref = imageRef('img-missing-bytes', { name: 'missing.png' })
  const request: ModelRequest = {
    model: 'claude-sonnet',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'look', images: [ref], createdAt: imageCreatedAt },
      },
    ],
  }

  assert.throws(() => buildAnthropicPayload(request), /missing\.png .*no send bytes loaded/)
  assert.throws(() => buildAnthropicPayload({ ...request, imageBytes: new Map() }), /img-missing-bytes/)
})

test('pre-mapped apiResultBlock tool results keep their priority shape untouched', () => {
  // Isolate the branch's shape from the last-message cache breakpoint, which
  // decorates whichever block happens to be last.
  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const messages = payloadMessagesOf({
    model: 'claude-sonnet',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'tool_use', id: 'call-ts', tool: 'ToolSearch', input: { query: 'read' } },
      {
        kind: 'tool_result',
        toolUseId: 'call-ts',
        tool: 'ToolSearch',
        ok: true,
        content: 'fallback text',
        apiResultBlock: {
          type: 'tool_result',
          tool_use_id: 'call-ts',
          content: [{ type: 'tool_reference', tool_name: 'Read' }],
        } as ToolResultBlockParam,
      },
    ],
  })

  const blocks = messages[1]?.content as Array<Record<string, unknown>>
  assert.deepEqual(blocks, [{
    type: 'tool_result',
    tool_use_id: 'call-ts',
    content: [{ type: 'tool_reference', tool_name: 'Read' }],
    is_error: false,
  }])
})

test('image blocks leave the cache_control marker count and distribution unchanged', () => {
  const ref = imageRef('img-cache', { name: 'cache.png' })
  const bytes = new Uint8Array([1, 2, 3])

  const withImages = cacheRequest({
    messages: [{
      id: 'user-1',
      role: 'user',
      content: 'Read the file',
      images: [ref],
      createdAt: '2026-09-06T00:00:00Z',
    }],
    imageBytes: new Map([[ref.id, imageBytesFor(bytes)]]),
  })
  const withoutImages = cacheRequest()

  const withPayload = buildAnthropicPayload(withImages)
  const withoutPayload = buildAnthropicPayload(withoutImages)

  assert.deepEqual(
    collectCacheControlTelemetry(withPayload).byLocation,
    collectCacheControlTelemetry(withoutPayload).byLocation,
  )
  assert.deepEqual(collectCacheControlTelemetry(withPayload).byLocation, {
    system: 1, tools: 1, messages: 1, other: 0,
  })
  assert.ok(collectCacheControlTelemetry(withPayload).total <= 4)
  // The message marker still lands on the last message's last block — now an
  // image block, which the API accepts and the limit accounting still counts.
  const lastMessage = (withPayload.messages as unknown as Array<{ content: Array<Record<string, unknown>> }>).at(-1)
  const lastBlock = lastMessage?.content.at(-1)
  assert.equal(lastBlock?.type, 'image')
  assert.deepEqual(lastBlock?.cache_control, { type: 'ephemeral' })
})

test('the provider sends base64 image blocks built from the request byte map', async () => {
  process.env.MYAGENT_DISABLE_PROMPT_CACHING = '1'
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', supportsImageInput: true })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  const ref = imageRef('img-e2e', { name: 'e2e.png' })
  const bytes = new Uint8Array([137, 80, 78, 71])

  await provider.createMessage(cacheRequest({
    messages: [{
      id: 'user-1',
      role: 'user',
      content: '请分析这张截图',
      images: [ref],
      createdAt: '2026-09-06T00:00:00Z',
    }],
    imageBytes: new Map([[ref.id, imageBytesFor(bytes)]]),
  }))

  const messages = requests[0]!.payload.messages as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>
  assert.deepEqual(messages.at(-1)?.content, [
    { type: 'text', text: '请分析这张截图' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from(bytes).toString('base64') },
    },
  ])
})

// --- Final pre-send checks (S19, design §11.1 step 5) -------------------------

function imageRequest(refs: ImageAttachmentRef[], bytesFor: (ref: ImageAttachmentRef) => Uint8Array): ModelRequest {
  return cacheRequest({
    messages: [{
      id: 'user-1',
      role: 'user',
      content: 'look at this',
      images: refs,
      createdAt: '2026-09-06T00:00:00Z',
    }],
    imageBytes: new Map(refs.map((ref) => [ref.id, imageBytesFor(bytesFor(ref))])),
  })
}

test('the provider refuses image-bearing requests when the model is not enabled for image input', async () => {
  // Model switch off: the resolved capability is false even though the
  // adapter supports images.
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key' })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  const ref = imageRef('img-switched-off', { name: 'off.png' })

  await assert.rejects(provider.createMessage(imageRequest([ref], () => new Uint8Array([1]))), (error: unknown) =>
    error instanceof TurnImageBlockError
      && error.imageInputBlock === 'model-not-capable'
      && /not enabled for image input/.test(error.message)
      && /off\.png/.test(error.message),
  )
  assert.equal(requests.length, 0, 'the request never reaches the endpoint')

  // Adapter-side refusal: a stubbed adapter flag blocks the same way.
  const adapterOff = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', supportsImageInput: true })
  ;(adapterOff as unknown as { supportsImageInput: () => boolean }).supportsImageInput = () => false
  const adapterRequests = captureRequests(adapterOff, () => ({ input_tokens: 10, output_tokens: 1 }))
  await assert.rejects(adapterOff.createMessage(imageRequest([ref], () => new Uint8Array([1]))), (error: unknown) =>
    error instanceof TurnImageBlockError && error.imageInputBlock === 'model-not-capable',
  )
  assert.equal(adapterRequests.length, 0)

  // Without images the same provider works untouched.
  await provider.createMessage(cacheRequest())
  assert.equal(requests.length, 1)
})

test('the final check rejects an oversized image before the endpoint is called, without retrying', async () => {
  const provider = new AnthropicProvider({ model: 'claude-sonnet', apiKey: 'test-key', supportsImageInput: true })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  const ref = imageRef('img-huge', { name: 'huge.png' })

  await assert.rejects(provider.createMessage({
    ...imageRequest([ref], () => new Uint8Array(3_750_001)),
    retry: { maxRetries: 3 },
  }), (error: unknown) =>
    error instanceof TurnImageBlockError
      && error.imageInputBlock === 'image-too-large'
      && /huge\.png/.test(error.message)
      && /3,750,001 bytes/.test(error.message)
      && /3,750,000-byte per-image limit/.test(error.message)
      && /Crop the image or attach a smaller version/.test(error.message),
  )
  assert.equal(requests.length, 0, 'rejected before any network call')
})

test('the final check rejects a request over an adapter-declared image-count limit', async () => {
  class TightCountProvider extends AnthropicProvider {
    maxImagesPerRequest(): number {
      return 1
    }
  }
  const provider = new TightCountProvider({ model: 'claude-sonnet', apiKey: 'test-key', supportsImageInput: true })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  const refs = [imageRef('img-a', { name: 'a.png' }), imageRef('img-b', { name: 'b.png' })]

  await assert.rejects(provider.createMessage(imageRequest(refs, () => new Uint8Array([1, 2]))), (error: unknown) =>
    error instanceof TurnImageBlockError
      && error.imageInputBlock === 'too-many-images'
      && /2 image blocks/.test(error.message)
      && /at most 1 are allowed/.test(error.message),
  )
  assert.equal(requests.length, 0)
})

test('the final check rejects a request whose serialized body exceeds the adapter-declared limit', async () => {
  class TightBodyProvider extends AnthropicProvider {
    maxRequestBodyBytes(): number {
      return 200
    }
  }
  const provider = new TightBodyProvider({ model: 'claude-sonnet', apiKey: 'test-key', supportsImageInput: true })
  const requests = captureRequests(provider, () => ({ input_tokens: 10, output_tokens: 1 }))
  const ref = imageRef('img-body', { name: 'body.png' })

  await assert.rejects(provider.createMessage(imageRequest([ref], () => new Uint8Array(300))), (error: unknown) =>
    error instanceof TurnImageBlockError
      && error.imageInputBlock === 'request-too-large'
      && /serialized request body is/.test(error.message)
      && /200-byte request limit/.test(error.message)
      && /image data/.test(error.message),
  )
  assert.equal(requests.length, 0)
})
