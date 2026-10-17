import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import type { SessionRecord, Tool } from '../src/harness/types.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import {
  assertInputImagesWithinRequestBody,
  DEFAULT_MAX_MEDIA_ITEMS,
  estimateRequestTextBytes,
  formatImageByteStripNotice,
  formatMediaStripNotice,
  formatTooManyImagesBlockedMessage,
  resolveMaxMediaItems,
  stripExcessImageBytes,
  stripExcessMediaItems,
} from '../src/harness/mediaStrip.js'
import { TurnImageBlockError } from '../src/harness/turnImages.js'

function image(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    id,
    ownerSessionId: 's1',
    name: `${id}.png`,
    mimeType: 'image/png',
    width: 64,
    height: 64,
    byteLength: 1000,
    ...overrides,
  }
}

function historyMessage(id: string, images: ImageAttachmentRef[], content = `message ${id}`): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'user',
    content,
    images,
    turnId: `turn-${id}`,
    createdAt: '2026-09-09T00:00:00.000Z',
  }
}

function historyToolResult(id: string, images: ImageAttachmentRef[]): SessionRecord {
  return {
    type: 'tool_result',
    id,
    toolUseId: `call-${id}`,
    tool: 'Read',
    ok: true,
    content: `read ${id}`,
    images,
    turnId: `turn-${id}`,
    createdAt: '2026-09-09T00:00:01.000Z',
  }
}

function currentTurnRecords(inputImages: ImageAttachmentRef[], toolImages: ImageAttachmentRef[]): SessionRecord[] {
  const records: SessionRecord[] = []
  if (toolImages.length > 0) {
    records.push(
      {
        type: 'tool_use',
        id: 'current-call',
        tool: 'Read',
        input: {},
        riskLevel: 'safe',
        turnId: 'turn-now',
        createdAt: '2026-09-09T00:00:10.000Z',
      },
      {
        type: 'tool_result',
        id: 'current-result',
        toolUseId: 'current-call',
        tool: 'Read',
        ok: true,
        content: 'read now',
        images: toolImages,
        turnId: 'turn-now',
        createdAt: '2026-09-09T00:00:11.000Z',
      },
    )
  }
  records.push({
    type: 'message',
    id: 'current-user',
    role: 'user',
    content: 'look at these',
    images: inputImages,
    turnId: 'turn-now',
    createdAt: '2026-09-09T00:00:09.000Z',
  })
  return records
}

// --- cap resolution ----------------------------------------------------------

test('resolveMaxMediaItems: the local cap applies, a lower adapter limit wins', () => {
  assert.equal(DEFAULT_MAX_MEDIA_ITEMS, 100)
  assert.equal(resolveMaxMediaItems(undefined), 100)
  assert.equal(resolveMaxMediaItems(500), 100, 'a higher adapter limit never loosens the local cap')
  assert.equal(resolveMaxMediaItems(5), 5)
  assert.equal(resolveMaxMediaItems(0), 0)
  assert.equal(resolveMaxMediaItems(-3), 0, 'nonsense degrades to zero, not to a negative cap')
  assert.equal(resolveMaxMediaItems(3.7), 3)
  assert.equal(resolveMaxMediaItems(Number.NaN), 100)
})

// --- under the cap -----------------------------------------------------------

test('within the cap nothing is stripped and the input array is returned as-is', () => {
  const records = [
    historyMessage('h1', [image('img-1')]),
    ...currentTurnRecords([image('img-cur')], [image('img-tool')]),
  ]
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 10,
  })
  assert.equal(result.records, records, 'identity: the same array reference, zero copying')
  assert.deepEqual(result.omittedImages, [])
  assert.equal(result.keptImageCount, 3)
  assert.equal(result.maxMediaItems, 10)
  assert.equal(result.signature, stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 10,
  }).signature, 'the signature is stable for the same state')
})

// --- over the cap: oldest history first --------------------------------------

test('over the cap the oldest historical images are omitted first', () => {
  const records = [
    historyMessage('h1', [image('img-1')]),
    historyMessage('h2', [image('img-2')]),
    historyMessage('h3', [image('img-3')]),
    ...currentTurnRecords([image('img-cur')], [image('img-tool')]),
  ]
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 3,
  })
  // 5 images, cap 3: the two oldest history records lose theirs; both the
  // current input's and the current turn's tool image survive.
  assert.deepEqual(
    result.omittedImages.map((omitted) => omitted.refId),
    ['img-1', 'img-2'],
  )
  assert.ok(result.omittedImages.every((omitted) => omitted.historical))
  assert.equal(result.keptImageCount, 3)

  const omittedFirst = result.records.find((record) => record.id === 'h1')
  assert.equal(omittedFirst?.type, 'message')
  assert.equal(
    omittedFirst?.type === 'message' ? omittedFirst.content : undefined,
    'message h1\n\n[Historical image omitted to stay within the 3-image request limit: '
      + 'img-1.png (attachment img-1). The pixels are not present in this request.]',
  )
  // A record whose images were all omitted loses the key entirely.
  assert.equal(omittedFirst?.type === 'message' ? omittedFirst.images : 'kept', undefined)
  const keptHistory = result.records.find((record) => record.id === 'h3')
  assert.deepEqual(keptHistory?.type === 'message' ? keptHistory.images : undefined, [image('img-3')])
  const currentInput = result.records.find((record) => record.id === 'current-user')
  assert.deepEqual(currentInput?.type === 'message' ? currentInput.images : undefined, [image('img-cur')])
})

