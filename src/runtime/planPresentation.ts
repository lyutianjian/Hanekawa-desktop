import type { ExitPlanDecision } from '../harness/planModeManager.js'
import { DEFAULT_LOCALE, type Locale } from './locale.js'

/**
 * How the two plan-mode dialogs are presented, independent of any view.
 *
 * These were pure functions inside `ExitPlanModeDialog.tsx` and
 * `EnterPlanModeDialog.tsx`, which value-import `ink`, `react`,
 * `node:child_process` and `readPlan` — so a desktop renderer could not reach
 * them without dragging all four into a browser bundle. They live here for the
 * same reason `permissionPresentation.ts` does: a terminal dialog and a DOM one
 * must offer the *same* options in the same order, and a second copy of the
 * slot logic would drift.
 *
 * Every cross-layer import in this file is type-only. Both dialogs re-export
 * what they used to define, so existing importers are unaffected.
 */

export interface DecisionOption {
  readonly kind: ExitPlanDecision['kind']
  readonly label: string
}

export interface EnterPlanOption {
  readonly value: 'yes' | 'no'
  readonly label: string
  readonly hotkey: '1' | '2'
}

/**
 * Every user-visible string here, per locale. Keyed `satisfies`, so a missing
 * translation fails the build by name rather than rendering `undefined`.
 */
interface PlanStrings {
  readonly enterYes: string
  readonly enterNo: string
  readonly bypassKeep: string
  readonly autoKeep: string
  readonly restoreKeep: string
  readonly reject: string
  readonly emptyYes: string
  readonly emptyNo: string
  readonly linesOmitted: (count: number) => string
}

const STRINGS = {
  en: {
    enterYes: 'Yes, enter plan mode',
    enterNo: 'No, start implementing now',
    bypassKeep: 'Yes, and bypass permissions',
    autoKeep: 'Yes, and ask only when needed',
    restoreKeep: 'Yes, manually approve edits',
    reject: 'No, keep planning',
    emptyYes: 'Yes',
    emptyNo: 'No',
    linesOmitted: (count) => `[... ${count} lines omitted from preview ...]`,
  },
  zh: {
    enterYes: '好，进入计划模式',
    enterNo: '不用，现在就开始实现',
    bypassKeep: '好，并开启完全访问权限',
    autoKeep: '好，必要时询问',
    restoreKeep: '好，逐条确认修改',
    reject: '不，继续规划',
    emptyYes: '好',
    emptyNo: '不',
    linesOmitted: (count) => `[... 预览中省略 ${count} 行 ...]`,
  },
} as const satisfies Record<Locale, PlanStrings>

export function enterPlanOptions(locale: Locale = DEFAULT_LOCALE): readonly EnterPlanOption[] {
  const strings = STRINGS[locale]
  return [
    { value: 'yes', label: strings.enterYes, hotkey: '1' },
    { value: 'no', label: strings.enterNo, hotkey: '2' },
  ] as const
}

/**
 * The English options, kept as a constant because the TUI and the runtime
 * barrel already import it by that name. `enterPlanOptions(locale)` is the
 * form a localised shell calls.
 */
export const ENTER_PLAN_OPTIONS: readonly EnterPlanOption[] = enterPlanOptions('en')

/**
 * Build the option list for the exit dialog. When bypass is available the user
 * sees parallel "elevated" choices for both clear-context and keep-context
 * paths, mirroring Claude Code's slot logic in `buildPlanApprovalOptions`.
 *
 * Hotkeys are assigned by index 1..N in render order so the labels stay
 * consistent without per-option metadata.
 */
export function buildExitPlanModeOptions(input: boolean | {
  isBypassAvailable?: boolean
  locale?: Locale
}): readonly DecisionOption[] {
  const isBypassAvailable = typeof input === 'boolean' ? input : input.isBypassAvailable === true
  const strings = STRINGS[typeof input === 'boolean' ? DEFAULT_LOCALE : input.locale ?? DEFAULT_LOCALE]
  const options: DecisionOption[] = []

  // Slot 1: keep-context with elevated mode (higher privilege first).
  if (isBypassAvailable) {
    options.push({
      kind: 'approve_bypass_keep',
      label: strings.bypassKeep,
    })
  } else {
    options.push({
      kind: 'approve_auto_keep',
      label: strings.autoKeep,
    })
  }

  // Slot 2: always-present default keep-context (manual approval).
  options.push({
    kind: 'approve_restore_keep',
    label: strings.restoreKeep,
  })

  // Slot 3: always-present reject with feedback.
  options.push({
    kind: 'reject',
    label: strings.reject,
  })

  return options
}

export type ElevatedExitPlanModeDecision = 'approve_bypass_keep' | 'approve_auto_keep'

export function elevatedExitPlanModeDecision(input: boolean | {
  isBypassAvailable?: boolean
}): ElevatedExitPlanModeDecision {
  const isBypassAvailable = typeof input === 'boolean' ? input : input.isBypassAvailable === true
  if (isBypassAvailable) return 'approve_bypass_keep'
  return 'approve_auto_keep'
}

/**
 * The two options an *empty* plan gets. An empty plan has nothing to
 * auto-accept, so the elevated slot is dropped rather than shown inert.
 */
export function emptyPlanOptions(locale: Locale = DEFAULT_LOCALE): readonly DecisionOption[] {
  const strings = STRINGS[locale]
  return [
    { kind: 'approve_restore_keep', label: strings.emptyYes },
    { kind: 'reject', label: strings.emptyNo },
  ] as const
}

/** The English form, kept as a constant for the TUI and the runtime barrel. */
export const EMPTY_PLAN_OPTIONS: readonly DecisionOption[] = emptyPlanOptions('en')

export function isEmptyPlan(planContent: string): boolean {
  return planContent.trim().length === 0
}

/** The option list for a plan of either kind, so a view picks neither by hand. */
export function exitPlanOptionsFor(input: {
  planContent: string
  isBypassAvailable?: boolean
  locale?: Locale
}): readonly DecisionOption[] {
  const locale = input.locale ?? DEFAULT_LOCALE
  if (isEmptyPlan(input.planContent)) return emptyPlanOptions(locale)
  return buildExitPlanModeOptions({ isBypassAvailable: input.isBypassAvailable === true, locale })
}

/**
 * Turn a selected option into the decision the manager expects.
 *
 * `reject` is the only kind that carries feedback, and the approvals are the
 * only ones that carry the plan text — getting that backwards silently drops
 * either the user's note or the plan the agent is about to execute.
 */
export function exitPlanDecisionFor(
  option: DecisionOption,
  state: { planContent: string; feedback: string },
): ExitPlanDecision {
  if (option.kind === 'reject') return { kind: 'reject', feedback: state.feedback }
  return { kind: option.kind, planContent: state.planContent }
}

export function previewMarkdownLines(
  content: string,
  maxLines: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const omittedLabel = STRINGS[locale].linesOmitted
  const lines = content.split(/\r?\n/)
  if (lines.length <= maxLines) return content
  const safeMax = Math.max(1, maxLines)
  if (safeMax === 1) {
    return `${lines[0] ?? ''}\n${omittedLabel(lines.length - 1)}`
  }

  const omitted = lines.length - safeMax + 1
  const headCount = Math.max(1, Math.ceil((safeMax - 1) * 0.6))
  const tailCount = Math.max(0, safeMax - 1 - headCount)
  const head = lines.slice(0, headCount)
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : []
  return [
    ...head,
    omittedLabel(omitted),
    ...tail,
  ].join('\n')
}
