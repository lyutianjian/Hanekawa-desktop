/**
 * The CDP transport: one socket, held for a whole launch.
 *
 * Stage 3j drove the desktop app this way and threw the driver away; the four
 * rules below cost that stage three of its four debugging rounds, so they are
 * spelled here as code with their reasons attached rather than as prose someone
 * has to find again.
 *
 * 1. **One socket for the run.** Attaching and detaching a DevTools session per
 *    step fights the browser's own bookkeeping and produces failures that look
 *    like app bugs.
 * 2. **Never enable `Target.setDiscoverTargets`.** With it on, a newly created
 *    window's renderer does not start — the app appears to hang and nothing in
 *    it is at fault.
 * 3. **Find the page by URL, and abort on more than one match.** Two matches
 *    means a stale instance is running, and every assertion downstream would be
 *    reading someone else's window.
 * 4. **A screenshot cannot see a native modal.** `dialog.showErrorBox` and
 *    friends are OS windows, not page content, so `Page.captureScreenshot`
 *    renders what is *under* them and looks perfectly healthy. Detection lives
 *    in `app.mjs`'s `liveness`, not here.
 *
 * Zero dependencies: Node 22+ has both `fetch` and `WebSocket` as globals.
 */
import { writeFileSync } from 'node:fs'

/** Modifier bits `Input.dispatchKeyEvent` expects. Windows values. */
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
// The app's primary modifier: ⌘ on macOS, Ctrl elsewhere — the host Electron runs on.
MOD.mod = process.platform === 'darwin' ? MOD.meta : MOD.ctrl

/**
 * The keys this driver presses, with the codes Chromium needs.
 *
 * `windowsVirtualKeyCode` is not optional in practice: without it a chord
 * arrives with `key` set but no usable code and the renderer's `keydown`
 * handlers see a key they cannot match.
 */
const KEYS = {
  b: { key: 'b', code: 'KeyB', vk: 66 },
  n: { key: 'n', code: 'KeyN', vk: 78, text: 'n' },
  t: { key: 't', code: 'KeyT', vk: 84 },
  w: { key: 'w', code: 'KeyW', vk: 87 },
  y: { key: 'y', code: 'KeyY', vk: 89, text: 'y' },
  o: { key: 'O', code: 'KeyO', vk: 79 },
  ',': { key: ',', code: 'Comma', vk: 188, text: ',' },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits for `fn` to return a truthy value, and reports *what it last saw* on
 * timeout.
 *
 * The last value is the whole point: "waitFor(activeLane === '3') timed out" is
 * a dead end, while "last saw '2'" says whether the app did nothing or did the
 * wrong thing.
 */
export async function waitFor(label, fn, { timeout = 15000, interval = 120 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      last = `threw: ${error instanceof Error ? error.message : String(error)}`
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${label}; last saw ${JSON.stringify(last)}`)
    }
    await sleep(interval)
  }
}

/**
 * The page target of the app under test.
 *
 * `/json/list` is polled rather than awaited once: the debugging endpoint answers
 * before the window's renderer has a target, so the first successful fetch
 * usually returns an empty list.
 */
export async function findPageTarget(port, { timeout = 30000, urlSuffix = 'renderer/index.html' } = {}) {
  return waitFor(
    `a single page target ending in ${urlSuffix}`,
    async () => {
      let targets
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        targets = await response.json()
      } catch {
        return undefined
      }
      const pages = targets.filter(
        (target) => target.type === 'page' && typeof target.url === 'string' && target.url.endsWith(urlSuffix),
      )
      // Rule 3: more than one means a stale instance. Fail loudly instead of
      // picking one and producing nondeterministic results for the rest of the run.
      if (pages.length > 1) {
        throw new Error(`found ${pages.length} page targets for ${urlSuffix}; a stale app instance is running`)
      }
      return pages[0]
    },
    { timeout, interval: 250 },
  )
}

class Cdp {
  #socket
  #next = 0
  #pending = new Map()
  #onEvent
  #listeners = new Map()
  #closed

  constructor(socket, onEvent) {
    this.#socket = socket
    this.#onEvent = onEvent
    socket.addEventListener('message', (event) => this.#receive(event.data))
    socket.addEventListener('close', () => this.#fail(new Error('the CDP socket closed')))
    socket.addEventListener('error', () => this.#fail(new Error('the CDP socket errored')))
  }

  #receive(data) {
    let frame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    if (typeof frame.id === 'number') {
      const settle = this.#pending.get(frame.id)
      if (!settle) return
      this.#pending.delete(frame.id)
      if (frame.error) settle.reject(new Error(`${settle.method}: ${frame.error.message} (${frame.error.code})`))
      else settle.resolve(frame.result)
      return
    }
    if (typeof frame.method === 'string') {
      this.#onEvent?.(frame)
      for (const listener of this.#listeners.get(frame.method) ?? []) listener(frame.params)
    }
  }

  #fail(error) {
    if (this.#closed) return
    this.#closed = error
    for (const [, settle] of this.#pending) settle.reject(error)
    this.#pending.clear()
  }

  send(method, params = {}) {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.#socket.close()
    } catch {
      // Already gone; the run is over either way.
    }
  }

  /** Trace/screencast observers share the launch's one socket. */
  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(method)
    }
  }
}

export async function connect(wsUrl, { onEvent, timeout = 15000 } = {}) {
  // `maxPayload` cannot be raised on the global WebSocket, and CDP replies from
  // `Runtime.evaluate` are the largest thing this driver reads — every probe
  // therefore returns a projection, never a DOM dump. See `probes.mjs`.
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket to ${wsUrl} did not open in ${timeout}ms`)), timeout)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`WebSocket to ${wsUrl} failed to open`))
    })
  })
  return new Cdp(socket, onEvent)
}

