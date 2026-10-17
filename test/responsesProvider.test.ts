import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { ResponsesProvider } from '../src/config/providers/responsesProvider.js'
import { buildResponsesPayload } from '../src/config/providers/responsesPayload.js'
import { createProvider, resolveImageCapability } from '../src/config/providers/registry.js'
import { classifyError } from '../src/config/retry.js'
import { resetCacheBreakDetection } from '../src/harness/cacheBreakDetection.js'
import type { ModelContextItem, ModelRequest, Tool } from '../src/harness/types.js'
import type { ImageAttachmentRef } from '../src/media/types.js'

const at = '2026-10-16T00:00:00.000Z'
const SOURCE = 'agent:responses-test'

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    cacheSource: SOURCE,
    model: 'gpt-x',
    system: 'be brief',
    messages: [{ id: 'u1', role: 'user', content: 'hello', createdAt: at }],
    retry: { maxRetries: 0 },
    ...overrides,
  }
}

const readTool: Tool = {
  name: 'Read',
  description: 'read a file',
  inputSchema: z.object({ file_path: z.string(), limit: z.number().optional() }),
  riskLevel: 'safe',
  execute: async () => ({ ok: true, content: '' }),
}

function imageRef(id: string): ImageAttachmentRef {
  return { id, name: `${id}.png`, mimeType: 'image/png', width: 1, height: 1, byteSize: 1, sha256: id, source: 'paste' } as unknown as ImageAttachmentRef
}

interface FinalShape {
  status?: 'completed' | 'incomplete'
  reason?: string
  output: unknown[]
  usage?: Record<string, unknown>
}

function finalResponse(shape: FinalShape): Record<string, unknown> {
  return {
    id: 'resp_1',
    status: shape.status ?? 'completed',
    incomplete_details: shape.reason ? { reason: shape.reason } : null,
    output: shape.output,
    usage: shape.usage ?? { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2 },
  }
}

function install(
  provider: ResponsesProvider,
  respond: (payload: Record<string, unknown>) => unknown[],
  baseURL = 'https://api.openai.com/v1',
  responseHeaders: Record<string, string> = {},
): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = []
  ;(provider as unknown as { client: unknown }).client = {
    baseURL,
    responses: {
      create: (payload: Record<string, unknown>, options?: { headers?: Record<string, string> }) => ({
        withResponse: async () => {
          payloads.push({ ...payload, headers: options?.headers })
          const events = respond(payload)
          return {
            data: {
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                yield* events
              },
            },
            response: new Response(null, { headers: responseHeaders }),
          }
        },
      }),
    },
  }
  return payloads
}

const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'enc' }
const messageItem = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Reading.', annotations: [] }] }
const callItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.ts"}' }

test('the payload uses instructions, non-strict tools, store: false and reasoning only when on', () => {
  const on = buildResponsesPayload(request({ tools: [readTool], maxOutputTokens: 500, effort: 'xhigh' }), { thinking: 'on', cacheKey: true })
  assert.equal(on.instructions, 'be brief')
  assert.deepEqual(on.input, [{ role: 'user', content: 'hello' }])
  assert.equal(on.stream, true)
  assert.equal(on.store, false)
  assert.equal(on.max_output_tokens, 500)
  assert.equal(on.tools?.[0]?.strict, false)
  assert.equal(on.tools?.[0]?.name, 'Read')
  assert.deepEqual(on.reasoning, { effort: 'xhigh', summary: 'auto' })
  assert.deepEqual(on.include, ['reasoning.encrypted_content'])
  assert.match(String(on.prompt_cache_key), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

  for (const thinking of ['off', undefined] as const) {
    const payload = buildResponsesPayload(request(), { thinking }) as Record<string, unknown>
    assert.equal('reasoning' in payload, false)
    assert.equal('include' in payload, false)
    assert.equal(JSON.stringify(payload).includes('prompt_cache'), false, 'no cache key once refused')
  }
})

test('history maps to input items; tool images ride inside the function output', () => {
  const ref = imageRef('shot')
  const contextItems: ModelContextItem[] = [
    { kind: 'message', message: { id: 'u1', role: 'user', content: 'look', images: [imageRef('pic')], createdAt: at } },
    { kind: 'message', message: { id: 'a1', role: 'assistant', content: '', createdAt: at } },
    { kind: 'tool_use', id: 'call_1', tool: 'Screenshot', input: {} },
    { kind: 'tool_result', toolUseId: 'call_1', tool: 'Screenshot', ok: true, content: 'taken', images: [ref] },
    { kind: 'message', message: { id: 'a2', role: 'assistant', content: 'Done.', createdAt: at } },
  ]
  const bytes = { bytes: new Uint8Array([1]), mimeType: 'image/png' as const }
  const payload = buildResponsesPayload(request({
    contextItems,
    imageBytes: new Map([['pic', bytes], ['shot', bytes]]),
  }))
  assert.deepEqual(payload.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AQ==', detail: 'auto' }] },
    { type: 'function_call', call_id: 'call_1', name: 'Screenshot', arguments: '{}' },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: [{ type: 'input_text', text: 'taken' }, { type: 'input_image', image_url: 'data:image/png;base64,AQ==', detail: 'auto' }],
    },
    { role: 'assistant', content: 'Done.' },
  ])
})

