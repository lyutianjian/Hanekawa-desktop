/**
 * Clicking, typing and scrolling: the host's half of acting on a page.
 *
 * Electron-free on purpose. It takes an evaluator, a CDP sender and an identity
 * object, so the whole sequence a click is — resolve in the page, move, press,
 * release — can be asserted against stubs in a plain `node:test` process. The
 * real wiring is two lines in `host.ts`.
 *
 * Three rules shape it:
 *
 * - **One tab, one queue.** Actions on a tab are serialized so a click and the
 *   typing that follows cannot interleave; the chain is broken with a swallowed
 *   rejection so one failure does not poison everything queued behind it.
 * - **`check()` at every boundary.** Cancellation is checked before dispatch and
 *   again after each await, which puts the granularity at one CDP command rather
 *   than at one operation — except inside a press/release pair, which always
 *   completes so nothing is left held down. A boundary is only reachable if the
 *   await before it returned, so a call that never settles is ended by
 *   `bounds.ts`'s deadline at the seam: the action then fails here instead of
 *   waiting on a page that will not answer, and the answer that eventually
 *   arrives reaches no step left to trigger. Phase 5's takeover arbitration
 *   hangs off the same hook — it is the one place a "stop now" can be observed
 *   mid-burst.
 * - **Nothing echoes what was typed.** The evidence line counts characters. A
 *   password typed into a field the projection refuses to read must not come
 *   back through the transcript instead.
 */

import type {
  CheckStateOptions,
  CheckStateResult,
  GuardOptions,
  PointResult,
  ScrollOptions,
  ScrollResult,
  SelectOptions,
  SelectResult,
  TargetOptions,
  TargetResult,
} from './inject/bundle.js'
import {
  checkStateScript,
  guardScript,
  pointScript,
  resolveScript,
  scrollScript,
  selectScript,
  unwrap,
} from './inject/bundle.js'
import { BrowserHostError } from './errors.js'
import { describeKeys, isModifier, macCommand, MODIFIER_BITS, type KeyDescription } from './keys.js'
import { FIELD_MAX_NAME, SCROLL_VIEWPORT_FRACTION, SENSITIVE_AUTOCOMPLETE, TYPE_TEXT_MAX } from './limits.js'

export type InputEvaluator = (script: string) => Promise<unknown>
export type InputSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export interface InputDeps {
  /** The tab's `WebContents`, used only as the queue's identity. */
  key: object
  send: InputSender
  /**
   * Holds the CDP attachment for the whole action, so a click's commands share
   * one attachment and it is not detached mid-sequence. Returns the release.
   */
  lease?: () => () => void
  evaluate: InputEvaluator
  /** Throws when the action must stop. Called before and after every await. */
  check: () => void
  /** `process.platform`, injected so the macOS key path is testable anywhere. */
  platform: string
}

export interface ClickRequest {
  ref?: string
  selector?: string
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

export interface ClickAtRequest {
  /** Viewport coordinates in CSS pixels. */
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

export interface TypeRequest {
  ref?: string
  selector?: string
  text: string
  /** Select the field's contents and delete them before typing. */
  clear?: boolean
  /** Press Enter afterwards. */
  submit?: boolean
}

export interface PressKeyRequest {
  /** Absent: the keys go to whatever has focus now. */
  ref?: string
  selector?: string
  /** One chord: pressed in order, released in reverse. */
  keys: string[]
}

export interface SelectRequest {
  ref?: string
  selector?: string
  value?: string
  label?: string
  index?: number
}

export interface SetCheckedRequest {
  ref?: string
  selector?: string
  checked: boolean
}

export interface HoverRequest {
  ref?: string
  selector?: string
}

export interface ScrollRequest {
  ref?: string
  selector?: string
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
}

export interface ActionResult {
  text: string
}

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 }

const pending = new Map<object, Promise<void>>()
const active = new Set<object>()

/**
 * Whether the agent is mid-burst on this tab.
 *
 * Phase 5 reads it to decide whether a key event in the page is the user taking
 * over or the echo of our own typing: a keystroke that arrives while this is
 * true came from us, and treating it as a takeover would abort every automation
 * sequence halfway through.
 */
export function isInputActive(key: object): boolean {
  return active.has(key)
}

/**
 * Runs `task` after everything already queued for this tab.
 *
 * The bookkeeping compares task identity before deleting: without that check a
 * finishing task removes the entry a *later* task has already installed, and the
 * queue silently stops serializing.
 */
export function enqueueInput<T>(key: object, task: () => Promise<T>): Promise<T> {
  const prior = pending.get(key) ?? Promise.resolve()
  const result = prior.then(task)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  pending.set(key, settled)
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key)
  })
  return result
}

