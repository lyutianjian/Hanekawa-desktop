import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_CRITICAL_RATIO,
  CONTEXT_WARN_RATIO,
  contextGaugeView,
  formatTokens,
  hiddenContextGauge,
  statusUsageView,
} from '../src/desktop/renderer/model/usage.js'
import type { TokenUsage } from '../src/harness/types.js'
import type { WireReadyRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The two token readouts, with no DOM — the `model/` half of the renderer's
 * split, same as `test/rendererComposerChip.test.ts`.
 */

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, ...overrides }
}

test('cache write display distinguishes unreported writes from explicit zero', () => {
  assert.equal(statusUsageView(usage({ inputTokens: 10 })).breakdown.some((row) => row.label === '缓存写入'), false)
  assert.equal(statusUsageView(usage({ inputTokens: 10, cacheCreationInputTokens: 0 })).breakdown.find((row) => row.label === '缓存写入')?.value, '0')
  assert.equal(statusUsageView(usage({ inputTokens: 10, cacheCreationInputTokens: 20 })).breakdown.find((row) => row.label === '缓存写入')?.value, '20')
})

test('token abbreviation carries rounding across units and omits redundant decimals', () => {
  for (const [count, expected] of [[0, '0'], [999, '999'], [1000, '1k'], [9999, '10k'], [10000, '10k'], [999499, '999k'], [999500, '1M'], [999999, '1M'], [1000000, '1M']] as const) {
    assert.equal(formatTokens(count), expected)
  }
})

function runtime(overrides: Partial<WireReadyRuntimeSnapshot> = {}): WireReadyRuntimeSnapshot {
  return {
    status: 'ready',
    modelKey: 'sonnet',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }
}

test('token counts abbreviate without losing the leading digits', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(16_400), '16k')
  assert.equal(formatTokens(950_000), '950k')
  assert.equal(formatTokens(1_200_000), '1.2M')
})

test('an untouched session leaves the status line empty', () => {
  // `#status` reserves its line height, so an empty string draws nothing
  // rather than a row of zeros under the composer.
  for (const view of [statusUsageView(usage()), statusUsageView(undefined)]) {
    assert.deepEqual(view.metrics, [])
    assert.equal(view.rate, undefined)
    assert.equal(view.text, '')
    assert.equal(view.title, '')
  }
})

test('the status line sums every count into one total', () => {
  const view = statusUsageView(
    usage({
      inputTokens: 12_400,
      cacheCreationInputTokens: 4_000,
      cacheReadInputTokens: 88_100,
      outputTokens: 3_200,
    }),
    usage({ inputTokens: 200, cacheReadInputTokens: 9_800 }),
  )
  // One chip on screen; its label lives in the accessible name beside it. Cache
  // writes are in the total — they were billed like any other input.
  assert.deepEqual(view.metrics.map((metric) => [metric.kind, metric.value]), [
    ['total', '108k token'],
  ])
  // The rate is the one field written out on screen — no glyph explains a ratio
  // — and it is the last request's, not the session's.
  assert.deepEqual(view.rate, { label: '本轮命中', percent: '98.0%' })
  assert.equal(view.text, '总计 108k token · 本轮命中 98.0%')
  // The hover card carries the split unabbreviated, and the cumulative rate
  // beside it; `title` is the same rows joined, for the accessible name only.
  assert.deepEqual(view.breakdown.map((row) => row.label), [
    '总计',
    '输入（未缓存）',
    '缓存写入',
    '缓存命中',
    '输出',
    '本轮命中',
    '会话累计命中',
  ])
  assert.match(view.title, /107,700/)
  assert.match(view.title, /12,400/)
  assert.match(view.title, /4,000/)
  assert.match(view.title, /88,100/)
  assert.match(view.title, /3,200/)
  assert.match(view.title, /会话累计命中 84\.3%/)
})

test('a cache write counts as a miss, not as nothing', () => {
  // A write is a miss that was paid for. Left out of the denominator, the first
  // request of every session would read as a perfect 100% hit.
  const view = statusUsageView(
    usage({ inputTokens: 1, cacheReadInputTokens: 1 }),
    usage({ cacheCreationInputTokens: 100, cacheReadInputTokens: 100 }),
  )
  assert.equal(view.rate?.percent, '50.0%')
})

