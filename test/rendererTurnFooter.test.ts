import assert from 'node:assert/strict'
import test from 'node:test'

import { absoluteTime, relativeTime } from '../src/desktop/renderer/model/turnFooter.js'

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