function exclusive<T>(deps: InputDeps, task: () => Promise<T>): Promise<T> {
  return enqueueInput(deps.key, async () => {
    active.add(deps.key)
    const release = deps.lease?.()
    try {
      return await task()
    } finally {
      release?.()
      active.delete(deps.key)
    }
  })
}

export function clickTarget(deps: InputDeps, request: ClickRequest): Promise<ActionResult> {
  return exclusive(deps, async () => {
    const target = await resolve(deps, request, { focus: false, requireEnabled: true, requireHit: true })
    const button = request.button ?? 'left'
    const clickCount = Math.min(3, Math.max(1, Math.floor(request.clickCount ?? 1)))
    const at = await aim(deps, target)
    await pressAt(deps, at, button, clickCount)

    const how = clickCount > 1 ? `${clickCount}× ${button}-clicked` : button === 'left' ? 'clicked' : `${button}-clicked`
    return { text: `${how} ${describe(target)} at (${at.x}, ${at.y}). ${where(target)}` }
  })
}

/**
 * A press at a bare viewport point, for pages with no element to name: a
 * canvas, a map, an image editor.
 *
 * No hit test refuses it — at a coordinate there is no intended element for
 * something else to cover — but the answer names what the point landed on,
 * read before the press can change the page.
 */
export function clickAt(deps: InputDeps, request: ClickAtRequest): Promise<ActionResult> {
  return exclusive(deps, async () => {
    const at = { x: Math.round(request.x), y: Math.round(request.y) }
    const button = request.button ?? 'left'
    const clickCount = Math.min(3, Math.max(1, Math.floor(request.clickCount ?? 1)))
    deps.check()
    // Asked first, so a point off the viewport is refused before anything moves.
    const point = unwrap<PointResult>(await deps.evaluate(pointScript({ ...at, sensitiveWords: SENSITIVE_AUTOCOMPLETE })))
    deps.check()
    await deps.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 })
    deps.check()
    await pressAt(deps, at, button, clickCount)

    const how = clickCount > 1 ? `${clickCount}× ${button}-clicked` : button === 'left' ? 'clicked' : `${button}-clicked`
    return { text: `${how} at (${at.x}, ${at.y}), which landed on ${point.hit}. ${where(point)}` }
  })
}

export function typeText(deps: InputDeps, request: TypeRequest): Promise<ActionResult> {
  if (request.text.length > TYPE_TEXT_MAX) {
    throw new BrowserHostError(
      'INVALID_REQUEST',
      `page.type takes at most ${TYPE_TEXT_MAX} characters at a time; this call had ${request.text.length}.`,
    )
  }
  return exclusive(deps, async () => {
    const target = await resolve(deps, request, { focus: true, requireEnabled: true })

    if (request.clear === true) {
      await guard(deps, target, 'keyboard')
      await dispatchKeys(deps, describeKeys(['ControlOrMeta', 'a'], deps.platform))
      await dispatchKeys(deps, describeKeys(['Backspace'], deps.platform))
    }
    if (request.text !== '') {
      // `insertText` rather than a key event per character: a hundred round trips
      // is a visible stall, and a page that reacts to `input` — which is all of
      // them — cannot tell the difference. Pages keyed on `keydown` for
      // individual characters are the known gap, and `submit` covers the common
      // one of those.
      await guard(deps, target, 'keyboard')
      await deps.send('Input.insertText', { text: request.text })
      deps.check()
    }
    if (request.submit === true) {
      await guard(deps, target, 'keyboard')
      await dispatchKeys(deps, describeKeys(['Enter'], deps.platform))
    }

    const parts = [`typed ${request.text.length} characters into ${describe(target)}`]
    if (request.clear === true) parts.push('after clearing it')
    if (request.submit === true) parts.push('then pressed Enter')
    return { text: `${parts.join(', ')}. ${where(target)}` }
  })
}

/**
 * A chord, on a target or on whatever has focus.
 *
 * With a target it is focused first, like `page.type`, and the focus is
 * re-checked right before the first key goes down. Without one the keys go
 * where the page already has them going, which is what Escape on a dialog or
 * PageDown on a document wants.
 */
