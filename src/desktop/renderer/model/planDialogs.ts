import {
  exitPlanDecisionFor,
  exitPlanOptionsFor,
  isEmptyPlan,
} from '../../../runtime/planPresentation.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../../harness/planModeManager.js'
import { UI_LOCALE } from './locale.js'

/**
 * The two plan-mode cards as data.
 *
 * The options and which half of the decision carries the plan text come from
 * `runtime/planPresentation.ts`, so the terminal and the desktop cannot offer
 * different choices. What lives here is the part that is per-view: the button
 * layout, the 修改… state, and how a keystroke maps onto them.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

// --- entering ---------------------------------------------------------------

export interface PlanCardButton<I> {
  readonly label: string
  readonly shortcut?: string
  readonly primary: boolean
  /** Left group (decline, adjust) or right group (accept). */
  readonly side: 'start' | 'end'
  readonly enabled: boolean
  readonly intent: I
}

export interface EnterPlanViewModel {
  readonly title: string
  readonly body: string
  readonly buttons: readonly PlanCardButton<EnterPlanIntent>[]
}

export type EnterPlanIntent =
  | { kind: 'answer'; approved: boolean }
  | { kind: 'none' }

export function enterPlanViewModel(): EnterPlanViewModel {
  return {
    title: '助手想先进入计划模式',
    body: '先读代码、出方案，你确认前不会修改文件',
    buttons: [
      { label: '拒绝', shortcut: 'Esc', primary: false, side: 'end', enabled: true, intent: { kind: 'answer', approved: false } },
      { label: '允许', shortcut: '⏎', primary: true, side: 'end', enabled: true, intent: { kind: 'answer', approved: true } },
    ],
  }
}

export function enterPlanKeyToIntent(event: { key: string; ctrlKey?: boolean; metaKey?: boolean }): EnterPlanIntent {
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }
  switch (event.key) {
    case '1':
    case 'Enter':
      return { kind: 'answer', approved: true }
    case '2':
    case 'Escape':
      // Declining entry is safe: the agent simply keeps working as it was.
      return { kind: 'answer', approved: false }
    default:
      return { kind: 'none' }
  }
}

// --- exiting ----------------------------------------------------------------

export interface ExitPlanState {
  readonly input: ExitDialogInput
  /** The 修改… field is open. */
  readonly modifying: boolean
  readonly feedback: string
}

export interface ExitPlanViewModel {
  readonly title: string
  readonly planFilePath: string
  readonly isEmptyPlan: boolean
  readonly modifying: boolean
  readonly feedback: string
  readonly buttons: readonly PlanCardButton<ExitPlanIntent>[]
}

export type ExitPlanIntent =
  /** Accept with the option at `slot` (0 is the elevated one, 1 the manual one). */
  | { kind: 'approve'; slot: number }
  | { kind: 'reject' }
  | { kind: 'modify' }
  | { kind: 'cancel-modify' }
  | { kind: 'feedback-set'; text: string }
  | { kind: 'send-feedback' }
  | { kind: 'none' }

export function createExitPlanState(input: ExitDialogInput): ExitPlanState {
  return { input, modifying: false, feedback: '' }
}

