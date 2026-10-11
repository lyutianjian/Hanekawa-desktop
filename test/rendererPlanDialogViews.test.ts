import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyExitPlanIntent,
  createExitPlanState,
  enterPlanKeyToIntent,
  enterPlanViewModel,
  exitPlanKeyToIntent,
  exitPlanViewModel,
} from '../src/desktop/renderer/model/planDialogs.js'
import type { ExitPlanIntent, ExitPlanState } from '../src/desktop/renderer/model/planDialogs.js'
import type { ExitDialogInput, ExitPlanDecision } from '../src/harness/planModeManager.js'

/** The desktop plan cards as data: button layout, the 修改… state, and the keys. */

function input(overrides: Partial<ExitDialogInput> = {}): ExitDialogInput {
  return {
    planContent: '# Plan\n- do the thing',
    planFilePath: '.myagent/plans/plan.md',
    ...overrides,
  }
}

function run(state: ExitPlanState, intents: ExitPlanIntent[]): { state: ExitPlanState; decision: ExitPlanDecision | undefined } {
  let current = state
  let decision: ExitPlanDecision | undefined
  for (const intent of intents) {
    const outcome = applyExitPlanIntent(current, intent)
    current = outcome.state
    if ('decision' in outcome) decision = outcome.decision
  }
  return { state: current, decision }
}

const labels = (state: ExitPlanState) => exitPlanViewModel(state).buttons.map((button) => button.label)

test('entering plan mode is a compact question with 拒绝 and a primary 允许', () => {
  const view = enterPlanViewModel()
  assert.equal(view.title, '助手想先进入计划模式')
  assert.match(view.body, /你确认前不会修改文件/)
  assert.deepEqual(view.buttons.map((button) => button.label), ['拒绝', '允许'])
  assert.deepEqual(view.buttons.map((button) => button.primary), [false, true])
  assert.deepEqual(view.buttons.map((button) => button.intent), [
    { kind: 'answer', approved: false },
    { kind: 'answer', approved: true },
  ])
})

test('entry keys: Enter and 1 allow, Escape and 2 decline, modified keys do nothing', () => {
  assert.deepEqual(enterPlanKeyToIntent({ key: 'Enter' }), { kind: 'answer', approved: true })
  assert.deepEqual(enterPlanKeyToIntent({ key: '1' }), { kind: 'answer', approved: true })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'Escape' }), { kind: 'answer', approved: false })
  assert.deepEqual(enterPlanKeyToIntent({ key: '2' }), { kind: 'answer', approved: false })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'Enter', metaKey: true }), { kind: 'none' })
  assert.deepEqual(enterPlanKeyToIntent({ key: 'x' }), { kind: 'none' })
})

test('a proposed plan lays out 拒绝 / 修改… on the left and 接受 / 接受并自动执行 on the right', () => {
  const view = exitPlanViewModel(createExitPlanState(input()))
  assert.equal(view.title, '助手提出了一个计划')
  assert.equal(view.planFilePath, '.myagent/plans/plan.md')
  assert.deepEqual(view.buttons.map((button) => [button.label, button.side, button.shortcut]), [
    ['拒绝', 'start', undefined],
    ['修改…', 'start', 'Esc'],
    ['接受', 'end', '⌘⇧⏎'],
    ['接受并自动执行', 'end', '⌘⏎'],
  ])
  assert.deepEqual(view.buttons.filter((button) => button.primary).map((button) => button.label), ['接受并自动执行'])
})

test('bypass turns the primary into 接受并绕过权限', () => {
  const state = createExitPlanState(input({ isBypassAvailable: true }))
  assert.deepEqual(labels(state), ['拒绝', '修改…', '接受', '接受并绕过权限'])
  assert.equal(run(state, [{ kind: 'approve', slot: 0 }]).decision?.kind, 'approve_bypass_keep')
})

test('接受 keeps manual edit approval, the primary asks only when needed; both carry the plan text', () => {
  const state = createExitPlanState(input())
  assert.deepEqual(run(state, [{ kind: 'approve', slot: 1 }]).decision, {
    kind: 'approve_restore_keep',
    planContent: '# Plan\n- do the thing',
  })
  assert.deepEqual(run(state, [{ kind: 'approve', slot: 0 }]).decision, {
    kind: 'approve_auto_keep',
    planContent: '# Plan\n- do the thing',
  })
})