export function pressKeys(deps: InputDeps, request: PressKeyRequest): Promise<ActionResult> {
  const descriptions = describeKeys(request.keys, deps.platform)
  return exclusive(deps, async () => {
    const hasTarget = (request.ref ?? '') !== '' || (request.selector ?? '') !== ''
    const target = hasTarget ? await resolve(deps, request, { focus: true, requireEnabled: true }) : undefined
    if (target !== undefined) await guard(deps, target, 'keyboard')
    await dispatchKeys(deps, descriptions)

    // A printable key into a password field is a character of the password.
    // Without a target the focused field is unknown, so it gets the same care.
    const secret = typesCharacters(descriptions) && (target === undefined || target.sensitive)
    const what = secret
      ? `${descriptions.length} key${descriptions.length === 1 ? '' : 's'}`
      : descriptions.map(keyLabel).join('+')
    if (target === undefined) return { text: `pressed ${what} on the focused element.` }
    return { text: `pressed ${what} on ${describe(target)}. ${where(target)}` }
  })
}

export function selectOption(deps: InputDeps, request: SelectRequest): Promise<ActionResult> {
  requireTarget(request)
  const picks = [request.value !== undefined, request.label !== undefined, request.index !== undefined]
  if (picks.filter(Boolean).length !== 1) {
    throw new BrowserHostError('INVALID_REQUEST', 'page.select_option takes exactly one of "value", "label" or "index".')
  }
  return exclusive(deps, async () => {
    const options: SelectOptions = { nameMax: FIELD_MAX_NAME, sensitiveWords: SENSITIVE_AUTOCOMPLETE }
    if ((request.ref ?? '') !== '') options.ref = request.ref
    else options.selector = request.selector
    if (request.value !== undefined) options.value = request.value
    if (request.label !== undefined) options.label = request.label
    if (request.index !== undefined) options.index = request.index

    deps.check()
    const result = unwrap<SelectResult>(await deps.evaluate(selectScript(options)))
    deps.check()

    const picked = result.sensitive
      ? `option ${result.index}`
      : `option ${result.index} "${result.label}"${result.value !== '' && result.value !== result.label ? ` (value=${result.value})` : ''}`
    return { text: `selected ${picked} in ${describe(result)}. ${where(result)}` }
  })
}

/**
 * Makes a checkbox, radio or switch say what was asked, by clicking it only
 * when it does not already.
 *
 * The click is a real one, through the same hit test and guard as
 * `page.click`, because a toggle's state is the page's to change — a script
 * flipping `checked` would skip every handler that validates or syncs it. A
 * native input styled out of sight is clicked through its visible label.
 * The state is read again afterwards: a click the page ignored is reported,
 * not claimed.
 */
export function setChecked(deps: InputDeps, request: SetCheckedRequest): Promise<ActionResult> {
  requireTarget(request)
  return exclusive(deps, async () => {
    const before = await readCheckState(deps, request)
    const word = request.checked ? 'checked' : 'unchecked'
    const handle = (request.ref ?? '') !== '' ? request.ref : request.selector
    const who = `${handle} (${before.role}${before.name === '' ? '' : ` "${before.name}"`})`
    if (before.checked === request.checked) return { text: `${who} is already ${word}; nothing was clicked.` }
    if (!request.checked && before.radio) {
      throw new BrowserHostError(
        'INVALID_REQUEST',
        `${who} is a radio button, which cannot be unchecked directly. Select another option in its group instead.`,
      )
    }
    if (before.disabled) throw new BrowserHostError('ELEMENT_NOT_INTERACTABLE', `${who} is disabled.`)

    const target = await resolve(deps, request, { focus: false, requireEnabled: true, requireHit: true, viaLabel: true })
    const at = await aim(deps, target)
    await pressAt(deps, at, 'left', 1)

    const after = await readCheckState(deps, request)
    if (after.checked !== request.checked) {
      throw new BrowserHostError(
        'ELEMENT_NOT_INTERACTABLE',
        `Clicked ${who} at (${at.x}, ${at.y}), but it is still ${after.checked ? 'checked' : 'unchecked'}. The page may require something else first — read it with a snapshot.`,
      )
    }
    const via = target.role === 'label' ? ' through its label' : ''
    return { text: `${word} ${who} by clicking${via} at (${at.x}, ${at.y}). ${where(target)}` }
  })
}

/**
 * Puts the pointer on the element and leaves it there, so a menu or tooltip
 * that opens on `mouseover` opens.
 *
 * The same resolve and hit test as `page.click`, then one move and nothing
 * else: no guard after it, because what the hover opens is expected to cover
 * the point. A disabled element is still hovered — its tooltip is often the
 * one explaining why.
 */
