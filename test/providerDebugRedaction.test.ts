import test from 'node:test'
import assert from 'node:assert/strict'
import type { ModelRequest } from '../src/harness/types.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import { debugProviderPayload, debugProviderSummary } from '../src/config/providers/debug.js'

/**
 * S19, design §13: `debugProviderPayload` used to serialize the whole payload,
 * which since S17/S18 can carry base64 image bodies. It must redact them and
 * log attachment facts (MIME, dimensions, byte count, attachment id) instead —
 * the debug stream may end up in user-shared logs.
 */

function ref(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id,
    ownerSessionId: 's19-debug',
    name: `${id}.png`,
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    byteLength: 100_857,
    ...overrides,
  }
}

function captureConsole(fn: () => void): string[] {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    fn()
  } finally {
    console.error = original
  }
  return lines
}

function imageRequest(refs: ImageAttachmentRef[]): ModelRequest {
  return {
    model: 'test-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'look at this',
      images: refs,
      createdAt: '2026-09-09T00:00:00.000Z',
    }],
    cacheSource: 'agent:debug-redaction-test',
    imageBytes: new Map(refs.map((image) => [
      image.id,
      { bytes: new Uint8Array(image.byteLength), mimeType: 'image/png' },
    ])),
  }
}

test('debugProviderPayload redacts base64 image data and logs attachment facts instead', () => {
  process.env.HANEKAWA_DEBUG_PROVIDER = '1'
  try {
    const shot = ref('img-shot', { name: 'shot.png', mimeType: 'image/jpeg' })
    const diagram = ref('img-diagram')
    const request = imageRequest([shot, diagram])
    const base64 = Buffer.from(new Uint8Array(16)).toString('base64')
    const payload = {
      model: 'test-model',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ] },
      ],
    }
    const payloadSnapshot = JSON.parse(JSON.stringify(payload))

    const lines = captureConsole(() => debugProviderPayload('anthropic', payload, request))
    const output = lines.join('\n')

    assert.ok(output.includes('[hanekawa][provider:anthropic] payload'), 'the payload line still logs')
    assert.ok(!output.includes(base64), 'no base64 body anywhere in the debug output')
    assert.match(output, /"media_type": "image\/jpeg"/, 'the MIME is kept')
    assert.match(output, /<redacted base64: \d+ chars, ~\d+ bytes>/, 'the data field states its size')
    assert.match(output, /base64,<redacted \d+ chars/, 'the data URL keeps its prefix and redacts the body')

    assert.ok(output.includes('[hanekawa][provider:anthropic] payload images'), 'the facts line logs')
    assert.match(output, /"attachmentId": "img-shot"/)
    assert.match(output, /"name": "shot\.png"/)
    assert.match(output, /"mimeType": "image\/jpeg"/)
    assert.match(output, /"width": 1920/)
    assert.match(output, /"height": 1080/)
    assert.match(output, /"byteLength": 100857/)
    assert.match(output, /"loadedByteLength": 100857/)

    // The payload object itself was not mutated by the redaction walk.
    assert.deepEqual(payload, payloadSnapshot)
  } finally {
    delete process.env.HANEKAWA_DEBUG_PROVIDER
  }
})

test('debugProviderPayload without images logs the payload as-is, with no facts line', () => {
  process.env.HANEKAWA_DEBUG_PROVIDER = '1'
  try {
    const lines = captureConsole(() => debugProviderPayload('openai', { model: 'm', messages: [] }))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /\[hanekawa\]\[provider:openai\] payload/)
  } finally {
    delete process.env.HANEKAWA_DEBUG_PROVIDER
  }
})

test('debugProviderPayload stays silent unless the debug env var is set', () => {
  delete process.env.HANEKAWA_DEBUG_PROVIDER
  const lines = captureConsole(() => debugProviderPayload('anthropic', { model: 'm' }, imageRequest([ref('img-silent')])))
  assert.equal(lines.length, 0)
})

test('debugProviderSummary previews image blocks as mime labels, never their data', () => {
  process.env.HANEKAWA_DEBUG_PROVIDER = '1'
  try {
    const base64 = Buffer.from(new Uint8Array(8)).toString('base64')
    const request = imageRequest([ref('img-shot')])
    const lines = captureConsole(() => debugProviderSummary('anthropic', request, {
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: base64 } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ] },
      ],
    }))
    const output = lines.join('\n')
    assert.ok(!output.includes(base64))
    assert.match(output, /image:image\/webp/)
    assert.match(output, /image_url:image\/png/)
  } finally {
    delete process.env.HANEKAWA_DEBUG_PROVIDER
  }
})
