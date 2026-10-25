import type { TokenUsage, UsageCost } from '../../../harness/types.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'

/**
 * The two token readouts under and beside the composer.
 *
 * Pure, like `model/composer.ts`: `dom/statusView.ts` and `dom/composerView.ts`
 * only turn what these return into nodes.
 *
 * The status line prints one count, not three: `总计 X token · 本轮命中 Y%`. It
 * carried a chip per direction for a while (`输入` / `缓存命中` / `输出`), which
 * is three figures to add up before the line answers the question it is actually
 * asked — how much this session has spent. The split survives in the hover for
 * anyone who wants it.
 *
 * The two numbers are deliberately on different denominators, which is why only
 * one of them is a total: the count is what the whole session spent, and the
 * rate is the *last request's*. A cumulative rate can only fall — the cold first
 * request, every compaction and every subagent prompt sit in its denominator
 * forever — so it answers "how did this session go" and not "is the cache
 * working right now", which is the question a status line is read for. The
 * cumulative figure is in the hover, next to the split.
 */

/** `--context-ratio`, written by `dom/composerView.ts` through `setProperty`. */
export const CONTEXT_RATIO_VARIABLE = '--context-ratio'

/** Above this share of the usable window the gauge starts warning. */
export const CONTEXT_WARN_RATIO = 0.8
/** Above this, autocompact is close enough that the gauge says so. */
export const CONTEXT_CRITICAL_RATIO = 0.95

/**
 * `16k` / `950k` / `1.2M`.
 *
 * Its own function rather than one shared with the TUI's identically named
 * local helper: that one is private to `StatusLine.tsx` and formats for a
 * monospaced grid, while this sits in proportional text beside a label.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 999_500) {
    const thousands = n / 1000
    return `${thousands < 10 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`
  }
  const millions = n / 1_000_000
  return `${millions < 10 ? Number(millions.toFixed(1)) : Math.round(millions)}M`
}

function formatExact(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Which count a chip carries — the view turns this into a glyph.
 *
 * One kind, kept as a union rather than collapsed away: the chip, its icon map
 * and its CSS hook are all keyed by it, and a second count coming back later
 * should be a new member here rather than a second shape of chip.
 */
export type UsageMetricKind = 'total'

export interface UsageMetric {
  readonly kind: UsageMetricKind
  /** `53.4M tok`, already abbreviated and carrying its unit. */
  readonly value: string
  /** What the glyph stands for, for the accessible name. */
  readonly label: string
}

/**
 * The cache hit rate: a written-out label and its percentage.
 *
 * The one field on this line that is *not* a glyph and a figure. It was a swept
 * ring for a while, which put a second ratio dial on the same screen as the
 * context indicator's — two rings, two meanings, one shape. A rate is also the
 * one number here that no mark explains on its own, so it carries its name.
 */
export interface UsageRateView {
  readonly label: string
  readonly percent: string
}

/** One line of the readout's hover card: a name and its unabbreviated figure. */
export interface UsageBreakdownRow {
  readonly label: string
  readonly value: string
}

export interface StatusUsageView {
  /**
   * Empty while nothing has been counted, so `#status` collapses to no height.
   * The chips the view draws; the numbers are never a single string on screen.
   */
  readonly metrics: readonly UsageMetric[]
  /** Absent when nothing has been read at all — no denominator, no rate. */
  readonly rate: UsageRateView | undefined
  /** The same line as one string, for the readout's accessible name. */
  readonly text: string
  /** The same numbers unabbreviated, for the hover card. Empty when `text` is. */
  readonly breakdown: readonly UsageBreakdownRow[]
  /** Why the 会话开销 row may fall short of the real spend; absent when it does not. */
  readonly costNote: string | undefined
  /**
   * The breakdown as one string, for the accessible name only.
   *
   * Not an OS tooltip any more: the `title` attribute waits a second before it
   * says anything and is drawn by the platform rather than by this app's
   * stylesheet, so the numbers come out in a bubble that belongs to no theme.
   * `dom/statusView.ts` draws them in a hover card instead.
   */
  readonly title: string
}

