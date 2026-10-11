import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OTHER_LABEL,
  applyAskIntent,
  askKeyToIntent,
  askViewModel,
  createAskState,
} from '../src/desktop/renderer/model/askUserQuestion.js'
import type { AskState } from '../src/desktop/renderer/model/askUserQuestion.js'
import type { AskUserQuestionRequest, AskUserQuestionResult } from '../src/harness/types.js'

/**
 * The desktop AskUserQuestion dialog, which used to auto-reject every request.
 *
 * These pin the contract the terminal dialog established: answers keyed by
 * question text, multi-select joined with ", ", an automatic "Other" row that
 * merges with the toggled options, and a two-level Escape. A selection is explicit: nothing is picked until the user
 * moves, presses a digit or clicks, and 提交 stays disabled until then.
 */

function request(overrides: Partial<AskUserQuestionRequest['questions'][number]>[] = []): AskUserQuestionRequest {
  return {
    questions: overrides.map((question, index) => ({
      question: question.question ?? `Question ${index + 1}?`,
      header: question.header ?? `H${index + 1}`,
      multiSelect: question.multiSelect ?? false,
      options: question.options ?? [
        { label: 'First', description: 'the first' },
        { label: 'Second', description: 'the second' },
      ],
    })),
  }
}

/** Drives keystrokes through the machine the way the DOM layer will. */
function press(state: AskState, keys: Array<string | { key: string }>): {
  state: AskState
  result: AskUserQuestionResult | undefined
} {
  let current = state
  let result: AskUserQuestionResult | undefined
  for (const raw of keys) {
    const event = typeof raw === 'string' ? { key: raw } : raw
    const outcome = applyAskIntent(current, askKeyToIntent(event, current))
    current = outcome.state
    if ('result' in outcome) result = outcome.result
  }
  return { state: current, result }
}

test('the option list is the declared options plus an automatic Other row', () => {
  const view = askViewModel(createAskState(request([{}])))
  assert.ok(view)
  assert.deepEqual(view.rows.map((row) => row.label), ['First', 'Second', OTHER_LABEL])
  assert.deepEqual(view.rows.map((row) => row.isOther), [false, false, true])
  assert.equal(view.multiSelect, false)
  assert.equal(view.questionTotal, 1)
})

test('a single-select answer needs a pick, then resolves with the label keyed by the question text', () => {
  const state = createAskState(request([{ question: 'Which one?' }]))
  assert.equal(askViewModel(state)?.canSubmit, false)
  assert.equal(press(state, ['Enter']).result, undefined, 'Enter with nothing picked is the disabled button')

  const { result } = press(state, ['ArrowDown', 'Enter'])
  assert.deepEqual(result, { kind: 'answers', answers: { 'Which one?': 'Second' } })
})

test('a digit key picks that row without answering', () => {
  const state = createAskState(request([{ question: 'Which one?' }]))
  const picked = press(state, ['2'])

  assert.equal(picked.result, undefined)
  const view = askViewModel(picked.state)
  assert.deepEqual(view?.rows.map((row) => row.selected), [false, true, false])
  assert.equal(view?.canSubmit, true)
  assert.deepEqual(press(picked.state, ['Enter']).result, { kind: 'answers', answers: { 'Which one?': 'Second' } })

  assert.deepEqual(askKeyToIntent({ key: '9' }, state), { kind: 'select', index: 8 })
  assert.deepEqual(press(state, ['9']).state, state, 'a digit past the last row does nothing')
})

test('an option preview becomes an annotation, and only when one existed', () => {
  const withPreview = request([{
    question: 'Layout?',
    options: [
      { label: 'A', description: 'a', preview: '+---+' },
      { label: 'B', description: 'b' },
    ],
  }])

  const picked = press(createAskState(withPreview), ['1', 'Enter'])
  assert.deepEqual(picked.result, {
    kind: 'answers',
    answers: { 'Layout?': 'A' },
    annotations: { 'Layout?': { preview: '+---+' } },
  })

  const plain = press(createAskState(withPreview), ['2', 'Enter'])
  assert.deepEqual(plain.result, { kind: 'answers', answers: { 'Layout?': 'B' } })
  assert.equal('annotations' in (plain.result ?? {}), false)
})

