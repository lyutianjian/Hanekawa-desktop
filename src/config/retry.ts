/**
 * Retry policy for provider HTTP calls.
 *
 * Errors are classified into a small set of categories. Each category has its
 * own retry budget, so a 429 (rate limit) and a 529 (overloaded) are no longer
 * treated as the same problem. 401/403 fail fast — credentials don't fix
 * themselves on retry.
 *
 * For 529 specifically, hammering an overloaded backend with retries makes
 * things worse. Background callers (e.g. the auto-compaction summarizer) skip
 * 529 retries entirely so they don't pile on top of the user's interactive
 * traffic.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export type RetryCallerKind = 'interactive' | 'background'

export type RetryErrorCategory =
  | 'rate_limit' // HTTP 429
  | 'overload' // HTTP 529 (Anthropic) or "overloaded" message
  | 'server_error' // 5xx other than 529
  | 'auth' // 401, 403 — never retry
  | 'transient' // ECONNRESET / ECONNREFUSED / timeout / stream ended
  | 'unknown'

export interface RetryPolicyLimits {
  rateLimit: number
  overload: number
  serverError: number
  transient: number
}

export const PERSISTENT_MAX_DELAY_MS = 300_000
export const DEFAULT_PERSISTENT_MAX_RETRIES = 12

export const DEFAULT_RETRY_LIMITS: RetryPolicyLimits = {
  rateLimit: 3,
  overload: 2,
  serverError: 5,
  transient: 3,
}

export const DEFAULT_PERSISTENT_RETRY_LIMITS: RetryPolicyLimits = {
  rateLimit: DEFAULT_PERSISTENT_MAX_RETRIES,
  overload: DEFAULT_RETRY_LIMITS.overload,
  serverError: DEFAULT_PERSISTENT_MAX_RETRIES,
  transient: DEFAULT_PERSISTENT_MAX_RETRIES,
}

export interface RetryOptions {
  /**
   * Cap on the maximum number of retries across all categories. The
   * per-category limit is `Math.min(limits[category], maxRetries)`. Defaults
   * to 5 normally, or the persistent retry cap when persistent mode is enabled.
   */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterFactor?: number
  /**
   * Expand retry budgets for unattended/background maintenance work. This keeps
   * fail-open tasks resilient to temporary 5xx/network issues without changing
   * the interactive default. Background 529 overloads still fail fast.
   */
  persistent?: boolean
  signal?: AbortSignal
  /**
   * Override per-category retry caps. Missing keys fall back to the active
   * default policy.
   */
  limits?: Partial<RetryPolicyLimits>
  /**
   * Caller kind. Background callers don't retry 529. Defaults to
   * 'interactive'.
   */
  callerKind?: RetryCallerKind
  /**
   * Optional caller-supplied predicate. When provided, it acts as an extra
   * filter on top of the category-based decision: an error must satisfy both
   * the category limit AND `shouldRetry` to be retried. This lets callers
   * narrow the policy further but never widen it.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /** Told before each backoff sleep: which attempt failed, why, and how long until the next. */
  onRetry?: (retry: { attempt: number; category: RetryErrorCategory; delayMs: number }) => void
}

export class FallbackTriggeredError extends Error {
  readonly originalError: unknown
  readonly attempts: number

  constructor(originalError: unknown, attempts: number) {
    super('Primary model overloaded after retry budget; fallback model should be used.')
    this.name = 'FallbackTriggeredError'
    this.originalError = originalError
    this.attempts = attempts
  }
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500
  const persistent = options.persistent ?? false
  const maxDelayMs = options.maxDelayMs ?? (persistent ? PERSISTENT_MAX_DELAY_MS : 32_000)
  const jitterFactor = options.jitterFactor ?? 0.25
  const callerKind: RetryCallerKind = options.callerKind ?? 'interactive'
  const globalCap = options.maxRetries ?? (persistent ? DEFAULT_PERSISTENT_MAX_RETRIES : 5)
  const limits: RetryPolicyLimits = {
    ...(persistent ? DEFAULT_PERSISTENT_RETRY_LIMITS : DEFAULT_RETRY_LIMITS),
    ...(options.limits ?? {}),
  }

