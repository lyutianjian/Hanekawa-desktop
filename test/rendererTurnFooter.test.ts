import assert from 'node:assert/strict'
import test from 'node:test'

import { absoluteTime, relativeTime, splitTurnFooters } from '../src/desktop/renderer/model/turnFooter.js'

test('tokens attach only to the footer of the turn that reported them', () => {
  const entries = [
    { kind: 'item', item: { id: 'answer', kind: 'assistant', text: 'done', turnId: 'old' } },
    { kind: 'item', item: { id: 'duration', kind: 'duration', text: '', durationMs: 100, turnId: 'old' } },
    { kind: 'item', item: { id: 'interrupted', kind: 'user', text: 'next', turnId: 'new' } },
  ] as const
  assert.equal(splitTurnFooters(entries, 20, 'new').footers.get(0)?.tokens, undefined)
  assert.equal(splitTurnFooters(entries, 20, 'old').footers.get(0)?.tokens, 20)
  assert.equal(splitTurnFooters(entries, 20).footers.get(0)?.tokens, undefined)
})

test('a wake turn continues the reply: its time joins the footer after the last turn', () => {
  const before = new Date(2026, 4, 7, 10, 0).toISOString()
  const after = new Date(2026, 4, 7, 10, 5).toISOString()
  const entries = [
    { kind: 'item', item: { id: 'u', kind: 'user', text: 'go', turnId: 't1' } },
    { kind: 'item', item: { id: 'a1', kind: 'assistant', text: 'started', turnId: 't1', createdAt: before } },
    { kind: 'item', item: { id: 'd1', kind: 'duration', text: '', durationMs: 7_000, turnId: 't1' } },
    // No input between the turns: a background task woke the session.
    { kind: 'item', item: { id: 'a2', kind: 'assistant', text: 'finished', turnId: 't2', createdAt: after } },
    { kind: 'item', item: { id: 'd2', kind: 'duration', text: '', durationMs: 5_000, turnId: 't2' } },
  ] as const
  const { footers } = splitTurnFooters(entries, 3200, 't2')
  assert.deepEqual([...footers.keys()], [2])
  assert.deepEqual(footers.get(2), { durationMs: 12_000, createdAt: after, tokens: 3200 })
  assert.equal(footers.has(1), false)
})

test('a still-streaming turn settles the previous reply footer before its own first entry', () => {
  const before = new Date(2026, 4, 7, 10, 0).toISOString()
  const entries = [
    { kind: 'item', item: { id: 'a1', kind: 'assistant', text: 'started', turnId: 't1', createdAt: before } },
    { kind: 'item', item: { id: 'd1', kind: 'duration', text: '', durationMs: 7_000, turnId: 't1' } },
    { kind: 'item', item: { id: 'a2', kind: 'assistant', text: 'streaming', turnId: 't2' } },
  ] as const
  const { footers } = splitTurnFooters(entries, undefined, undefined, 't2')
  assert.deepEqual([...footers.keys()], [0])
  assert.deepEqual(footers.get(0), { durationMs: 7_000, createdAt: before })
})

/**
 * The window's one time label. A message stamp used to be a bare 「14:32」 from
 * any day, and the thread list counted 「3 小时前」 while the transcript said
 * 「今天 14:32」; every stamp is now this.
 */
test('relative time reads 刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / M月D日', () => {
  const now = new Date(2026, 4, 7, 15, 0, 0).getTime()
  const ago = (ms: number): string => new Date(now - ms).toISOString()
  assert.equal(relativeTime(ago(30_000), now), '刚刚')
  assert.equal(relativeTime(ago(5 * 60_000), now), '5 分钟前')
  assert.equal(relativeTime(new Date(2026, 4, 7, 9, 5).toISOString(), now), '今天 09:05')
  assert.equal(relativeTime(new Date(2026, 4, 6, 23, 59).toISOString(), now), '昨天 23:59')
  assert.equal(relativeTime(new Date(2026, 4, 5, 8, 0).toISOString(), now), '5月5日')
  assert.equal(relativeTime(new Date(2025, 11, 31, 8, 0).toISOString(), now), '2025年12月31日')
  assert.equal(relativeTime(new Date(now + 5 * 60_000).toISOString(), now), '刚刚', 'clock skew reads as just now')
  assert.equal(relativeTime(undefined, now), undefined)
  assert.equal(relativeTime('nope', now), undefined)
})

test('the absolute time is the title text', () => {
  assert.equal(absoluteTime(new Date(2026, 4, 7, 14, 32).toISOString()), '2026-05-07 14:32')
})