export function hoverTarget(deps: InputDeps, request: HoverRequest): Promise<ActionResult> {
  return exclusive(deps, async () => {
    const target = await resolve(deps, request, { focus: false, requireEnabled: false, requireHit: true })
    const at = { x: Math.round(target.x), y: Math.round(target.y) }
    deps.check()
    await deps.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 })
    deps.check()
    return { text: `hovered over ${describe(target)} at (${at.x}, ${at.y}). ${where(target)}` }
  })
}

export function scrollPage(deps: InputDeps, request: ScrollRequest): Promise<ActionResult> {
  return exclusive(deps, async () => {
    const options: ScrollOptions = {
      direction: request.direction ?? 'down',
      viewportFraction: SCROLL_VIEWPORT_FRACTION,
    }
    if (request.ref !== undefined) options.ref = request.ref
    if (request.selector !== undefined) options.selector = request.selector
    if (request.amount !== undefined) options.amount = Math.max(1, Math.floor(request.amount))

    deps.check()
    const result = unwrap<ScrollResult>(await deps.evaluate(scrollScript(options)))
    deps.check()

    const position = `y=${Math.round(result.scrollY)} of ${Math.round(result.maxScrollY)}`
    const end = result.atBottom ? ' (bottom of the page)' : ''
    return { text: `scrolled ${result.target}: ${position}${end}. url=${result.url} title=${result.title}` }
  })
}

// --- internals ---------------------------------------------------------------

function requireTarget(request: { ref?: string; selector?: string }): void {
  if ((request.ref ?? '') === '' && (request.selector ?? '') === '') {
    throw new BrowserHostError(
      'INVALID_REQUEST',
      'Name a "ref" from page.elements.snapshot, or a CSS "selector".',
    )
  }
}

async function readCheckState(
  deps: InputDeps,
  request: { ref?: string; selector?: string },
): Promise<CheckStateResult> {
  const options: CheckStateOptions = { nameMax: FIELD_MAX_NAME, sensitiveWords: SENSITIVE_AUTOCOMPLETE }
  if ((request.ref ?? '') !== '') options.ref = request.ref
  else options.selector = request.selector
  deps.check()
  const state = unwrap<CheckStateResult>(await deps.evaluate(checkStateScript(options)))
  deps.check()
  return state
}

async function resolve(
  deps: InputDeps,
  request: { ref?: string; selector?: string },
  mode: { focus: boolean; requireEnabled: boolean; requireHit?: boolean; viaLabel?: boolean },
): Promise<TargetResult> {
  requireTarget(request)
  const options: TargetOptions = {
    nameMax: FIELD_MAX_NAME,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    scrollIntoView: true,
    focus: mode.focus,
    requireEnabled: mode.requireEnabled,
  }
  if (mode.requireHit === true) options.requireHit = true
  if (mode.viaLabel === true) options.viaLabel = true
  // A ref wins: it addresses the element the model actually read, while a
  // selector is re-resolved against whatever matches now.
  if ((request.ref ?? '') !== '') options.ref = request.ref
  else options.selector = request.selector

  deps.check()
  const target = unwrap<TargetResult>(await deps.evaluate(resolveScript(options)))
  deps.check()
  return target
}

/**
 * Hover over the target, then make sure the press will still land on it.
 *
 * The move comes first because half the web only reveals what it is about to
 * be clicked on hover: a menu that opens on `mouseover` is not open yet when
 * the press lands without one. The guard comes after it for the same reason —
 * whatever the hover opened is now part of what the press would hit.
 */
async function aim(deps: InputDeps, target: TargetResult): Promise<{ x: number; y: number }> {
  const at = { x: Math.round(target.x), y: Math.round(target.y) }
  deps.check()
  await deps.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 })
  await guard(deps, target, 'pointer', at)
  return at
}

/** One press and its release at a point the caller has already aimed at and guarded. */
async function pressAt(
  deps: InputDeps,
  at: { x: number; y: number },
  button: 'left' | 'right' | 'middle',
  clickCount: number,
): Promise<void> {
  const buttons = BUTTON_MASK[button] ?? 1
  await paired(
    () => deps.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button, buttons, clickCount }),
    () => deps.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button, buttons, clickCount }),
  )
  deps.check()
}