  // Track per-category retry counts so a long-running call mixing 5xx and 429
  // can't exceed any single budget.
  const used: Record<RetryErrorCategory, number> = {
    rate_limit: 0,
    overload: 0,
    server_error: 0,
    auth: 0,
    transient: 0,
    unknown: 0,
  }

  let attempt = 0
  // Loop without a hard upper bound; each error path either retries (within a
  // budget) or throws. The category caps guarantee termination.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++
    if (options.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    try {
      return await operation(attempt)
    } catch (error) {
      const category = classifyError(error)
      const budget = budgetFor(category, callerKind, limits, globalCap)

      if (budget <= 0) throw error
      if (used[category] >= budget) {
        if (category === 'overload' && callerKind === 'interactive') {
          throw new FallbackTriggeredError(error, attempt)
        }
        throw error
      }
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) throw error

      used[category]++
      const delay = calculateRetryDelay(category, used[category], attempt, baseDelayMs, maxDelayMs, jitterFactor)
      options.onRetry?.({ attempt, category, delayMs: delay })
      await sleep(delay, options.signal)
    }
  }
}

function budgetFor(
  category: RetryErrorCategory,
  callerKind: RetryCallerKind,
  limits: RetryPolicyLimits,
  globalCap: number,
): number {
  if (category === 'auth' || category === 'unknown') return 0
  if (category === 'overload' && callerKind === 'background') return 0
  const categoryLimit =
    category === 'rate_limit' ? limits.rateLimit
    : category === 'overload' ? limits.overload
    : category === 'server_error' ? limits.serverError
    : limits.transient
  return Math.max(0, Math.min(categoryLimit, globalCap))
}

export function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number = 0.25,
): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
  const jitter = exponentialDelay * jitterFactor * Math.random()
  return exponentialDelay + jitter
}

export function calculateRetryDelay(
  category: RetryErrorCategory,
  categoryRetryCount: number,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number = 0.25,
): number {
  if (category === 'transient' && categoryRetryCount === 1) return 0
  // 5xx backs off linearly: 2s, 3s, 4s, ...
  if (category === 'server_error') return Math.min((categoryRetryCount + 1) * 1000, maxDelayMs)
  return calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor)
}

/**
 * Classify a thrown error into a retry category. The status field comes from
 * Anthropic/OpenAI SDK errors; the message-fallback handles cases where the
 * SDK doesn't set status (network errors, stream timeouts).
 */
export function classifyError(error: unknown): RetryErrorCategory {
  if (!(error instanceof Error)) return 'unknown'
  // SDK network failures and timeouts ("Connection error.", "Request timed out.") carry no status.
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError) return 'transient'

  const status = (error as Error & { status?: number }).status
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 529) return 'overload'
  if (status !== undefined && status >= 500 && status < 600) return 'server_error'

  const msg = error.message.toLowerCase()
  // Order matters: 401/403 should be unambiguous, but if status was missing
  // and the message clearly indicates auth, treat it as auth.
  if (msg.includes('401') || msg.includes('unauthorized')) return 'auth'
  if (msg.includes('403') || msg.includes('forbidden')) return 'auth'
  if (msg.includes('overload') || msg.includes('529')) return 'overload'
  if (msg.includes('rate') || msg.includes('429')) return 'rate_limit'
  if (msg.includes('timeout')) return 'transient'
  if (msg.includes('stream ended')) return 'transient'
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('epipe')) return 'transient'
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return 'server_error'
  }
  return 'unknown'
}

/**
 * Backwards-compatible "is this retryable at all" predicate. Returns true if
 * the error falls into any retryable category (rate_limit, overload,
 * server_error, transient). 401/403/unknown return false.
 *
 * Callers that need finer control should use `classifyError` directly.
 */
export function isRetryableError(error: unknown): boolean {
  const category = classifyError(error)
  return (
    category === 'rate_limit'
    || category === 'overload'
    || category === 'server_error'
    || category === 'transient'
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }, { once: true })
  })
}
