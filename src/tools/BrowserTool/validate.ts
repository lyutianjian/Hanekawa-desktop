/**
 * Validation as instruction.
 *
 * The published schema (`schema.ts`) is flat, so it cannot say that
 * `tab.navigate` needs a `tabId` and a `url` while `browser.get_state` needs
 * nothing. That knowledge has to reach the model somewhere, and a rejection is
 * the moment it is most useful: the model is already holding the call it meant
 * to make, and one sentence naming the missing field turns the next turn into
 * the right call instead of a guess.
 *
 * So every message here names the operation, the field, and where the value
 * comes from. The generic zod issue is the fallback, not the product.
 */

import type { ToolValidationError, ToolValidationResult } from '../../harness/toolValidation.js'
import { BROWSER_OPERATIONS, OPERATIONS_NEEDING_TAB, OPERATIONS_NEEDING_TARGET, WAIT_FOR_DEFAULT_MS } from './constants.js'
import { browserInputSchema } from './schema.js'

/** Where a `tabId` comes from. Repeated on purpose: it is the common mistake. */
const TAB_ID_REMEDY = 'Get tabId from browser.get_state or browser.create_tab.'

const OPERATION_LIST = BROWSER_OPERATIONS.join(', ')

/** What a cursor read honours; every other snapshot field was fixed when the snapshot was taken. */
const CURSOR_FIELDS = new Set(['operation', 'tabId', 'cursor', 'maxChars'])

/** `page.wait_for` states about one element's own state, which text cannot answer. */
const ELEMENT_STATES = new Set(['enabled', 'disabled', 'checked', 'unchecked'])

function fail(message: string, path = 'operation'): ToolValidationResult {
  const error: ToolValidationError = { path, expected: 'valid Browser input', actual: 'invalid', message }
  return { ok: false, errors: [error] }
}

/** The fields one operation accepts, read off the schema so it cannot drift. */
export function fieldsFor(operation: string): { required: string[]; optional: string[] } | undefined {
  const option = browserInputSchema.options.find(
    (candidate) => (candidate.shape.operation as { value?: unknown }).value === operation,
  )
  if (option === undefined) return undefined
  const required: string[] = []
  const optional: string[] = []
  for (const [name, field] of Object.entries(option.shape)) {
    if (name === 'operation') continue
    ;(field.isOptional() ? optional : required).push(name)
  }
  return { required, optional }
}

function describeFields(operation: string): string {
  const fields = fieldsFor(operation)
  if (!fields) return ''
  const parts: string[] = []
  if (fields.required.length > 0) parts.push(`requires ${fields.required.join(', ')}`)
  parts.push(fields.optional.length > 0 ? `accepts ${fields.optional.join(', ')}` : 'accepts no other fields')
  return `${operation} ${parts.join('; ')}.`
}

/**
 * The rules a discriminated union cannot hold: "one of these two fields", and
 * "a cursor read takes no filters".
 *
 * They are checked after the schema rather than inside it because a `refine`
 * turns a branch into a `ZodEffects`, which `discriminatedUnion` will not take —
 * and because the message is the point, and a refinement's is generic.
 */
function crossFieldRules(operation: string, input: Record<string, unknown>): ToolValidationResult {
  const has = (key: string): boolean => typeof input[key] === 'string' && (input[key] as string) !== ''
  if (operation === 'browser.create_tab' || operation === 'tab.navigate') {
    if (has('url') && has('path')) {
      return fail(`${operation} takes "url" or "path", not both: "url" is an http(s) address, "path" is a page on disk.`, 'path')
    }
    if (operation === 'tab.navigate' && !has('url') && !has('path')) {
      return fail('tab.navigate needs a "url" (http or https) or a "path" (a page on disk).', 'url')
    }
  }
  if (has('cursor')) {
    const ignored = Object.keys(input).filter((key) => input[key] !== undefined && !CURSOR_FIELDS.has(key))
    if (ignored.length > 0) {
      return fail(
        `${operation} with "cursor" reads the snapshot already taken, so ${ignored.map((key) => `"${key}"`).join(', ')} would be ignored. To change the filters, drop "cursor" and scan again; to keep paging, pass only tabId, cursor and maxChars.`,
        ignored[0],
      )
    }
  }
  if (OPERATIONS_NEEDING_TARGET.has(operation) && !has('ref') && !has('selector')) {
    return fail(
      `${operation} needs an element: pass "ref" from a page.elements.snapshot row, or a CSS "selector".`,
      'ref',
    )
  }
  if (operation === 'page.select_option') {
    const picks = ['value', 'label', 'index'].filter((key) => input[key] !== undefined)
    if (picks.length !== 1) {
      return fail(
        `page.select_option takes exactly one of "value", "label" or "index"; this call had ${picks.length === 0 ? 'none' : picks.map((key) => `"${key}"`).join(' and ')}.`,
        'value',
      )
    }
  }
  if (operation === 'tab.emulate') {
    const device = ['preset', 'width', 'height', 'deviceScaleFactor', 'mobile', 'userAgent'].filter((key) => input[key] !== undefined)
    if (input['reset'] === true && device.length > 0) {
      return fail(
        `tab.emulate with reset clears the emulation and takes nothing else; drop ${device.map((key) => `"${key}"`).join(', ')}.`,
        device[0],
      )
    }
    if (input['reset'] !== true && !has('preset') && (input['width'] === undefined || input['height'] === undefined)) {
      return fail(
        'tab.emulate needs a "preset" (iphone, ipad or desktop), or both "width" and "height" — or reset: true to clear it.',
        'preset',
      )
    }
  }
  if (operation === 'page.wait_for' && !has('selector') && !has('text') && !has('url')) {
    return fail(
      'page.wait_for needs something to wait for: a CSS "selector", a "text", a "url", or a combination (all must hold).',
      'selector',
    )
  }
  if (operation === 'page.wait_for') {
    const state = input['state']
    if (typeof state === 'string' && ELEMENT_STATES.has(state) && (!has('selector') || has('text'))) {
      return fail(
        `page.wait_for with state "${state}" is about one element: pass a CSS "selector" and no "text".`,
        has('text') ? 'text' : 'selector',
      )
    }
    const stable = input['stableForMs']
    const timeout = typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : WAIT_FOR_DEFAULT_MS
    if (typeof stable === 'number' && stable >= timeout) {
      return fail(
        `page.wait_for: stableForMs (${stable}) must be shorter than timeoutMs (${timeout}), or the wait can never succeed.`,
        'stableForMs',
      )
    }
  }
  return { ok: true, errors: [] }
}

