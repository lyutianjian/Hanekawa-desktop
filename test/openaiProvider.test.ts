import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { OpenAIProvider } from '../src/config/providers/openaiProvider.js'
import { buildOpenAIMessages, buildOpenAIPayload } from '../src/config/providers/openaiPayload.js'
import { resetCacheBreakDetection, type CacheBreakSource } from '../src/harness/cacheBreakDetection.js'
import { clearToolSchemaCache } from '../src/utils/toolSchemaCache.js'
import { TurnImageBlockError } from '../src/harness/turnImages.js'
import { consumeWithIdleTimeout } from '../src/config/providers/streamIdle.js'
import { classifyError } from '../src/config/retry.js'
import type { ModelRequest, RequestImageBytes, Tool } from '../src/harness/types.js'
import type { ImageAttachmentRef, ImageMimeType } from '../src/media/types.js'

interface FakeOpenAIResponse {
  id: string
  choices: Array<{
    finish_reason: string
    message: {
      content: string
      reasoning_content?: string
      tool_calls?: Array<{
        id: string
        function: {
          name: string
          arguments: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

/** A whole response replayed as the stream the provider now reads: reasoning, text, tool calls, then usage. */
function streamOf(response: FakeOpenAIResponse | unknown[]): AsyncIterable<unknown> & { controller: AbortController } {
  const chunks = Array.isArray(response) ? response : chunksOf(response)
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

function chunksOf(response: FakeOpenAIResponse): unknown[] {
  const choice = response.choices[0]!
  const delta = (fields: Record<string, unknown>, finish: string | null = null) =>
    ({ id: response.id, choices: [{ index: 0, delta: fields, finish_reason: finish }] })
  return [
    ...(choice.message.reasoning_content ? [delta({ reasoning_content: choice.message.reasoning_content })] : []),
    ...(choice.message.content ? [delta({ content: choice.message.content })] : []),
    ...(choice.message.tool_calls ?? []).map((call, index) =>
      delta({ tool_calls: [{ index, id: call.id, function: call.function }] })),
    delta({}, choice.finish_reason),
    ...(response.usage ? [{ id: response.id, choices: [], usage: response.usage }] : []),
  ]
}

function installFakeClient(
  provider: OpenAIProvider,
  create: (payload: unknown, options?: unknown) => Promise<FakeOpenAIResponse | unknown[]>,
  baseURL = 'https://api.openai.com/v1',
): void {
  ;(provider as unknown as {
    client: {
      baseURL: string
      chat: { completions: { create: (payload: unknown, options?: unknown) => Promise<unknown> } }
    }
  }).client = {
    baseURL,
    chat: {
      completions: {
        create: async (payload, options) => streamOf(await create(payload, options)),
      },
    },
  }
}

function openAIResponse(
  id: string,
  cachedTokens: number,
  promptTokens = cachedTokens + 1_000,
  reasoningContent?: string,
): FakeOpenAIResponse {
  return {
    id,
    choices: [{
      finish_reason: 'stop',
      message: {
        content: 'visible answer',
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      },
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 42,
      prompt_tokens_details: {
        cached_tokens: cachedTokens,
      },
    },
  }
}

function createTool(name: string, inputSchema: Tool['inputSchema']): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema,
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ok' }),
  }
}

function baseRequest(source: CacheBreakSource): ModelRequest {
  return {
    cacheSource: source,
    model: 'gpt-test',
    system: 'system',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date('2026-05-24T00:00:00.000Z').toISOString(),
    }],
    retry: { maxRetries: 0 },
  }
}

test('OpenAI provider preserves reasoning_content and cached-token usage', async () => {
  const source = 'agent:openai-reasoning-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'deepseek-reasoner',
      apiKey: 'test-key',
    })
    installFakeClient(provider, async () => openAIResponse(
      'chatcmpl_reasoning',
      300,
      1_000,
      'private reasoning from provider',
    ))

    const response = await provider.createMessage({
      ...baseRequest(source),
      model: 'deepseek-reasoner',
    })

    assert.equal(response.content, 'visible answer')
    assert.equal(response.reasoningContent, 'private reasoning from provider')
    assert.deepEqual(response.usage, {
      inputTokens: 700,
      cacheReadInputTokens: 300,
      outputTokens: 42,
    })
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('OpenAI provider normalizes length finish_reason to max_tokens', async () => {
  const source = 'agent:openai-length-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
    })
    installFakeClient(provider, async () => ({
      ...openAIResponse('chatcmpl_length', 0),
      choices: [{
        finish_reason: 'length',
        message: {
          content: 'partial answer',
        },
      }],
    }))

    const response = await provider.createMessage(baseRequest(source))

    assert.equal(response.content, 'partial answer')
    assert.equal(response.stopReason, 'max_tokens')
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('OpenAI provider reports cache breaks with prompt-change reasons', async () => {
  const scenarios: Array<{
    name: string
    source: CacheBreakSource
    previous: ModelRequest
    current: ModelRequest
    expectedReason: RegExp
  }> = [
    {
      name: 'system',
      source: 'agent:openai-cache-system-test',
      previous: baseRequest('agent:openai-cache-system-test'),
      current: { ...baseRequest('agent:openai-cache-system-test'), system: 'changed system' },
      expectedReason: /^system_prompt_changed/,
    },
    {
      name: 'tools',
      source: 'agent:openai-cache-tools-test',
      previous: {
        ...baseRequest('agent:openai-cache-tools-test'),
        tools: [createTool('lookup', z.object({ query: z.string() }))],
      },
      current: {
        ...baseRequest('agent:openai-cache-tools-test'),
        tools: [createTool('lookup', z.object({ query: z.number() }))],
      },
      expectedReason: /^tool_schemas_changed$/,
    },
    {
      name: 'model',
      source: 'agent:openai-cache-model-test',
      previous: baseRequest('agent:openai-cache-model-test'),
      current: { ...baseRequest('agent:openai-cache-model-test'), model: 'gpt-other' },
      expectedReason: /^model_changed$/,
    },
  ]

  for (const scenario of scenarios) {
    resetCacheBreakDetection(scenario.source)
    clearToolSchemaCache()
    try {
      let calls = 0
      const provider = new OpenAIProvider({
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'test-key',
      })
      installFakeClient(provider, async () => {
        calls += 1
        return calls === 1
          ? openAIResponse(`chatcmpl_${scenario.name}_1`, 10_000, 11_000)
          : openAIResponse(`chatcmpl_${scenario.name}_2`, 100, 1_100)
      })

      const first = await provider.createMessage(scenario.previous)
      const second = await provider.createMessage(scenario.current)

      assert.equal(first.cacheBreak, undefined)
      assert.equal(second.cacheBreak?.source, scenario.source)
      assert.equal(second.cacheBreak?.tokenDrop, 9_900)
      assert.ok(
        second.cacheBreak?.reasons.some((reason) => scenario.expectedReason.test(reason)),
        `${scenario.name} cache break reasons: ${second.cacheBreak?.reasons.join(', ')}`,
      )
    } finally {
      resetCacheBreakDetection(scenario.source)
    }
  }
})

// --- Image payload mapping (S18, design §10.2) ---

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

function dataUrl(bytes: Uint8Array, mimeType: ImageMimeType = 'image/png'): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

function openAIMessagesOf(request: ModelRequest): Array<{ role: string; content: unknown; tool_call_id?: string }> {
  return buildOpenAIMessages(request) as Array<{ role: string; content: unknown; tool_call_id?: string }>
}

test('user messages map to text and image_url data URL parts; pure-image messages survive', () => {
  const shot = imageRef('img-shot', { name: 'shot.png' })
  // The ref claims PNG; the loaded bytes decide the data URL MIME.
  const diagram = imageRef('img-diagram', { name: 'diagram.jpg', mimeType: 'image/png' })
  const silent = imageRef('img-silent', { name: 'silent.png' })
  const shotBytes = new Uint8Array([1, 2, 3, 4])
  const diagramBytes = new Uint8Array([5, 6])

  const messages = openAIMessagesOf({
    model: 'gpt-test',
    system: 'system',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: '请分析这张截图', images: [shot, diagram], createdAt: imageCreatedAt } },
      { kind: 'message', message: { id: 'u2', role: 'user', content: '', images: [silent], createdAt: imageCreatedAt } },
    ],
    imageBytes: new Map([
      [shot.id, imageBytesFor(shotBytes)],
      [diagram.id, imageBytesFor(diagramBytes, 'image/jpeg')],
      [silent.id, imageBytesFor(new Uint8Array([9]))],
    ]),
  })

  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { role: 'system', content: 'system' })
  // deepEqual also pins "no detail key" — the first version sends none.
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: '请分析这张截图' },
      { type: 'image_url', image_url: { url: dataUrl(shotBytes) } },
      { type: 'image_url', image_url: { url: dataUrl(diagramBytes, 'image/jpeg') } },
    ],
  })
  // A pure-image message survives as an image-only content array, no empty text part.
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: dataUrl(new Uint8Array([9])) } }],
  })
})

