import test from 'node:test'
import assert from 'node:assert/strict'
import type { ModelRequest } from '../src/harness/types.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import {
  MAX_IMAGE_SEND_BYTES,
  MAX_REQUEST_BODY_BYTES,
  IMAGE_BLOCK_OVERHEAD_BYTES,
  estimateImageBlockBytes,
  resolveMaxImageBytes,
  resolveMaxRequestBodyBytes,
} from '../src/media/imageRequestLimits.js'
import {
  assertFinalImageRequestLimits,
  assertRequestImageCapability,
  collectRequestImageRefs,
  formatProviderCapabilityBlockedMessage,
  redactImageBytesFromText,
  resolveImageRequestGuardLimits,
} from '../src/config/providers/imageRequestGuard.js'
import { TurnImageBlockError } from '../src/harness/turnImages.js'

function ref(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id,
    ownerSessionId: 's19',
    name: `${id}.png`,
    mimeType: 'image/png',
    width: 64,
    height: 48,
    byteLength: 96,
    ...overrides,
  }
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'test-model',
    messages: [],
    cacheSource: 'agent:guard-test',
    ...overrides,
  }
}

const limits = { maxImages: 100, maxImageBytes: MAX_IMAGE_SEND_BYTES, maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES }

// --- limit resolution ---------------------------------------------------------

test('per-image and request-body limits take the stricter of local and adapter', () => {
  assert.equal(MAX_IMAGE_SEND_BYTES, 3_750_000)
  assert.equal(MAX_REQUEST_BODY_BYTES, 15_000_000)

  assert.equal(resolveMaxImageBytes(undefined), 3_750_000)
  assert.equal(resolveMaxImageBytes(1_000_000), 1_000_000, 'a lower adapter limit wins')
  assert.equal(resolveMaxImageBytes(50_000_000), 3_750_000, 'a higher adapter limit never loosens the local cap')
  assert.equal(resolveMaxImageBytes(-5), 0)
  assert.equal(resolveMaxImageBytes(3.9), 3)
  assert.equal(resolveMaxImageBytes(Number.NaN), 3_750_000)

  assert.equal(resolveMaxRequestBodyBytes(undefined), 15_000_000)
  assert.equal(resolveMaxRequestBodyBytes(10_000_000), 10_000_000)
  assert.equal(resolveMaxRequestBodyBytes(90_000_000), 15_000_000)
  assert.equal(resolveMaxRequestBodyBytes(Number.NaN), 15_000_000)

  const resolved = resolveImageRequestGuardLimits({
    name: 'fake',
    createMessage: async () => ({ content: '', toolCalls: [] }),
    maxImagesPerRequest: () => 7,
    maxImageBytes: () => 1_000,
    maxRequestBodyBytes: () => 5_000,
  })
  assert.deepEqual(resolved, { maxImages: 7, maxImageBytes: 1_000, maxRequestBodyBytes: 5_000 })
  assert.deepEqual(
    resolveImageRequestGuardLimits({ name: 'fake', createMessage: async () => ({ content: '', toolCalls: [] }) }),
    { maxImages: 100, maxImageBytes: 3_750_000, maxRequestBodyBytes: 15_000_000 },
  )
})

test('the per-occurrence estimate is base64 size plus block overhead, from metadata only', () => {
  assert.equal(estimateImageBlockBytes({ ...ref('x'), byteLength: 3000 }), 4 * 1000 + IMAGE_BLOCK_OVERHEAD_BYTES)
  // Uneven byte lengths round the base64 length up.
  assert.equal(estimateImageBlockBytes({ ...ref('x'), byteLength: 1 }), 4 * 1 + IMAGE_BLOCK_OVERHEAD_BYTES)
})

// --- ref collection -----------------------------------------------------------

test('collectRequestImageRefs reads messages and contextItems, unique by id', () => {
  const shot = ref('img-shot')
  const diagram = ref('img-diagram')
  const collected = collectRequestImageRefs(request({
    messages: [{ id: 'm1', role: 'user', content: 'a', images: [shot], createdAt: '2026-09-09T00:00:00Z' }],
    contextItems: [
      { kind: 'message', message: { id: 'm2', role: 'user', content: 'b', images: [shot, diagram], createdAt: '2026-09-09T00:00:00Z' } },
      { kind: 'tool_result', toolUseId: 'c1', tool: 'Read', ok: true, content: 'saw', images: [diagram] },
      { kind: 'tool_use', id: 'c1', tool: 'Read', input: {} },
    ],
  }))
  assert.deepEqual(collected, [shot, diagram])
  assert.deepEqual(collectRequestImageRefs(request()), [])
})

// --- capability re-check ------------------------------------------------------

