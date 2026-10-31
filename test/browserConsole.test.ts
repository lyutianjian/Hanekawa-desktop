import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONSOLE_ERROR_MAX_CHARS,
  CONSOLE_ERRORS_KEPT,
  ConsoleErrors,
} from '../src/desktop/browser/console.js'

/**
 * A page's console is the only place that explains a click that did nothing, so
 * the bookkeeping matters in two directions: nothing is lost before the agent
 * reads it, and nothing is repeated after. Neither needs a window.
 */

const PAGE = 7

test('errors are handed over once, then kept as seen', () => {
  const errors = new ConsoleErrors()
  errors.record(PAGE, 'TypeError: x is undefined', 'https://x.test/app.js', 12)
  assert.deepEqual(errors.take(PAGE), ['TypeError: x is undefined (app.js:12)'])
  assert.deepEqual(errors.take(PAGE), [])
})

test('a repeated error is one line, and a new one still arrives', () => {
  const errors = new ConsoleErrors()
  errors.record(PAGE, 'boom', '', 0)
  errors.record(PAGE, 'boom', '', 0)
  assert.deepEqual(errors.take(PAGE), ['boom'])
  // Repeating an error that was already reported does not resurrect it: a page
  // throwing on every frame would otherwise fill every later read.
  errors.record(PAGE, 'boom', '', 0)
  assert.deepEqual(errors.take(PAGE), [])
  errors.record(PAGE, 'other', '', 0)
  assert.deepEqual(errors.take(PAGE), ['other'])
})

test('order is oldest first, and one page is not another', () => {
  const errors = new ConsoleErrors()
  errors.record(PAGE, 'first', '', 0)
  errors.record(PAGE, 'second', '', 0)
  errors.record(9, 'elsewhere', '', 0)
  assert.deepEqual(errors.take(PAGE), ['first', 'second'])
  assert.deepEqual(errors.take(9), ['elsewhere'])
  assert.deepEqual(errors.take(404), [])
})

test('forget drops what a page said, as a navigation does', () => {
  const errors = new ConsoleErrors()
  errors.record(PAGE, 'from the old document', '', 0)
  errors.forget(PAGE)
  assert.deepEqual(errors.take(PAGE), [])
})

test('a new error pushes the oldest out, and an empty message is not one', () => {
  const errors = new ConsoleErrors()
  for (let index = 0; index < CONSOLE_ERRORS_KEPT + 3; index += 1) errors.record(PAGE, `error ${index}`, '', 0)
  errors.record(PAGE, '   ', '', 0)
  const kept = errors.take(PAGE)
  assert.equal(kept.length, CONSOLE_ERRORS_KEPT)
  assert.equal(kept[0], 'error 3')
  assert.equal(kept.at(-1), `error ${CONSOLE_ERRORS_KEPT + 2}`)
})

test('a message is one clipped line, with a web source beside it', () => {
  const errors = new ConsoleErrors()
  errors.record(PAGE, 'Uncaught\n  Error:   bad\n', 'https://x.test/js/deep/chunk.js?h=1', 44)
  // A non-web source is not the site's code, so it contributes no location:
  // `data:` and `blob:` have no path worth reading.
  errors.record(PAGE, 'from an extension', 'chrome-extension://abc/inject.js', 3)
  errors.record(PAGE, 'from nowhere', 'not a url', 9)
  errors.record(PAGE, 'x'.repeat(CONSOLE_ERROR_MAX_CHARS * 2), '', 0)
  const kept = errors.take(PAGE)
  assert.deepEqual(kept.slice(0, 3), [
    'Uncaught Error: bad (chunk.js:44)',
    'from an extension',
    'from nowhere',
  ])
  assert.equal(kept[3]?.length, CONSOLE_ERROR_MAX_CHARS)
  assert.ok(kept[3]?.endsWith('…'))
})