import type {
  AskUserQuestionAnnotations,
  AskUserQuestionAnswers,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../../harness/types.js'

/**
 * The AskUserQuestion dialog as a state machine.
 *
 * Mirrors `src/tui/components/AskUserQuestionDialog.tsx` decision for decision,
 * because the tool's contract is the same on both shells: 1–4 questions asked one
 * at a time, 2–4 declared options plus an automatic "Other" free-text row,
 * multi-select answers joined with ", ", answers keyed by the *question text*,
 * and Escape rejecting the whole request rather than skipping a question.
 *
 * The shipped desktop renderer auto-rejected every request, so this is the first
 * time the tool is usable there at all.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export const OTHER_LABEL = '其他'

export interface AskState {
  readonly request: AskUserQuestionRequest
  readonly questionIndex: number
  readonly selectedIndex: number
  /** False until the user has picked or moved; nothing is selected before that. */
  readonly touched: boolean
  /** Indices of toggled options; only meaningful for a multi-select question. */
  readonly toggled: readonly number[]
  readonly otherMode: boolean
  readonly otherText: string
  /** The card folded to its title row so the transcript can be read. */
  readonly collapsed: boolean
  readonly answers: AskUserQuestionAnswers
  readonly annotations: AskUserQuestionAnnotations
}

export interface AskOptionRow {
  readonly label: string
  readonly description: string
  readonly isOther: boolean
  readonly selected: boolean
  readonly toggled: boolean
  readonly preview: string | undefined
}

export interface AskViewModel {
  readonly header: string
  readonly question: string
  readonly questionNumber: number
  readonly questionTotal: number
  readonly multiSelect: boolean
  readonly rows: readonly AskOptionRow[]
  readonly otherMode: boolean
  readonly otherText: string
  readonly collapsed: boolean
  /** The selected option's preview, shown under the rows. */
  readonly preview: string | undefined
  readonly canSubmit: boolean
  readonly canGoBack: boolean
  /** Whether committing answers the request, rather than moving to the next question. */
  readonly isLast: boolean
}

export function createAskState(request: AskUserQuestionRequest): AskState {
  return { ...questionReset(), request, questionIndex: 0, answers: {}, annotations: {} }
}

function questionReset() {
  return { selectedIndex: 0, touched: false, toggled: [], otherMode: false, otherText: '', collapsed: false } as const
}

export type AskIntent =
  | { kind: 'move'; direction: 'up' | 'down' }
  /** A row was picked outright — a digit key or a click. See `applyAskIntent`. */
  | { kind: 'select'; index: number }
  | { kind: 'toggle' }
  | { kind: 'commit' }
  | { kind: 'back' }
  | { kind: 'other-set'; text: string }
  | { kind: 'toggle-collapse' }
  /** Esc: backs out of the free-text field first, else skips. */
  | { kind: 'cancel' }
  /** The ✕ and 跳过 buttons: rejects the request from anywhere. */
  | { kind: 'skip' }
  | { kind: 'none' }

/**
 * Structural key shape rather than `KeyboardEvent` — this module is imported by
 * a test, which compiles it without the DOM lib.
 *
 * `none` in the free-text field means "let the input type it".
 */
