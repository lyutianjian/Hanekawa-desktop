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

// The codes the message fallback always covered; read from `error.code` so an
// SDK error with an empty message still reads as a dropped connection.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE'])

/**
 * A status token only counts when the message names it as a status — a bare
 * number in an error text is usually a token count or a duration, and the
 * number inside a larger word ("5290", "215290") is not a status at all.
 */
const MESSAGE_STATUS_TOKEN =
  /(?:^|\b(?:http(?:\s+status)?|status|statuscode|code|error|got|received|returned|responded(?:\s+with)?)\b\s*[:=]?\s*|\()(\d{3})\b/i

function structuredStatus(error: Error): number | undefined {
  const candidate = error as Error & { status?: unknown; statusCode?: unknown }
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value < 600) return value
  }
  return undefined
}

function categoryForStatus(status: number): RetryErrorCategory | undefined {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 529) return 'overload'
  // A request timeout is the one 4xx that means "ask again".
  if (status === 408) return 'transient'
  if (status >= 500 && status < 600) return 'server_error'
  if (status >= 400 && status < 500) return 'unknown'
  return undefined
}

function messageStatus(message: string): number | undefined {
  const match = MESSAGE_STATUS_TOKEN.exec(message)
  if (!match) return undefined
  const status = Number(match[1])
  return status >= 100 && status < 600 ? status : undefined
}

function networkCode(error: Error): string | undefined {
  const direct = (error as { code?: unknown }).code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: { code?: unknown } }).cause
  return typeof cause?.code === 'string' ? cause.code : undefined
}

/**
 * Classify a thrown error into a retry category. A structured status from the
 * Anthropic/OpenAI SDK is authoritative and is never overruled by numbers or
 * words in the message: a 400 "prompt is too long: 215290 tokens" is a failed
 * request, not an overload, and "could not generate" is not a rate limit.
 * Text rules run only when the error carries no status, and they match a
 * status token or a real limit phrase rather than any digit or the "rate"
 * inside "generate".
 */
export function classifyError(error: unknown): RetryErrorCategory {
  if (!(error instanceof Error)) return 'unknown'
  // A cancellation is the caller's decision, not a transient fault. The SDKs'
  // abort errors carry no status and only the message "Request was aborted."
  if (error.name === 'AbortError'
    || error instanceof OpenAI.APIUserAbortError
    || error instanceof Anthropic.APIUserAbortError) {
    return 'unknown'
  }
  // SDK network failures and timeouts ("Connection error.", "Request timed out.") carry no status.
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError) return 'transient'

  const status = structuredStatus(error)
  if (status !== undefined) return categoryForStatus(status) ?? 'unknown'

  const code = networkCode(error)?.toUpperCase()
  if (code !== undefined && TRANSIENT_CODES.has(code)) return 'transient'

  const msg = error.message.toLowerCase()
  const msgStatus = messageStatus(msg)
  if (msgStatus !== undefined) return categoryForStatus(msgStatus) ?? 'unknown'

  if (msg.includes('unauthorized') || msg.includes('forbidden')) return 'auth'
  if (msg.includes('overload')) return 'overload'
  if (/\brate[ _-]?limit/.test(msg) || msg.includes('too many requests')) return 'rate_limit'
  if (msg.includes('timeout') || msg.includes('timed out')) return 'transient'
  if (msg.includes('stream ended')) return 'transient'
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('epipe')) return 'transient'
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
