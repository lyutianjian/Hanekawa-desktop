import type { ModelPricing, TokenUsage, UsageCost } from './types.js'

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
}

/** Whether this usage carries a cache-write count at all. */
export function reportsCacheCreation(usage?: TokenUsage): boolean {
  const value = usage?.cacheCreationInputTokens
  return typeof value === 'number' && Number.isFinite(value)
}

/** Cache writes as a number: absent means "not reported", which costs nothing. */
export function cacheCreationTokens(usage?: TokenUsage): number {
  return reportsCacheCreation(usage) ? usage!.cacheCreationInputTokens as number : 0
}

/**
 * The cache-write field of a sum, present only when a side reported one.
 *
 * Arithmetic over these counts preserves absence rather than materializing a
 * zero: a session on an endpoint that does not report cache writes should keep
 * producing the same three-field usage it always did — in its records, in its
 * metrics and on the wire — instead of carrying a zero that claims the provider
 * answered "no writes".
 */
function sumCacheCreation(
  left: TokenUsage,
  right: TokenUsage,
): Pick<TokenUsage, 'cacheCreationInputTokens'> | Record<string, never> {
  if (!reportsCacheCreation(left) && !reportsCacheCreation(right)) return {}
  return { cacheCreationInputTokens: cacheCreationTokens(left) + cacheCreationTokens(right) }
}

/**
 * The whole prompt of one request: uncached input + cache writes + cache reads.
 *
 * The one place those three are added up. This is what the model was actually
 * sent, so it is both the context-window occupancy and the hit rate's
 * denominator — the same figure Claude Code's status line reports as
 * `context_window.total_input_tokens`. Adding only two of the three (which is
 * what every caller did while writes were folded into `inputTokens`) silently
 * drops every newly cached prefix.
 */
export function promptTokens(usage?: TokenUsage): number {
  if (!usage) return 0
  return usage.inputTokens + cacheCreationTokens(usage) + usage.cacheReadInputTokens
}

/**
 * Cache reads over the whole prompt, or null when nothing was sent at all.
 *
 * Output is not in the denominator: generated tokens can never be served from
 * cache, so folding them in would only drag the number down for a reason nobody
 * can act on. Cache *writes* are, and must be — a write is a miss that was paid
 * for, and a rate that ignored them would read 100% on a cold turn.
 */
export function cacheHitRate(usage: TokenUsage): number | null {
  const total = promptTokens(usage)
  if (total === 0) return null
  return usage.cacheReadInputTokens / total
}

export function addTokenUsage(left: TokenUsage, right?: TokenUsage): TokenUsage {
  if (!right) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    ...sumCacheCreation(left, right),
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...costField(addUsageCost(left.cost, right.cost)),
  }
}

export function costField(cost: UsageCost | undefined): Pick<TokenUsage, 'cost'> {
  return cost ? { cost } : {}
}

/** Per-currency sum; a flag on either side survives. */
export function addUsageCost(left?: UsageCost, right?: UsageCost): UsageCost | undefined {
  if (!left || !right) return left ?? right
  const amounts = { ...left.amounts }
  for (const [currency, amount] of Object.entries(right.amounts)) amounts[currency] = (amounts[currency] ?? 0) + amount
  return {
    amounts,
    ...(left.unpriced || right.unpriced ? { unpriced: true as const } : {}),
    ...(left.legacy || right.legacy ? { legacy: true as const } : {}),
  }
}

/** `left - right` per currency, clamped at zero. The flags are `left`'s: it is the superset. */
export function subtractUsageCost(left?: UsageCost, right?: UsageCost): UsageCost | undefined {
  if (!left || !right) return left
  const amounts: Record<string, number> = {}
  for (const [currency, amount] of Object.entries(left.amounts)) {
    amounts[currency] = Math.max(0, amount - (right.amounts[currency] ?? 0))
  }
  return { ...left, amounts }
}

type CompletePricing = ModelPricing & {
  inputPerMillionTokens: number
  outputPerMillionTokens: number
}

export function hasCompletePricing(pricing?: ModelPricing): pricing is CompletePricing {
  return typeof pricing?.inputPerMillionTokens === 'number'
    && Number.isFinite(pricing.inputPerMillionTokens)
    && typeof pricing.outputPerMillionTokens === 'number'
    && Number.isFinite(pricing.outputPerMillionTokens)
}

export function calculateTokenCost(usage: TokenUsage, pricing: CompletePricing): number {
  const cacheReadPrice = pricing.cacheReadInputPerMillionTokens ?? pricing.inputPerMillionTokens
  // Both cache rates fall back to the input rate rather than to zero: a model
  // priced without them is one whose cache rates are unknown, and charging a
  // write nothing would make a cold turn look free.
  const cacheWritePrice = pricing.cacheWriteInputPerMillionTokens ?? pricing.inputPerMillionTokens
  return (usage.cacheReadInputTokens / 1_000_000) * cacheReadPrice
    + (cacheCreationTokens(usage) / 1_000_000) * cacheWritePrice
    + (usage.inputTokens / 1_000_000) * pricing.inputPerMillionTokens
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokens
}

/**
 * One response's usage with its cost attached, priced by the model that served
 * it. Applied once, where the provider is built (`runtime/createRuntime.ts`), so
 * every request — foreground, fallback, compaction, subagent — carries the price
 * of its own model, and a later price edit never reprices what was already spent.
 *
 * Incomplete pricing marks the tokens unpriced instead of costing them zero:
 * "not priced" and "free" are different answers.
 */
export function priceUsage(usage: TokenUsage, pricing?: ModelPricing): TokenUsage {
  if (!hasCompletePricing(pricing)) return { ...usage, cost: { amounts: {}, unpriced: true } }
  return { ...usage, cost: { amounts: { [pricing.currency ?? 'USD']: calculateTokenCost(usage, pricing) } } }
}

export function formatUsageLine(usage: TokenUsage, pricing?: ModelPricing, label = 'Tokens'): string {
  const writes = cacheCreationTokens(usage)
  const tokens = `${label}: cache read ${usage.cacheReadInputTokens},${writes > 0 ? ` cache write ${writes},` : ''} input ${usage.inputTokens}, output ${usage.outputTokens}`
  if (!hasCompletePricing(pricing)) return tokens

  const currency = pricing.currency ?? 'USD'
  const cost = calculateTokenCost(usage, { ...pricing, currency })
  return `${tokens} | Cost: ${currency} ${formatCost(cost)}`
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.000001) return cost.toExponential(4)
  return cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}
