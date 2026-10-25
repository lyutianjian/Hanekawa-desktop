import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { abortedError, stuckError, withinBounds } from '../src/desktop/browser/bounds.js'
import { BrowserHostError } from '../src/desktop/browser/errors.js'
import { AUTOMATION_CALL_TIMEOUT_MS } from '../src/desktop/browser/limits.js'

/**
 * The deadline and the cancel signal every call into the page goes through.
 *
 * Something to hang on purpose is the whole point: a real hung page is an
 * `alert()` or a script looping in the renderer's own event loop, which no unit
 * test can produce. What these pin is the promise arithmetic around it — that a
 * call settles once, on time, without holding a timer or a listener, and that
 * nothing delivered after a cancellation reaches the caller.
 */

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

async function rejectsWith(promise: Promise<unknown>, code: string, pattern: RegExp): Promise<BrowserHostError> {
  let thrown: unknown
  await promise.catch((error: unknown) => {
    thrown = error
  })
  assert.ok(thrown instanceof BrowserHostError, `expected a BrowserHostError, got ${String(thrown)}`)
  assert.equal(thrown.code, code)
  assert.match(thrown.message, pattern)
  return thrown
}

test('a call that never answers is ended at its deadline', async () => {
  const error = await rejectsWith(
    withinBounds({ timeoutMs: 10 }, 'reading the page', never),
    'PAGE_NOT_READY',
    /did not answer within 10ms while reading the page/,
  )
  assert.equal(error.retryable, true, 'a stuck page is worth one more try once it is usable')
})

test('the deadline is a default, so no call into the page is unbounded', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const call = withinBounds(undefined, 'reading the page', never)
    mock.timers.tick(AUTOMATION_CALL_TIMEOUT_MS)
    const error = await rejectsWith(call, 'PAGE_NOT_READY', new RegExp(`within ${AUTOMATION_CALL_TIMEOUT_MS}ms`))
    assert.equal(error.retryable, true)
  } finally {
    mock.timers.reset()
  }
})

test('a timeout says the wait was ended, never that the page was stopped', async () => {
  const message = stuckError('clicking', 25).message
  assert.match(message, /The wait was ended/)
  assert.match(message, /stays done/)
  assert.match(message, /The tab was left as it is/)
  assert.doesNotMatch(message, /stopped the (page|script)|interrupted the page|killed/i)
})

test('a cancelled call settles at once rather than waiting for its deadline', async () => {
  const controller = new AbortController()
  const call = withinBounds({ signal: controller.signal, timeoutMs: 60_000 }, 'reading the page', never)
  controller.abort()
  const error = await rejectsWith(call, 'OPERATION_ABORTED', /was cancelled/)
  assert.equal(error.retryable, false, 'a cancellation is the caller asking; retrying would ignore it')
})

test('a signal that is already aborted never runs the page script', async () => {
  const controller = new AbortController()
  controller.abort()
  let started = 0
  await rejectsWith(
    withinBounds({ signal: controller.signal }, 'reading the page', async () => {
      started++
      return 1
    }),
    'OPERATION_ABORTED',
    /was cancelled/,
  )
  assert.equal(started, 0, 'a cancelled action must not reach the page at all')
})

test('a late answer after a cancellation is dropped, not delivered', async () => {
  const controller = new AbortController()
  let answer: (value: unknown) => void = () => {}
  let settlements = 0
  let value: unknown
  const call = withinBounds({ signal: controller.signal, timeoutMs: 60_000 }, 'reading the page', () => {
    return new Promise<unknown>((resolve) => {
      answer = resolve
    })
  })
  const watched = call.then(
    (result) => {
      settlements++
      value = result
    },
    () => {
      settlements++
    },
  )
  controller.abort()
  await watched
  answer({ ref: 'e1', x: 10, y: 20 })
  // Two turns, so a second settlement would have run by now.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settlements, 1, 'the call settles exactly once')
  assert.equal(value, undefined, 'the answer that arrived after the cancel never reached the caller')
})

test('a late failure after a cancellation does not surface as unhandled', async () => {
  const controller = new AbortController()
  let fail: (error: Error) => void = () => {}
  const call = withinBounds({ signal: controller.signal, timeoutMs: 60_000 }, 'reading the page', () => {
    return new Promise<unknown>((_resolve, reject) => {
      fail = reject
    })
  })
  controller.abort()
  await assert.rejects(call, /was cancelled/)
  fail(new Error('the renderer went away'))
  // node:test fails the file on an unhandled rejection, so reaching here is the assertion.
  await new Promise((resolve) => setImmediate(resolve))
})

test('an answer inside the deadline is passed through untouched', async () => {
  const value = await withinBounds({ timeoutMs: 1_000 }, 'reading the page', async () => ({ ok: 'yes' }))
  assert.deepEqual(value, { ok: 'yes' })
})

test('the error the call raised is the one reported, not a timeout', async () => {
  const original = new BrowserHostError('PAGE_NOT_READY', 'The page could not be read: frame detached', true)
  const error = await rejectsWith(
    withinBounds({ timeoutMs: 1_000 }, 'reading the page', async () => {
      throw original
    }),
    'PAGE_NOT_READY',
    /frame detached/,
  )
  assert.equal(error, original)
})

test('a start that throws synchronously rejects instead of escaping', async () => {
  // Neither seam throws before returning a promise, so this only has to hold for
  // the arithmetic: the throw becomes this call's rejection, not an escaping one.
  const boom = new Error('not attached')
  await assert.rejects(
    withinBounds({ timeoutMs: 1_000 }, 'sending the input command Input.dispatchMouseEvent', () => {
      throw boom
    }),
    (error: unknown) => error === boom,
  )
})

test('a settled call leaves no timer behind to keep the process awake', async () => {
  const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
  await withinBounds({ timeoutMs: 60_000 }, 'reading the page', async () => 'quick')
  const after = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
  assert.equal(after, before, 'the deadline timer must be cleared when the call answers')
})

test('the cancellation error is the same one the host raises between awaits', () => {
  const error = abortedError()
  assert.equal(error.code, 'OPERATION_ABORTED')
  assert.equal(error.message, 'The browser action was cancelled.')
  assert.equal(error.retryable, false)
})