test('tool images ride a synthetic user message after the whole tool batch, never inside role: tool', () => {
  const shot = imageRef('img-shot', { name: 'shot.png' })
  const diagram = imageRef('img-diagram', { name: 'diagram.png' })
  const photo = imageRef('img-photo', { name: 'photo.jpg', mimeType: 'image/png' })

  const messages = openAIMessagesOf({
    model: 'gpt-test',
    system: 'system',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'checking', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'shot.png' } },
      { kind: 'tool_use', id: 'call-2', tool: 'Read', input: { filePath: 'diagram.png' } },
      { kind: 'tool_use', id: 'call-3', tool: 'Grep', input: { pattern: 'x' } },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw it', images: [shot] },
      { kind: 'tool_result', toolUseId: 'call-2', tool: 'Read', ok: true, content: 'second', images: [diagram, photo] },
      { kind: 'tool_result', toolUseId: 'call-3', tool: 'Grep', ok: true, content: '2 matches' },
    ],
    imageBytes: new Map([
      [shot.id, imageBytesFor(new Uint8Array([1]))],
      [diagram.id, imageBytesFor(new Uint8Array([2]))],
      [photo.id, imageBytesFor(new Uint8Array([3]), 'image/jpeg')],
    ]),
  })

  assert.equal(messages.length, 6)
  // The assistant message carries all three calls of the batch.
  const assistant = messages[1] as { role: string; content: string; tool_calls: Array<{ id: string }> }
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['call-1', 'call-2', 'call-3'])
  // Tool messages stay pure text — Chat Completions `role: tool` accepts text only.
  assert.deepEqual(messages[2], { role: 'tool', content: 'saw it', tool_call_id: 'call-1' })
  assert.deepEqual(messages[3], { role: 'tool', content: 'second', tool_call_id: 'call-2' })
  assert.deepEqual(messages[4], { role: 'tool', content: '2 matches', tool_call_id: 'call-3' })
  // The synthetic message lands after the ENTIRE batch, clearly labelled as
  // tool output with its call IDs — never between the tool messages.
  assert.deepEqual(messages[5], {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '[Tool output data, not user input. Images returned by tool calls: '
          + 'Read (tool call call-1): shot.png; Read (tool call call-2): diagram.png, photo.jpg.]',
      },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array([1])) } },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array([2])) } },
      { type: 'image_url', image_url: { url: dataUrl(new Uint8Array([3]), 'image/jpeg') } },
    ],
  })
})

