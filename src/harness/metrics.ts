import type { CacheBreakSource } from './cacheBreakDetection.js'
import type { TokenUsage, UsageCost } from './types.js'
import { cacheCreationTokens, costField, reportsCacheCreation, promptTokens } from './usage.js'

/**
 * Persisted spend for an individual request or a legacy aggregate.
 */
export interface MetricUsage {
  input_tokens: number
  cache_creation_tokens?: number
  cache_read_tokens: number
  response_tokens: number
  /** Absent in sidecars written before costs were recorded. */
  cost?: UsageCost
}

export type SessionMetric =
  | {
      event: 'request_usage'
      created_at: string
      session_id: string
      model: string
      source: RequestUsageSource
      usage: MetricUsage
    }
  | {
      event: 'turn'
      created_at: string
      session_id: string
      model: string
      input_tokens?: number
      /**
       * Cache writes. Optional because sessions recorded before the split (and
       * endpoints that do not report writes) have none; a reader that needs the
       * prompt total must add it in as 0 rather than assume it was folded into
       * `input_tokens`.
       */
      cache_creation_tokens?: number
      response_tokens: number
      cache_read_tokens: number
      cache_hit_rate: number | null
      tool_calls: number
      duration_ms: number
      /** Absent in sidecars written before costs were recorded. */
      cost?: UsageCost
      /** Spend is already in request_usage; this event describes the response. */
      usageRecorded?: true
    }
  | {
      event: 'compact'
      created_at: string
      session_id: string
      model: string
      pre_tokens: number
      post_tokens: number
      compact_duration_ms: number
      usage?: MetricUsage
    }
  | {
      /** One finished subagent run, whose own requests never reach this sidecar. */
      event: 'subagent_usage'
      created_at: string
      session_id: string
      model: string
      usage: MetricUsage
    }
  | {
      /**
       * One model call made on the session's behalf outside its turns: a
       * tool-use summary, a generated title or a rewind summary.
       */
      event: 'aux_usage'
      created_at: string
      session_id: string
      model: string
      source: AuxUsageSource
      usage: MetricUsage
    }
  | {
      event: 'cache_break'
      created_at: string
      session_id: string
      source: CacheBreakSource
      reasons: string[]
      drop_tokens: number
    }
  | {
      event: 'session_cache_summary'
      created_at: string
      session_id: string
      total_cache_hit_rate: number | null
      total_turns: number
      first_break_turn_count: number | null
      cache_break_count: number
      cause_distribution: Record<string, number>
    }
  | {
      event: 'mcp_connect_failed'
      created_at: string
      session_id: string
      server: string
      error: string
    }

type MetricInput<T extends SessionMetric> = Omit<T, 'created_at' | 'session_id'>

export type AuxUsageSource = 'tool_summary' | 'session_title' | 'rewind_summary'
export type RequestUsageSource = AuxUsageSource | 'foreground' | 'compact' | 'subagent'

export interface RequestUsage {
  model: string
  source: RequestUsageSource
  usage: TokenUsage
}

export type SessionMetricInput =
  | MetricInput<Extract<SessionMetric, { event: 'request_usage' }>>
  | MetricInput<Extract<SessionMetric, { event: 'turn' }>>
  | MetricInput<Extract<SessionMetric, { event: 'compact' }>>
  | MetricInput<Extract<SessionMetric, { event: 'subagent_usage' }>>
  | MetricInput<Extract<SessionMetric, { event: 'aux_usage' }>>
  | MetricInput<Extract<SessionMetric, { event: 'cache_break' }>>
  | MetricInput<Extract<SessionMetric, { event: 'session_cache_summary' }>>
  | MetricInput<Extract<SessionMetric, { event: 'mcp_connect_failed' }>>

// The hit rate itself lives in `usage.ts`, beside `promptTokens()`: it is a
// function of a `TokenUsage`, not of two loose numbers, and the denominator has
// to include cache writes — which a caller passing `(inputTokens, readTokens)`
// cannot supply.

export function toMetricUsage(usage: TokenUsage): MetricUsage {
  return {
    input_tokens: usage.inputTokens,
    ...(reportsCacheCreation(usage) ? { cache_creation_tokens: cacheCreationTokens(usage) } : {}),
    cache_read_tokens: usage.cacheReadInputTokens,
    response_tokens: usage.outputTokens,
    ...costField(usage.cost),
  }
}

/** What one metric spent, or undefined for an event that carries no usage. */
export function metricTokenUsage(metric: SessionMetric): TokenUsage | undefined {
  if (metric.event === 'turn' && metric.usageRecorded) return undefined
  const fields: MetricUsage | undefined = metric.event === 'turn'
    ? { ...metric, input_tokens: inferTurnInputTokens(metric) }
    : metric.event === 'compact' || metric.event === 'subagent_usage' || metric.event === 'aux_usage' || metric.event === 'request_usage'
      ? metric.usage
      : undefined
  if (!fields) return undefined
  const usage: TokenUsage = {
    inputTokens: Math.max(0, fields.input_tokens),
    ...(typeof fields.cache_creation_tokens === 'number'
      ? { cacheCreationInputTokens: Math.max(0, fields.cache_creation_tokens) }
      : {}),
    cacheReadInputTokens: Math.max(0, fields.cache_read_tokens),
    outputTokens: Math.max(0, fields.response_tokens),
  }
  if (fields.cost) return { ...usage, cost: fields.cost }
  return promptTokens(usage) + usage.outputTokens > 0 ? { ...usage, cost: { amounts: {}, legacy: true } } : usage
}

export function inferTurnInputTokens(turn: Extract<SessionMetric, { event: 'turn' }>): number {
  if (typeof turn.input_tokens === 'number' && Number.isFinite(turn.input_tokens)) {
    return Math.max(0, turn.input_tokens)
  }
  if (turn.cache_hit_rate && turn.cache_hit_rate > 0) {
    // The rate's denominator is the whole prompt, so what is left after the
    // reads is input *and* writes; subtract the writes when they were recorded.
    const total = turn.cache_read_tokens / turn.cache_hit_rate
    return Math.max(0, total - turn.cache_read_tokens - (turn.cache_creation_tokens ?? 0))
  }
  return 0
}
