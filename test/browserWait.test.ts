import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserHostError } from '../src/desktop/browser/errors.js'
import { waitForCondition, type WaitCondition, type WaitDeps } from '../src/desktop/browser/wait.js'

/**
 * The wait loop, driven by a fake clock.
 *
 * Real sleeping would make these tests slow and flaky in the same stroke, and
 * the behaviour under test is arithmetic anyway: when it polls, what it keeps
 * from each observation, and which of the two failures it is allowed to turn
 * into a timeout.
 */

interface Observation {
  matched: boolean
  observed: string
}

function harness(options: {
  observations: Array<Observation | Error>
  timeoutMs?: number
  generations?: Array<number | undefined>
  /** Successive committed URLs, one per poll; the last one repeats. */
  urls?: Array<string | undefined>
}): { deps: WaitDeps; polls: () => number; elapsed: () => number } {
  let index = 0
  let clock = 0
  let generationIndex = 0
  let urlIndex = 0

  const deps: WaitDeps = {
    timeoutMs: options.timeoutMs ?? 1000,
    evaluate: async () => {
      const next = options.observations[Math.min(index, options.observations.length - 1)]
      index += 1
      if (next instanceof Error) throw next
      return { ok: true, value: { ...next, url: 'https://x.test/', title: 'X' } }
    },
    generation: () => {
      const list = options.generations
      if (list === undefined) return 1
      const value = list[Math.min(generationIndex, list.length - 1)]
      generationIndex += 1
      return value
    },
    url: () => {
      const list = options.urls ?? ['https://x.test/']
      const value = list[Math.min(urlIndex, list.length - 1)]
      urlIndex += 1
      return value
    },
    check: () => undefined,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { deps, polls: () => index, elapsed: () => clock }
}

const condition: WaitCondition = { selector: '#done' }

test('a condition already met answers on the first poll', async () => {
  const { deps, polls, elapsed } = harness({ observations: [{ matched: true, observed: '#done is visible' }] })
  const result = await waitForCondition(deps, condition)
  assert.match(result.text, /#done is visible\. url=https:\/\/x\.test\/ title=X/)
  assert.equal(polls(), 1)
  assert.equal(elapsed(), 0, 'nothing may sleep once the answer is in')
})

test('an unmet condition is polled until it holds', async () => {
  const { deps, polls, elapsed } = harness({
    observations: [
      { matched: false, observed: 'still loading' },
      { matched: false, observed: 'still loading' },
      { matched: true, observed: '#done is visible' },
    ],
  })
  await waitForCondition(deps, condition)
  assert.equal(polls(), 3)
  assert.equal(elapsed(), 200)
})

test('a timeout carries the last thing actually seen', async () => {
  const { deps } = harness({
    observations: [{ matched: false, observed: '"Loaded" is not visible in the page' }],
    timeoutMs: 300,
  })
  await assert.rejects(
    () => waitForCondition(deps, condition),
    (error: unknown) => {
      assert.ok(error instanceof BrowserHostError)
      assert.equal(error.code, 'WAIT_TIMEOUT')
      assert.match(error.message, /within 300ms/)
      assert.match(error.message, /Last seen: "Loaded" is not visible in the page/)
      assert.equal((error as unknown as { lastObserved: string }).lastObserved, '"Loaded" is not visible in the page')
      return true
    },
  )
})

test('a timeout before any observation says exactly that', async () => {
  const { deps } = harness({
    observations: [Object.assign(new Error('The page could not be read.'), { retryable: true })],
    timeoutMs: 100,
  })
  await assert.rejects(
    () => waitForCondition(deps, condition),
    (error: unknown) => error instanceof BrowserHostError && /Last seen: The page could not be read/.test(error.message),
  )

  const silent = harness({ observations: [{ matched: false, observed: '' }], timeoutMs: 0 })
  // A zero budget still polls once: the answer may already be true.
  await assert.rejects(() => waitForCondition(silent.deps, condition))
})

test('a page that cannot answer yet is waited out; one that never will is not', async () => {
  const retryable = harness({
    observations: [
      Object.assign(new Error('The page has not finished loading.'), { retryable: true }),
      { matched: true, observed: '#done is visible' },
    ],
  })
  const result = await waitForCondition(retryable.deps, condition)
  assert.match(result.text, /#done is visible/)

  const fatal = harness({
    observations: [new BrowserHostError('INVALID_REQUEST', 'not a usable CSS selector: #)')],
  })
  await assert.rejects(
    () => waitForCondition(fatal.deps, condition),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
})

test('a navigation mid-wait is noted rather than treated as a failure', async () => {
  const { deps } = harness({
    observations: [
      { matched: false, observed: 'no element matches #done' },
      { matched: true, observed: '#done is visible' },
    ],
    generations: [4, 5],
  })
  const result = await waitForCondition(deps, condition)
  assert.match(result.text, /the document changed while waiting/)
})

test('a wait with nothing to wait for is refused', async () => {
  const { deps } = harness({ observations: [{ matched: true, observed: 'x' }] })
  await assert.rejects(
    () => waitForCondition(deps, {}),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
})

test('an already aborted wait stops before it asks the page anything', async () => {
  const { deps, polls } = harness({ observations: [{ matched: true, observed: 'x' }] })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => waitForCondition({ ...deps, signal: controller.signal }, condition),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )
  assert.equal(polls(), 0)
})

test('a URL condition holds once the committed address matches, and never asks the page', async () => {
  const { deps, polls, elapsed } = harness({
    observations: [new Error('the page must not be asked')],
    urls: ['https://shop.test/cart', 'https://shop.test/checkout/step-1'],
  })
  const result = await waitForCondition(deps, { url: 'https://shop.test/checkout' })
  assert.equal(polls(), 0)
  assert.equal(elapsed(), 100, 'it matched on the second poll')
  assert.match(result.text, /url starts with https:\/\/shop\.test\/checkout\. url=https:\/\/shop\.test\/checkout\/step-1/)

  const exact = harness({ observations: [], urls: ['https://a.test/x?y=1'] })
  await assert.rejects(() => waitForCondition({ ...exact.deps, timeoutMs: 0 }, { url: 'https://a.test/x', urlMatch: 'exact' }))
  const contains = harness({ observations: [], urls: ['https://a.test/x?y=1'] })
  await waitForCondition(contains.deps, { url: 'y=1', urlMatch: 'contains' })
})

test('a URL plus a text needs both, and a timeout says which URL it last saw', async () => {
  const both = harness({
    observations: [
      { matched: true, observed: 'found "Thanks" in: Thanks!' },
    ],
    urls: [undefined, 'https://a.test/old', 'https://a.test/done'],
  })
  const result = await waitForCondition(both.deps, { url: 'https://a.test/done', text: 'Thanks' })
  // The page is only asked once the address is right.
  assert.equal(both.polls(), 1)
  assert.match(result.text, /^url starts with https:\/\/a\.test\/done, and found "Thanks"/)

  const stuck = harness({
    observations: [{ matched: false, observed: '"Thanks" is not visible in the page' }],
    urls: ['https://a.test/done'],
    timeoutMs: 200,
  })
  await assert.rejects(
    () => waitForCondition(stuck.deps, { url: 'https://a.test/done', text: 'Thanks' }),
    /Last seen: url=https:\/\/a\.test\/done; "Thanks" is not visible/,
  )

  const elsewhere = harness({ observations: [], urls: ['https://a.test/login'], timeoutMs: 200 })
  await assert.rejects(
    () => waitForCondition(elsewhere.deps, { url: 'https://a.test/done' }),
    (error: unknown) =>
      error instanceof BrowserHostError && error.code === 'WAIT_TIMEOUT' && /Last seen: url=https:\/\/a\.test\/login/.test(error.message),
  )
})

test('stableForMs waits for the condition to hold without a break', async () => {
  const { deps, polls, elapsed } = harness({
    observations: [
      { matched: true, observed: '#done is visible' },
      { matched: false, observed: '#done is present but not visible' },
      { matched: true, observed: '#done is visible' },
    ],
  })
  const result = await waitForCondition(deps, { selector: '#done', stableForMs: 250 })
  // Held at 0, broken at 100, held again from 200: success at 450, not 250.
  assert.equal(elapsed(), 450)
  assert.equal(polls(), 6)
  assert.match(result.text, /#done is visible\. url=.* \(held for 250ms\)/)
})

test('a condition that never holds long enough times out saying how long it held', async () => {
  const { deps } = harness({
    observations: [
      { matched: true, observed: '#done is visible' },
      { matched: false, observed: 'gone' },
    ],
    timeoutMs: 300,
  })
  await assert.rejects(
    () => waitForCondition(deps, { selector: '#done', stableForMs: 250 }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'WAIT_TIMEOUT' && /Last seen: gone/.test(error.message),
  )
})

test('a document swap restarts the stability clock', async () => {
  const { deps, elapsed } = harness({
    observations: [{ matched: true, observed: '#done is visible' }],
    generations: [1, 1, 1, 2, 2],
  })
  await waitForCondition(deps, { selector: '#done', stableForMs: 150 })
  // Held from 0 on generation 1, restarted at 100 on generation 2.
  assert.equal(elapsed(), 250)
})

test('an element state needs a selector and no text', async () => {
  const { deps, polls } = harness({ observations: [{ matched: true, observed: 'x' }] })
  await assert.rejects(
    () => waitForCondition(deps, { text: 'Go', state: 'enabled' }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
  assert.equal(polls(), 0)
})

test('a page that never answers a poll ends the wait on the wait\'s own deadline', async () => {
  let asked = 0
  const deps: WaitDeps = {
    timeoutMs: 20,
    evaluate: () => {
      asked += 1
      return new Promise<unknown>(() => {})
    },
    generation: () => 1,
    check: () => undefined,
  }

  await assert.rejects(
    () => waitForCondition(deps, condition),
    (error: unknown) =>
      error instanceof BrowserHostError &&
      error.code === 'WAIT_TIMEOUT' &&
      /not met within 20ms\. Last seen: The page did not answer/.test(error.message),
  )
  // Each poll is bounded by what is left of the wait, so the loop gets at most a
  // second, shorter one before its deadline lands; what it must never do is ask again
  // once the wait it was given is over.
  assert.ok(asked <= 2, `a stuck poll must not be retried past the wait's deadline (asked ${asked})`)
})

test('a cancel during a hung poll ends the wait instead of waiting out its timeout', async () => {
  const controller = new AbortController()
  let started = (): void => {}
  const asked = new Promise<void>((resolve) => {
    started = resolve
  })
  const deps: WaitDeps = {
    timeoutMs: 60_000,
    signal: controller.signal,
    evaluate: () => {
      started()
      return new Promise<unknown>(() => {})
    },
    generation: () => 1,
    check: () => undefined,
  }

  const waiting = waitForCondition(deps, condition)
  await asked
  controller.abort()
  await assert.rejects(
    waiting,
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )
})