/** Re-asks the page whether the resolved element is still what the next command reaches. */
async function guard(
  deps: InputDeps,
  target: TargetResult,
  mode: 'pointer' | 'keyboard',
  at?: { x: number; y: number },
): Promise<void> {
  const options: GuardOptions = {
    mode,
    label: target.ref !== undefined ? `ref ${target.ref}` : `selector ${target.selector ?? ''}`,
    nameMax: FIELD_MAX_NAME,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
  }
  if (at !== undefined) {
    options.x = at.x
    options.y = at.y
  }
  deps.check()
  unwrap<boolean>(await deps.evaluate(guardScript(options)))
  deps.check()
}

/** The element, as the transcript should remember it. Never its value. */
function describe(target: { ref?: string; selector?: string; role: string; name: string; sensitive: boolean }): string {
  const handle = target.ref !== undefined ? target.ref : (target.selector ?? 'element')
  const name = target.sensitive || target.name === '' ? '' : ` "${target.name}"`
  return `${handle} (${target.role}${name})`
}

function where(target: { url: string; title: string }): string {
  return `url=${target.url} title=${target.title}`
}

/**
 * A press that is never left without its release.
 *
 * Chromium keeps CDP input state per page, so a press whose release never goes
 * out — a cancel or takeover observed between the two, or the press command
 * itself failing after the renderer saw it — leaves the button or key held down
 * under the person who just took the tab back: their next move becomes a drag,
 * their next keystroke a shortcut. So cancellation is checked before the press
 * and after the pair, never inside it; the release is sent whatever the press
 * did; and when both fail, the press's error is the one reported.
 *
 * Keys are the same rule with more than one press in flight: see `dispatchKeys`.
 */
async function paired(press: () => Promise<unknown>, release: () => Promise<unknown>): Promise<void> {
  let failure: { error: unknown } | undefined
  try {
    await press()
  } catch (error) {
    failure = { error }
  }
  try {
    await release()
  } catch (error) {
    failure ??= { error }
  }
  if (failure !== undefined) throw failure.error
}

/**
 * Presses a chord and lets it go, whatever happens in between.
 *
 * Keys go down in order, each carrying the modifiers held so far, and come up
 * in reverse. A key counts as pressed from the moment its command is sent —
 * a command that fails after the renderer saw it still left the key down — so
 * every one of them is lifted even when the press, a cancellation, or another
 * lift fails, and the first failure is the one reported.
 *
 * A key only types when no Control, Alt or Meta is held (Shift picks the
 * character instead): `keyDown` with `text` inserts it, while `rawKeyDown`
 * leaves the page to treat the chord as a shortcut.
 */
export async function dispatchKeys(deps: InputDeps, descriptions: readonly KeyDescription[]): Promise<void> {
  const mac = isMac(deps)
  const pressed: Array<{ base: Record<string, unknown> }> = []
  let modifiers = 0
  let failure: { error: unknown } | undefined
  try {
    for (const description of descriptions) {
      deps.check()
      if (isModifier(description)) modifiers |= MODIFIER_BITS[description.key] as number
      const base: Record<string, unknown> = {
        key: description.key,
        code: description.code,
        windowsVirtualKeyCode: description.keyCode,
        nativeVirtualKeyCode: description.keyCode,
        modifiers,
      }
      if (description.location !== undefined) base['location'] = description.location
      const types = description.text !== undefined && (modifiers & 7) === 0
      const down: Record<string, unknown> = { ...base, type: types ? 'keyDown' : 'rawKeyDown' }
      if (types) {
        down['text'] = description.text
        down['unmodifiedText'] = description.text
      }
      const command = mac && !isModifier(description) ? macCommand(description, modifiers) : undefined
      if (command !== undefined) down['commands'] = [command]
      pressed.push({ base })
      await deps.send('Input.dispatchKeyEvent', down)
    }
  } catch (error) {
    failure = { error }
  }
  for (const { base } of pressed.reverse()) {
    try {
      await deps.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure !== undefined) throw failure.error
  deps.check()
}

/** Whether any key in the chord inserts a character rather than acting as a shortcut. */
function typesCharacters(descriptions: readonly KeyDescription[]): boolean {
  let modifiers = 0
  for (const description of descriptions) {
    if (isModifier(description)) modifiers |= MODIFIER_BITS[description.key] as number
    else if (description.text !== undefined && description.key !== 'Enter' && (modifiers & 7) === 0) return true
  }
  return false
}

function keyLabel(description: KeyDescription): string {
  if (description.key === ' ') return 'Space'
  return description.key.length === 1 ? description.key.toUpperCase() : description.key
}

function isMac(deps: InputDeps): boolean {
  return deps.platform === 'darwin'
}
