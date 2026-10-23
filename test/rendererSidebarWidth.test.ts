import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  RESIZER_KEY_STEP,
  clampSidebarWidth,
  parseSidebarWidth,
  resizerKeyWidth,
  sidebarWidthVariable,
} from '../src/desktop/renderer/model/sidebarWidth.js'

/**
 * The rail's width: the three decisions behind a drag.
 *
 * Pure, so the drag itself — pointer capture, the class that suspends the
 * collapse transition — is the only part of the feature `app.ts` owns and the
 * arithmetic is testable without a window.
 */

test('a width is clamped to the two resting bounds and rounded', () => {
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MIN - 100), SIDEBAR_WIDTH_MIN)
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX + 100), SIDEBAR_WIDTH_MAX)
  assert.equal(clampSidebarWidth(-4000), SIDEBAR_WIDTH_MIN)
  // Sub-pixel drags are real (a fractional `clientX` on a scaled display); the
  // property they end up in is a whole number of CSS pixels.
  assert.equal(clampSidebarWidth(300.4), 300)
})

test('a width that is not a number at all falls back to the default', () => {
  // Not clamped to an edge: `NaN` means the caller has no width, and the narrow
  // bound would be a rail the user never asked for.
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_WIDTH_DEFAULT)
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_DEFAULT)
})

test('nothing stored is the default, and a stored value is clamped rather than dropped', () => {
  assert.equal(parseSidebarWidth(null), SIDEBAR_WIDTH_DEFAULT)
  assert.equal(parseSidebarWidth('320'), 320)
  assert.equal(parseSidebarWidth('320px'), 320)
  assert.equal(parseSidebarWidth('nonsense'), SIDEBAR_WIDTH_DEFAULT)
  // A value written by a build with a wider range comes back inside today's.
  assert.equal(parseSidebarWidth(String(SIDEBAR_WIDTH_MAX + 200)), SIDEBAR_WIDTH_MAX)
})

test('the custom property carries its unit, so app.ts never spells px', () => {
  assert.equal(sidebarWidthVariable(300), '300px')
  assert.equal(sidebarWidthVariable(Number.NaN), `${SIDEBAR_WIDTH_DEFAULT}px`)
})

test('a focused resizer answers the slider keys, in the direction its column grows', () => {
  // The handles were pointer-only; a focusable separator is a slider to a screen
  // reader, so it takes the slider's keys. The side panel's handle is on its
  // left edge, so there ← widens.
  const rail = { min: 200, max: 320, grows: 'right' as const }
  const side = { min: 240, max: 900, grows: 'left' as const }
  assert.equal(resizerKeyWidth('ArrowRight', false, 256, rail), 256 + RESIZER_KEY_STEP)
  assert.equal(resizerKeyWidth('ArrowLeft', false, 256, rail), 256 - RESIZER_KEY_STEP)
  assert.equal(resizerKeyWidth('ArrowLeft', false, 400, side), 400 + RESIZER_KEY_STEP)
  assert.equal(resizerKeyWidth('ArrowRight', true, 400, side), 400 - RESIZER_KEY_STEP * 4)
  assert.equal(resizerKeyWidth('ArrowUp', false, 400, side), 400 + RESIZER_KEY_STEP)
  assert.equal(resizerKeyWidth('ArrowDown', false, 256, rail), 256 - RESIZER_KEY_STEP)
  assert.equal(resizerKeyWidth('Home', false, 256, rail), 200)
  assert.equal(resizerKeyWidth('End', false, 400, side), 900)
  assert.equal(resizerKeyWidth('Enter', false, 256, rail), undefined)
})
