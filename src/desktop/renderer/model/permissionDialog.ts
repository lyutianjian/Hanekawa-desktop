import {
  defaultPermissionIndex,
  destructiveWarningsForRequest,
  formatPermissionInputBlock,
  formatPermissionPreviewMessage,
  formatPermissionPreviewTitle,
  formatPermissionReason,
  formatPermissionRequestLabel,
  formatPermissionSubtitle,
  nextPermissionIndex,
  permissionOptionsForRequest,
  permissionToneForRequest,
  resolvePermissionOption,
  type PermissionAction,
  type PermissionInputBlock,
  type PermissionOption,
  type PermissionTone,
} from '../../../runtime/permissionPresentation.js'
import type { DestructiveCommandWarning } from '../../../harness/destructiveCommands.js'
import type { PermissionRequestDto, UiResponse } from '../../../runtime/protocol/wire.js'
import { previewView, type PreviewView } from './diffRows.js'
import type { DialogAction } from './dialogActions.js'
import { UI_LOCALE } from './locale.js'

/**
 * The permission dialog as data.
 *
 * Everything about *what* to offer comes from `runtime/permissionPresentation.ts`
 * — the same module the terminal dialog uses — so the two cannot drift on the
 * two decisions that matter: whether "always allow" is offered at all, and which
 * option starts focused. Deriving either from the DTO's fields directly would
 * re-implement rules that already exist:
 *
 * - `permissionOptionsForRequest` suppresses always-allow whenever the request
 *   carries destructive warnings, even if `canAlwaysAllow` is true.
 * - `defaultPermissionIndex` focuses **deny** for those same requests.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export interface PermissionViewModel {
  readonly title: string
  readonly subtitle: string
  readonly reason: string
  readonly tone: PermissionTone
  readonly inputBlock: PermissionInputBlock
  readonly warnings: readonly DestructiveCommandWarning[]
  readonly denialStreakNote: string | undefined
  readonly options: readonly PermissionOption[]
  readonly selectedIndex: number
  readonly preview: PreviewView | undefined
  /** Labels of the other requests waiting, for the "Also waiting" line. */
  readonly alsoWaiting: readonly string[]
  /** The options again, as buttons: here an option *is* the action. */
  readonly actions: readonly DialogAction[]
}

/** How many other pending requests to name before summarising the rest. */
export const ALSO_WAITING_LIMIT = 3

export function initialPermissionIndex(request: PermissionRequestDto): number {
  return defaultPermissionIndex(request)
}

export function permissionViewModel(input: {
  request: PermissionRequestDto
  selectedIndex: number
  /** Position of this request among everything pending, for the subtitle. */
  activeIndex?: number
  total?: number
  others?: readonly PermissionRequestDto[]
}): PermissionViewModel {
  const { request } = input
  const warnings = destructiveWarningsForRequest(request)
  const options = permissionOptionsForRequest(request, UI_LOCALE)
  const total = input.total ?? 1
  const activeIndex = input.activeIndex ?? 0
  const tone = permissionToneForRequest(request, warnings)

  return {
    title: formatPermissionPreviewTitle(request, UI_LOCALE),
    // Already carries "n/m pending" when total > 1 — a view must not print a
    // second counter of its own.
    subtitle: formatPermissionSubtitle(request, activeIndex, total, UI_LOCALE),
    reason: formatPermissionReason(request, UI_LOCALE),
    tone,
    inputBlock: formatPermissionInputBlock(request, UI_LOCALE),
    warnings,
    denialStreakNote: denialStreakNote(request.denialStreak),
    options,
    selectedIndex: clampIndex(input.selectedIndex, options.length),
    preview: request.preview ? localizedPreview(previewView(request.preview)) : undefined,
    alsoWaiting: alsoWaitingLabels(input.others ?? []),
    actions: actionsFor(options, tone),
  }
}

export type PermissionIntent =
  | { kind: 'move'; selectedIndex: number }
  | { kind: 'answer'; action: PermissionAction }
  | { kind: 'cycle'; direction: 'next' | 'prev' }
  | { kind: 'none' }

/**
 * A keystroke to an intent.
 *
 * Deliberately *not* given the DOM `KeyboardEvent` type: this module is imported
 * by a test, which compiles it in the base tsconfig program where there is no
 * DOM lib. The structural shape is what `bridgeChannel.ts` does for the same
 * reason.
 *
 * Escape answers `deny` rather than closing the dialog. There is no "close" — a
 * request left unanswered parks the agent loop, and the keymap therefore gives
 * an open dialog priority over interrupting the turn.
 */
