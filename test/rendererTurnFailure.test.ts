import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyTurnFailure,
  endpointLabel,
  turnFailureCard,
  type TurnFailureKind,
} from '../src/desktop/renderer/model/turnFailure.js'
import {
  applySessionEvent,
  createTranscriptState,
  failedTurnInput,
  withFailureActions,
} from '../src/desktop/renderer/model/transcript.js'
import type { SessionRecord, TurnFailureRecord } from '../src/harness/types.js'

/**
 * A turn that ended on a provider error, in the words a user can act on: the
 * classification is the renderer's, the raw error is what the record keeps.
 */

function failure(overrides: Partial<TurnFailureRecord> = {}): TurnFailureRecord {
  return {
    id: 'f1',
    type: 'turn_failure',
    userMessageId: 'u1',
    error: 'Connection error.',
    createdAt: '2026-10-14T00:00:00.000Z',
    ...overrides,
  }
}

function user(id: string, content = '你好'): SessionRecord {
  return { type: 'message', id, role: 'user', content, createdAt: '2026-10-14T00:00:00.000Z' }
}

test('provider errors read as a plain-language cause', () => {
  const cases: Array<[Parameters<typeof classifyTurnFailure>[0], TurnFailureKind]> = [
    [{ error: 'Connection error.', code: 'ECONNREFUSED' }, 'network'],
    [{ error: 'fetch failed', code: 'ENOTFOUND' }, 'network'],
    [{ error: 'Request timed out.' }, 'timeout'],
    [{ error: 'connect ETIMEDOUT 1.2.3.4:443', code: 'ETIMEDOUT' }, 'timeout'],
    [{ error: '401 invalid x-api-key', status: 401 }, 'auth'],
    [{ error: 'Incorrect API key provided', code: 'invalid_api_key' }, 'auth'],
    [{ error: 'You exceeded your current quota', status: 429, code: 'insufficient_quota' }, 'quota'],
    [{ error: 'Your credit balance is too low', status: 400 }, 'quota'],
    [{ error: 'model: gpt-9 does not exist', status: 404 }, 'model'],
    [{ error: 'Not Found', status: 404 }, 'endpoint'],
    [{ error: 'Too many requests', status: 429 }, 'rate-limit'],
    [{ error: 'Overloaded', status: 529 }, 'overloaded'],
    [{ error: 'Internal server error', status: 500 }, 'server'],
    [{ error: 'prompt is too long: 250000 tokens', status: 400 }, 'context'],
    [{ error: 'messages: bad shape', status: 400 }, 'rejected'],
    [{ error: 'something odd' }, 'unknown'],
  ]
  for (const [input, kind] of cases) assert.equal(classifyTurnFailure(input), kind, input.error)
})

test('the card names the reason, the model and the endpoint involved', () => {
  const card = turnFailureCard(failure({
    error: 'connect ECONNREFUSED 127.0.0.1:9',
    code: 'ECONNREFUSED',
    model: 'broken-model',
    providerName: 'local',
    baseUrl: 'http://127.0.0.1:9/v1/',
  }))
  assert.equal(card.kind, 'network')
  assert.equal(card.reason, '连不上服务商')
  assert.equal(card.target, '模型 broken-model · 服务商 127.0.0.1:9/v1')
  assert.equal(card.detail, 'connect ECONNREFUSED 127.0.0.1:9')
  assert.equal(card.userMessageId, 'u1')
  assert.equal(card.retryable, false, 'whether to offer a retry is the transcript\'s call')
})

test('a record that names no model or endpoint draws no target line', () => {
  assert.equal(turnFailureCard(failure()).target, undefined)
  assert.equal(turnFailureCard(failure({ model: 'm' })).target, '模型 m')
  assert.equal(endpointLabel(undefined, 'local'), 'local')
  assert.equal(endpointLabel('not a url', undefined), 'not a url')
})

test('a failure survives a reload: the record replays into the same card', () => {
  const records = [user('u1'), failure({ model: 'm' })]
  const items = createTranscriptState(records).items
  assert.deepEqual(items.map((item) => item.kind), ['user', 'turn-failure'])
  assert.equal(items[1]!.failure?.reason, '连不上服务商')
})

test('a live failure record lands in the transcript as a card', () => {
  const state = applySessionEvent(createTranscriptState([user('u1')]), { type: 'record', record: failure() }).state
  assert.equal(state.items.at(-1)?.kind, 'turn-failure')
})

test('only the newest failure, with nothing sent since, is offered a retry', () => {
  const retryable = (records: SessionRecord[]): boolean[] =>
    withFailureActions(createTranscriptState(records)).items.flatMap((item) => (item.failure ? [item.failure.retryable] : []))

  assert.deepEqual(retryable([user('u1'), failure()]), [true])
  assert.deepEqual(retryable([user('u1'), failure({ id: 'f1' }), user('u2'), failure({ id: 'f2', userMessageId: 'u2' })]), [false, true])
  assert.deepEqual(retryable([user('u1'), failure(), user('u2')]), [false], 'a later message retires the buttons')
  assert.deepEqual(retryable([failure()]), [false], 'a message that is no longer on screen cannot be sent again')
})

test('retrying sends the failed message again, pictures included', () => {
  const state = createTranscriptState([
    {
      type: 'message', id: 'u1', role: 'user', content: '看看这张图', createdAt: 'now',
      images: [{ id: 'img1', name: 'a.png', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }],
    } as unknown as SessionRecord,
    failure(),
  ])
  assert.deepEqual(failedTurnInput(state, 'u1'), { text: '看看这张图', imageIds: ['img1'] })
  assert.equal(failedTurnInput(state, 'nope'), undefined)
})
