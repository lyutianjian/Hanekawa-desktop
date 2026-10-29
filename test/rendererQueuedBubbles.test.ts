import test from 'node:test'
import assert from 'node:assert/strict'
import type { PersistedQueuedMessage } from '../src/harness/types.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import {
  applySessionEvent,
  createTranscriptState,
  withPendingSends,
  withQueuedMessages,
  type PendingSendEntry,
} from '../src/desktop/renderer/model/transcript.js'

function queued(id: string, content: string): PersistedQueuedMessage {
  return { id, content, priority: 'next', createdAt: '2026-09-30T00:00:00.000Z' }
}

test('a queued message shows as a user bubble at the tail until the transcript carries it', () => {
  const started = applySessionEvent(createTranscriptState(), {
    type: 'turn-start',
    messageId: 'm1',
    displayInput: 'fix the bug',
    createdAt: '2026-09-30T00:00:00.000Z',
  }).state
  const waiting = withQueuedMessages(started, [queued('q1', 'only in src')])
  assert.deepEqual(waiting.items.map((item) => [item.kind, item.text]), [['user', 'fix the bug'], ['user', 'only in src']])

  // Steered into the turn: the record names its queued message, so the bubble
  // is not drawn twice while the queue's own update is still on its way.
  const steered = applySessionEvent(started, {
    type: 'record',
    record: {
      type: 'message',
      id: 'm2',
      role: 'user',
      content: 'only in src',
      sourceQueuedMessageId: 'q1',
      createdAt: '2026-09-30T00:00:01.000Z',
    },
  }).state
  assert.equal(withQueuedMessages(steered, [queued('q1', 'only in src')]).items.filter((item) => item.kind === 'user').length, 2)
})

test('a queued message the pump started a turn from is not drawn twice', () => {
  const started = applySessionEvent(createTranscriptState(), {
    type: 'turn-start',
    messageId: 'm1',
    displayInput: 'next task',
    createdAt: '2026-09-30T00:00:00.000Z',
    queuedMessageId: 'q1',
  }).state
  assert.equal(withQueuedMessages(started, [queued('q1', 'next task')]).items.length, 1)
})

function pendingEntry(id: string, text: string, images: PendingSendEntry['images'] = []): PendingSendEntry {
  return { id, text, images, createdAt: '2026-09-30T00:00:02.000Z' }
}

function imageRef(id: string): ImageAttachmentRef {
  return { id, ownerSessionId: 'sess-1', name: `${id}.png`, mimeType: 'image/png', width: 8, height: 8, byteLength: 10 }
}

test('a staged send paints as a user bubble at the tail, keyed apart from the records', () => {
  const base = createTranscriptState()
  assert.equal(withPendingSends(base, []), base, 'nothing staged repaints nothing')

  const staged = withPendingSends(base, [pendingEntry('s1', 'look at this')])
  assert.equal(staged.items.length, 1)
  assert.deepEqual(
    [staged.items[0]!.kind, staged.items[0]!.text, staged.items[0]!.id],
    ['user', 'look at this', 'sending:s1'],
  )
  assert.equal(staged.items[0]!.pendingImages, undefined, 'a text-only send has no picture row')
})

test('a staged bubble keeps its pictures in order, ready ones and still-loading ones alike', () => {
  const entry = pendingEntry('s1', 'two shots', [
    { kind: 'ready', ref: imageRef('img-1') },
    { kind: 'loading', name: 'later.png', previewUrl: 'blob:preview' },
  ])
  const item = withPendingSends(createTranscriptState(), [entry]).items[0]!
  assert.deepEqual(item.pendingImages, entry.images)

  // Two staged sends stack in the order the user pressed Enter.
  const both = withPendingSends(createTranscriptState(), [pendingEntry('s1', 'first'), pendingEntry('s2', 'second')])
  assert.deepEqual(both.items.map((item) => item.text), ['first', 'second'])
})