test('拒绝 rejects with no feedback', () => {
  assert.deepEqual(run(createExitPlanState(input()), [{ kind: 'reject' }]).decision, { kind: 'reject', feedback: '' })
})

test('修改… opens the field; sending rejects with the trimmed feedback, and empty feedback cannot send', () => {
  const opened = run(createExitPlanState(input()), [{ kind: 'modify' }]).state
  assert.equal(opened.modifying, true)
  const view = exitPlanViewModel(opened)
  assert.deepEqual(view.buttons.map((button) => button.label), ['取消', '发送'])
  assert.equal(view.buttons[1]!.enabled, false)
  assert.equal(run(opened, [{ kind: 'send-feedback' }]).decision, undefined)
  assert.equal(run(opened, [{ kind: 'feedback-set', text: '  \n' }, { kind: 'send-feedback' }]).decision, undefined)

  const typed = run(opened, [{ kind: 'feedback-set', text: ' 先补测试 ' }])
  assert.equal(exitPlanViewModel(typed.state).buttons[1]!.enabled, true)
  assert.deepEqual(run(typed.state, [{ kind: 'send-feedback' }]).decision, { kind: 'reject', feedback: '先补测试' })
})

test('cancelling 修改… closes the field and drops what was typed', () => {
  const typed = run(createExitPlanState(input()), [{ kind: 'modify' }, { kind: 'feedback-set', text: 'wip' }]).state
  const back = run(typed, [{ kind: 'cancel-modify' }]).state
  assert.equal(back.modifying, false)
  assert.equal(back.feedback, '')
})

test('keys: Enter and ⌘⏎ take the primary, ⌘⇧⏎ the manual accept, Escape opens 修改…', () => {
  const state = createExitPlanState(input())
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Enter' }, state), { kind: 'approve', slot: 0 })
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Enter', metaKey: true }, state), { kind: 'approve', slot: 0 })
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Enter', metaKey: true, shiftKey: true }, state), { kind: 'approve', slot: 1 })
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Escape' }, state), { kind: 'modify' })
  assert.deepEqual(exitPlanKeyToIntent({ key: 'z' }, state), { kind: 'none' })
})

test('digits count the buttons in reading order', () => {
  const state = createExitPlanState(input())
  assert.deepEqual(['1', '2', '3', '4', '5'].map((key) => exitPlanKeyToIntent({ key }, state)), [
    { kind: 'approve', slot: 0 },
    { kind: 'approve', slot: 1 },
    { kind: 'modify' },
    { kind: 'reject' },
    { kind: 'none' },
  ])
})

test('while the field is open only Enter and Escape are ours; the rest is typing', () => {
  const state = run(createExitPlanState(input()), [{ kind: 'modify' }]).state
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Enter' }, state), { kind: 'send-feedback' })
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Escape' }, state), { kind: 'cancel-modify' })
  for (const key of ['1', '3', 'a', ' ', 'Backspace']) assert.deepEqual(exitPlanKeyToIntent({ key }, state), { kind: 'none' })
})

test('an empty plan offers only 接受 and 拒绝', () => {
  const state = createExitPlanState(input({ planContent: '   \n ' }))
  const view = exitPlanViewModel(state)
  assert.equal(view.title, '助手希望退出计划模式')
  assert.equal(view.isEmptyPlan, true)
  assert.deepEqual(labels(state), ['拒绝', '接受'])
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Enter' }, state), { kind: 'approve', slot: 0 })
  assert.deepEqual(exitPlanKeyToIntent({ key: 'Escape' }, state), { kind: 'reject' })
  assert.deepEqual(exitPlanKeyToIntent({ key: '2' }, state), { kind: 'reject' })
  assert.equal(run(state, [{ kind: 'approve', slot: 0 }]).decision?.kind, 'approve_restore_keep')
})

test('an approve intent that lands on no accepting option decides nothing', () => {
  const state = createExitPlanState(input({ planContent: '' }))
  assert.equal(run(state, [{ kind: 'approve', slot: 1 }]).decision, undefined)
})