test('kept output items go back verbatim to the same model only, and only with all their calls present', () => {
  const history = (model: string, withToolUse = true): ModelRequest => request({
    model,
    contextItems: [
      { kind: 'message', message: { id: 'u1', role: 'user', content: 'q', createdAt: at } },
      {
        kind: 'message',
        message: { id: 'a1', role: 'assistant', content: 'Reading.', createdAt: at, model: 'gpt-x', responseItems: [reasoningItem, messageItem, callItem] },
      },
      ...(withToolUse
        ? [
            { kind: 'tool_use', id: 'call_1', tool: 'Read', input: { file_path: 'a.ts' } },
            { kind: 'tool_result', toolUseId: 'call_1', tool: 'Read', ok: true, content: 'x' },
          ] as ModelContextItem[]
        : []),
    ],
  })

  assert.deepEqual(buildResponsesPayload(history('gpt-x')).input.slice(1), [
    reasoningItem, messageItem, callItem,
    { type: 'function_call_output', call_id: 'call_1', output: 'x' },
  ])
  const rebuilt = [
    { role: 'assistant', content: 'Reading.' },
    { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'x' },
  ]
  assert.deepEqual(buildResponsesPayload(history('gpt-y')).input.slice(1), rebuilt)
  // A call the history no longer holds (repaired away) cannot be replayed without its output.
  assert.deepEqual(buildResponsesPayload(history('gpt-x', false)).input.slice(1), [{ role: 'assistant', content: 'Reading.' }])
})

test('a streamed reply emits live events and is read off the terminal response', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k' })
  install(provider, () => [
    { type: 'response.created', response: {} },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Reading.' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'Read' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"file_path":"a.ts"}' },
    {
      type: 'response.completed',
      response: finalResponse({
        output: [reasoningItem, messageItem, callItem],
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 }, output_tokens: 20 },
      }),
    },
  ])
  const events: string[] = []
  const response = await provider.createMessage(request({ onStreamEvent: (event) => events.push(event.type) }))
  resetCacheBreakDetection(SOURCE)

  assert.deepEqual(events, [
    'message_start', 'thinking_start', 'thinking_delta', 'thinking_stop', 'text_delta', 'tool_input_delta', 'message_stop',
  ])
  assert.equal(response.content, 'Reading.')
  assert.deepEqual(response.toolCalls, [{ id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } }])
  assert.equal(response.reasoningContent, 'plan')
  assert.deepEqual(response.responseItems, [reasoningItem, messageItem, callItem])
  assert.equal(response.stopReason, 'tool_calls')
  assert.deepEqual(response.usage, { inputTokens: 300, cacheCreationInputTokens: 100, cacheReadInputTokens: 600, outputTokens: 20 })
})

test('a reply without reasoning keeps no output items', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k' })
  install(provider, () => [{ type: 'response.completed', response: finalResponse({ output: [messageItem] }) }])
  const response = await provider.createMessage(request())
  resetCacheBreakDetection(SOURCE)
  assert.equal(response.responseItems, undefined)
  assert.equal(response.stopReason, 'stop')
})

test('the conversation id is the cache key and the Codex session headers', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k' })
  const payloads = install(provider, () => [{ type: 'response.completed', response: finalResponse({ output: [messageItem] }) }], 'https://relay.example/v1')
  await provider.createMessage(request({ promptCacheKey: 'session-1' }))
  await provider.createMessage(request())
  await provider.createMessage(request())
  resetCacheBreakDetection(SOURCE)
  const [own, first, second] = payloads
  assert.equal(own?.prompt_cache_key, 'session-1')
  assert.deepEqual(own?.headers, { 'session-id': 'session-1', 'thread-id': 'session-1', 'x-client-request-id': 'session-1' })
  // Outside a conversation the id comes from the prompt prefix, so it holds.
  assert.match(String(first?.prompt_cache_key), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(second?.prompt_cache_key, first?.prompt_cache_key)
})