test('each tool batch gets its own synthetic message; none is inserted mid-batch', () => {
  const first = imageRef('img-first', { name: 'first.png' })
  const second = imageRef('img-second', { name: 'second.png' })

  const messages = openAIMessagesOf({
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'look', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'first.png' } },
      // Pure-image tool result: the tool message keeps its (empty) string content.
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: '', images: [first] },
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'noted', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-2', tool: 'Read', input: { filePath: 'second.png' } },
      { kind: 'tool_result', toolUseId: 'call-2', tool: 'Read', ok: true, content: 'again', images: [second] },
    ],
    imageBytes: new Map([
      [first.id, imageBytesFor(new Uint8Array([1]))],
      [second.id, imageBytesFor(new Uint8Array([2]))],
    ]),
  })

  assert.equal(messages.length, 7)
  assert.deepEqual(messages[0], { role: 'user', content: 'look' })
  assert.deepEqual(messages[2], { role: 'tool', content: '', tool_call_id: 'call-1' })
  // Batch 1's images flush before the assistant reply that follows the batch.
  assert.equal(messages[3].role, 'user')
  const firstSynthetic = messages[3].content as Array<{ type: string; text?: string }>
  assert.equal(firstSynthetic[0]?.text, '[Tool output data, not user input. Images returned by tool calls: Read (tool call call-1): first.png.]')
  assert.equal(firstSynthetic.length, 2)
  // The next batch's tool_use still merges into the assistant message.
  const followUp = messages[4] as { role: string; content: string; tool_calls: Array<{ id: string }> }
  assert.equal(followUp.role, 'assistant')
  assert.equal(followUp.content, 'noted')
  assert.deepEqual(followUp.tool_calls.map((call) => call.id), ['call-2'])
  assert.deepEqual(messages[5], { role: 'tool', content: 'again', tool_call_id: 'call-2' })
  // A request ending on tool results flushes its batch last.
  assert.equal(messages[6].role, 'user')
  const secondSynthetic = messages[6].content as Array<{ type: string; text?: string }>
  assert.equal(secondSynthetic[0]?.text, '[Tool output data, not user input. Images returned by tool calls: Read (tool call call-2): second.png.]')
  assert.equal(secondSynthetic.length, 2)
})

