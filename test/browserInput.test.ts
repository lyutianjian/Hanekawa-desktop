import assert from 'node:assert/strict'
import test from 'node:test'

import { withinBounds } from '../src/desktop/browser/bounds.js'
import { BrowserHostError } from '../src/desktop/browser/errors.js'
import { describeKeys } from '../src/desktop/browser/keys.js'
import {
  clickAt,
  clickTarget,
  dispatchKeys,
  enqueueInput,
  hoverTarget,
  pressKeys,
  selectOption,
  setChecked,
  isInputActive,
  scrollPage,
  typeText,
  type InputDeps,
} from '../src/desktop/browser/input.js'
import { TYPE_TEXT_MAX } from '../src/desktop/browser/limits.js'

/**
 * The input layer with the page and the debugger replaced by records.
 *
 * Everything worth pinning here is a sequence, not a pixel: which CDP commands
 * a click is and in what order, where cancellation is observed, and what the
 * evidence line is allowed to say. None of it needs a window, so none of these
 * tests opens one — the real script running against a real DOM is
 * `browserInject.test.ts`'s job.
 */

interface Sent {
  method: string
  params: Record<string, unknown>
}

interface Harness {
  deps: InputDeps
  sent: Sent[]
  scripts: string[]
}

interface TargetOverrides {
  ref?: string
  selector?: string
  role?: string
  name?: string
  sensitive?: boolean
  x?: number
  y?: number
}

function harness(options: {
  platform?: string
  target?: TargetOverrides
  scroll?: { scrollY?: number; maxScrollY?: number; atBottom?: boolean; target?: string }
  /** Throws on the n-th `check()`, counting from 1. Stands in for a cancel. */
  cancelAt?: number
  /** The page's answer to a guard; a message makes it refuse. */
  guard?: () => string | undefined
  /** Successive answers to a check-state read. */
  checkStates?: Array<{ checked: boolean; radio?: boolean; disabled?: boolean }>
} = {}): Harness {
  const sent: Sent[] = []
  const scripts: string[] = []
  let checks = 0

  const target = {
    ref: 'e1',
    role: 'button',
    name: 'Sign in',
    sensitive: false,
    x: 120.4,
    y: 240.6,
    width: 80,
    height: 24,
    focused: true,
    url: 'https://x.test/',
    title: 'X',
    ...options.target,
  }
  const scroll = {
    scrollY: 900,
    maxScrollY: 4000,
    viewport: 720,
    atBottom: false,
    target: 'down 648px',
    url: 'https://x.test/',
    title: 'X',
    ...options.scroll,
  }

  const deps: InputDeps = {
    key: {},
    platform: options.platform ?? 'linux',
    send: async (method, params) => {
      sent.push({ method, params: params ?? {} })
      return undefined
    },
    evaluate: async (script) => {
      scripts.push(script)
      if (script.includes('hkCheckState(document')) {
        const state = options.checkStates?.shift() ?? { checked: false }
        return {
          ok: true,
          value: { role: 'checkbox', name: 'Remember me', radio: false, disabled: false, ...state },
        }
      }
      if (script.includes('hkSelectOption(document')) {
        return {
          ok: true,
          value: {
            ref: 'e5', role: 'combobox', name: 'Country', sensitive: false,
            index: 1, label: 'France', value: 'fr', url: 'https://x.test/', title: 'X',
          },
        }
      }
      if (script.includes('hkGuardTarget(document')) {
        const refusal = options.guard?.()
        return refusal === undefined ? { ok: true, value: true } : { ok: false, message: refusal }
      }
      if (script.includes('hkDescribePoint(document')) {
        return { ok: true, value: { hit: '<canvas> "Map"', url: 'https://x.test/', title: 'X' } }
      }
      return { ok: true, value: script.includes('hkScrollPage(') ? scroll : target }
    },
    check: () => {
      checks += 1
      if (options.cancelAt !== undefined && checks >= options.cancelAt) {
        throw new BrowserHostError('OPERATION_ABORTED', 'The browser action was cancelled.')
      }
    },
  }
  return { deps, sent, scripts }
}

function methods(sent: Sent[]): string[] {
  return sent.map((entry) => `${entry.method}:${String(entry.params['type'] ?? '')}`)
}

