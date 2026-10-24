import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFORT_LABELS,
  PERMISSION_MODE_LABELS,
  PERMISSION_PILL_MODES,
  composerChipView,
  insertMentionToken,
  permissionPillView,
  submitButtonView,
  submitLabel,
} from '../src/desktop/renderer/model/composer.js'
import type { WireReadyRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The composer chip's decisions, with no DOM in sight — the `model/` half of
 * the renderer's split, same as `test/rendererSidebar.test.ts`.
 */

function runtime(overrides: Partial<WireReadyRuntimeSnapshot> = {}): WireReadyRuntimeSnapshot {
  return {
    status: 'ready',
    modelKey: 'sonnet',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }
}

test('the chip is inert until a runtime snapshot arrives', () => {
  // A pane that has not finished starting must not show the *previous* pane's
  // model, which is why `renderStatus` repaints the chip even with no snapshot.
  const view = composerChipView(undefined)
  assert.equal(view.enabled, false)
  assert.equal(view.model, '…')
  assert.equal(view.effort, '…')
  assert.equal(view.atCeiling, false)
})

test('an unconfigured runtime offers settings instead of a loading placeholder', () => {
  const view = composerChipView({
    status: 'needs_configuration',
    configurationIssue: { code: 'no_default_model', message: '尚未配置模型。' },
    effort: 'high',
    permissionMode: 'default',
  })
  assert.equal(view.enabled, true)
  assert.equal(view.model, '配置模型')
  assert.match(view.title, /点击配置模型与服务商/)
})

test('the chip shows the model and the effort level', () => {
  const view = composerChipView(runtime())
  assert.equal(view.model, 'sonnet')
  assert.equal(view.effort, EFFORT_LABELS.high)
  assert.equal(view.enabled, true)
  assert.match(view.modelTitle, /sonnet/)
})

test('the chip tooltip names the two fields it opens, and no context figures', () => {
  const view = composerChipView(runtime())
  assert.match(view.title, /模型：sonnet/)
  assert.match(view.title, /思考强度/)
  assert.doesNotMatch(view.title, /上下文/)
})



test('the chip title is exactly its model and effort titles', () => {
  const view = composerChipView(runtime())
  assert.equal(view.title, `${view.modelTitle}\n${view.effortTitle}`)
})

test('the provider is in the tooltip, not the chip', () => {
  // The chip has room for a name, not a name and a vendor; the vendor is the
  // kind of thing you go looking for rather than read at a glance.
  const view = composerChipView(runtime({ providerName: 'anthropic' }))
  assert.equal(view.model, 'sonnet')
  assert.match(view.modelTitle, /anthropic/)
})

test('a raw token budget is shown verbatim', () => {
  // `WireReadyRuntimeSnapshot.effort` is a string because `set-effort.level` accepts
  // a decimal token budget as well as a level name. A budget has no rung on the
  // ladder, so there is no label to map it to.
  const view = composerChipView(runtime({ effort: '32000' }))
  assert.equal(view.effort, '32000')
  assert.equal(view.atCeiling, false, 'a budget cannot be compared against a level ceiling')
})

const CAPPED = ['low', 'medium', 'high'] as const

test('atCeiling is true at the model maximum and false below it', () => {
  assert.equal(composerChipView(runtime({ effort: 'high', supportedEfforts: [...CAPPED] })).atCeiling, true)
  assert.equal(composerChipView(runtime({ effort: 'medium', supportedEfforts: [...CAPPED] })).atCeiling, false)
  // At or above, not merely equal: a stale config can leave effort past the
  // ceiling, and the chip should still say "this is as far as it goes".
  assert.equal(composerChipView(runtime({ effort: 'max', supportedEfforts: [...CAPPED] })).atCeiling, true)
  assert.equal(composerChipView(runtime({ effort: 'max' })).atCeiling, false, 'no ceiling declared')
  // The highest *supported* level, not the highest rung: a gapped set tops out
  // wherever its own last entry is.
  assert.equal(composerChipView(runtime({ effort: 'high', supportedEfforts: ['low', 'high'] })).atCeiling, true)
  assert.equal(composerChipView(runtime({ effort: 'low', supportedEfforts: ['low', 'high'] })).atCeiling, false)
})

test('the ceiling is explained in the tooltip when it has been reached', () => {
  const capped = composerChipView(runtime({ effort: 'high', supportedEfforts: [...CAPPED] }))
  assert.match(capped.effortTitle, /最高档/)
  const room = composerChipView(runtime({ effort: 'low', supportedEfforts: [...CAPPED] }))
  assert.doesNotMatch(room.effortTitle, /最高档/)
})

test('every effort level has a label', () => {
  // Guards the chip against rendering `undefined` if a level is ever added.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(typeof EFFORT_LABELS[level], 'string')
    assert.ok(EFFORT_LABELS[level].length > 0)
  }
})