test('multi-select toggles with Space or a digit and joins the labels', () => {
  const multi = request([{
    question: 'Which features?',
    multiSelect: true,
    options: [
      { label: 'Alpha', description: 'a' },
      { label: 'Beta', description: 'b' },
      { label: 'Gamma', description: 'g' },
    ],
  }])

  assert.deepEqual(
    press(createAskState(multi), [' ', 'ArrowDown', 'ArrowDown', ' ', 'Enter']).result,
    { kind: 'answers', answers: { 'Which features?': 'Alpha, Gamma' } },
  )
  assert.deepEqual(
    press(createAskState(multi), ['3', '1', 'Enter']).result,
    { kind: 'answers', answers: { 'Which features?': 'Alpha, Gamma' } },
  )
})

test('multi-select cannot submit with nothing ticked', () => {
  const multi = createAskState(request([{ question: 'Pick?', multiSelect: true }]))
  const moved = press(multi, ['ArrowDown', 'Enter'])

  assert.equal(moved.result, undefined)
  assert.equal(askViewModel(moved.state)?.canSubmit, false)
})

test('moving onto Other opens its field and moving off closes it', () => {
  const state = createAskState(request([{}]))
  const onOther = press(state, ['ArrowDown', 'ArrowDown']).state
  assert.equal(onOther.otherMode, true)

  const off = press(onOther, ['ArrowUp']).state
  assert.equal(off.otherMode, false)
  assert.equal(off.selectedIndex, 1)
})

test('Other collects free text, and merges it with prior multi-select toggles', () => {
  const multi = request([{ question: 'Which?', multiSelect: true }])
  const toggled = press(createAskState(multi), [' ', '3'])
  assert.equal(askViewModel(toggled.state)?.otherMode, true, 'picking Other opens the text field rather than answering')
  assert.equal(toggled.result, undefined)

  const typing = applyAskIntent(toggled.state, { kind: 'other-set', text: ' mine ' }).state
  assert.deepEqual(press(typing, ['Enter']).result, { kind: 'answers', answers: { 'Which?': 'First, mine' } })
})

test('Other on a single-select question answers with just the typed text', () => {
  const opened = press(createAskState(request([{ question: 'Which?' }])), ['3']).state
  const typed = applyAskIntent(opened, { kind: 'other-set', text: 'xy' }).state

  assert.deepEqual(press(typed, ['Enter']).result, { kind: 'answers', answers: { 'Which?': 'xy' } })
})

test('Cmd/Ctrl+Enter commits like Enter, and does nothing on a collapsed card', () => {
  const state = createAskState(request([{}]))
  assert.deepEqual(askKeyToIntent({ key: 'Enter', metaKey: true }, state), { kind: 'commit' })
  assert.deepEqual(askKeyToIntent({ key: 'Enter', ctrlKey: true }, state), { kind: 'commit' })
  assert.deepEqual(askKeyToIntent({ key: '1', metaKey: true }, state), { kind: 'none' })
  assert.deepEqual(askKeyToIntent({ key: 'Enter', metaKey: true }, { ...state, collapsed: true }), { kind: 'none' })
})

test('empty free text is not an answer; typed keys are left to the input', () => {
  const opened = press(createAskState(request([{}])), ['3']).state

  assert.equal(press(opened, ['Enter']).result, undefined, 'an empty Other must not resolve')
  assert.equal(askViewModel(opened)?.canSubmit, false)
  assert.deepEqual(askKeyToIntent({ key: 'a' }, opened), { kind: 'none' })
  assert.deepEqual(askKeyToIntent({ key: '2' }, opened), { kind: 'none' }, 'digits are text inside the field')
  assert.equal(askViewModel(applyAskIntent(opened, { kind: 'other-set', text: 'a' }).state)?.canSubmit, true)
})

test('Escape in the text field goes back; Escape in the list skips', () => {
  const opened = press(createAskState(request([{}])), ['3']).state
  const backedOut = press(opened, ['Escape'])

  assert.equal(backedOut.result, undefined)
  assert.equal(askViewModel(backedOut.state)?.otherMode, false)

  const rejected = press(backedOut.state, ['Escape'])
  assert.deepEqual(rejected.result, { kind: 'rejected' })
})

test('skip rejects the request from anywhere, even inside the field', () => {
  const opened = press(createAskState(request([{}])), ['3']).state
  const outcome = applyAskIntent(opened, { kind: 'skip' })
  assert.ok('result' in outcome)
  assert.deepEqual(outcome.result, { kind: 'rejected' })
})