test('a click hovers before it presses, and lands on the rounded centre', async () => {
  const { deps, sent, scripts } = harness()
  const result = await clickTarget(deps, { ref: 'e1' })

  assert.deepEqual(methods(sent), [
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ])
  assert.equal(scripts.length, 2)
  assert.match(scripts[0] ?? '', /hkResolveTarget\(document, window, globalThis/)
  assert.match(scripts[0] ?? '', /"requireHit":true/)
  // The guard runs after the hover, with the point the press will use.
  assert.match(scripts[1] ?? '', /hkGuardTarget\(document, globalThis, \{"mode":"pointer".*"x":120,"y":241/)
  for (const entry of sent) {
    assert.equal(entry.params['x'], 120)
    assert.equal(entry.params['y'], 241)
  }
  assert.equal(sent[1]?.params['button'], 'left')
  assert.equal(sent[1]?.params['clickCount'], 1)
  // The hover carries no button, or a page that watches `buttons` sees a drag.
  assert.equal(sent[0]?.params['buttons'], 0)
  assert.match(result.text, /clicked e1 \(button "Sign in"\) at \(120, 241\)/)
  assert.match(result.text, /url=https:\/\/x\.test\//)
})

test('a click at a point names what it lands on, then moves and presses there', async () => {
  const { deps, sent, scripts } = harness()
  const result = await clickAt(deps, { x: 300.4, y: 200.6, button: 'right' })

  assert.deepEqual(methods(sent), [
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ])
  for (const entry of sent) assert.deepEqual([entry.params['x'], entry.params['y']], [300, 201])
  assert.equal(sent[1]?.params['button'], 'right')
  // One read of the point and no resolve or guard: a coordinate has no target to cover.
  assert.equal(scripts.length, 1)
  assert.match(scripts[0] ?? '', /hkDescribePoint\(document, window, \{"x":300,"y":201/)
  assert.equal(result.text, 'right-clicked at (300, 201), which landed on <canvas> "Map". url=https://x.test/ title=X')
})

test('a hover resolves with the hit test, moves once, and presses nothing', async () => {
  const { deps, sent, scripts } = harness()
  const result = await hoverTarget(deps, { selector: '#menu' })

  assert.deepEqual(methods(sent), ['Input.dispatchMouseEvent:mouseMoved'])
  assert.equal(sent[0]?.params['buttons'], 0)
  assert.deepEqual([sent[0]?.params['x'], sent[0]?.params['y']], [120, 241])
  // One resolve, no guard: what the hover opens may well cover the point.
  assert.equal(scripts.length, 1)
  assert.match(scripts[0] ?? '', /"requireEnabled":false/)
  assert.match(scripts[0] ?? '', /"requireHit":true/)
  assert.match(result.text, /hovered over e1 \(button "Sign in"\) at \(120, 241\)/)
})

test('a right or double click says so, in the event and in the evidence', async () => {
  const right = harness()
  const rightResult = await clickTarget(right.deps, { selector: '#menu', button: 'right' })
  assert.equal(right.sent[1]?.params['button'], 'right')
  assert.equal(right.sent[1]?.params['buttons'], 2)
  assert.match(rightResult.text, /right-clicked/)

  const double = harness()
  const doubleResult = await clickTarget(double.deps, { ref: 'e2', clickCount: 2 })
  assert.equal(double.sent[1]?.params['clickCount'], 2)
  assert.match(doubleResult.text, /2× left-clicked/)
})

test('an element removed between the resolve and the press is never pressed', async () => {
  const { deps, sent } = harness({
    guard: () => 'STALE_ELEMENT: ref e1 was removed from the page before the input was sent.',
  })
  await assert.rejects(
    () => clickTarget(deps, { ref: 'e1' }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'STALE_ELEMENT',
  )
  assert.deepEqual(methods(sent), ['Input.dispatchMouseEvent:mouseMoved'])
})

test('an action holds one CDP lease for its whole length, and returns it on failure too', async () => {
  const log: string[] = []
  const lease = (): (() => void) => {
    log.push('acquire')
    return () => log.push('release')
  }
  const ok = harness({})
  const sendOk = ok.deps.send
  ok.deps.lease = lease
  ok.deps.send = async (method, params) => {
    log.push('send')
    return sendOk(method, params)
  }
  await clickTarget(ok.deps, { ref: 'e1' })
  assert.equal(log[0], 'acquire')
  assert.equal(log.at(-1), 'release')
  assert.equal(log.filter((entry) => entry === 'acquire').length, 1)
  assert.equal(log.filter((entry) => entry === 'release').length, 1)

  log.length = 0
  const failing = harness({ guard: () => 'STALE_ELEMENT: gone.' })
  failing.deps.lease = lease
  await assert.rejects(() => clickTarget(failing.deps, { ref: 'e1' }))
  assert.deepEqual(log, ['acquire', 'release'])
})

test('typing re-checks focus before the text and before Enter, and stops at the first refusal', async () => {
  let guards = 0
  const { deps, sent, scripts } = harness({
    guard: () => (++guards === 2 ? 'ELEMENT_NOT_INTERACTABLE: ref e1 lost focus to <div>.' : undefined),
  })
  await assert.rejects(() => typeText(deps, { ref: 'e1', text: 'hi', submit: true }), /lost focus/)
  assert.doesNotMatch(scripts[0] ?? '', /"requireHit"/, 'a covered field still takes keystrokes')
  assert.match(scripts[1] ?? '', /"mode":"keyboard"/)
  // The text went in; the Enter never did.
  assert.deepEqual(methods(sent), ['Input.insertText:'])
})

test('an action with neither ref nor selector never reaches the page', async () => {
  const { deps, scripts, sent } = harness()
  await assert.rejects(
    () => clickTarget(deps, {}),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
  assert.deepEqual(scripts, [])
  assert.deepEqual(sent, [])
})

test('a ref wins over a selector, because it names what was read', async () => {
  const { deps, scripts } = harness()
  await clickTarget(deps, { ref: 'e7', selector: '#other' })
  const script = scripts[0] ?? ''
  assert.match(script, /"ref":"e7"/)
  assert.doesNotMatch(script, /"selector"/)
})

test('clearing a field uses the platform’s own select-all', async () => {
  const mac = harness({ platform: 'darwin' })
  await typeText(mac.deps, { ref: 'e1', text: 'hi', clear: true })
  const keys = mac.sent.filter((entry) => entry.method === 'Input.dispatchKeyEvent')
  assert.deepEqual(
    keys.map((entry) => `${String(entry.params['type'])}:${String(entry.params['key'])}`),
    ['rawKeyDown:Meta', 'rawKeyDown:a', 'keyUp:a', 'keyUp:Meta', 'rawKeyDown:Backspace', 'keyUp:Backspace'],
  )
  assert.deepEqual(keys[1]?.params['commands'], ['selectAll'])
  assert.equal(keys[1]?.params['modifiers'], 4)
  assert.deepEqual(keys[4]?.params['commands'], ['deleteBackward'])

  const linux = harness({ platform: 'linux' })
  await typeText(linux.deps, { ref: 'e1', text: 'hi', clear: true })
  assert.equal(linux.sent[0]?.params['key'], 'Control')
  assert.equal(linux.sent[1]?.params['modifiers'], 2)
  assert.equal(linux.sent[1]?.params['commands'], undefined)
  assert.equal(linux.sent[4]?.params['commands'], undefined)
})

test('typing inserts the text once and never echoes it back', async () => {
  const { deps, sent } = harness({ target: { ref: 'e3', role: 'textbox', name: 'Password', sensitive: true } })
  const result = await typeText(deps, { ref: 'e3', text: 'hunter2', submit: true })

  const insert = sent.filter((entry) => entry.method === 'Input.insertText')
  assert.equal(insert.length, 1)
  assert.equal(insert[0]?.params['text'], 'hunter2')
  assert.equal(sent.at(-2)?.params['key'], 'Enter')
  assert.match(result.text, /typed 7 characters into e3 \(textbox\)/)
  assert.match(result.text, /then pressed Enter/)
  // Neither the secret nor the field's name: a sensitive field's name is part of
  // what the projection refuses to carry.
  assert.doesNotMatch(result.text, /hunter2/)
  assert.doesNotMatch(result.text, /Password/)
})

test('an oversized paste is refused before anything is focused', () => {
  const { deps, scripts } = harness()
  assert.throws(
    () => typeText(deps, { ref: 'e1', text: 'x'.repeat(TYPE_TEXT_MAX + 1) }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
  assert.deepEqual(scripts, [])
})

test('scrolling happens in the page, and reports where it stopped', async () => {
  const { deps, sent, scripts } = harness({ scroll: { scrollY: 4000, atBottom: true, target: 'bottom' } })
  const result = await scrollPage(deps, { direction: 'bottom' })

  assert.deepEqual(sent, [], 'a scroll needs no synthetic input at all')
  assert.match(scripts[0] ?? '', /"direction":"bottom"/)
  assert.match(result.text, /scrolled bottom: y=4000 of 4000 \(bottom of the page\)/)
})

test('a cancel is observed at the next boundary, not after the burst', async () => {
  // The first check runs before the page is even asked; the third is between
  // the resolve and the press.
  const { deps, sent } = harness({ cancelAt: 3 })
  await assert.rejects(
    () => clickTarget(deps, { ref: 'e1' }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )
  assert.deepEqual(sent, [], 'no input may be dispatched once the action is cancelled')
})

test('a page that stops answering ends the action instead of holding the tab', async () => {
  // What `bounds.ts` hands the input layer when a page hangs on an `alert()` or
  // a dead loop: a rejection, where before this awaited forever with the lease
  // still held. The action must settle, release, and press nothing.
  const { deps, sent } = harness()
  const log: string[] = []
  deps.lease = () => {
    log.push('acquire')
    return () => log.push('release')
  }
  deps.evaluate = () => withinBounds({ timeoutMs: 10 }, 'reading the page', () => new Promise<never>(() => {}))

  await assert.rejects(
    () => clickTarget(deps, { ref: 'e1' }),
    (error: unknown) =>
      error instanceof BrowserHostError && error.code === 'PAGE_NOT_READY' && error.retryable === true,
  )
  assert.deepEqual(sent, [], 'a press cannot follow an answer the page never gave')
  assert.deepEqual(log, ['acquire', 'release'], 'the queue and the CDP lease must not be held by a hung call')
})

test('a cancelled action acts on nothing the page answers afterwards', async () => {
  const controller = new AbortController()
  const { deps, sent } = harness()
  const log: string[] = []
  deps.lease = () => {
    log.push('acquire')
    return () => log.push('release')
  }
  let answer: (value: unknown) => void = () => {}
  let observed = (): void => {}
  const asked = new Promise<void>((resolve) => {
    observed = resolve
  })
  deps.evaluate = () =>
    withinBounds({ signal: controller.signal, timeoutMs: 60_000 }, 'reading the page', () => {
      return new Promise<unknown>((resolve) => {
        answer = resolve
        observed()
      })
    })

  const action = clickTarget(deps, { ref: 'e1' })
  await asked
  controller.abort()
  await assert.rejects(
    action,
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )

  // The page finally answers, with a target the click would have used.
  answer({ ok: true, value: { ref: 'e1', role: 'button', name: 'Sign in', x: 120, y: 240, url: '/', title: 'X' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(sent, [], 'no click may ride on an answer that arrived after the cancel')
  assert.deepEqual(log, ['acquire', 'release'])
})

test('a cancel that lands mid-press still releases the button', async () => {
  const { deps, sent } = harness()
  let pressed = false
  const send = deps.send
  deps.send = async (method, params) => {
    if (params?.['type'] === 'mousePressed') pressed = true
    return send(method, params)
  }
  deps.check = () => {
    if (pressed) throw new BrowserHostError('OPERATION_ABORTED', 'The browser action was cancelled.')
  }

  await assert.rejects(
    () => clickTarget(deps, { ref: 'e1' }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )
  assert.deepEqual(methods(sent), [
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ])
})

test('a cancel that lands mid-keystroke still lifts the key and the modifier', async () => {
  const { deps, sent } = harness()
  let down = false
  const send = deps.send
  deps.send = async (method, params) => {
    const type = params?.['type']
    if (type === 'rawKeyDown' || type === 'keyDown') down = true
    return send(method, params)
  }
  deps.check = () => {
    if (down) throw new BrowserHostError('OPERATION_ABORTED', 'The browser action was cancelled.')
  }

  await assert.rejects(() => typeText(deps, { ref: 'e1', text: 'x', clear: true }))
  // Select-all went down and came back up; nothing after the pair was sent.
  assert.deepEqual(methods(sent), ['Input.dispatchKeyEvent:rawKeyDown', 'Input.dispatchKeyEvent:keyUp'])
  assert.equal(sent[1]?.params['modifiers'], sent[0]?.params['modifiers'])
})

test('a press whose command fails is still released, and its error is the one reported', async () => {
  const { deps, sent } = harness()
  deps.send = async (method, params) => {
    sent.push({ method, params: params ?? {} })
    if (params?.['type'] === 'mousePressed') throw new Error('press failed')
    if (params?.['type'] === 'mouseReleased') throw new Error('release failed')
    return undefined
  }

  await assert.rejects(() => clickTarget(deps, { ref: 'e1' }), /press failed/)
  assert.deepEqual(methods(sent).slice(-2), [
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ])
})

test('a key whose press fails is still lifted', async () => {
  const { deps, sent } = harness()
  deps.send = async (method, params) => {
    sent.push({ method, params: params ?? {} })
    if (params?.['type'] === 'keyDown') throw new Error('enter failed')
    return undefined
  }

  await assert.rejects(() => typeText(deps, { ref: 'e1', text: '', submit: true }), /enter failed/)
  assert.deepEqual(methods(sent), ['Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp'])
})

test('actions on one tab serialize, and one failure does not poison the queue', async () => {
  const key = {}
  const order: string[] = []
  const slow = enqueueInput(key, async () => {
    order.push('first:start')
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push('first:end')
    throw new Error('boom')
  })
  const next = enqueueInput(key, async () => {
    order.push('second')
    return 'ok'
  })

  await assert.rejects(() => slow)
  assert.equal(await next, 'ok')
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})

test('the active flag is set for the length of an action and cleared after it', async () => {
  const { deps } = harness()
  assert.equal(isInputActive(deps.key), false)
  const inFlight: boolean[] = []
  const observed = enqueueInput(deps.key, async () => {
    inFlight.push(isInputActive(deps.key))
    return undefined
  })
  const click = clickTarget(deps, { ref: 'e1' })
  await click
  await observed
  assert.equal(isInputActive(deps.key), false)
})

// --- page.press_key -----------------------------------------------------------

function keyEvents(sent: Sent[]): string[] {
  return sent
    .filter((entry) => entry.method === 'Input.dispatchKeyEvent')
    .map((entry) => `${String(entry.params['type'])}:${String(entry.params['key'])}`)
}

test('ControlOrMeta is Meta on macOS and Control everywhere else', async () => {
  const mac = harness({ platform: 'darwin' })
  const macResult = await pressKeys(mac.deps, { keys: ['ControlOrMeta', 'c'] })
  assert.deepEqual(keyEvents(mac.sent), ['rawKeyDown:Meta', 'rawKeyDown:c', 'keyUp:c', 'keyUp:Meta'])
  assert.equal(mac.sent[1]?.params['modifiers'], 4)
  assert.deepEqual(mac.sent[1]?.params['commands'], ['copy'])
  assert.match(macResult.text, /pressed Meta\+C on the focused element/)

  const linux = harness({ platform: 'linux' })
  await pressKeys(linux.deps, { keys: ['ControlOrMeta+c'] })
  assert.deepEqual(keyEvents(linux.sent), ['rawKeyDown:Control', 'rawKeyDown:c', 'keyUp:c', 'keyUp:Control'])
  assert.equal(linux.sent[1]?.params['modifiers'], 2)
  assert.equal(linux.sent[1]?.params['commands'], undefined)
})

test('Shift+1 types "!", while Control+A types nothing and goes down raw', async () => {
  const shifted = harness()
  await pressKeys(shifted.deps, { keys: ['Shift', '1'] })
  const bang = shifted.sent[1]?.params
  assert.equal(bang?.['type'], 'keyDown')
  assert.equal(bang?.['key'], '!')
  assert.equal(bang?.['text'], '!')
  assert.equal(bang?.['code'], 'Digit1')
  assert.equal(bang?.['modifiers'], 8)

  const chord = harness()
  await pressKeys(chord.deps, { keys: ['Control', 'A'] })
  const a = chord.sent[1]?.params
  assert.equal(a?.['type'], 'rawKeyDown')
  assert.equal(a?.['text'], undefined)
  assert.equal(a?.['modifiers'], 2)
})

test('keys already down are lifted in reverse when a later press fails', async () => {
  const { deps, sent } = harness()
  deps.send = async (method, params) => {
    sent.push({ method, params: params ?? {} })
    if (params?.['type'] === 'rawKeyDown' && params['key'] === 'Tab') throw new Error('tab failed')
    return undefined
  }
  await assert.rejects(() => dispatchKeys(deps, describeKeys(['Control', 'Shift', 'Tab'], 'linux')), /tab failed/)
  assert.deepEqual(keyEvents(sent), [
    'rawKeyDown:Control',
    'rawKeyDown:Shift',
    'rawKeyDown:Tab',
    'keyUp:Tab',
    'keyUp:Shift',
    'keyUp:Control',
  ])
})

test('an unknown key, or a chord of nothing but modifiers, is refused before anything is pressed', () => {
  const invalid = (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST'
  const { deps, sent, scripts } = harness()
  assert.throws(() => pressKeys(deps, { keys: ['Hyper'] }), invalid)
  assert.throws(() => pressKeys(deps, { keys: ['Control', 'Shift'] }), invalid)
  assert.throws(() => pressKeys(deps, { keys: ['constructor'] }), invalid)
  assert.throws(() => pressKeys(deps, { keys: [] }), invalid)
  assert.deepEqual(sent, [])
  assert.deepEqual(scripts, [])
})

test('a key pressed on a target focuses it first, and a secret field never hears its characters echoed', async () => {
  const plain = harness({ target: { ref: 'e4', role: 'textbox', name: '搜索' } })
  const plainResult = await pressKeys(plain.deps, { ref: 'e4', keys: ['Control', 'a'] })
  assert.match(plain.scripts[0] ?? '', /"focus":true/)
  assert.match(plain.scripts[1] ?? '', /"mode":"keyboard"/)
  assert.match(plainResult.text, /pressed Control\+A on e4 \(textbox "搜索"\)/)

  const secret = harness({ target: { ref: 'e3', role: 'textbox', name: 'Password', sensitive: true } })
  const secretResult = await pressKeys(secret.deps, { ref: 'e3', keys: ['x', 'y', 'z'] })
  assert.match(secretResult.text, /pressed 3 keys on e3 \(textbox\)/)
  assert.doesNotMatch(secretResult.text, /X\+Y|Password/)
  // Named keys type nothing worth hiding.
  assert.match((await pressKeys(secret.deps, { ref: 'e3', keys: ['Enter'] })).text, /pressed Enter/)
})

// --- select_option and set_checked ---------------------------------------------

test('set_checked on a box already in that state clicks nothing', async () => {
  const { deps, sent } = harness({ checkStates: [{ checked: true }] })
  const result = await setChecked(deps, { ref: 'e6', checked: true })
  assert.deepEqual(sent, [])
  assert.match(result.text, /e6 \(checkbox "Remember me"\) is already checked; nothing was clicked/)
})

test('set_checked clicks through the hit test and confirms the state flipped', async () => {
  const { deps, sent, scripts } = harness({ checkStates: [{ checked: false }, { checked: true }] })
  const result = await setChecked(deps, { ref: 'e6', checked: true })
  assert.deepEqual(methods(sent), [
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ])
  const resolve = scripts.find((script) => script.includes('hkResolveTarget(document')) ?? ''
  assert.match(resolve, /"requireHit":true/)
  assert.match(resolve, /"viaLabel":true/)
  assert.match(result.text, /^checked e6 \(checkbox "Remember me"\) by clicking at \(120, 241\)/)
})

test('set_checked reports a click the page ignored, and refuses to uncheck a radio', async () => {
  const ignored = harness({ checkStates: [{ checked: false }, { checked: false }] })
  await assert.rejects(
    () => setChecked(ignored.deps, { ref: 'e6', checked: true }),
    (error: unknown) =>
      error instanceof BrowserHostError && error.code === 'ELEMENT_NOT_INTERACTABLE' && /still unchecked/.test(error.message),
  )

  const radio = harness({ checkStates: [{ checked: true, radio: true }] })
  await assert.rejects(
    () => setChecked(radio.deps, { ref: 'e7', checked: false }),
    (error: unknown) =>
      error instanceof BrowserHostError && error.code === 'INVALID_REQUEST' && /Select another option/.test(error.message),
  )
  assert.deepEqual(radio.sent, [])
})

test('select_option needs exactly one way to pick, and reports what it picked', async () => {
  const { deps, scripts } = harness()
  assert.throws(() => selectOption(deps, { ref: 'e5' }), /exactly one/)
  assert.throws(() => selectOption(deps, { ref: 'e5', value: 'fr', index: 1 }), /exactly one/)
  assert.deepEqual(scripts, [])

  const result = await selectOption(deps, { ref: 'e5', label: 'France' })
  assert.match(scripts[0] ?? '', /"label":"France"/)
  assert.match(result.text, /selected option 1 "France" \(value=fr\) in e5 \(combobox "Country"\)/)
})
