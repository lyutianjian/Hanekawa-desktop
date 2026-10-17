import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createBridgeChannel,
  type BridgeWindow,
} from '../src/desktop/renderer/bridgeChannel.js'
import type { DesktopBridge } from '../src/desktop/types.js'

/**
 * The renderer half of the desktop transport.
 *
 * This covers the adapter the shipped renderer actually runs. It used to be an
 * object literal inline in `renderer/app.ts` while the suite tested a separate
 * `ipcRenderer`-shaped factory that production never called — so the tests
 * agreed with a mock instead of with the code. `createBridgeChannel` exists so
 * there is one implementation and the tests point at it.
 */

interface MockBridge extends DesktopBridge {
  /** Everything the renderer posted, in order. */
  readonly sent: unknown[]
  /** Deliver a host message to whoever is subscribed. */
  deliver(message: unknown): void
  /** How many bridge subscriptions are live. */
  subscriberCount(): number
  /** How many times `close()` was called. */
  closeCalls(): number
}

function createMockBridge(): MockBridge {
  const sent: unknown[] = []
  let handlers: Array<(event: unknown) => void> = []
  let closes = 0

  return {
    platform: 'win32',
    pathForFile: () => '',
    sent,
    send(message) {
      sent.push(message)
    },
    onMessage(handler) {
      handlers.push(handler)
      return () => {
        handlers = handlers.filter((candidate) => candidate !== handler)
      }
    },
    close() {
      closes++
    },
    deliver(message) {
      for (const handler of [...handlers]) handler(message)
    },
    subscriberCount: () => handlers.length,
    closeCalls: () => closes,
  }
}

interface MockWindow extends BridgeWindow {
  /** Fire the browser's real `pagehide`. */
  pagehide(): void
  listenerCount(): number
}

function createMockWindow(): MockWindow {
  let listeners: Array<() => void> = []
  return {
    addEventListener(_event, listener) {
      listeners.push(listener)
    },
    removeEventListener(_event, listener) {
      listeners = listeners.filter((candidate) => candidate !== listener)
    },
    pagehide() {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.length,
  }
}

test('post() hands the message to the bridge', () => {
  const bridge = createMockBridge()
  const channel = createBridgeChannel(bridge, createMockWindow())

  channel.post({ type: 'hello', id: 'a' })
  assert.deepEqual(bridge.sent, [{ type: 'hello', id: 'a' }])
})

test('a host message reaches every registered handler exactly once', () => {
  const bridge = createMockBridge()
  const channel = createBridgeChannel(bridge, createMockWindow())

  const first: unknown[] = []
  const second: unknown[] = []
  channel.onMessage((message) => first.push(message))
  channel.onMessage((message) => second.push(message))

  bridge.deliver({ n: 1 })

  assert.deepEqual(first, [{ n: 1 }])
  assert.deepEqual(second, [{ n: 1 }], 'no handler may be skipped or doubled')
})

test('the bridge is subscribed once regardless of how many handlers register', () => {
  // The inline version this replaced called `bridge.onMessage` inside every
  // `channel.onMessage` while each subscription fanned out to *all* handlers,
  // so N handlers meant N deliveries each. It survived only because
  // `SessionClient` happens to register exactly one.
  const bridge = createMockBridge()
  const channel = createBridgeChannel(bridge, createMockWindow())
  assert.equal(bridge.subscriberCount(), 1)

  channel.onMessage(() => {})
  channel.onMessage(() => {})
  channel.onMessage(() => {})

  assert.equal(bridge.subscriberCount(), 1, 'one bridge subscription for the channel')
})

test('unsubscribe returned by onMessage drops further deliveries', () => {
  const bridge = createMockBridge()
  const channel = createBridgeChannel(bridge, createMockWindow())

  const received: unknown[] = []
  const off = channel.onMessage((message) => received.push(message))

  bridge.deliver({ a: 1 })
  off()
  bridge.deliver({ a: 2 })

  assert.deepEqual(received, [{ a: 1 }])
})

test("the browser's pagehide closes the channel", () => {
  // This is the renderer's only honest teardown signal. A `pagehide` synthesized
  // by the preload cannot reach this world under `contextIsolation`, so the real
  // DOM event is what we listen for.
  const bridge = createMockBridge()
  const window = createMockWindow()
  const channel = createBridgeChannel(bridge, window)

  let closeFires = 0
  channel.onClose(() => {
    closeFires++
  })

  window.pagehide()
  assert.equal(closeFires, 1)

  channel.post({ dropped: true })
  assert.deepEqual(bridge.sent, [], 'a closed channel must not post')
})

test('close() fires onClose once and tears down both subscriptions', () => {
  const bridge = createMockBridge()
  const window = createMockWindow()
  const channel = createBridgeChannel(bridge, window)

  let closeFires = 0
  channel.onClose(() => {
    closeFires++
  })

  channel.close()
  channel.close()

  assert.equal(closeFires, 1)
  assert.equal(bridge.subscriberCount(), 0, 'bridge subscription must be released')
  assert.equal(window.listenerCount(), 0, 'pagehide listener must be released')
  assert.equal(bridge.closeCalls(), 1, 'the preload bridge must be told to stop delivering')
})

test('after close(), post() is a silent drop', () => {
  const bridge = createMockBridge()
  const channel = createBridgeChannel(bridge, createMockWindow())

  channel.post({ id: 'a' })
  channel.close()
  channel.post({ id: 'b' })

  assert.deepEqual(bridge.sent, [{ id: 'a' }])
})

test('onClose handler fires synchronously when registered after close()', () => {
  const bridge = createMockBridge()
  const channel = createBridgeChannel(bridge, createMockWindow())
  channel.close()

  let fired = 0
  channel.onClose(() => {
    fired++
  })
  assert.equal(fired, 1)
})