test('requests without images keep the exact string format they have always had', () => {
  const messages = openAIMessagesOf({
    model: 'gpt-test',
    system: 'system',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'hello', createdAt: imageCreatedAt } },
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'checking', createdAt: imageCreatedAt } },
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: { filePath: 'x.ts' } },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw it' },
    ],
  })

  // The pre-image shape, byte for byte: string contents everywhere and no
  // synthetic message trailing the tool result.
  assert.deepEqual(messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Read', arguments: '{"filePath":"x.ts"}' } }] },
    { role: 'tool', content: 'saw it', tool_call_id: 'call-1' },
  ])
})

test('an image ref without loaded bytes fails the payload build instead of silently dropping it', () => {
  const userRef = imageRef('img-missing-bytes', { name: 'missing.png' })
  const toolRef = imageRef('img-tool-missing', { name: 'tool-missing.png' })
  const userRequest: ModelRequest = {
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'look', images: [userRef], createdAt: imageCreatedAt } },
    ],
  }

  assert.throws(() => buildOpenAIMessages(userRequest), /missing\.png .*no send bytes loaded/)
  assert.throws(() => buildOpenAIMessages({ ...userRequest, imageBytes: new Map() }), /img-missing-bytes/)
  // The synthetic tool-output path refuses missing bytes too.
  assert.throws(() => buildOpenAIMessages({
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'tool_use', id: 'call-1', tool: 'Read', input: {} },
      { kind: 'tool_result', toolUseId: 'call-1', tool: 'Read', ok: true, content: 'saw', images: [toolRef] },
    ],
  }), /tool-missing\.png .*no send bytes loaded/)
})

test('an assistant message carrying images fails the build instead of emitting invalid content', () => {
  const ref = imageRef('img-assistant', { name: 'assistant.png' })
  assert.throws(() => buildOpenAIMessages({
    model: 'gpt-test',
    messages: [],
    cacheSource: 'agent:image-test',
    contextItems: [
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: 'here', images: [ref], createdAt: imageCreatedAt } },
    ],
    imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array([1]))]]),
  }), /cannot carry image_url parts/)
})

test('endpoint rejections of image-bearing requests surface endpoint, model and reason without side effects', async () => {
  const source = 'agent:openai-image-reject-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      supportsImageInput: true,
    })
    const ref = imageRef('img-reject', { name: 'reject.png' })
    const thrown = Object.assign(new Error('Invalid request: image_url content type not supported'), { status: 400 })
    let calls = 0
    installFakeClient(provider, async () => {
      calls += 1
      throw thrown
    })
    const imageRequest: ModelRequest = {
      ...baseRequest(source),
      retry: { maxRetries: 3 },
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look at this',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array([1, 2]))]]),
    }

    await assert.rejects(provider.createMessage(imageRequest), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Endpoint https:\/\/api\.openai\.com\/v1 \(model gpt-test\) rejected a request carrying 1 image\(s\)/)
      assert.match(error.message, /image_url content type not supported/)
      assert.match(error.message, /may not accept standard data URL image parts/)
      assert.match(error.message, /No protocol was switched, no image was dropped, and the capability setting was not changed automatically/)
      assert.equal((error as Error & { status?: number }).status, 400)
      assert.equal((error as { cause?: unknown }).cause, thrown)
      return true
    })
    // A request-shape rejection is not retried — no retry storm against an
    // incompatible endpoint.
    assert.equal(calls, 1)
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('auth failures and text-only rejections keep their original error', async () => {
  const authSource = 'agent:openai-image-auth-test'
  const textSource = 'agent:openai-image-text-test'
  resetCacheBreakDetection(authSource)
  resetCacheBreakDetection(textSource)
  try {
    // 401 on an image-bearing request is an auth problem, not an image
    // incompatibility — it must pass through untouched.
    const authProvider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      supportsImageInput: true,
    })
    const authRef = imageRef('img-auth', { name: 'auth.png' })
    installFakeClient(authProvider, async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    })
    await assert.rejects(authProvider.createMessage({
      ...baseRequest(authSource),
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [authRef],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[authRef.id, imageBytesFor(new Uint8Array([1]))]]),
    }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Unauthorized')
      return true
    })

    // A 400 on a request without images has no image context to add.
    const textProvider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
    })
    installFakeClient(textProvider, async () => {
      throw Object.assign(new Error('Bad request'), { status: 400 })
    })
    await assert.rejects(textProvider.createMessage(baseRequest(textSource)), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Bad request')
      return true
    })
  } finally {
    resetCacheBreakDetection(authSource)
    resetCacheBreakDetection(textSource)
  }
})

