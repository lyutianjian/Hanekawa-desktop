import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addTokenUsage,
  cacheHitRate,
  calculateTokenCost,
  formatUsageLine,
  priceUsage,
  promptTokens,
  subtractUsageCost,
} from '../src/harness/usage.js'

const usage = {
  cacheReadInputTokens: 100_000,
  inputTokens: 200_000,
  outputTokens: 50_000,
}

test('formatUsageLine shows tokens without pricing', () => {
  assert.equal(
    formatUsageLine(usage),
    'Tokens: cache read 100000, input 200000, output 50000',
  )
})

test('formatUsageLine supports a custom label', () => {
  assert.equal(
    formatUsageLine(usage, undefined, 'Turn'),
    'Turn: cache read 100000, input 200000, output 50000',
  )
})

test('formatUsageLine shows cost with complete pricing', () => {
  assert.equal(
    formatUsageLine(usage, {
      cacheReadInputPerMillionTokens: 0.1,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      currency: 'CNY',
    }),
    'Tokens: cache read 100000, input 200000, output 50000 | Cost: CNY 0.31',
  )
})

test('formatUsageLine falls back to input pricing for unspecified cache prices', () => {
  assert.equal(
    formatUsageLine(usage, {
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    }),
    'Tokens: cache read 100000, input 200000, output 50000 | Cost: USD 0.4',
  )
})

test('calculateTokenCost uses per-million token prices', () => {
  const cost = calculateTokenCost(usage, {
    cacheReadInputPerMillionTokens: 0.1,
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
    currency: 'USD',
  })

  assert.ok(Math.abs(cost - 0.31) < Number.EPSILON)
})

test('priceUsage attaches the cost in the model currency', () => {
  const priced = priceUsage(usage, {
    cacheReadInputPerMillionTokens: 0.1,
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
    currency: 'CNY',
  })

  assert.ok(Math.abs((priced.cost?.amounts.CNY ?? 0) - 0.31) < 1e-12)
  assert.equal(priced.inputTokens, usage.inputTokens)
  assert.deepEqual(Object.keys(priced.cost!.amounts), ['CNY'])
  assert.deepEqual(Object.keys(priceUsage(usage, { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }).cost!.amounts), ['USD'])
})

test('priceUsage marks tokens unpriced rather than free without complete pricing', () => {
  // "Not priced" and "free" are different answers.
  assert.deepEqual(priceUsage(usage).cost, { amounts: {}, unpriced: true })
  assert.deepEqual(priceUsage(usage, { inputPerMillionTokens: 1 }).cost, { amounts: {}, unpriced: true },
    'half a price list is not a price list')
})

test('addTokenUsage sums the cost per currency and keeps either side\'s flags', () => {
  const usd = { ...usage, cost: { amounts: { USD: 1 } } }
  const cny = { ...usage, cost: { amounts: { CNY: 2, USD: 0.5 }, unpriced: true as const } }
  assert.deepEqual(addTokenUsage(usd, cny).cost, { amounts: { USD: 1.5, CNY: 2 }, unpriced: true })
  // A side that carries no cost leaves the other's untouched.
  assert.deepEqual(addTokenUsage(usage, usd).cost, { amounts: { USD: 1 } })
  assert.equal(addTokenUsage(usage, usage).cost, undefined)
})

test('subtractUsageCost clamps at zero per currency', () => {
  assert.deepEqual(
    subtractUsageCost({ amounts: { USD: 3, CNY: 1 }, legacy: true }, { amounts: { USD: 1, CNY: 4 } }),
    { amounts: { USD: 2, CNY: 0 }, legacy: true },
  )
})

/**
 * The three input-side counts are disjoint, and every readout that means "how
 * big was this prompt" has to add all three. `promptTokens` is that sum; these
 * pin it, because the alternative — each caller adding the two fields it
 * happens to know about — is how cache writes vanished from the context gauge.
 */
test('promptTokens counts input, writes and reads, never the output', () => {
  assert.equal(promptTokens({
    inputTokens: 100,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 300,
    outputTokens: 40,
  }), 420)
  // Absent writes are zero writes for arithmetic, which is what an
  // OpenAI-compatible endpoint reports.
  assert.equal(promptTokens({ inputTokens: 100, cacheReadInputTokens: 300, outputTokens: 40 }), 400)
  assert.equal(promptTokens(undefined), 0)
})

test('the hit rate has cache writes in its denominator', () => {
  // A write is a miss that was paid for: a cold request that cached its whole
  // prompt must not read as a perfect hit.
  assert.equal(cacheHitRate({
    inputTokens: 0,
    cacheCreationInputTokens: 1000,
    cacheReadInputTokens: 0,
    outputTokens: 10,
  }), 0)
  assert.equal(cacheHitRate({
    inputTokens: 100,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 800,
    outputTokens: 10,
  }), 0.8)
  // Nothing sent at all is "no rate", not a zero.
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 }), null)
})

test('adding usage keeps "not reported" out of the sum', () => {
  // Absence is an answer: a provider that never reports writes must keep
  // producing three-field usage rather than a zero that claims otherwise.
  assert.deepEqual(
    addTokenUsage(
      { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
      { inputTokens: 10, cacheReadInputTokens: 20, outputTokens: 30 },
    ),
    { inputTokens: 11, cacheReadInputTokens: 22, outputTokens: 33 },
  )
  assert.deepEqual(
    addTokenUsage(
      { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
      { inputTokens: 10, cacheCreationInputTokens: 5, cacheReadInputTokens: 20, outputTokens: 30 },
    ),
    { inputTokens: 11, cacheCreationInputTokens: 5, cacheReadInputTokens: 22, outputTokens: 33 },
  )
})

test('calculateTokenCost bills cache writes at their own rate', () => {
  // Anthropic charges a write above the input rate; folded into `inputTokens`
  // they were billed as ordinary input, which under-reports every cold turn.
  const cost = calculateTokenCost(
    {
      inputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
    },
    {
      cacheReadInputPerMillionTokens: 0.1,
      cacheWriteInputPerMillionTokens: 1.25,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    },
  )
  assert.ok(Math.abs(cost - 2.35) < 1e-9)
})

test('calculateTokenCost falls back to the input rate for unpriced writes', () => {
  // "Unknown write rate" must not read as "writes are free".
  const cost = calculateTokenCost(
    { inputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 0, outputTokens: 0 },
    { inputPerMillionTokens: 3, outputPerMillionTokens: 2 },
  )
  assert.ok(Math.abs(cost - 3) < 1e-9)
})
