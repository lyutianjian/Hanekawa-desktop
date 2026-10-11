import assert from 'node:assert/strict'
import test from 'node:test'

import { absoluteTime, relativeTime } from '../src/desktop/renderer/model/turnFooter.js'

test('relative time reads 刚刚 / N 分钟前 / 今天 HH:mm / M月D日', () => {
  const now = new Date(2026, 4, 7, 15, 0, 0).getTime()
  const ago = (ms: number): string => new Date(now - ms).toISOString()
  assert.equal(relativeTime(ago(30_000), now), '刚刚')
  assert.equal(relativeTime(ago(5 * 60_000), now), '5 分钟前')
  assert.equal(relativeTime(new Date(2026, 4, 7, 9, 5).toISOString(), now), '今天 09:05')
  assert.equal(relativeTime(new Date(2026, 4, 6, 23, 59).toISOString(), now), '5月6日')
  assert.equal(relativeTime(undefined, now), undefined)
  assert.equal(relativeTime('nope', now), undefined)
})

test('the absolute time is the title text', () => {
  assert.equal(absoluteTime(new Date(2026, 4, 7, 14, 32).toISOString()), '2026-05-07 14:32')
})
