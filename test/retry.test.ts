import test from 'node:test'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import assert from 'node:assert/strict'
import {
  calculateRetryDelay,
  classifyError,
  FallbackTriggeredError,
  isRetryableError,
  PERSISTENT_MAX_DELAY_MS,
  withRetry,
  type RetryErrorCategory,
} from '../src/config/retry.js'

function httpError(status: number, message = `status ${status}`): Error {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

// ---- classifyError -------------------------------------------------------

test('classifyError maps 401 and 403 to auth', () => {
  assert.equal(classifyError(httpError(401)), 'auth')
  assert.equal(classifyError(httpError(403)), 'auth')
})

test('classifyError maps 429 to rate_limit', () => {
  assert.equal(classifyError(httpError(429)), 'rate_limit')
})

test('classifyError maps 529 to overload', () => {
  assert.equal(classifyError(httpError(529)), 'overload')
})

test('classifyError maps other 5xx to server_error', () => {
  assert.equal(classifyError(httpError(500)), 'server_error')
  assert.equal(classifyError(httpError(502)), 'server_error')
  assert.equal(classifyError(httpError(503)), 'server_error')
  assert.equal(classifyError(httpError(504)), 'server_error')
})

test('classifyError uses message fallback for network errors', () => {
  assert.equal(classifyError(new Error('ECONNRESET on socket')), 'transient')
  assert.equal(classifyError(new Error('write EPIPE')), 'transient')
  assert.equal(classifyError(new Error('Stream ended unexpectedly')), 'transient')
  assert.equal(classifyError(new Error('Read timeout after 90s')), 'transient')
  assert.equal(classifyError(new OpenAI.APIConnectionTimeoutError()), 'transient')
  assert.equal(classifyError(new OpenAI.APIConnectionError({ message: undefined })), 'transient')
  assert.equal(classifyError(new Anthropic.APIConnectionTimeoutError()), 'transient')
})

test('classifyError uses message fallback for overload without status', () => {
  assert.equal(classifyError(new Error('upstream is overloaded')), 'overload')
  assert.equal(classifyError(new Error('got 529 from server')), 'overload')
})

test('classifyError returns unknown for non-Error and unmatched messages', () => {
  assert.equal(classifyError('not an error'), 'unknown')
  assert.equal(classifyError(null), 'unknown')
  assert.equal(classifyError(new Error('something weird happened')), 'unknown')
})

test('classifyError trusts a structured status over numbers in the message', () => {
  const cases: Array<[Error & { status?: number }, RetryErrorCategory]> = [
    [httpError(400, 'prompt is too long: 215290 tokens > 150000 maximum'), 'unknown'],
    [httpError(400, 'could not generate a response'), 'unknown'],
    [httpError(400, 'invalid request: rate limit setting is out of range'), 'unknown'],
    [httpError(413, 'request too large: 160000 tokens'), 'unknown'],
    [httpError(404, 'model not found'), 'unknown'],
    // An explicit 4xx stays non-retryable even when its wording sounds transient.
    [httpError(400, 'upstream is overloaded'), 'unknown'],
    [httpError(400, 'Read timeout'), 'unknown'],
    [httpError(429, 'requests per minute exceeded'), 'rate_limit'],
    // 408 is the one 4xx that a retry can fix, and it already was retried when
    // the message said "timed out".
    [httpError(408, 'Request timed out.'), 'transient'],
    [httpError(500, 'internal error'), 'server_error'],
    [httpError(529, 'overloaded'), 'overload'],
  ]
  for (const [error, expected] of cases) {
    assert.equal(classifyError(error), expected, `for ${error.status} ${error.message}`)
  }
})

test('classifyError message rules match whole status tokens and real limit phrases only', () => {
  const cases: Array<[Error, RetryErrorCategory]> = [
    // Numbers inside a larger token must never be read as an HTTP status.
    [new Error('usage was 215290 tokens'), 'unknown'],
    [new Error('max output 150000 was exceeded'), 'unknown'],
    [new Error('upstream reported 5290'), 'unknown'],
    // "generate"/"rate" substrings must not imply rate limiting.
    [new Error('could not generate output'), 'unknown'],
    [new Error('generated 120 items'), 'unknown'],
    [new Error('rate limit exceeded'), 'rate_limit'],
    [new Error('ratelimit_exceeded'), 'rate_limit'],
    [new Error('Too many requests, please slow down'), 'rate_limit'],
    [new Error('got 429 from upstream'), 'rate_limit'],
    [new Error('got 529 from server'), 'overload'],
    [new Error('server is overloaded'), 'overload'],
    [new Error('upstream returned 503'), 'server_error'],
    [new Error('connect ECONNREFUSED 127.0.0.1:443'), 'transient'],
    [new Error('Unauthorized: bad key'), 'auth'],
  ]
  for (const [error, expected] of cases) {
    assert.equal(classifyError(error), expected, `for ${error.message}`)
  }
})

test('classifyError reads a connection code even without a message', () => {
  const error = Object.assign(new Error(''), { code: 'ECONNRESET' })
  assert.equal(classifyError(error), 'transient')
})

test('classifyError treats a user cancellation as non-retryable', () => {
  const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
  assert.equal(classifyError(aborted), 'unknown')
  // The SDKs' own abort error carries no status and only the message "Request was aborted."
  assert.equal(classifyError(new OpenAI.APIUserAbortError()), 'unknown')
  assert.equal(classifyError(new Anthropic.APIUserAbortError()), 'unknown')
})

// ---- isRetryableError (back-compat) --------------------------------------

test('isRetryableError still reports retryable categories as true', () => {
  assert.equal(isRetryableError(httpError(429)), true)
  assert.equal(isRetryableError(httpError(529)), true)
  assert.equal(isRetryableError(httpError(503)), true)
  assert.equal(isRetryableError(new Error('ECONNRESET')), true)
})

test('isRetryableError reports auth and unknown as false', () => {
  assert.equal(isRetryableError(httpError(401)), false)
  assert.equal(isRetryableError(httpError(403)), false)
  assert.equal(isRetryableError(new Error('something weird')), false)
})

// ---- withRetry: per-category behaviour -----------------------------------

interface RecordedCall {
  attempt: number
}

function makeOperation(errors: unknown[], result?: unknown) {
  const calls: RecordedCall[] = []
  const op = async (attempt: number) => {
    calls.push({ attempt })
    if (calls.length <= errors.length) {
      throw errors[calls.length - 1]
    }
    return result
  }
  return { op, calls }
}

test('withRetry never retries on 401', async () => {
  const { op, calls } = makeOperation([httpError(401), httpError(401), httpError(401)])
  await assert.rejects(
    () => withRetry(op, { baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error & { status?: number }) => err.status === 401,
  )
  assert.equal(calls.length, 1)
})

test('withRetry never retries on 403', async () => {
  const { op, calls } = makeOperation([httpError(403)])
  await assert.rejects(
    () => withRetry(op, { baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error & { status?: number }) => err.status === 403,
  )
  assert.equal(calls.length, 1)
})

test('withRetry retries 429 up to maxRetries times', async () => {
  const { op, calls } = makeOperation(
    [httpError(429), httpError(429), httpError(429)],
    'ok',
  )
  const result = await withRetry(op, {
    maxRetries: 3,
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 4) // 1 initial + 3 retries
})

test('withRetry stops retrying 429 after exhausting category budget', async () => {
  const { op, calls } = makeOperation([
    httpError(429),
    httpError(429),
    httpError(429),
    httpError(429),
  ])
  await assert.rejects(
    () => withRetry(op, { maxRetries: 3, baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error & { status?: number }) => err.status === 429,
  )
  assert.equal(calls.length, 4) // 1 initial + 3 retries, then throw
})

test('withRetry caps 529 at 2 retries even when maxRetries is higher', async () => {
  const { op, calls } = makeOperation([
    httpError(529),
    httpError(529),
    httpError(529),
  ])
  await assert.rejects(
    () => withRetry(op, { maxRetries: 10, baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error) => err instanceof FallbackTriggeredError,
  )
  // 1 initial + 2 retries (the 3rd 529 exceeds the overload budget)
  assert.equal(calls.length, 3)
})

test('withRetry succeeds on 529 within the 2-retry overload budget', async () => {
  const { op, calls } = makeOperation([httpError(529), httpError(529)], 'ok')
  const result = await withRetry(op, {
    maxRetries: 10,
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 3)
})

test('withRetry never retries 529 for background callers', async () => {
  const { op, calls } = makeOperation([httpError(529)])
  await assert.rejects(
    () =>
      withRetry(op, {
        callerKind: 'background',
        maxRetries: 10,
        baseDelayMs: 0,
        jitterFactor: 0,
        maxDelayMs: 0,
      }),
    (err: Error & { status?: number }) => err.status === 529,
  )
  assert.equal(calls.length, 1)
})

test('withRetry still retries 429 for background callers', async () => {
  // Background callers should fail fast on 529 specifically; rate-limit 429
  // is normal backpressure and a small retry is fine.
  const { op, calls } = makeOperation([httpError(429), httpError(429)], 'ok')
  const result = await withRetry(op, {
    callerKind: 'background',
    maxRetries: 3,
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 3)
})

test('withRetry retries 5xx (non-529) up to maxRetries', async () => {
  const { op, calls } = makeOperation([httpError(500), httpError(503)], 'ok')
  const result = await withRetry(op, {
    maxRetries: 3,
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 3)
})

test('withRetry retries 5xx 5 times by default, other categories stay at 3', async () => {
  const opts = { baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }
  const server = makeOperation(Array.from({ length: 6 }, () => httpError(500)), 'ok')
  await assert.rejects(() => withRetry(server.op, opts))
  assert.equal(server.calls.length, 6)

  const rate = makeOperation(Array.from({ length: 4 }, () => httpError(429)), 'ok')
  await assert.rejects(() => withRetry(rate.op, opts))
  assert.equal(rate.calls.length, 4)
})

test('withRetry retries network errors (ECONNRESET)', async () => {
  const { op, calls } = makeOperation([new Error('ECONNRESET')], 'ok')
  const result = await withRetry(op, {
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 2)
})

test('withRetry uses immediate delay for the first transient retry', () => {
  assert.equal(calculateRetryDelay('transient', 1, 1, 500, 32_000, 0), 0)
  assert.equal(calculateRetryDelay('transient', 2, 2, 500, 32_000, 0), 1000)
})

test('5xx retries back off linearly from 2s', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => calculateRetryDelay('server_error', n, n, 500, 32_000, 0.25)), [2000, 3000, 4000, 5000, 6000])
  assert.equal(calculateRetryDelay('server_error', 3, 3, 500, 0, 0), 0)
})

test('withRetry persistent mode expands 5xx retry budget and caps delay at 5 minutes', async () => {
  const { op, calls } = makeOperation(
    [
      httpError(503),
      httpError(503),
      httpError(503),
      httpError(503),
    ],
    'ok',
  )
  const result = await withRetry(op, {
    persistent: true,
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 5)
  assert.equal(calculateRetryDelay('rate_limit', 12, 12, 500, PERSISTENT_MAX_DELAY_MS, 0), PERSISTENT_MAX_DELAY_MS)
})

test('withRetry persistent mode still fails fast on background 529', async () => {
  const { op, calls } = makeOperation([httpError(529)])
  await assert.rejects(
    () =>
      withRetry(op, {
        callerKind: 'background',
        persistent: true,
        baseDelayMs: 0,
        jitterFactor: 0,
      }),
    (err: Error & { status?: number }) => err.status === 529,
  )
  assert.equal(calls.length, 1)
})

test('withRetry never retries unknown errors', async () => {
  const { op, calls } = makeOperation([new Error('mystery')])
  await assert.rejects(
    () => withRetry(op, { baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    /mystery/,
  )
  assert.equal(calls.length, 1)
})

test('withRetry makes one request for an oversized 400 and never triggers fallback', async () => {
  const error = httpError(400, 'prompt is too long: 215290 tokens > 150000 maximum')
  const { op, calls } = makeOperation([error, error, error])
  await assert.rejects(
    () => withRetry(op, { maxRetries: 10, baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: unknown) => err === error,
  )
  assert.equal(calls.length, 1)
})

test('withRetry does not retry a request the caller cancelled mid-flight', async () => {
  const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
  const { op, calls } = makeOperation([aborted, aborted])
  await assert.rejects(
    () => withRetry(op, { maxRetries: 10, baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error) => err.name === 'AbortError',
  )
  assert.equal(calls.length, 1)
})

test('withRetry per-category budgets are independent', async () => {
  // 3 rate_limit retries + 2 overload retries should all succeed when the
  // category caps are honoured separately.
  const { op, calls } = makeOperation(
    [
      httpError(429),
      httpError(529),
      httpError(429),
      httpError(529),
      httpError(429),
    ],
    'ok',
  )
  const result = await withRetry(op, {
    maxRetries: 5,
    baseDelayMs: 0,
    jitterFactor: 0,
    maxDelayMs: 0,
  })
  assert.equal(result, 'ok')
  assert.equal(calls.length, 6)
})

test('withRetry exhausts overload budget independently of rate_limit budget', async () => {
  // 2 overload retries are allowed, the 3rd should throw even though plenty
  // of rate_limit budget is left.
  const { op, calls } = makeOperation([
    httpError(529),
    httpError(529),
    httpError(529),
  ])
  await assert.rejects(
    () => withRetry(op, { maxRetries: 10, baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error) => err instanceof FallbackTriggeredError,
  )
  assert.equal(calls.length, 3)
})

test('withRetry wraps exhausted interactive overloads in FallbackTriggeredError', async () => {
  const finalError = httpError(529)
  const { op } = makeOperation([
    httpError(529),
    httpError(529),
    finalError,
  ])

  await assert.rejects(
    () => withRetry(op, { maxRetries: 10, baseDelayMs: 0, jitterFactor: 0, maxDelayMs: 0 }),
    (err: Error) => {
      assert.ok(err instanceof FallbackTriggeredError)
      assert.equal(err.originalError, finalError)
      assert.equal(err.attempts, 3)
      return true
    },
  )
})

test('withRetry returns immediately when shouldRetry rejects', async () => {
  const { op, calls } = makeOperation([httpError(429)])
  await assert.rejects(
    () =>
      withRetry(op, {
        baseDelayMs: 0,
        jitterFactor: 0,
        maxDelayMs: 0,
        shouldRetry: () => false,
      }),
    (err: Error & { status?: number }) => err.status === 429,
  )
  assert.equal(calls.length, 1)
})

test('withRetry honours abort signal before invoking operation', async () => {
  const controller = new AbortController()
  controller.abort()
  let invoked = false
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          invoked = true
          return 'ok'
        },
        { signal: controller.signal },
      ),
    (err: Error) => err.name === 'AbortError',
  )
  assert.equal(invoked, false)
})

test('withRetry can be configured with custom limits', async () => {
  const { op, calls } = makeOperation([httpError(429), httpError(429)])
  await assert.rejects(
    () =>
      withRetry(op, {
        maxRetries: 10,
        limits: { rateLimit: 1, overload: 0, serverError: 0, transient: 0 },
        baseDelayMs: 0,
        jitterFactor: 0,
        maxDelayMs: 0,
      }),
    (err: Error & { status?: number }) => err.status === 429,
  )
  assert.equal(calls.length, 2) // 1 initial + 1 retry
})

test('classifyError integration coverage spans every category', () => {
  const cases: Array<[unknown, RetryErrorCategory]> = [
    [httpError(401), 'auth'],
    [httpError(403), 'auth'],
    [httpError(429), 'rate_limit'],
    [httpError(529), 'overload'],
    [httpError(500), 'server_error'],
    [new Error('ECONNRESET'), 'transient'],
    [new Error('something weird'), 'unknown'],
  ]
  for (const [err, expected] of cases) {
    assert.equal(classifyError(err), expected, `for ${String(err)}`)
  }
})