// --- Final pre-send checks (S19, design §11.1 step 5) -------------------------

test('the provider refuses image-bearing requests when the model is not enabled for image input', async () => {
  const source = 'agent:openai-image-capability-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      // Model switch off: the resolved capability is false even though the
      // adapter supports images.
    })
    const ref = imageRef('img-switched-off', { name: 'off.png' })
    let calls = 0
    installFakeClient(provider, async () => {
      calls += 1
      return openAIResponse('r', 0)
    })
    await assert.rejects(provider.createMessage({
      ...baseRequest(source),
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array([1]))]]),
    }), (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'model-not-capable'
        && /not enabled for image input/.test(error.message)
        && /off\.png/.test(error.message),
    )
    assert.equal(calls, 0, 'the request never reaches the endpoint')

    // Adapter-side refusal: a stubbed adapter flag blocks the same way.
    const adapterOff = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      supportsImageInput: true,
    })
    ;(adapterOff as unknown as { supportsImageInput: () => boolean }).supportsImageInput = () => false
    let adapterCalls = 0
    installFakeClient(adapterOff, async () => {
      adapterCalls += 1
      return openAIResponse('r', 0)
    })
    await assert.rejects(adapterOff.createMessage({
      ...baseRequest(source),
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array([1]))]]),
    }), (error: unknown) =>
      error instanceof TurnImageBlockError && error.imageInputBlock === 'model-not-capable',
    )
    assert.equal(adapterCalls, 0)

    // Without images the same provider works untouched.
    await provider.createMessage(baseRequest(source))
    assert.equal(calls, 1)
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('the final check rejects an oversized image before the endpoint is called, without retrying', async () => {
  const source = 'agent:openai-image-toolarge-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      supportsImageInput: true,
    })
    const ref = imageRef('img-huge', { name: 'huge.png' })
    let calls = 0
    installFakeClient(provider, async () => {
      calls += 1
      return openAIResponse('r', 0)
    })
    await assert.rejects(provider.createMessage({
      ...baseRequest(source),
      retry: { maxRetries: 3 },
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array(3_750_001))]]),
    }), (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'image-too-large'
        && /huge\.png/.test(error.message)
        && /3,750,001 bytes/.test(error.message)
        && /3,750,000-byte per-image limit/.test(error.message)
        && /Crop the image/.test(error.message),
    )
    assert.equal(calls, 0, 'rejected before any network call')
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('the final check rejects a request whose serialized body exceeds the adapter-declared limit', async () => {
  const source = 'agent:openai-image-bodylimit-test'
  resetCacheBreakDetection(source)
  try {
    // A lower adapter-declared body limit wins over the local default.
    class TightBodyProvider extends OpenAIProvider {
      maxRequestBodyBytes(): number {
        return 200
      }
    }
    const provider = new TightBodyProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      supportsImageInput: true,
    })
    const ref = imageRef('img-body', { name: 'body.png' })
    let calls = 0
    installFakeClient(provider, async () => {
      calls += 1
      return openAIResponse('r', 0)
    })
    await assert.rejects(provider.createMessage({
      ...baseRequest(source),
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array(300))]]),
    }), (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'request-too-large'
        && /serialized request body is/.test(error.message)
        && /200-byte request limit/.test(error.message)
        && /image data/.test(error.message),
    )
    assert.equal(calls, 0)
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('an endpoint rejection that echoes a data URL is redacted in the surfaced error', async () => {
  const source = 'agent:openai-image-redact-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-key',
      supportsImageInput: true,
    })
    const ref = imageRef('img-echo', { name: 'echo.png' })
    const echoed = Buffer.from(new Uint8Array(64)).toString('base64')
    installFakeClient(provider, async () => {
      throw Object.assign(
        new Error(`Invalid request: got data:image/png;base64,${echoed} which is not allowed here`),
        { status: 400 },
      )
    })
    await assert.rejects(provider.createMessage({
      ...baseRequest(source),
      messages: [{
        id: 'u1',
        role: 'user',
        content: 'look',
        images: [ref],
        createdAt: imageCreatedAt,
      }],
      imageBytes: new Map([[ref.id, imageBytesFor(new Uint8Array(64))]]),
    }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(echoed), 'no base64 body in the surfaced message')
      assert.match(error.message, /\[redacted image data\]/)
      assert.match(error.message, /rejected a request carrying 1 image\(s\)/)
      return true
    })
  } finally {
    resetCacheBreakDetection(source)
  }
})