/**
 * Evaluates an expression in the page's main world and returns its value.
 *
 * `awaitPromise` is on so a probe may be async; `returnByValue` is what makes
 * the result plain JSON, which is why probes must project rather than return
 * nodes — a node is not serialisable and comes back as an opaque handle.
 */
export async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description ?? exceptionDetails.text
    throw new Error(`evaluate failed: ${text}\n  expression: ${expression.slice(0, 200)}`)
  }
  return result.value
}

/**
 * Presses one chord, e.g. `'Mod+b'`, `'Enter'`, `'y'`. `Mod` is ⌘ on macOS, Ctrl elsewhere.
 *
 * Modified keys use `rawKeyDown`, which is precisely "a keydown that generates
 * no character"; unmodified printable keys use `keyDown` with `text` so
 * Chromium synthesizes the char event itself. Mixing the two up is why a
 * `Ctrl+B` can arrive as a literal `b` in the composer.
 */
export async function key(cdp, chord) {
  const parts = chord.split('+')
  const name = parts.pop()
  const spec = KEYS[name]
  if (!spec) throw new Error(`unknown key ${name} in chord ${chord}`)
  let modifiers = 0
  for (const part of parts) {
    const bit = MOD[part.toLowerCase()]
    if (bit === undefined) throw new Error(`unknown modifier ${part} in chord ${chord}`)
    modifiers |= bit
  }
  const base = {
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
  }
  const typed = modifiers === 0 && spec.text !== undefined
  await cdp.send('Input.dispatchKeyEvent', {
    ...base,
    type: typed ? 'keyDown' : 'rawKeyDown',
    ...(typed ? { text: spec.text, unmodifiedText: spec.text } : {}),
  })
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

/**
 * Clicks at a viewport point with a real mouse event.
 *
 * Not `element.click()` through `evaluate`: that dispatches straight at the node
 * and would pass even if the row were covered, hidden behind another layer, or
 * had `pointer-events: none`. Chromium hit-tests these, so what they prove is
 * that the pixel the user aims at is the pixel that answers.
 */
export async function mouseClick(cdp, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
}

/**
 * Writes a PNG of the page.
 *
 * `captureBeyondViewport` stays off deliberately: several of the visual checks
 * are about whether a form fits the window, and stitching a taller image would
 * erase exactly the evidence being collected.
 */
export async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/** Shrinks the layout viewport without touching the OS window. */
export async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
}

export async function clearViewport(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride')
}