test('the hit rate ignores output tokens', () => {
  // Output is generated and can never be served from cache; folding it into the
  // denominator would drag the number down for a reason nobody can act on.
  const view = statusUsageView(
    usage({ inputTokens: 100, cacheReadInputTokens: 100, outputTokens: 1_000_000 }),
    usage({ inputTokens: 100, cacheReadInputTokens: 100, outputTokens: 1_000_000 }),
  )
  assert.equal(view.rate?.percent, '50.0%')
})

test('a session with no request behind it yet shows the count and no rate', () => {
  // The count is the session's and survives a resume; the rate belongs to a
  // request, and there is none until one lands.
  const view = statusUsageView(usage({ inputTokens: 100, outputTokens: 500 }))
  assert.equal(view.rate, undefined)
  assert.equal(view.text, '总计 600 token')
})

test('a session that never touched the cache shows no rate', () => {
  // An endpoint with prompt caching off reports neither reads nor writes; a
  // 0.0% there would read as a cache that is failing, not one that is absent.
  const view = statusUsageView(
    usage({ inputTokens: 5_000, outputTokens: 500 }),
    usage({ inputTokens: 2_000, outputTokens: 200 }),
  )
  assert.equal(view.rate, undefined)
  assert.equal(view.text, '总计 5.5k token')
  assert.ok(!view.breakdown.some((row) => row.label === '会话累计命中'))
})

test('a turn with no input side reports no rate at all', () => {
  const view = statusUsageView(usage({ outputTokens: 500 }), usage({ outputTokens: 500 }))
  assert.equal(view.rate, undefined)
  assert.equal(view.text, '总计 500 token')
})

test('the gauge is absent, not empty, when either number is missing', () => {
  const hiddenCases = [
    contextGaugeView(undefined, runtime({ usableContextWindow: 167_000 })),
    contextGaugeView(1000, runtime()),
    contextGaugeView(1000, undefined),
    contextGaugeView(1000, runtime({ usableContextWindow: 0 })),
  ]
  for (const view of hiddenCases) {
    assert.equal(view.visible, false)
    assert.equal(view.used, '')
    assert.equal(view.usable, '')
    assert.equal(view.modelWindow, undefined)
  }
  assert.equal(hiddenContextGauge().visible, false)
})

test('the gauge measures against the usable window, not the raw one', () => {
  // The denominator is the autocompact threshold: the turn that crosses it gets
  // compacted, so a percentage of the raw window would promise room no turn is
  // allowed to use. 16k of 167k is 10%; of 200k it would read 8%.
  const view = contextGaugeView(16_700, runtime({
    contextWindow: 200_000,
    usableContextWindow: 167_000,
  }))
  assert.equal(view.visible, true)
  assert.equal(view.percent, '10%')
  assert.equal(view.used, '17k')
  assert.equal(view.usable, '167k')
  assert.equal(view.modelWindow, '200k')
  // 「可用窗口」, because that is the denominator above: calling it the context
  // window would hand the reserve back in the one line a screen reader gets.
  assert.match(view.title, /^可用窗口：10% 已用（剩余 90%）/)
  assert.doesNotMatch(view.title, /上下文窗口/)
  assert.match(view.title, /已用 17k token，共 167k/)
  assert.match(view.title, /模型窗口 200k/)
})

test('the gauge clamps rather than overflowing its ring', () => {
  const view = contextGaugeView(500_000, runtime({ usableContextWindow: 167_000 }))
  assert.equal(view.ratio, 1)
  assert.equal(view.percent, '100%')
})

test('the gauge changes level as autocompact approaches', () => {
  const at = (ratio: number) => contextGaugeView(
    Math.round(100_000 * ratio),
    runtime({ usableContextWindow: 100_000 }),
  ).level
  assert.equal(at(0.5), 'normal')
  assert.equal(at(CONTEXT_WARN_RATIO - 0.01), 'normal')
  assert.equal(at(CONTEXT_WARN_RATIO), 'warn')
  assert.equal(at(CONTEXT_CRITICAL_RATIO - 0.01), 'warn')
  assert.equal(at(CONTEXT_CRITICAL_RATIO), 'critical')
})

test('a model whose whole window is usable does not claim a separate reserve', () => {
  const view = contextGaugeView(10, runtime({ contextWindow: 1000, usableContextWindow: 1000 }))
  assert.equal(view.modelWindow, undefined)
  assert.doesNotMatch(view.title, /模型窗口/)
})