// --- Chat Completions streaming and compatibility ---

function chunk(fields: Record<string, unknown>, finish: string | null = null): unknown {
  return { id: 'chatcmpl_stream', choices: [{ index: 0, delta: fields, finish_reason: finish }] }
}

function requestPayloads(provider: OpenAIProvider, baseURL: string, respond: (payload: Record<string, unknown>, call: number) => FakeOpenAIResponse | unknown[]): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = []
  installFakeClient(provider, async (payload) => {
    payloads.push(payload as Record<string, unknown>)
    return respond(payload as Record<string, unknown>, payloads.length)
  }, baseURL)
  return payloads
}

test('a streamed response assembles reasoning, text and fragmented tool arguments, emitting stream events', async () => {
  const source = 'agent:openai-stream-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({ provider: 'openai', model: 'gpt-test', apiKey: 'test-key' })
    requestPayloads(provider, 'https://api.openai.com/v1', () => [
      chunk({ reasoning: 'think ' }),
      chunk({ reasoning: 'hard' }),
      chunk({ content: 'Reading.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] }),
      chunk({}, 'tool_calls'),
      { id: 'chatcmpl_stream', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ])
    const events: string[] = []
    const response = await provider.createMessage({
      ...baseRequest(source),
      onStreamEvent: (event) => events.push(event.type),
    })

    assert.equal(response.content, 'Reading.')
    assert.equal(response.reasoningContent, 'think hard')
    assert.deepEqual(response.toolCalls, [{ id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } }])
    assert.equal(response.stopReason, 'tool_calls')
    assert.equal(response.requestId, 'chatcmpl_stream')
    assert.deepEqual(response.usage, { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 5 })
    assert.deepEqual(events, [
      'message_start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_stop',
      'text_delta', 'tool_input_delta', 'tool_input_delta', 'message_stop',
    ])
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('a stream that ends without finish_reason, or on content_filter, is an error', async () => {
  const source = 'agent:openai-stream-end-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({ provider: 'openai', model: 'gpt-test', apiKey: 'test-key' })
    requestPayloads(provider, 'https://api.openai.com/v1', () => [chunk({ content: 'half' })])
    await assert.rejects(provider.createMessage(baseRequest(source)), /Stream ended without finish_reason/)

    requestPayloads(provider, 'https://api.openai.com/v1', () => [chunk({ content: 'x' }, 'content_filter')])
    await assert.rejects(provider.createMessage(baseRequest(source)), /content_filter/)
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('each server gets its own request shape and thinking fields', async () => {
  const cases: Array<{ url: string; format?: string; expect: Record<string, unknown>; absent: string[] }> = [
    {
      url: 'https://api.openai.com/v1',
      expect: { max_completion_tokens: 1000, store: false, reasoning_effort: 'high' },
      absent: ['max_tokens', 'thinking'],
    },
    {
      url: 'https://api.deepseek.com',
      expect: { max_tokens: 1000, thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      absent: ['store', 'max_completion_tokens'],
    },
    { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', expect: { enable_thinking: true }, absent: ['reasoning_effort'] },
    { url: 'https://open.bigmodel.cn/api/paas/v4', expect: { thinking: { type: 'enabled' } }, absent: ['reasoning_effort'] },
    { url: 'https://openrouter.ai/api/v1', expect: { reasoning: { effort: 'high' } }, absent: ['reasoning_effort'] },
    { url: 'https://api.moonshot.cn/v1', expect: {}, absent: ['reasoning_effort', 'thinking', 'reasoning'] },
    { url: 'https://relay.example/v1', expect: { reasoning_effort: 'high' }, absent: [] },
    { url: 'https://relay.example/v1', format: 'deepseek', expect: { thinking: { type: 'enabled' } }, absent: [] },
  ]
  for (const entry of cases) {
    const source = 'agent:openai-compat-test'
    resetCacheBreakDetection(source)
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'm',
      apiKey: 'k',
      ...(entry.format ? { thinkingFormat: entry.format as 'deepseek' } : {}),
    })
    const payloads = requestPayloads(provider, entry.url, () => openAIResponse('r', 0))
    await provider.createMessage({ ...baseRequest(source), maxOutputTokens: 1000, effort: 'high' })
    const payload = payloads[0]!
    for (const [key, value] of Object.entries(entry.expect)) assert.deepEqual(payload[key], value, `${entry.url} ${key}`)
    for (const key of entry.absent) assert.equal(key in payload, false, `${entry.url} must not send ${key}`)
    assert.match(String(payload.prompt_cache_key), /^myagent:/, `${entry.url} sends the cache key`)
    assert.equal(payload.stream, true)
    assert.deepEqual(payload.stream_options, { include_usage: true })
    const instruction = (payload.messages as Array<{ role: string }>)[0]!.role
    assert.equal(instruction, entry.url.includes('api.openai.com') ? 'developer' : 'system')
  }
  resetCacheBreakDetection('agent:openai-compat-test')
})

test('thinking off sends an explicit off only where the server has one', async () => {
  const sent = async (url: string, config: Record<string, unknown>, request: Partial<ModelRequest> = {}) => {
    const source = 'agent:openai-thinking-off-test'
    resetCacheBreakDetection(source)
    const provider = new OpenAIProvider({ provider: 'openai', model: 'm', apiKey: 'k', ...config })
    const payloads = requestPayloads(provider, url, () => openAIResponse('r', 0))
    await provider.createMessage({ ...baseRequest(source), effort: 'low', ...request })
    resetCacheBreakDetection(source)
    return payloads[0]!
  }
  const modelOff = { thinking: { type: 'disabled' as const } }
  assert.deepEqual((await sent('https://api.deepseek.com', modelOff)).thinking, { type: 'disabled' })
  assert.equal((await sent('https://dashscope.aliyuncs.com/compatible-mode/v1', modelOff)).enable_thinking, false)
  assert.equal('reasoning_effort' in await sent('https://api.openai.com/v1', modelOff), false)
  // The global switch turns it off the same way.
  assert.deepEqual(
    (await sent('https://api.deepseek.com', {}, { thinking: { type: 'disabled' } })).thinking,
    { type: 'disabled' },
  )
})

test('a model that rejects the thinking fields is sent again without them, and remembered', async () => {
  const source = 'agent:openai-thinking-reject-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'k' })
    const rejected = Object.assign(new Error("400 Unrecognized request argument supplied: reasoning_effort"), { status: 400 })
    const payloads = requestPayloads(provider, 'https://reject-thinking.example/v1', (payload) => {
      if ('reasoning_effort' in payload) throw rejected
      return openAIResponse('r', 0)
    })
    const request = { ...baseRequest(source), model: 'gpt-4o', effort: 'high' as const }
    assert.equal((await provider.createMessage(request)).content, 'visible answer')
    await provider.createMessage(request)
    assert.deepEqual(payloads.map((payload) => 'reasoning_effort' in payload), [true, false, false])

    // Another model on the same server is still asked first.
    await provider.createMessage({ ...request, model: 'gpt-5' })
    assert.deepEqual(payloads.slice(3).map((payload) => 'reasoning_effort' in payload), [true, false])
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('an unrelated 400, or a retry that also fails, is not taken for a thinking rejection', async () => {
  const source = 'agent:openai-thinking-unrelated-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({ provider: 'openai', model: 'm', apiKey: 'k' })
    const unrelated = Object.assign(new Error('400 max_tokens is too large'), { status: 400 })
    const payloads = requestPayloads(provider, 'https://unrelated.example/v1', () => { throw unrelated })
    const request = { ...baseRequest(source), effort: 'high' as const }
    await assert.rejects(provider.createMessage(request), (error) => error === unrelated)
    assert.equal(payloads.length, 1)

    // An echoing proxy: the message names the field, but the bare retry fails too.
    const echoed = Object.assign(new Error('400 bad request: {"reasoning_effort":"high"}'), { status: 400 })
    const echoPayloads = requestPayloads(provider, 'https://echo.example/v1', () => { throw echoed })
    await assert.rejects(provider.createMessage(request))
    await assert.rejects(provider.createMessage(request))
    assert.deepEqual(echoPayloads.map((payload) => 'reasoning_effort' in payload), [true, false, true, false])
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('a server that refuses prompt_cache_key is sent again without it, and remembered', async () => {
  const source = 'agent:openai-cache-hint-reject-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({ provider: 'openai', model: 'm', apiKey: 'k' })
    const rejected = Object.assign(new Error('400 Unrecognized request argument supplied: prompt_cache_key'), { status: 400 })
    const payloads = requestPayloads(provider, 'https://reject-cache.example/v1', (payload) => {
      if ('prompt_cache_key' in payload) throw rejected
      return openAIResponse('r', 0)
    })
    await provider.createMessage(baseRequest(source))
    await provider.createMessage(baseRequest(source))
    assert.deepEqual(payloads.map((payload) => 'prompt_cache_key' in payload), [true, false, false])
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('OpenRouter reasoning_details are merged, returned, and replayed only to the model that wrote them', async () => {
  const source = 'agent:openai-reasoning-details-test'
  resetCacheBreakDetection(source)
  try {
    const provider = new OpenAIProvider({ provider: 'openai', model: 'google/gemini', apiKey: 'k' })
    requestPayloads(provider, 'https://openrouter.ai/api/v1', () => [
      chunk({ reasoning: 'a', reasoning_details: [{ type: 'reasoning.text', text: 'a', index: 0 }] }),
      chunk({ reasoning: 'b', reasoning_details: [{ type: 'reasoning.text', text: 'b', index: 0 }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque', index: 1 }] }),
      chunk({ content: 'done' }, 'stop'),
    ])
    const response = await provider.createMessage({ ...baseRequest(source), model: 'google/gemini' })
    assert.deepEqual(response.reasoningDetails, [
      { type: 'reasoning.text', text: 'ab', index: 0 },
      { type: 'reasoning.encrypted', data: 'opaque', index: 1 },
    ])

    const history = (model: string): ModelRequest => ({
      ...baseRequest(source),
      model,
      messages: [
        { id: 'u1', role: 'user', content: 'q', createdAt: imageCreatedAt },
        {
          id: 'a1', role: 'assistant', content: 'done', createdAt: imageCreatedAt, model: 'google/gemini',
          reasoningContent: 'ab', reasoningDetails: response.reasoningDetails,
        },
        { id: 'u2', role: 'user', content: 'next', createdAt: imageCreatedAt },
      ],
    })
    const same = buildOpenAIMessages(history('google/gemini'))[2] as unknown as Record<string, unknown>
    assert.deepEqual(same.reasoning_details, response.reasoningDetails)
    assert.equal('reasoning_content' in same, false)
    const other = buildOpenAIMessages(history('openai/gpt-5'))[2] as unknown as Record<string, unknown>
    assert.equal('reasoning_details' in other, false)
    assert.equal(other.reasoning_content, 'ab')
  } finally {
    resetCacheBreakDetection(source)
  }
})

test('history is tidied for strict servers', () => {
  const at = imageCreatedAt
  const request: ModelRequest = {
    ...baseRequest('agent:openai-history-test'),
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'q', createdAt: at } },
      { kind: 'message', message: { id: 'a0', role: 'assistant', content: '', createdAt: at } },
      { kind: 'message', message: { id: 'a1', role: 'assistant', content: '', createdAt: at } },
      { kind: 'tool_use', id: 'call_1', tool: 'Read', input: { file_path: 'a' } },
      { kind: 'tool_result', toolUseId: 'call_1', tool: 'Read', ok: true, content: 'text' },
      { kind: 'message', message: { id: 'a2', role: 'assistant', content: 'ok', createdAt: at } },
    ] as ModelRequest['contextItems'],
  }
  const payload = buildOpenAIPayload(request, {
    compat: { official: false, thinkingFormat: 'deepseek', reasoningContentOnAssistant: true },
    thinking: 'on',
  })
  const roles = payload.messages.map((message) => message.role)
  // The empty interrupted assistant is gone; the one carrying a tool call stays.
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant'])
  // No tools offered, but the history holds a call.
  assert.deepEqual((payload as { tools?: unknown[] }).tools, [])
  // DeepSeek thinking mode: every assistant message carries the field.
  for (const message of payload.messages.filter((message) => message.role === 'assistant')) {
    assert.equal((message as { reasoning_content?: string }).reasoning_content, '')
  }
})

test('a silent stream warns, then is aborted as a transient idle timeout', async () => {
  const controller = new AbortController()
  const silent = {
    controller,
    async *[Symbol.asyncIterator]() {
      yield 'first'
      await new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    },
  }
  const items: unknown[] = []
  const events: string[] = []
  await assert.rejects(
    consumeWithIdleTimeout(silent, (item) => items.push(item), (event) => events.push(event.type), 40, 10),
    (error: Error) => error.message === 'Stream idle timeout' && classifyError(error) === 'transient',
  )
  assert.deepEqual(items, ['first'])
  assert.deepEqual(events, ['idle_warning'])
})