test('the strip is a pure projection: the input records are never mutated', () => {
  const records = [
    historyMessage('h1', [image('img-1'), image('img-2')]),
    ...currentTurnRecords([image('img-cur')], []),
  ]
  const snapshot = JSON.parse(JSON.stringify(records))
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 1,
  })
  assert.equal(result.omittedImages.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(records)), snapshot)
})

test('a record with several images keeps the ones that fit', () => {
  const records = [
    historyMessage('h1', [image('img-1'), image('img-2'), image('img-3')]),
    ...currentTurnRecords([], []),
  ]
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 2,
  })
  assert.deepEqual(result.omittedImages.map((omitted) => omitted.refId), ['img-1'])
  const record = result.records.find((entry) => entry.id === 'h1')
  assert.deepEqual(record?.type === 'message' ? record.images : undefined, [image('img-2'), image('img-3')])
  assert.match(
    record?.type === 'message' ? record.content : '',
    /\[Historical image omitted to stay within the 2-image request limit: img-1\.png/,
  )
})

test('the same attachment appearing twice is two occurrences; the older one goes first', () => {
  const shared = image('img-shared')
  const records = [
    historyToolResult('h1', [shared]),
    historyToolResult('h2', [shared]),
    ...currentTurnRecords([], []),
  ]
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 1,
  })
  assert.deepEqual(result.omittedImages.map((omitted) => omitted.recordId), ['h1'])
  const older = result.records.find((record) => record.id === 'h1')
  const newer = result.records.find((record) => record.id === 'h2')
  assert.equal(older?.type === 'tool_result' ? older.images : undefined, undefined)
  assert.deepEqual(newer?.type === 'tool_result' ? newer.images : undefined, [shared])
})

// --- current-turn protection --------------------------------------------------

test('current-turn tool images are omitted only once every historical image has been', () => {
  const records = [
    historyMessage('h1', [image('img-hist')]),
    ...currentTurnRecords([image('img-cur-input')], [image('img-tool-1'), image('img-tool-2')]),
  ]
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 2,
  })
  // 4 images, cap 2: history first, then the oldest current-turn tool image;
  // the input's own image is never the one dropped.
  assert.deepEqual(
    result.omittedImages.map((omitted) => omitted.refId),
    ['img-hist', 'img-tool-1'],
  )
  assert.deepEqual(
    result.omittedImages.map((omitted) => omitted.historical),
    [true, false],
  )
  const currentInput = result.records.find((record) => record.id === 'current-user')
  assert.deepEqual(currentInput?.type === 'message' ? currentInput.images : undefined, [image('img-cur-input')])
  const toolResult = result.records.find((record) => record.id === 'current-result')
  assert.deepEqual(toolResult?.type === 'tool_result' ? toolResult.images : undefined, [image('img-tool-2')])
  assert.match(
    toolResult?.type === 'tool_result' ? toolResult.content : '',
    /\[Image omitted to stay within the 2-image request limit: img-tool-1\.png/,
    'current-turn omissions say so, without the historical qualifier',
  )
})

