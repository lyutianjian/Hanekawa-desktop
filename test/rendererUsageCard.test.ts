import assert from 'node:assert/strict'
import test from 'node:test'

import { formatTokens, usageCardView } from '../src/desktop/renderer/model/usageCard.js'

test('tokens format in 万 / 亿 with one decimal under 100 of the unit', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(9_876), '9,876')
  assert.equal(formatTokens(12_000), '1.2 万')
  assert.equal(formatTokens(1_230_000), '123 万')
  assert.equal(formatTokens(340_000_000), '3.4 亿')
  assert.equal(formatTokens(100_000), '10 万')
})

test('an empty history is zeros and dashes, with an all-quiet heatmap', () => {
  const view = usageCardView([], 'overview', 'all', new Date(2026, 9, 11))
  assert.equal(view.loading, false)
  assert.deepEqual(view.cells.map((cell) => cell.value), ['0', '0', '0', '0', '—', '—'])
  assert.ok(view.heatmap.flat().every((cell) => cell === null || cell.level === 0))
  assert.equal(view.footnote, '你用掉的 token 大约相当于 0 本《三体》')
})

test('no data yet is loading; shares appear only on the model tab', () => {
  const now = new Date(2026, 9, 11)
  assert.equal(usageCardView(undefined, 'overview', 'all', now).loading, true)
  const days = [{ day: '2026-10-11', sessions: 1, turns: 2, tokens: 100, hours: new Array<number>(24).fill(0), models: { a: 100 } }]
  assert.equal(usageCardView(days, 'overview', 'all', now).shares.length, 0)
  assert.deepEqual(usageCardView(days, 'models', 'all', now).shares, [{ model: 'a', tokens: '100', percent: '100%', width: 100 }])
})

test('large values group their digits', () => {
  assert.equal(formatTokens(60_660_000), '6,066 万')
})

test('large values group their digits', () => {
  assert.equal(formatTokens(60_660_000), '6,066 万')
})