test('several questions are asked in order, can step back, and answer together at the end', () => {
  const two = request([
    { question: 'First question?' },
    { question: 'Second question?', options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }] },
  ])

  const first = press(createAskState(two), ['1', 'Enter'])
  assert.equal(first.result, undefined, 'the request resolves only once')
  const view = askViewModel(first.state)
  assert.equal(view?.question, 'Second question?')
  assert.equal(view?.questionNumber, 2)
  assert.equal(view?.isLast, true)
  assert.equal(view?.canGoBack, true)
  assert.equal(view?.rows.some((row) => row.selected), false, 'per-question state resets')

  const back = applyAskIntent(first.state, { kind: 'back' }).state
  assert.equal(askViewModel(back)?.question, 'First question?')
  assert.deepEqual(back.answers, {}, 'going back withdraws that answer')
  assert.equal(askViewModel(back)?.isLast, false)

  const second = press(first.state, ['2', 'Enter'])
  assert.deepEqual(second.result, {
    kind: 'answers',
    answers: { 'First question?': 'First', 'Second question?': 'No' },
  })
})

test('collapsing is state, and a collapsed card answers only to expand or skip', () => {
  const state = createAskState(request([{}]))
  const collapsed = applyAskIntent(state, { kind: 'toggle-collapse' }).state
  assert.equal(askViewModel(collapsed)?.collapsed, true)

  assert.deepEqual(askKeyToIntent({ key: '1' }, collapsed), { kind: 'none' })
  assert.deepEqual(askKeyToIntent({ key: 'Enter' }, collapsed), { kind: 'toggle-collapse' })
  assert.deepEqual(askKeyToIntent({ key: 'Escape' }, collapsed), { kind: 'cancel' })
  assert.equal(askViewModel(press(collapsed, ['Enter']).state)?.collapsed, false)
})

test('Space is inert on a single-select question and on the Other row', () => {
  const single = createAskState(request([{}]))
  assert.deepEqual(askKeyToIntent({ key: ' ' }, single), { kind: 'none' })

  const onOther = press(createAskState(request([{ multiSelect: true }])), ['ArrowDown', 'ArrowDown']).state
  const toggled = applyAskIntent(onOther, { kind: 'toggle' })
  assert.deepEqual(toggled.state.toggled, [], 'Other needs text; it cannot be toggled')
})

test('an empty request rejects rather than hanging the tool', () => {
  const outcome = applyAskIntent(createAskState({ questions: [] }), { kind: 'commit' })
  assert.ok('result' in outcome)
  assert.equal(outcome.result.kind, 'rejected')
  assert.equal(askViewModel(createAskState({ questions: [] })), undefined)
})

test('modifier combinations are left to the browser', () => {
  const state = createAskState(request([{}]))
  assert.deepEqual(askKeyToIntent({ key: 'a', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(askKeyToIntent({ key: 'ArrowDown', metaKey: true }, state), { kind: 'none' })
})

// --- the mouse ---------------------------------------------------------------

test('clicking a single-select row picks it; 提交 answers', () => {
  const state = createAskState(request([{}]))
  const picked = applyAskIntent(state, { kind: 'select', index: 1 })

  assert.ok(!('result' in picked))
  const outcome = applyAskIntent(picked.state, { kind: 'commit' })
  assert.ok('result' in outcome)
  assert.deepEqual(outcome.result, { kind: 'answers', answers: { 'Question 1?': 'Second' } })
})

test('clicking a multi-select row ticks it instead of submitting, and again unticks it', () => {
  const state = createAskState(request([{ multiSelect: true }]))
  const first = applyAskIntent(state, { kind: 'select', index: 1 })

  assert.ok(!('result' in first), 'the question stays open — the answer is 提交')
  assert.deepEqual(first.state.toggled, [1])
  assert.equal(first.state.selectedIndex, 1)
  assert.equal(askViewModel(first.state)?.canSubmit, true)

  const second = applyAskIntent(first.state, { kind: 'select', index: 1 })
  assert.deepEqual(second.state.toggled, [])
})

test('clicking the Other row opens the text field rather than answering with its label', () => {
  const other = applyAskIntent(createAskState(request([{ multiSelect: true }])), { kind: 'select', index: 2 })

  assert.ok(!('result' in other))
  assert.equal(other.state.otherMode, true)
  assert.equal(other.state.otherText, '')
})

test('clicking a row while the field is open leaves the field; out-of-range clicks are inert', () => {
  const typing = applyAskIntent(createAskState(request([{}])), { kind: 'select', index: 2 })
  assert.equal(typing.state.otherMode, true)
  const left = applyAskIntent(typing.state, { kind: 'select', index: 0 })
  assert.equal(left.state.otherMode, false)
  assert.equal(left.state.selectedIndex, 0)

  const state = createAskState(request([{}]))
  assert.deepEqual(applyAskIntent(state, { kind: 'select', index: 9 }).state, state)
  assert.deepEqual(applyAskIntent(state, { kind: 'select', index: -1 }).state, state)
})