test('the sticky-routing token goes back for the rest of its turn only', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k' })
  const payloads = install(provider, () => [{ type: 'response.completed', response: finalResponse({ output: [messageItem] }) }], 'https://relay.example/v1', { 'x-codex-turn-state': 'tok' })
  await provider.createMessage(request({ promptCacheKey: 's', turnId: 't1' }))
  await provider.createMessage(request({ promptCacheKey: 's', turnId: 't1' }))
  await provider.createMessage(request({ promptCacheKey: 's', turnId: 't2' }))
  await provider.createMessage(request({ promptCacheKey: 'other', turnId: 't2' }))
  resetCacheBreakDetection(SOURCE)
  const tokens = payloads.map((payload) => (payload.headers as Record<string, string>)['x-codex-turn-state'])
  assert.deepEqual(tokens, [undefined, 'tok', undefined, undefined])
})

test('terminal states: truncation is max_tokens, everything else that is not complete is an error', async () => {
  const run = async (events: unknown[]) => {
    resetCacheBreakDetection(SOURCE)
    const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k' })
    install(provider, () => events)
    try {
      return await provider.createMessage(request())
    } finally {
      resetCacheBreakDetection(SOURCE)
    }
  }
  const truncated = await run([{ type: 'response.incomplete', response: finalResponse({ status: 'incomplete', reason: 'max_output_tokens', output: [] }) }])
  assert.equal(truncated.stopReason, 'max_tokens')

  await assert.rejects(
    run([{ type: 'response.incomplete', response: finalResponse({ status: 'incomplete', reason: 'content_filter', output: [] }) }]),
    /Response incomplete: content_filter/,
  )
  await assert.rejects(
    run([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }]),
    /Response failed: server_error boom/,
  )
  await assert.rejects(run([{ type: 'response.created', response: {} }]), (error: Error) =>
    /Stream ended/.test(error.message) && classifyError(error) === 'transient')
})

test('a stream that fails on prompt_cache_key is sent again without it', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-key-test', apiKey: 'k' })
  const payloads = install(provider, (payload) => 'prompt_cache_key' in payload
    ? [{ type: 'response.failed', response: { error: { code: 'invalid_parameter', message: 'prompt_cache_key is not supported on this model' } } }]
    : [{ type: 'response.completed', response: finalResponse({ output: [messageItem] }) }], 'https://relay.example/v1')
  await provider.createMessage(request({ model: 'gpt-key-test' }))
  resetCacheBreakDetection(SOURCE)
  assert.deepEqual(payloads.map((payload) => 'prompt_cache_key' in payload), [true, false])
  assert.ok(payloads[1]?.headers, 'the session headers stay')
})

test('a model that rejects reasoning is sent again without reasoning or include, and remembered', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-4.1', apiKey: 'k' })
  const rejected = Object.assign(new Error("400 Unsupported parameter: 'reasoning.effort' is not supported with this model."), { status: 400 })
  const payloads = install(provider, (payload) => {
    if ('reasoning' in payload) throw rejected
    return [{ type: 'response.completed', response: finalResponse({ output: [messageItem] }) }]
  }, 'https://reject-reasoning.example/v1')
  await provider.createMessage(request({ model: 'gpt-4.1', effort: 'high' }))
  await provider.createMessage(request({ model: 'gpt-4.1', effort: 'high' }))
  resetCacheBreakDetection(SOURCE)
  assert.deepEqual(payloads.map((payload) => ['reasoning' in payload, 'include' in payload]), [[true, true], [false, false], [false, false]])
})

test('the model thinking switch sends no reasoning at all', async () => {
  resetCacheBreakDetection(SOURCE)
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k', thinking: { type: 'disabled' } })
  const payloads = install(provider, () => [{ type: 'response.completed', response: finalResponse({ output: [messageItem] }) }])
  await provider.createMessage(request({ effort: 'high' }))
  resetCacheBreakDetection(SOURCE)
  assert.equal('reasoning' in payloads[0]!, false)
})

test('the registry builds the Responses adapter and reports its image capability', () => {
  assert.ok(createProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k' }) instanceof ResponsesProvider)
  assert.equal(resolveImageCapability({ provider: 'openai-responses', supportsImageInput: true }), true)
})

test('input_image parts count against the per-request image cap', async () => {
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'k', supportsImageInput: true })
  ;(provider as unknown as { maxImagesPerRequest: () => number }).maxImagesPerRequest = () => 1
  const payloads = install(provider, () => [])
  const bytes = { bytes: new Uint8Array([1]), mimeType: 'image/png' as const }
  await assert.rejects(provider.createMessage(request({
    messages: [{ id: 'u1', role: 'user', content: 'two', images: [imageRef('a'), imageRef('b')], createdAt: at }],
    imageBytes: new Map([['a', bytes], ['b', bytes]]),
  })), (error: Error & { imageInputBlock?: string }) => error.imageInputBlock === 'too-many-images')
  assert.equal(payloads.length, 0)
})
