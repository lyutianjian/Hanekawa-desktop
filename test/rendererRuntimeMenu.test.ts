import assert from 'node:assert/strict'
import test from 'node:test'

import { EFFORT_LABELS } from '../src/desktop/renderer/model/composer.js'
import { runtimeMenuView } from '../src/desktop/renderer/model/runtimeMenu.js'
import type { WireModelsResult, WireReadyRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The composer chip's popover, as a decision.
 *
 * The point of the module is that it does *not* re-answer what the options are:
 * the rows come from `modelPickerView` / `effortPickerView`, the same two the
 * `#surface` cards `/model` and `/effort` open are built from. So what is worth
 * asserting here is the folding — which value each row shows, and what survives
 * a missing snapshot or a model list that could not be fetched.
 */

const MODELS: WireModelsResult = {
  models: [],
  pickerOptions: [
    // Every field the picker card spells out, so "the flyout shows the name and
    // nothing else" is a claim with something to strip.
    {
      key: 'sonnet',
      label: 'Sonnet',
      modelKey: 'sonnet',
      modelId: 'claude-sonnet-5',
      providerName: 'anthropic',
      supportsImageInput: true,
      isCurrent: true,
      isDefault: true,
    },
    {
      key: 'opus',
      label: 'Opus',
      modelKey: 'opus',
      modelId: 'claude-opus-5',
      providerName: 'anthropic',
      isCurrent: false,
      isDefault: false,
    },
  ],
}

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

test('the two rows name their field and show the value in force', () => {
  const view = runtimeMenuView({ runtime: runtime(), models: MODELS })

  assert.equal(view.enabled, true)
  assert.deepEqual(view.entries.map((entry) => [entry.key, entry.label, entry.value]), [
    ['model', '模型', 'sonnet'],
    ['effort', '思考强度', EFFORT_LABELS.high],
  ])
  assert.deepEqual(view.entries.map((entry) => entry.title), ['选择模型', '选择思考强度'])
})

test('each row carries the picker rows, actions and marks included', () => {
  const view = runtimeMenuView({ runtime: runtime(), models: MODELS })
  const [model, effort] = view.entries

  assert.deepEqual(model!.rows.map((row) => row.id), ['sonnet', 'opus'])
  // A name and nothing else — except the image marker, the one attribute worth
  // the flyout's width when the current model has just refused an image.
  assert.deepEqual(model!.rows.map((row) => [row.label, row.detail]), [
    ['Sonnet', '视觉'],
    ['Opus', ''],
  ])
  assert.equal(model!.rows[0]!.current, true)
  // A slash command, not `set-model`: that is what persists the choice.
  assert.deepEqual(model!.rows[1]!.action, { kind: 'run-command', line: '/model opus' })
  assert.deepEqual(effort!.rows.map((row) => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(effort!.rows[0]!.action, { kind: 'run-command', line: '/effort low' })
})

test('a model that cannot be loaded keeps its reason and stays unpickable', () => {
  // The one thing besides the name that survives the trim: a row nobody can pick
  // and that does not say why is worse than a noisy one.
  const view = runtimeMenuView({
    runtime: runtime(),
    models: {
      models: [],
      pickerOptions: [
        { key: 'broken', label: 'Broken', modelKey: 'broken', disabledReason: '缺少 API key', isCurrent: false, isDefault: false },
      ],
    },
  })

  const row = view.entries[0]!.rows[0]!
  assert.deepEqual([row.label, row.detail, row.disabledReason], ['Broken', '', '缺少 API key'])
  assert.equal(row.action, undefined)
})

test('a level the model does not support is disabled with its reason', () => {
  const view = runtimeMenuView({
    runtime: runtime({ supportedEfforts: ['low', 'medium', 'high'] }),
    models: MODELS,
  })
  const effort = view.entries[1]!

  const blocked = effort.rows.filter((row) => row.disabled)
  assert.deepEqual(blocked.map((row) => row.id), ['xhigh', 'max'])
  assert.match(blocked[0]!.disabledReason ?? '', /不支持/)
  assert.equal(blocked[0]!.action, undefined)
})

test('a model list that could not be fetched still opens the menu', () => {
  // The effort half is answerable from the snapshot alone, and a chip that
  // silently refuses to open reads as the app having hung.
  const view = runtimeMenuView({ runtime: runtime(), models: undefined })

  assert.equal(view.enabled, true)
  assert.deepEqual(view.entries[0]!.rows, [])
  assert.equal(view.entries[0]!.value, 'sonnet', 'the current model is still named')
  assert.equal(view.entries[1]!.rows.length, 5)
})

test('no snapshot means no menu', () => {
  const view = runtimeMenuView({ runtime: undefined, models: MODELS })

  assert.equal(view.enabled, false)
  // Still two entries: the view is inert, not malformed, and the chip's own
  // placeholder comes from the same `composerChipView`.
  assert.deepEqual(view.entries.map((entry) => entry.key), ['model', 'effort'])
})

test('a raw token budget is shown verbatim rather than forced onto the ladder', () => {
  // `effort` is a string on the wire because it carries either a level name or a
  // token budget as a decimal string.
  const view = runtimeMenuView({ runtime: runtime({ effort: '24000' }), models: MODELS })

  assert.equal(view.entries[1]!.value, '24000')
  assert.equal(view.entries[1]!.rows.every((row) => !row.current), true)
})