export function permissionKeyToIntent(
  event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  state: { selectedIndex: number; options: readonly PermissionOption[] },
): PermissionIntent {
  if (event.ctrlKey === true || event.metaKey === true) return { kind: 'none' }
  const total = state.options.length

  switch (event.key) {
    case 'ArrowUp':
      return { kind: 'move', selectedIndex: nextPermissionIndex(state.selectedIndex, 'up', total) }
    case 'ArrowDown':
      return { kind: 'move', selectedIndex: nextPermissionIndex(state.selectedIndex, 'down', total) }
    case 'Tab':
      return { kind: 'cycle', direction: event.shiftKey === true ? 'prev' : 'next' }
    case 'Enter':
      return { kind: 'answer', action: resolvePermissionOption(state.selectedIndex, state.options).action }
    case 'Escape':
      return { kind: 'answer', action: 'deny' }
    default:
      break
  }

  const hotkey = event.key.toLowerCase()
  const match = state.options.find((option) => option.hotkey === hotkey)
  if (match) return { kind: 'answer', action: match.action }

  // Numeric shortcuts by slot, as every other dialog in this project offers.
  const slot = Number.parseInt(event.key, 10)
  if (!Number.isNaN(slot) && slot >= 1 && slot <= total) {
    return permissionIndexToIntent(slot - 1, state.options)
  }

  return { kind: 'none' }
}

/**
 * A slot to an intent, for both the numeric hotkey and a click on the row.
 *
 * The two paths must not diverge: a click on 「允许一次」 answers exactly what
 * pressing its number answers. `resolvePermissionOption` is what maps the index,
 * so an out-of-range slot cannot resolve to a neighbouring option here.
 */
export function permissionIndexToIntent(
  index: number,
  options: readonly PermissionOption[],
): PermissionIntent {
  if (index < 0 || index >= options.length) return { kind: 'none' }
  return { kind: 'answer', action: resolvePermissionOption(index, options).action }
}

/**
 * The wire answer for an action.
 *
 * `alwaysAllow` is only ever set here; the host fires `onAlwaysAllow` **before**
 * resolving the gate's promise, because `PermissionGate` reads the captured flag
 * on the statement right after its `await` returns.
 */
export function permissionResponseFor(action: PermissionAction): Extract<UiResponse, { kind: 'permission' }> {
  if (action === 'always') return { kind: 'permission', approved: true, alwaysAllow: true }
  return { kind: 'permission', approved: action === 'allow' }
}

/**
 * The preview's own title and summary ("Edit file: a.txt", "a.txt will be
 * edited") restate the card's title and input block, so the views draw only
 * the diff or the message; the message is the one piece of prose left.
 */
function localizedPreview(view: PreviewView): PreviewView {
  if (view.kind !== 'message') return view
  return { ...view, message: formatPermissionPreviewMessage(view.message, UI_LOCALE) }
}

function alsoWaitingLabels(others: readonly PermissionRequestDto[]): string[] {
  const labels = others.slice(0, ALSO_WAITING_LIMIT).map(formatPermissionRequestLabel)
  const rest = others.length - labels.length
  return rest > 0 ? [...labels, `另有 ${rest} 项`] : labels
}

/**
 * Surfaced because a streak means the agent is looping on something the user
 * keeps refusing, and the gate is about to start auto-denying.
 */
function denialStreakNote(denialStreak: number): string | undefined {
  if (denialStreak <= 0) return undefined
  return denialStreak === 1
    ? '已拒绝过一次。'
    : `已拒绝过 ${denialStreak} 次。`
}

/**
 * The options as buttons, in the order the list already has them.
 *
 * Exactly one primary, and it is 允许一次. Denying is what Escape does and what a
 * destructive request starts focused on, so it must not be the loud one — and
 * neither may 始终允许, which writes a rule that outlives this request. Two
 * primaries would say the same thing about both.
 *
 * Approving a request that carries destructive warnings is drawn as danger: an
 * outline and a text colour, never a fill. `permissionOptionsForRequest` drops
 * 始终允许 from exactly those requests, so only 允许一次 can carry it.
 */
function actionsFor(
  options: readonly PermissionOption[],
  tone: PermissionTone,
): DialogAction[] {
  return options.map((option, index) => ({
    label: option.label,
    shortcut: option.hotkey.toUpperCase(),
    role: option.action === 'allow' ? 'primary' : 'secondary',
    ...(option.action === 'allow' && tone === 'danger' ? { tone: 'danger' as const } : {}),
    slot: index,
  }))
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0
  if (index < 0) return 0
  return index > total - 1 ? total - 1 : index
}