test('an input that alone exceeds the cap is blocked, not silently trimmed', () => {
  const records = [
    historyMessage('h1', [image('img-hist')]),
    ...currentTurnRecords([image('in-1'), image('in-2'), image('in-3')], []),
  ]
  assert.throws(
    () => stripExcessMediaItems(records, {
      currentTurnId: 'turn-now',
      currentUserMessageId: 'current-user',
      maxMediaItems: 2,
    }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'too-many-images'
        && error.images.length === 3
        && /3 images/.test(error.message)
        && /at most 2 per request/.test(error.message),
  )
})

test('without a current turn every image is omittable history', () => {
  const records = [
    historyMessage('h1', [image('img-1')]),
    historyMessage('h2', [image('img-2')]),
  ]
  const result = stripExcessMediaItems(records, { maxMediaItems: 1 })
  assert.deepEqual(result.omittedImages.map((omitted) => omitted.refId), ['img-1'])
  assert.equal(result.keptImageCount, 1)
})

test('diagnostics name each omission and feed the notice', () => {
  const records = [
    historyMessage('h1', [image('img-1', { name: 'screenshot.png' })]),
    ...currentTurnRecords([], []),
  ]
  const result = stripExcessMediaItems(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxMediaItems: 0,
  })
  assert.deepEqual(result.omittedImages, [
    { refId: 'img-1', name: 'screenshot.png', recordId: 'h1', historical: true },
  ])
  assert.equal(result.keptImageCount, 0)

  const notice = formatMediaStripNotice(2, 5)
  assert.match(notice, /limit of 5 images/)
  assert.match(notice, /2 of the oldest images/)
  assert.match(notice, /originals are kept/)

  const blocked = formatTooManyImagesBlockedMessage(4, 3)
  assert.match(blocked, /4 images/)
  assert.match(blocked, /at most 3 per request/)
  assert.match(blocked, /Remove it and resend/)
})

test('a cap of zero with no images at all is a valid empty request', () => {
  const records = [historyMessage('h1', [], 'text only')]
  const result = stripExcessMediaItems(records, { maxMediaItems: 0 })
  assert.equal(result.records, records)
  assert.equal(result.keptImageCount, 0)
})

// --- request-size budget (S19, design §11.1 step 3, volume half) --------------

// byteLength 3000 → 4 * ceil(3000/3) + 128 = 4,128 estimated serialized bytes.
function sizedImage(id: string, byteLength: number): ImageAttachmentRef {
  return image(id, { byteLength })
}

test('within the byte budget nothing is stripped and the input array is returned as-is', () => {
  const records = [
    historyMessage('h1', [sizedImage('img-1', 3000)]),
    ...currentTurnRecords([sizedImage('img-cur', 3000)], [sizedImage('img-tool', 3000)]),
  ]
  const result = stripExcessImageBytes(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxImageRequestBytes: 4128 * 3,
  })
  assert.equal(result.records, records, 'identity: the same array reference, zero copying')
  assert.deepEqual(result.omittedImages, [])
  assert.equal(result.keptImageBytes, 4128 * 3)
  assert.equal(result.maxImageRequestBytes, 4128 * 3)
  assert.equal(
    result.signature,
    stripExcessImageBytes(records, {
      currentTurnId: 'turn-now',
      currentUserMessageId: 'current-user',
      maxImageRequestBytes: 4128 * 3,
    }).signature,
    'the signature is stable for the same state',
  )
})

test('over the byte budget the oldest historical images are omitted first', () => {
  const records = [
    historyMessage('h1', [sizedImage('img-1', 3000)]),
    historyMessage('h2', [sizedImage('img-2', 3000)]),
    historyMessage('h3', [sizedImage('img-3', 3000)]),
    ...currentTurnRecords([sizedImage('img-cur', 3000)], [sizedImage('img-tool', 3000)]),
  ]
  // 5 * 4128 = 20,640 total; the budget fits three images.
  const result = stripExcessImageBytes(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxImageRequestBytes: 4128 * 3,
  })
  assert.deepEqual(
    result.omittedImages.map((omitted) => omitted.refId),
    ['img-1', 'img-2'],
  )
  assert.ok(result.omittedImages.every((omitted) => omitted.historical))
  assert.equal(result.keptImageBytes, 4128 * 3)

  const omittedFirst = result.records.find((record) => record.id === 'h1')
  assert.equal(omittedFirst?.type, 'message')
  assert.equal(
    omittedFirst?.type === 'message' ? omittedFirst.content : undefined,
    'message h1\n\n[Historical image omitted to keep this request within its 12,384-byte size limit: '
      + 'img-1.png (attachment img-1). The pixels are not present in this request.]',
  )
  assert.equal(omittedFirst?.type === 'message' ? omittedFirst.images : 'kept', undefined)
  const currentInput = result.records.find((record) => record.id === 'current-user')
  assert.deepEqual(
    currentInput?.type === 'message' ? currentInput.images : undefined,
    [sizedImage('img-cur', 3000)],
  )
  // Pure projection: the input records are never mutated.
  const snapshot = JSON.parse(JSON.stringify(records))
  JSON.parse(JSON.stringify(records))
  stripExcessImageBytes(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxImageRequestBytes: 4128,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(records)), snapshot)
})