/** A stand-in for the tab a batch step will get from an earlier `browser.create_tab`. */
const CREATED_TAB = 'created-tab'

/** The URL a step starts a navigation to, or `undefined` when it navigates nowhere. */
export function navigationUrl(step: Record<string, unknown>): string | undefined {
  const { operation, url } = step
  return (operation === 'tab.navigate' || operation === 'browser.create_tab') && typeof url === 'string' ? url : undefined
}

/**
 * Every step is validated before any runs — a typo in step five must not
 * surface after four steps already moved the page — and a step's message says
 * which step it is.
 *
 * One navigation host per batch: permission is asked per host, and a single
 * approval for a call that visits two hosts would be an approval for the
 * second nobody looked at.
 */
function batchRules(batch: { tabId?: string | undefined; steps: Record<string, unknown>[] }): ToolValidationResult {
  let tabKnown = batch.tabId !== undefined
  const hosts = new Set<string>()
  for (const [index, step] of batch.steps.entries()) {
    const label = `steps[${index}]`
    const operation = step['operation']
    if (operation === 'batch') return fail(`${label}: a batch cannot contain another batch.`, label)
    let checked = step
    if (typeof operation === 'string' && OPERATIONS_NEEDING_TAB.has(operation) && step['tabId'] === undefined) {
      if (!tabKnown) {
        return fail(
          `${label} (${operation}) needs a tabId: give the step one, set the batch's tabId, or open the tab with browser.create_tab in an earlier step.`,
          `${label}.tabId`,
        )
      }
      checked = { ...step, tabId: batch.tabId ?? CREATED_TAB }
    }
    const result = validateBrowserInput(checked)
    if (!result.ok) {
      return {
        ok: false,
        errors: result.errors.map((error) => ({ ...error, path: `${label}.${error.path}`, message: `${label}: ${error.message}` })),
      }
    }
    if (operation === 'browser.create_tab') tabKnown = true
    const url = navigationUrl(step)
    if (url !== undefined) {
      try {
        hosts.add(new URL(url).hostname)
      } catch {
        hosts.add(url)
      }
    }
  }
  if (hosts.size > 1) {
    return fail(
      `A batch may navigate to one host only, and this one visits ${[...hosts].join(', ')}. Split it into one batch per host.`,
      'steps',
    )
  }
  return { ok: true, errors: [] }
}

export function validateBrowserInput(input: unknown): ToolValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(`Browser takes an object with an "operation" field. One of: ${OPERATION_LIST}.`)
  }

  const operation = (input as { operation?: unknown }).operation
  if (typeof operation !== 'string') {
    return fail(`Browser needs an "operation" field. One of: ${OPERATION_LIST}.`)
  }
  if (!(BROWSER_OPERATIONS as readonly string[]).includes(operation)) {
    return fail(`Unknown Browser operation "${operation}". One of: ${OPERATION_LIST}.`)
  }

  const parsed = browserInputSchema.safeParse(input)
  if (parsed.success && parsed.data.operation === 'batch') return batchRules(parsed.data)
  if (parsed.success) return crossFieldRules(operation, input as Record<string, unknown>)

  const errors = parsed.error.issues.map((issue) => {
    const field = issue.path.filter((part) => part !== 'operation').join('.')
    if (issue.code === 'unrecognized_keys') {
      return {
        path: issue.keys.join(', '),
        expected: describeFields(operation),
        actual: issue.keys.join(', '),
        message: `${operation} does not take ${issue.keys.map((key) => `"${key}"`).join(', ')}. ${describeFields(operation)}`,
      }
    }
    const missing = issue.code === 'invalid_type' && issue.received === 'undefined'
    const remedy = field === 'tabId' ? ` ${TAB_ID_REMEDY}` : ''
    const message = missing
      ? `${operation} requires "${field}". ${describeFields(operation)}${remedy}`
      : `${operation}: ${field || 'input'} ${issue.message.toLowerCase()}. ${describeFields(operation)}`
    return { path: field || 'operation', expected: describeFields(operation), actual: issue.code, message }
  })

  return { ok: false, errors }
}
