import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { settleScript, type SettleProbe } from '../src/desktop/browser/inject/bundle.js'
import { NetworkActivity, type NetworkState } from '../src/desktop/browser/network.js'
import { describeSettle, waitForSettle, type SettleDeps } from '../src/desktop/browser/settle.js'

/** The settle loop on a fake clock: one probe and one network state per poll, the last repeating. */
function harness(options: {
  probes: Array<Partial<SettleProbe> | Error>
  networks?: NetworkState[]
  timeoutMs?: number
}): { deps: SettleDeps; polls: () => number } {
  let clock = 0
  let index = 0
  let netIndex = 0
  const deps: SettleDeps = {
    timeoutMs: options.timeoutMs ?? 1000,
    evaluate: async () => {
      const next = options.probes[Math.min(index, options.probes.length - 1)]!
      index += 1
      if (next instanceof Error) throw next
      return { ok: true, value: { readyState: 'complete', animations: 0, fontsLoading: false, layout: 1, ...next } }
    },
    network: () => {
      const list = options.networks ?? [{ pending: [], quietMs: Infinity }]
      return list[Math.min(netIndex++, list.length - 1)]!
    },
    generation: () => 1,
    check: () => undefined,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { deps, polls: () => index }
}

test('a still page settles on the second look, never the first', async () => {
  const { deps, polls } = harness({ probes: [{}] })
  const report = await waitForSettle(deps)
  assert.equal(report.settled, true)
  assert.equal(polls(), 2)
  assert.match(describeSettle(report), /^The page was settled after 100ms\.$/)
})

test('a moving layout, a running animation and loading fonts each hold it up until they stop', async () => {
  const { deps, polls } = harness({
    probes: [{ layout: 1 }, { layout: 2 }, { layout: 3, animations: 1 }, { layout: 3, fontsLoading: true }, { layout: 3 }],
  })
  const report = await waitForSettle(deps)
  assert.equal(report.settled, true)
  assert.equal(polls(), 5)
})

test('a page that never settles is reported, not failed, and names what was still going on', async () => {
  const { deps } = harness({
    probes: [{ animations: 2 }],
    networks: [{ pending: [{ url: 'https://x.test/api/items?page=2', ageMs: 300 }], quietMs: 0 }],
    timeoutMs: 500,
  })
  const report = await waitForSettle(deps)
  assert.equal(report.settled, false)
  assert.equal(report.waitedMs, 500)
  const line = describeSettle(report)
  assert.match(line, /still changing after 500ms/)
  assert.match(line, /2 animations running/)
  assert.match(line, /1 request in flight: x\.test\/api\/items/)
  assert.match(line, /mid-transition/)
})

test('a request running past the long-request mark is not waited for, but is mentioned', async () => {
  const { deps } = harness({
    probes: [{}],
    networks: [{ pending: [{ url: 'https://x.test/stream', ageMs: 5000 }], quietMs: 5000 }],
  })
  const report = await waitForSettle(deps)
  assert.equal(report.settled, true)
  assert.match(describeSettle(report), /1 long-running request not waited for: x\.test\/stream/)
})

test('the network has to have been quiet for a while, not merely empty', async () => {
  const { deps, polls } = harness({
    probes: [{}],
    networks: [{ pending: [], quietMs: 50 }, { pending: [], quietMs: 150 }, { pending: [], quietMs: 600 }],
  })
  assert.equal((await waitForSettle(deps)).settled, true)
  assert.equal(polls(), 3)
})

test('an abort raised by check ends the wait', async () => {
  const { deps } = harness({ probes: [{ animations: 1 }] })
  deps.check = () => {
    throw new Error('cancelled')
  }
  await assert.rejects(waitForSettle(deps), /cancelled/)
})

test('a poll that never comes back ends the settle window instead of holding the turn', async () => {
  const deps: SettleDeps = {
    timeoutMs: 30,
    evaluate: () => new Promise<unknown>(() => {}),
    network: () => ({ pending: [], quietMs: Infinity }),
    generation: () => 1,
    check: () => undefined,
  }
  const report = await waitForSettle(deps)
  assert.equal(report.settled, false, 'a page that will not answer was not seen settle')
  assert.match(describeSettle(report), /still changing/)
})

test('network bookkeeping: in flight until it ends, quiet counted from the last event, forgotten with the page', () => {
  let clock = 0
  const network = new NetworkActivity(() => clock)
  assert.deepEqual(network.state(7), { pending: [], quietMs: Infinity })
  network.started(7, 1, 'https://x.test/a')
  clock = 300
  assert.deepEqual(network.state(7), { pending: [{ url: 'https://x.test/a', ageMs: 300 }], quietMs: 300 })
  network.ended(7, 1)
  clock = 400
  assert.deepEqual(network.state(7), { pending: [], quietMs: 100 })
  network.ended(8, 1)
  network.forget(7)
  assert.deepEqual(network.state(7), { pending: [], quietMs: Infinity })
})

/** Just enough DOM for the probe: boxes, parents, and the document's animation list. */
function probePage(options: { spinnerAngle: number; finite: number }): SettleProbe {
  const box = (top: number, parentElement: unknown = null) => ({
    parentElement,
    getBoundingClientRect: () => ({ top, left: 0, width: 100, height: 20 }),
  })
  const body = box(0)
  const spinner = { parentElement: body, getBoundingClientRect: () => ({ top: options.spinnerAngle, left: 0, width: 10, height: 10 }) }
  const spinnerChild = { parentElement: spinner, getBoundingClientRect: () => ({ top: options.spinnerAngle, left: 0, width: 5, height: 5 }) }
  const animation = (endTime: number, target: unknown) => ({
    playState: 'running',
    effect: { target, getComputedTiming: () => ({ endTime }) },
  })
  const document = {
    readyState: 'complete',
    fonts: { status: 'loaded' },
    getAnimations: () => [
      animation(Infinity, spinner),
      ...Array.from({ length: options.finite }, () => animation(300, body)),
    ],
    getElementsByTagName: () => [body, box(20, body), spinner, spinnerChild],
  }
  const window = { innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0 }
  const raw = vm.runInNewContext(settleScript(400), { document, window }) as { ok: boolean; value: SettleProbe }
  assert.equal(raw.ok, true)
  return raw.value
}

test('the probe counts animations that will end and ignores what an endless one moves', () => {
  const first = probePage({ spinnerAngle: 0, finite: 2 })
  const later = probePage({ spinnerAngle: 45, finite: 0 })
  assert.equal(first.animations, 2)
  assert.equal(later.animations, 0)
  assert.equal(first.fontsLoading, false)
  // The spinner and its child moved; nothing else did, so the layout reads the same.
  assert.equal(first.layout, later.layout)
})