export function exitPlanViewModel(state: ExitPlanState): ExitPlanViewModel {
  const empty = isEmptyPlan(state.input.planContent)
  const base = { planFilePath: state.input.planFilePath, isEmptyPlan: empty, modifying: state.modifying, feedback: state.feedback }
  const entry = (
    label: string,
    side: 'start' | 'end',
    intent: ExitPlanIntent,
    extra: { shortcut?: string; primary?: boolean; enabled?: boolean } = {},
  ): PlanCardButton<ExitPlanIntent> => ({
    label,
    side,
    intent,
    primary: extra.primary ?? false,
    enabled: extra.enabled ?? true,
    ...(extra.shortcut === undefined ? {} : { shortcut: extra.shortcut }),
  })

  if (empty) {
    return {
      ...base,
      title: '助手希望退出计划模式',
      buttons: [
        entry('拒绝', 'start', { kind: 'reject' }, { shortcut: 'Esc' }),
        entry('接受', 'end', { kind: 'approve', slot: 0 }, { shortcut: '⏎', primary: true }),
      ],
    }
  }
  if (state.modifying) {
    return {
      ...base,
      title: '助手提出了一个计划',
      buttons: [
        entry('取消', 'start', { kind: 'cancel-modify' }, { shortcut: 'Esc' }),
        entry('发送', 'end', { kind: 'send-feedback' }, {
          shortcut: '⏎',
          primary: true,
          enabled: state.feedback.trim().length > 0,
        }),
      ],
    }
  }
  const elevated = exitPlanOptionsFor({
    planContent: state.input.planContent,
    isBypassAvailable: state.input.isBypassAvailable === true,
    locale: UI_LOCALE,
  })[0]
  return {
    ...base,
    title: '助手提出了一个计划',
    buttons: [
      entry('拒绝', 'start', { kind: 'reject' }),
      entry('修改…', 'start', { kind: 'modify' }, { shortcut: 'Esc' }),
      entry('接受', 'end', { kind: 'approve', slot: 1 }, { shortcut: '⌘⇧⏎' }),
      entry(
        elevated?.kind === 'approve_bypass_keep' ? '接受并绕过权限' : '接受并自动执行',
        'end',
        { kind: 'approve', slot: 0 },
        { shortcut: '⌘⏎', primary: true },
      ),
    ],
  }
}

/**
 * Keys for the card. While the 修改… field is open only Enter and Escape are
 * ours; everything else is typing. Otherwise Enter and ⌘⏎ take the primary
 * button, ⌘⇧⏎ the manual accept, Escape opens 修改… (or rejects an empty plan),
 * and the digits count the buttons in reading order.
 */
export function exitPlanKeyToIntent(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  state: ExitPlanState,
): ExitPlanIntent {
  const empty = isEmptyPlan(state.input.planContent)
  if (state.modifying) {
    if (event.key === 'Escape') return { kind: 'cancel-modify' }
    return event.key === 'Enter' ? { kind: 'send-feedback' } : { kind: 'none' }
  }
  if (event.key === 'Enter') {
    if (empty) return { kind: 'approve', slot: 0 }
    return event.shiftKey === true && (event.metaKey === true || event.ctrlKey === true)
      ? { kind: 'approve', slot: 1 }
      : { kind: 'approve', slot: 0 }
  }
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }
  if (event.key === 'Escape') return empty ? { kind: 'reject' } : { kind: 'modify' }
  const digits: readonly ExitPlanIntent[] = empty
    ? [{ kind: 'approve', slot: 0 }, { kind: 'reject' }]
    : [{ kind: 'approve', slot: 0 }, { kind: 'approve', slot: 1 }, { kind: 'modify' }, { kind: 'reject' }]
  return /^[1-9]$/.test(event.key) ? digits[Number(event.key) - 1] ?? { kind: 'none' } : { kind: 'none' }
}

export type ExitPlanOutcome =
  | { readonly state: ExitPlanState }
  | { readonly state: ExitPlanState; readonly decision: ExitPlanDecision }

export function applyExitPlanIntent(state: ExitPlanState, intent: ExitPlanIntent): ExitPlanOutcome {
  switch (intent.kind) {
    case 'approve': {
      const option = exitPlanOptionsFor({
        planContent: state.input.planContent,
        isBypassAvailable: state.input.isBypassAvailable === true,
        locale: UI_LOCALE,
      })[intent.slot]
      if (!option || option.kind === 'reject') return { state }
      return { state, decision: exitPlanDecisionFor(option, { planContent: state.input.planContent, feedback: '' }) }
    }

    case 'reject':
      return { state, decision: { kind: 'reject', feedback: '' } }

    case 'modify':
      return { state: { ...state, modifying: true } }

    case 'cancel-modify':
      return { state: { ...state, modifying: false, feedback: '' } }

    case 'feedback-set':
      return { state: { ...state, feedback: intent.text } }

    case 'send-feedback': {
      const feedback = state.feedback.trim()
      return feedback.length === 0 ? { state } : { state, decision: { kind: 'reject', feedback } }
    }

    case 'none':
      return { state }
  }

  return assertNever(intent)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan dialog intent: ${JSON.stringify(value)}`)
}