test('the send button relabels rather than disabling mid-turn', () => {
  // The button stays enabled while streaming, and the Enter path reaches the
  // same verdict: `requestSubmit()` ignores a disabled button, so a disagreement
  // here swallows the click silently.
  assert.notEqual(submitLabel(true), submitLabel(false))
})

test('one button: lit send with text, stop when a turn runs with nothing typed', () => {
  assert.deepEqual(submitButtonView({ streaming: false, empty: true }), { state: 'idle', label: submitLabel(false), showStop: false })
  assert.deepEqual(submitButtonView({ streaming: false, empty: false }), { state: 'ready', label: submitLabel(false), showStop: false })
  assert.equal(submitButtonView({ streaming: true, empty: true }).showStop, true)
  // Typing mid-turn brings the lit send back: the message steers the turn.
  assert.deepEqual(submitButtonView({ streaming: true, empty: false }), { state: 'ready', label: submitLabel(true), showStop: false })
})

// --- the permission pill ----------------------------------------------------

test('the pill is inert until a runtime snapshot arrives', () => {
  const view = permissionPillView({ runtime: undefined, open: true })
  assert.equal(view.enabled, false)
  assert.equal(view.label, '…')
  // Never open while inert: a menu over a pill with nothing to switch would sit
  // there until the snapshot landed.
  assert.equal(view.open, false)
})

test('the pill names the live mode and offers the four switchable ones', () => {
  const view = permissionPillView({ runtime: runtime({ permissionMode: 'auto' }), open: true })
  assert.equal(view.label, PERMISSION_MODE_LABELS.auto)
  assert.equal(view.enabled, true)
  assert.equal(view.open, true)
  assert.deepEqual(view.options.map((option) => option.mode), [...PERMISSION_PILL_MODES])
  assert.deepEqual(
    view.options.filter((option) => option.current).map((option) => option.mode),
    ['auto'],
    'exactly one option is the current one',
  )
})

test('a mode outside the menu is still named rather than mislabelled', () => {
  // `readonly` is not offered — the built-in `explore`/`plan` agents run under it
  // and a user does not pick it for a conversation — but a snapshot can carry it,
  // and a pill that showed the first option instead would be a lie about the gate.
  const view = permissionPillView({ runtime: runtime({ permissionMode: 'readonly' }), open: false })
  assert.equal(view.label, PERMISSION_MODE_LABELS.readonly)
  assert.equal(view.options.some((option) => option.current), false)
  assert.equal(PERMISSION_PILL_MODES.includes('readonly'), false)
})

test('a coordinator lane hides the permission pill; a thread lane keeps it', () => {
  const rt = runtime({ permissionMode: 'readonly' })
  const coordinator = permissionPillView({ runtime: rt, open: true, coordinator: true })
  assert.equal(coordinator.hidden, true)
  assert.equal(coordinator.open, false)
  assert.equal(permissionPillView({ runtime: rt, open: false, coordinator: false }).hidden, false)
  assert.equal(permissionPillView({ runtime: rt, open: false }).hidden, false)
})

test('every permission mode has a label, including the unoffered one', () => {
  for (const mode of ['default', 'plan', 'auto', 'bypass', 'readonly'] as const) {
    assert.ok(PERMISSION_MODE_LABELS[mode].length > 0, `${mode} has no label`)
  }
})

// --- the attachment control -------------------------------------------------

test('the mention token goes in at the caret, not at the end', () => {
  assert.deepEqual(insertMentionToken('hello world', 5), { text: 'hello @ world', cursorPos: 7 })
})

test('a mid-word caret gets a space first, so the mention starts a token', () => {
  // Without it the control produces `foo@`, which the mention scanner does not
  // recognise — the completion would simply never open.
  assert.deepEqual(insertMentionToken('foo', 3), { text: 'foo @', cursorPos: 5 })
})

test('no space is added where one is not needed', () => {
  assert.deepEqual(insertMentionToken('', 0), { text: '@', cursorPos: 1 })
  assert.deepEqual(insertMentionToken('foo ', 4), { text: 'foo @', cursorPos: 5 })
  assert.deepEqual(insertMentionToken('foo\n', 4), { text: 'foo\n@', cursorPos: 5 })
})

test('an @ already before the caret is left alone rather than doubled', () => {
  assert.deepEqual(insertMentionToken('see @', 5), { text: 'see @', cursorPos: 5 })
})

test('an out-of-range caret is clamped rather than producing a hole', () => {
  assert.deepEqual(insertMentionToken('ab', 99), { text: 'ab @', cursorPos: 4 })
  assert.deepEqual(insertMentionToken('ab', -3), { text: '@ab', cursorPos: 1 })
})