test('current-turn tool images are byte-omitted only once every historical image has been', () => {
  const records = [
    historyMessage('h1', [sizedImage('img-hist', 3000)]),
    ...currentTurnRecords(
      [sizedImage('img-cur-input', 3000)],
      [sizedImage('img-tool-1', 3000), sizedImage('img-tool-2', 3000)],
    ),
  ]
  // 4 * 4128 = 16,512 total; budget fits two.
  const result = stripExcessImageBytes(records, {
    currentTurnId: 'turn-now',
    currentUserMessageId: 'current-user',
    maxImageRequestBytes: 4128 * 2,
  })
  assert.deepEqual(
    result.omittedImages.map((omitted) => omitted.refId),
    ['img-hist', 'img-tool-1'],
  )
  assert.deepEqual(result.omittedImages.map((omitted) => omitted.historical), [true, false])
  const toolResult = result.records.find((record) => record.id === 'current-result')
  assert.match(
    toolResult?.type === 'tool_result' ? toolResult.content : '',
    /\[Image omitted to keep this request within its 8,256-byte size limit: img-tool-1\.png/,
    'current-turn omissions say so, without the historical qualifier',
  )
  const currentInput = result.records.find((record) => record.id === 'current-user')
  assert.deepEqual(
    currentInput?.type === 'message' ? currentInput.images : undefined,
    [sizedImage('img-cur-input', 3000)],
  )
})

test('an input whose images alone exceed the byte budget is blocked, not silently trimmed', () => {
  const records = [
    historyMessage('h1', [sizedImage('img-hist', 3000)]),
    ...currentTurnRecords([sizedImage('in-1', 30_000), sizedImage('in-2', 30_000)], []),
  ]
  assert.throws(
    () => stripExcessImageBytes(records, {
      currentTurnId: 'turn-now',
      currentUserMessageId: 'current-user',
      maxImageRequestBytes: 4128,
    }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'request-too-large'
        && error.images.length === 2
        && /serialize to about/.test(error.message)
        && /in-1\.png, in-2\.png/.test(error.message)
        && /Nothing was sent or recorded/.test(error.message)
        && /crop\/downscale/.test(error.message),
  )
})

test('the submission-level byte gate compares the input alone against the body limit', () => {
  assert.doesNotThrow(() => assertInputImagesWithinRequestBody(undefined, 100))
  assert.doesNotThrow(() => assertInputImagesWithinRequestBody([sizedImage('img-ok', 3000)], 4128))
  assert.throws(
    () => assertInputImagesWithinRequestBody([sizedImage('img-big', 30_000)], 4128),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'request-too-large'
        && /on their own/.test(error.message)
        && /Nothing was sent or recorded/.test(error.message),
  )
})

test('the omission notice names the budget and the way out', () => {
  const notice = formatImageByteStripNotice(2, 20_000_000)
  assert.match(notice, /20,000,000-byte size budget/)
  assert.match(notice, /2 of the oldest images/)
  assert.match(notice, /originals are kept/)
})

test('estimateRequestTextBytes counts system, record contents, structure, and tool schemas', () => {
  const records: SessionRecord[] = [
    historyMessage('h1', [], 'four'),
    {
      type: 'compact_boundary',
      id: 'cb1',
      summary: 'summary text',
      preTokens: 10,
      createdAt: '2026-09-09T00:00:00.000Z',
    },
    {
      type: 'tool_use',
      id: 'tu1',
      tool: 'Read',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-09-09T00:00:00.000Z',
    },
  ]
  const tools = [{
    name: 'Read',
    description: 'Read a file',
    inputSchema: z.object({ path: z.string() }).strict(),
    riskLevel: 'safe' as const,
    execute: async () => ({ ok: true, content: '' }),
  }] satisfies Tool[]
  const withTools = estimateRequestTextBytes(records, { system: 'sys', tools })
  const withoutTools = estimateRequestTextBytes(records, { system: 'sys' })
  // Structure overhead is 256 per record; forwarded fields contribute their JSON-encoded size.
  assert.ok(withTools > withoutTools, 'tool schemas are part of the estimate')
  assert.equal(
    withoutTools,
    Buffer.byteLength('sys', 'utf8') + '"four"'.length + '"summary text"'.length + '{}'.length + 256 * 3,
  )
  assert.equal(estimateRequestTextBytes([]), 0)
})

test('estimateRequestTextBytes counts thinking blocks and tool inputs', () => {
  const thinking = 'x'.repeat(50_000)
  const input = { file_path: '/a.ts', content: 'y'.repeat(80_000) }
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'a1',
      role: 'assistant',
      content: '',
      thinkingBlocks: [{ type: 'thinking', thinking, signature: 'sig' }],
      createdAt: '2026-09-09T00:00:00.000Z',
    },
    {
      type: 'tool_use',
      id: 'tu1',
      tool: 'Write',
      input,
      riskLevel: 'safe',
      createdAt: '2026-09-09T00:00:00.000Z',
    },
  ]
  assert.ok(estimateRequestTextBytes(records) > thinking.length + input.content.length)
})
