import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_PLAN_OPTIONS,
  ENTER_PLAN_OPTIONS,
  buildExitPlanModeOptions,
  emptyPlanOptions,
  enterPlanOptions,
  elevatedExitPlanModeDecision,
  exitPlanDecisionFor,
  exitPlanOptionsFor,
  isEmptyPlan,
  previewMarkdownLines,
} from '../src/runtime/planPresentation.js'

/**
 * The plan dialogs' shared decisions, now that a DOM view offers them too.
 *
 * `test/exitPlanModeDialog.test.ts` still covers the same three functions
 * through the TUI component's re-export, which is what pins that the move did
 * not change behaviour. What is new here is the part the terminal dialog had
 * inlined in JSX and a renderer therefore could not reuse: which option list an
 * empty plan gets, and which half of the decision carries the plan text.
 */

test('an empty plan drops the elevated slot instead of showing it inert', () => {
  const options = exitPlanOptionsFor({ planContent: '   \n  ', isBypassAvailable: true })

  assert.deepEqual(options, EMPTY_PLAN_OPTIONS)
  assert.deepEqual(options.map((option) => option.kind), ['approve_restore_keep', 'reject'])
  assert.equal(isEmptyPlan('   \n  '), true)
})

test('a non-empty plan gets the full slot list, bypass first when available', () => {
  const withBypass = exitPlanOptionsFor({ planContent: '# Plan', isBypassAvailable: true })
  const without = exitPlanOptionsFor({ planContent: '# Plan' })

  assert.deepEqual(withBypass, buildExitPlanModeOptions({ isBypassAvailable: true }))
  assert.equal(withBypass[0]?.kind, 'approve_bypass_keep')
  assert.equal(without[0]?.kind, 'approve_auto_keep')
  assert.equal(isEmptyPlan('# Plan'), false)
})

test('approvals carry the plan and only rejection carries feedback', () => {
  const state = { planContent: '# Plan\n- step', feedback: 'not yet' }

  assert.deepEqual(
    exitPlanDecisionFor({ kind: 'approve_restore_keep', label: '' }, state),
    { kind: 'approve_restore_keep', planContent: '# Plan\n- step' },
  )
  assert.deepEqual(
    exitPlanDecisionFor({ kind: 'approve_bypass_keep', label: '' }, state),
    { kind: 'approve_bypass_keep', planContent: '# Plan\n- step' },
  )
  // Backwards would silently drop either the user's note or the plan the agent
  // is about to execute.
  assert.deepEqual(
    exitPlanDecisionFor({ kind: 'reject', label: '' }, state),
    { kind: 'reject', feedback: 'not yet' },
  )
})

test('the elevated shortcut picks bypass only when it is available', () => {
  assert.equal(elevatedExitPlanModeDecision({ isBypassAvailable: true }), 'approve_bypass_keep')
  assert.equal(elevatedExitPlanModeDecision({ isBypassAvailable: false }), 'approve_auto_keep')
  assert.equal(elevatedExitPlanModeDecision(true), 'approve_bypass_keep')
  assert.equal(elevatedExitPlanModeDecision(false), 'approve_auto_keep')
})

test('the enter-plan options are two, ordered yes then no', () => {
  assert.deepEqual(ENTER_PLAN_OPTIONS.map((option) => option.value), ['yes', 'no'])
  assert.deepEqual(ENTER_PLAN_OPTIONS.map((option) => option.hotkey), ['1', '2'])
})

test('the preview keeps head and tail and reports how many lines it dropped', () => {
  const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

  const preview = previewMarkdownLines(content, 5)
  const lines = preview.split('\n')

  assert.equal(lines.length, 5)
  assert.equal(lines[0], 'line 1')
  assert.equal(lines.at(-1), 'line 20')
  assert.match(preview, /\[\.\.\. 16 lines omitted from preview \.\.\.\]/)
})

test('the preview leaves a short plan byte-identical and handles maxLines 1', () => {
  const short = 'one\ntwo\nthree'
  assert.equal(previewMarkdownLines(short, 5), short)

  const single = previewMarkdownLines('a\nb\nc', 1)
  assert.equal(single, 'a\n[... 2 lines omitted from preview ...]')
})

// --- locale -----------------------------------------------------------------

test('the locale parameter defaults to English, which is what keeps the TUI untouched', () => {
  assert.deepEqual(enterPlanOptions(), ENTER_PLAN_OPTIONS)
  assert.deepEqual(emptyPlanOptions(), EMPTY_PLAN_OPTIONS)
  assert.equal(ENTER_PLAN_OPTIONS[0]?.label, 'Yes, enter plan mode')
  assert.equal(
    buildExitPlanModeOptions({ isBypassAvailable: true })[0]?.label,
    'Yes, and bypass permissions',
  )
  assert.match(previewMarkdownLines('a\nb\nc', 2), /lines omitted from preview/)
})

test('Chinese changes the labels, never the slots', () => {
  const zh = buildExitPlanModeOptions({ isBypassAvailable: true, locale: 'zh' })
  assert.deepEqual(
    zh.map((option) => option.kind),
    buildExitPlanModeOptions({ isBypassAvailable: true }).map((option) => option.kind),
    'the slot order is the hotkey map',
  )
  assert.equal(zh[0]?.label, '好，并开启完全访问权限')
  assert.equal(enterPlanOptions('zh')[0]?.label, '好，进入计划模式')
  assert.deepEqual(enterPlanOptions('zh').map((option) => option.hotkey), ['1', '2'])
  assert.deepEqual(emptyPlanOptions('zh').map((option) => option.kind), ['approve_restore_keep', 'reject'])
  assert.deepEqual(exitPlanOptionsFor({ planContent: '  ', locale: 'zh' }), emptyPlanOptions('zh'))
  assert.match(previewMarkdownLines('a\nb\nc', 2, 'zh'), /预览中省略/)
})