export function askKeyToIntent(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean },
  state: AskState,
): AskIntent {
  if (event.ctrlKey === true || event.metaKey === true) {
    return event.key === 'Enter' && !state.collapsed ? { kind: 'commit' } : { kind: 'none' }
  }

  if (state.collapsed) {
    if (event.key === 'Escape') return { kind: 'cancel' }
    return event.key === 'Enter' || event.key === ' ' ? { kind: 'toggle-collapse' } : { kind: 'none' }
  }

  if (state.otherMode) {
    if (event.key === 'Escape') return { kind: 'cancel' }
    if (event.key === 'Enter') return { kind: 'commit' }
    if (event.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
    return { kind: 'none' }
  }

  switch (event.key) {
    case 'Escape':
      return { kind: 'cancel' }
    case 'ArrowUp':
      return { kind: 'move', direction: 'up' }
    case 'ArrowDown':
      return { kind: 'move', direction: 'down' }
    case 'Enter':
      return { kind: 'commit' }
    case ' ':
      return currentQuestion(state)?.multiSelect === true ? { kind: 'toggle' } : { kind: 'none' }
    default:
      return /^[1-9]$/.test(event.key) ? { kind: 'select', index: Number(event.key) - 1 } : { kind: 'none' }
  }
}

export type AskOutcome =
  | { readonly state: AskState }
  | { readonly state: AskState; readonly result: AskUserQuestionResult }

/** Applies an intent, answering the request once the last question is committed. */
export function applyAskIntent(state: AskState, intent: AskIntent): AskOutcome {
  const question = currentQuestion(state)
  if (!question) {
    // An empty request cannot be answered; rejecting is the only honest reply.
    return { state, result: { kind: 'rejected', feedback: '没有提出任何问题。' } }
  }
  const labels = optionLabels(question)

  switch (intent.kind) {
    case 'move': {
      const delta = intent.direction === 'up' ? -1 : 1
      return { state: focusRow(state, clamp(state.selectedIndex + delta, 0, labels.length - 1), labels) }
    }

    // A digit or a click: focus the row, then pick it — tick it on a multi-select
    // question, open the free-text field for 「其他」. Answering stays with commit.
    case 'select': {
      if (intent.index < 0 || intent.index >= labels.length) return { state }
      const focused = focusRow(state, intent.index, labels)
      return question.multiSelect === true && !isOtherIndex(intent.index, labels)
        ? applyAskIntent(focused, { kind: 'toggle' })
        : { state: focused }
    }

    case 'toggle': {
      if (isOtherIndex(state.selectedIndex, labels)) return { state }
      const toggled = state.toggled.includes(state.selectedIndex)
        ? state.toggled.filter((index) => index !== state.selectedIndex)
        : [...state.toggled, state.selectedIndex]
      return { state: { ...state, toggled } }
    }

    case 'other-set':
      return { state: { ...state, otherText: intent.text } }

    case 'toggle-collapse':
      return { state: { ...state, collapsed: !state.collapsed } }

    case 'cancel':
      if (state.otherMode) return { state: { ...state, ...questionResetKeepingToggles(state) } }
      return { state, result: { kind: 'rejected' } }

    case 'skip':
      return { state, result: { kind: 'rejected' } }

    case 'back': {
      const previous = state.request.questions[state.questionIndex - 1]
      if (!previous) return { state }
      const { [previous.question]: _answer, ...answers } = state.answers
      const { [previous.question]: _annotation, ...annotations } = state.annotations
      return { state: { ...state, ...questionReset(), questionIndex: state.questionIndex - 1, answers, annotations } }
    }

    case 'commit':
      return commit(state, question, labels)

    case 'none':
      return { state }
  }

  return assertNever(intent)
}

/** Leaving the free-text field keeps ticked boxes but drops the text and the cursor. */
function questionResetKeepingToggles(state: AskState) {
  return { ...questionReset(), toggled: state.toggled }
}

/** Moves the cursor; landing on 「其他」 opens its field, leaving it closes it. */
function focusRow(state: AskState, index: number, labels: readonly string[]): AskState {
  return { ...state, selectedIndex: index, touched: true, otherMode: isOtherIndex(index, labels) }
}

export function canSubmit(state: AskState): boolean {
  const question = currentQuestion(state)
  if (!question) return false
  if (state.otherMode) return state.otherText.trim().length > 0
  return question.multiSelect === true ? state.toggled.length > 0 : state.touched
}

function commit(state: AskState, question: AskUserQuestionItem, labels: string[]): AskOutcome {
  if (!canSubmit(state)) return { state }

  if (state.otherMode) {
    const trimmed = state.otherText.trim()
    const merged = question.multiSelect && state.toggled.length > 0
      ? [...selectedLabels(state.toggled, labels), trimmed].join(', ')
      : trimmed
    return answer(state, question, merged)
  }

  if (question.multiSelect) return answer(state, question, selectedLabels(state.toggled, labels).join(', '))

  const label = labels[state.selectedIndex]
  if (label === undefined) return { state }
  const preview = question.options[state.selectedIndex]?.preview
  return answer(state, question, label, preview ? { preview } : undefined)
}

function answer(
  state: AskState,
  question: AskUserQuestionItem,
  value: string,
  annotation?: AskUserQuestionAnnotations[string],
): AskOutcome {
  // Keyed by the question text, which is what the tool's caller reads back.
  const answers = { ...state.answers, [question.question]: value }
  const annotations = annotation
    ? { ...state.annotations, [question.question]: annotation }
    : state.annotations

  const nextIndex = state.questionIndex + 1
  const next: AskState = { ...state, ...questionReset(), answers, annotations, questionIndex: nextIndex }

  if (nextIndex < state.request.questions.length) return { state: next }

  return {
    state: next,
    result: {
      kind: 'answers',
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
  }
}

export function askViewModel(state: AskState): AskViewModel | undefined {
  const question = currentQuestion(state)
  if (!question) return undefined
  const labels = optionLabels(question)

  return {
    header: question.header,
    question: question.question,
    questionNumber: state.questionIndex + 1,
    questionTotal: state.request.questions.length,
    multiSelect: question.multiSelect === true,
    rows: labels.map((label, index) => ({
      label,
      description: question.options[index]?.description ?? '',
      isOther: isOtherIndex(index, labels),
      selected: state.touched && index === state.selectedIndex,
      toggled: state.toggled.includes(index),
      preview: question.options[index]?.preview,
    })),
    otherMode: state.otherMode,
    otherText: state.otherText,
    collapsed: state.collapsed,
    preview: question.multiSelect === true || !state.touched
      ? undefined
      : question.options[state.selectedIndex]?.preview,
    canSubmit: canSubmit(state),
    canGoBack: state.questionIndex > 0,
    isLast: state.questionIndex === state.request.questions.length - 1,
  }
}

export function currentQuestion(state: AskState): AskUserQuestionItem | undefined {
  return state.request.questions[state.questionIndex]
}

/** Declared options plus the automatic "Other" row, which is always last. */
export function optionLabels(question: AskUserQuestionItem): string[] {
  return [...question.options.map((option) => option.label), OTHER_LABEL]
}

function isOtherIndex(index: number, labels: readonly string[]): boolean {
  return index === labels.length - 1
}

function selectedLabels(indices: readonly number[], labels: readonly string[]): string[] {
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => labels[index])
    .filter((label): label is string => typeof label === 'string')
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  if (value < min) return min
  return value > max ? max : value
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ask intent: ${JSON.stringify(value)}`)
}