const EMPTY: StatusUsageView = Object.freeze({
  metrics: [],
  rate: undefined,
  text: '',
  breakdown: [],
  costNote: undefined,
  title: '',
})

/** Cache writes, 0 when the provider does not report them. */
function writes(usage: TokenUsage): number {
  const value = usage.cacheCreationInputTokens
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * What one request sent: uncached input + cache writes + cache reads.
 *
 * Spelled out here rather than imported from `harness/usage.ts` because the
 * renderer may not value-import that layer; `test/rendererUsage.test.ts` pins it
 * against the same numbers the host computes.
 */
function prompt(usage: TokenUsage): number {
  return usage.inputTokens + writes(usage) + usage.cacheReadInputTokens
}

/**
 * Cache reads over the whole prompt, or undefined when nothing was sent.
 *
 * Writes are in the denominator and output is not: a write is a miss that was
 * paid for, while generated tokens can never be served from cache and would only
 * drag the number down for a reason nobody can act on.
 */
function hitRate(usage: TokenUsage): number | undefined {
  const total = prompt(usage)
  return total > 0 ? (usage.cacheReadInputTokens / total) * 100 : undefined
}

/**
 * The session's total token spend, and the cache hit rate beside it.
 *
 * The count is cumulative, like the cost in the hover. The rate is the
 * last request's, because that is the one an unexpectedly cold turn shows up in;
 * the cumulative rate is in the hover, which is where a number that can only
 * fall belongs.
 */
export function statusUsageView(
  total: TokenUsage | undefined,
  lastRequest?: TokenUsage | null,
): StatusUsageView {
  if (!total) return EMPTY
  const { inputTokens, cacheReadInputTokens, outputTokens } = total
  const allTokens = prompt(total) + outputTokens
  if (allTokens === 0) return EMPTY

  const metrics: UsageMetric[] = [
    { kind: 'total', value: `${formatTokens(allTokens)} token`, label: '总计' },
  ]
  const cost = formatSessionCost(total.cost)
  const breakdown: UsageBreakdownRow[] = [
    { label: '总计', value: `${formatExact(allTokens)} token` },
    ...(cost ? [{ label: '会话开销', value: cost }] : []),
    { label: '输入（未缓存）', value: formatExact(inputTokens) },
    ...(total.cacheCreationInputTokens === undefined ? [] : [{ label: '缓存写入', value: formatExact(writes(total)) }]),
    { label: '缓存命中', value: formatExact(cacheReadInputTokens) },
    { label: '输出', value: formatExact(outputTokens) },
  ]

  const parts = metrics.map((metric) => `${metric.label} ${metric.value}`)
  // A session that has never written to or read from the cache is one whose
  // endpoint is not caching at all: 「本轮命中 0.0%」 there reads as a broken
  // cache rather than an absent one, so the rate is left out entirely.
  const cacheTouched = cacheReadInputTokens > 0 || writes(total) > 0
  const lastRate = lastRequest && cacheTouched ? hitRate(lastRequest) : undefined
  let rate: UsageRateView | undefined
  if (lastRate !== undefined) {
    rate = { label: '本轮命中', percent: `${lastRate.toFixed(1)}%` }
    parts.push(`${rate.label} ${rate.percent}`)
    breakdown.push({ label: '本轮命中', value: rate.percent })
  }
  const sessionRate = cacheTouched ? hitRate(total) : undefined
  if (sessionRate !== undefined) {
    breakdown.push({ label: '会话累计命中', value: `${sessionRate.toFixed(1)}%` })
  }

  return {
    metrics,
    rate,
    text: parts.join(' · '),
    breakdown,
    costNote: cost ? costNote(total.cost!) : undefined,
    title: `本会话累计\n${breakdown.map((row) => `${row.label} ${row.value}`).join('\n')}`,
  }
}

/**
 * `$0.42`, or `$0.42 + ¥1.20` across currencies; undefined when no request was
 * priced, so a session on unpriced models shows no row rather than a zero.
 */
function formatSessionCost(cost: UsageCost | undefined): string | undefined {
  const amounts = Object.entries(cost?.amounts ?? {})
  if (amounts.length === 0) return undefined
  return amounts.map(([currency, amount]) => `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${formatCost(amount)}`).join(' + ')
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥' }

/** Enough digits to see a cheap turn move the number, without a wall of zeros. */
function formatCost(amount: number): string {
  if (amount === 0) return '0'
  if (amount < 0.01) return amount.toFixed(4)
  return amount.toFixed(2)
}

function costNote(cost: UsageCost): string | undefined {
  const notes = [
    ...(cost.unpriced ? ['开销未计入未设置价格的模型'] : []),
    ...(cost.legacy ? ['开销不含早期请求'] : []),
  ]
  return notes.length > 0 ? notes.join('；') : undefined
}

export type ContextGaugeLevel = 'normal' | 'warn' | 'critical'

export interface ContextGaugeView {
  /** False when either number is missing; the gauge is absent rather than empty. */
  readonly visible: boolean
  /** Clamped to 0..1 — a turn may momentarily report more than the threshold. */
  readonly ratio: number
  readonly percent: string
  readonly level: ContextGaugeLevel
  /** Formatted for the indicator's structured tooltip. Empty when not visible. */
  readonly used: string
  readonly usable: string
  readonly modelWindow: string | undefined
  /** Multi-line, for the indicator's accessible name. Empty when not visible. */
  readonly title: string
}

const HIDDEN: ContextGaugeView = Object.freeze({
  visible: false,
  ratio: 0,
  percent: '',
  level: 'normal' as const,
  used: '',
  usable: '',
  modelWindow: undefined,
  title: '',
})

/** The "nothing to draw" gauge, so callers with no numbers yet need no `undefined` branch. */
export function hiddenContextGauge(): ContextGaugeView {
  return HIDDEN
}

/**
 * How full the context is, against the window that is *actually usable*.
 *
 * The denominator is `usableContextWindow` — the loop's autocompact threshold,
 * i.e. the raw window minus the summary's reserved output and the safety
 * buffer. That is the number the conversation is measured against in practice:
 * the turn that crosses it gets compacted, so a percentage of the raw window
 * would promise room that no turn is ever allowed to use. The raw window is
 * still reported, on its own line, as context for the reserve.
 */
export function contextGaugeView(
  used: number | undefined,
  runtime: WireRuntimeSnapshot | undefined,
): ContextGaugeView {
  if (runtime?.status !== 'ready') return HIDDEN
  const usable = runtime?.usableContextWindow
  if (used === undefined || usable === undefined || usable <= 0) return HIDDEN

  const usedText = formatTokens(used)
  const usableText = formatTokens(usable)
  const modelWindow = runtime?.contextWindow !== undefined && runtime.contextWindow > usable
    ? formatTokens(runtime.contextWindow)
    : undefined

  const ratio = Math.min(1, Math.max(0, used / usable))
  const percent = `${Math.round(ratio * 100)}%`
  const level: ContextGaugeLevel = ratio >= CONTEXT_CRITICAL_RATIO
    ? 'critical'
    : ratio >= CONTEXT_WARN_RATIO
      ? 'warn'
      : 'normal'

  const lines = [
    // 「可用窗口」, not 「上下文窗口」: the percentage above is measured against
    // `usableContextWindow`, and calling it the context window promises the
    // reserve back.
    `可用窗口：${percent} 已用（剩余 ${100 - Math.round(ratio * 100)}%）`,
    `已用 ${usedText} token，共 ${usableText}（已预留自动压缩空间）`,
  ]
  if (modelWindow) lines.push(`模型窗口 ${modelWindow}`)

  return {
    visible: true,
    ratio,
    percent,
    level,
    used: usedText,
    usable: usableText,
    modelWindow,
    title: lines.join('\n'),
  }
}