test('the provider capability check only fires for image-bearing requests', () => {
  assert.doesNotThrow(() => assertRequestImageCapability(request(), false))
  const bearing = request({
    messages: [{ id: 'm1', role: 'user', content: 'a', images: [ref('img-1')], createdAt: '2026-09-09T00:00:00Z' }],
  })
  assert.doesNotThrow(() => assertRequestImageCapability(bearing, true))
  assert.throws(
    () => assertRequestImageCapability(bearing, false),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'model-not-capable'
        && error.images.length === 1
        && /not enabled for image input/.test(error.message)
        && /img-1\.png/.test(error.message),
  )
  assert.match(
    formatProviderCapabilityBlockedMessage('m1', [ref('img-1')]),
    /Enable this model's image capability switch/,
  )
})

// --- the three-layer final check ---------------------------------------------

test('layer 1: one oversized image rejects with a distinguishable reason', () => {
  const big = ref('img-big', { name: 'big.png' })
  assert.throws(
    () => assertFinalImageRequestLimits(
      { messages: [] },
      request({
        messages: [{ id: 'm1', role: 'user', content: 'a', images: [big], createdAt: '2026-09-09T00:00:00Z' }],
        imageBytes: new Map([['img-big', { bytes: new Uint8Array(3_750_001), mimeType: 'image/png' }]]),
      }),
      limits,
    ),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'image-too-large'
        && /big\.png/.test(error.message)
        && /Crop the image/.test(error.message),
  )
  // At exactly the limit it passes.
  assert.doesNotThrow(() => assertFinalImageRequestLimits(
    { messages: [] },
    request({
      messages: [{ id: 'm1', role: 'user', content: 'a', images: [big], createdAt: '2026-09-09T00:00:00Z' }],
      imageBytes: new Map([['img-big', { bytes: new Uint8Array(3_750_000), mimeType: 'image/png' }]]),
    }),
    limits,
  ))
})

test('layer 2: the mapped payload image count is re-verified', () => {
  const twoBlocks = {
    messages: [
      { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      ] },
    ],
  }
  assert.doesNotThrow(() => assertFinalImageRequestLimits(twoBlocks, request(), { ...limits, maxImages: 2 }))
  assert.throws(
    () => assertFinalImageRequestLimits(twoBlocks, request(), { ...limits, maxImages: 1 }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'too-many-images'
        && /2 image blocks/.test(error.message)
        && /at most 1 are allowed/.test(error.message),
  )
  // OpenAI-style parts count through the same walker.
  const openAIPayload = {
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
      ] },
    ],
  }
  assert.throws(
    () => assertFinalImageRequestLimits(openAIPayload, request(), { ...limits, maxImages: 1 }),
    (error: unknown) => error instanceof TurnImageBlockError && error.imageInputBlock === 'too-many-images',
  )
  // A tool schema naming an image-ish shape does not count.
  assert.doesNotThrow(() => assertFinalImageRequestLimits(
    { tools: [{ name: 'T', input_schema: { type: 'object', properties: { shot: { type: 'image' } } } }] },
    request(),
    { ...limits, maxImages: 0 },
  ))
})

test('layer 3: the whole serialized body is checked, naming the image share', () => {
  const image = ref('img-1')
  const textOnlyPayload = { model: 'm', system: 'x'.repeat(500) }
  assert.throws(
    () => assertFinalImageRequestLimits(textOnlyPayload, request(), { ...limits, maxRequestBodyBytes: 200 }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'request-too-large'
        && /serialized request body is/.test(error.message)
        && /no images, so its text alone is over the limit/.test(error.message),
  )

  assert.throws(
    () => assertFinalImageRequestLimits(
      { model: 'm', system: 'x'.repeat(500) },
      request({
        messages: [{ id: 'm1', role: 'user', content: 'a', images: [image], createdAt: '2026-09-09T00:00:00Z' }],
        imageBytes: new Map([['img-1', { bytes: new Uint8Array(60), mimeType: 'image/png' }]]),
      }),
      { ...limits, maxRequestBodyBytes: 200 },
    ),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'request-too-large'
        && /of those are image data/.test(error.message)
        && /Send fewer or smaller images/.test(error.message),
  )
})

// --- error-text redaction ------------------------------------------------------

test('image bodies are redacted from text that will surface in errors', () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(120)}`
  assert.equal(
    redactImageBytesFromText(`Invalid: ${dataUrl} not allowed`),
    'Invalid: [redacted image data] not allowed',
  )
  const longRun = 'aB+/='.repeat(120)
  assert.equal(
    redactImageBytesFromText(`echoed: ${longRun} end`),
    'echoed: [redacted image data] end',
  )
  // Short, legitimate content survives: checksums, ids, words.
  const checksum = 'd41d8cd98f00b204e9800998ecf8427e'
  assert.equal(redactImageBytesFromText(`sha256: ${checksum}`), `sha256: ${checksum}`)
  assert.equal(redactImageBytesFromText('plain error'), 'plain error')
  assert.equal(redactImageBytesFromText('data:image/png;base64,QUJD'), 'data:image/png;base64,QUJD')
})
