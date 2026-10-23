import { EFFORT_RANK, VALID_EFFORT_LEVELS, type EffortLevel } from '../../../config/effort.js'
import type { PermissionMode } from '../../../harness/permissions.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'

/**
 * What the composer's chip says.
 *
 * Stage-4 decision 4: effort is not a setting. It belongs beside the input,
 * where it can be changed for the next turn without leaving the conversation —
 * so the model name and the effort level live in the composer's action bar as a
 * chip, not in the status bar. (The status bar's own copy of the model was
 * deleted when this landed; two places showing the same field is two places to
 * drift.)
 *
 * Pure, and therefore testable with no DOM — `dom/composerView.ts` only turns
 * this into nodes.
 */

/**
 * Short labels for the chip. Renderer-owned copy, so Chinese directly rather
 * than through the `locale` parameter the shared presentation modules take:
 * nothing in the TUI renders this.
 */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

export interface ComposerChipView {
  /** The model's display name, or a placeholder before the first snapshot. */
  readonly model: string
  readonly modelTitle: string
  /** A level's short label, or the raw value when effort is a token budget. */
  readonly effort: string
  readonly effortTitle: string
  /** Already at the model's ceiling, so the chip should not invite raising it. */
  readonly atCeiling: boolean
  /** False until a runtime snapshot has arrived; the chip is inert until then. */
  readonly enabled: boolean
  /** The chip's whole tooltip: model and effort only. The context gauge owns its own. */
  readonly title: string
}

const PLACEHOLDER = '…'

function isEffortLevel(value: string): value is EffortLevel {
  return (VALID_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function composerChipView(
  runtime: WireRuntimeSnapshot | undefined,
): ComposerChipView {
  if (!runtime) {
    return {
      model: PLACEHOLDER,
      modelTitle: '正在连接会话…',
      effort: PLACEHOLDER,
      effortTitle: '正在连接会话…',
      atCeiling: false,
      enabled: false,
      title: '正在连接会话…',
    }
  }

  if (runtime.status === 'needs_configuration') {
    const title = `${runtime.configurationIssue.message} 点击配置模型与服务商。`
    return {
      model: '配置模型',
      modelTitle: title,
      effort: '—',
      effortTitle: title,
      atCeiling: false,
      enabled: true,
      title,
    }
  }

  const provider = runtime.providerName ? `（${runtime.providerName}）` : ''
  // `effort` is a string on the wire because it carries either a level name or a
  // raw token budget as a decimal string (`set-effort.level` is `z.string()`).
  // A budget has no position on the ladder, so it is shown verbatim.
  const level = isEffortLevel(runtime.effort) ? runtime.effort : undefined
  // The top of what this model accepts, which is not necessarily `max`: a model
  // restricted to low/high is already at its highest on `high`.
  const highest = runtime.supportedEfforts === undefined
    ? undefined
    : [...runtime.supportedEfforts].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]).at(-1)
  const atCeiling = level !== undefined
    && highest !== undefined
    && EFFORT_RANK[level] >= EFFORT_RANK[highest]

  const ceilingNote = atCeiling && highest
    ? `（已是该模型最高档 ${EFFORT_LABELS[highest]}）`
    : ''

  const modelTitle = `模型：${runtime.model}${provider} · 点击切换`
  const effortTitle = `思考强度：${level ? EFFORT_LABELS[level] : runtime.effort}${ceilingNote} · 点击切换`

  return {
    model: runtime.model,
    modelTitle,
    effort: level ? EFFORT_LABELS[level] : runtime.effort,
    effortTitle,
    atCeiling,
    enabled: true,
    title: [modelTitle, effortTitle].join('\n'),
  }
}

/**
 * What the send button means right now.
 *
 * Mid-turn the message joins the running turn at its next step (steering). The
 * Enter path reaches the same verdict through `model/keymap.ts`, and they must
 * agree — `requestSubmit()` silently ignores a disabled button, so a mismatch
 * swallows the click with no error anywhere.
 */
export function submitLabel(streaming: boolean): string {
  return streaming ? '发送到当前轮次' : '发送'
}

/**
 * The composer's one round button (`design_guidance.md` 四.2②.3): with
 * something typed it sends, lit; empty mid-turn it becomes stop; empty and
 * idle it is the unlit send.
 *
 * `idle` is "there is nothing to send", not "sending is impossible": the button
 * is never disabled, because `requestSubmit()` ignores a disabled button and the
 * click would vanish with no error anywhere.
 */
export type SubmitButtonState = 'idle' | 'ready'

export interface SubmitButtonView {
  readonly state: SubmitButtonState
  readonly label: string
  /** `#stop` stands in for the send button: a turn is running and nothing is typed. */
  readonly showStop: boolean
}

export function submitButtonView(input: { streaming: boolean; empty: boolean }): SubmitButtonView {
  return {
    state: input.empty ? 'idle' : 'ready',
    label: submitLabel(input.streaming),
    showStop: input.streaming && input.empty,
  }
}

/**
 * The permission-mode pill, `design_guidance.md` 四.2①.2.
 *
 * Renderer-owned Chinese, like `EFFORT_LABELS`: nothing in the TUI draws this.
 * `readonly` has a label but is **not** in `PERMISSION_PILL_MODES` — the stage-5
 * decision table lists four modes for the menu, and `readonly` is a mode the
 * built-in `explore`/`plan` agents run under rather than one a user picks for a
 * conversation. It still needs a label, because a snapshot can carry it and a
 * pill that cannot name its own current value is worse than one with an
 * unreachable label.
 */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: '请求批准',
  auto: '必要时询问',
  plan: '计划模式',
  bypass: '绕过权限',
  readonly: '只读',
}

export const PERMISSION_PILL_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'auto',
  'bypass',
] as const

export interface PermissionPillOption {
  readonly mode: PermissionMode
  readonly label: string
  readonly current: boolean
}

export interface PermissionPillView {
  readonly label: string
  readonly title: string
  /** False until a runtime snapshot has arrived; the pill is inert until then. */
  readonly enabled: boolean
  readonly open: boolean
  readonly options: readonly PermissionPillOption[]
  /** A coordinator's mode is locked readonly in the backend: no pill at all. */
  readonly hidden: boolean
}

/**
 * Switching modes goes through `set-permission-mode`, not through a slash
 * command: unlike `/model` and `/effort` there is nothing to persist — the mode
 * is a property of the live gate, and `permissions.mode` in settings is only the
 * *startup* mode (`sessionScope.ts` snapshots it when the scope is built).
 */
export function permissionPillView(input: {
  runtime: WireRuntimeSnapshot | undefined
  open: boolean
  coordinator?: boolean
}): PermissionPillView {
  const hidden = input.coordinator === true
  const current = input.runtime?.permissionMode
  const options = PERMISSION_PILL_MODES.map((mode) => ({
    mode,
    label: PERMISSION_MODE_LABELS[mode],
    current: mode === current,
  }))

  if (!current) {
    return {
      label: PLACEHOLDER,
      title: '正在连接会话…',
      enabled: false,
      open: false,
      options,
      hidden,
    }
  }

  const label = PERMISSION_MODE_LABELS[current]
  return {
    label,
    title: `权限模式：${label} · 点击切换`,
    enabled: true,
    // Never open while inert, so a snapshot arriving late cannot leave a menu
    // hanging over a pill that has nothing to switch.
    open: input.open && !hidden,
    options,
    hidden,
  }
}

/**
 * What the composer's `+` does.
 *
 * There is no host command behind a native file dialog, so the attachment
 * control seeds an `@` at the caret and hands over to the mention completion
 * that already exists. Inserting at the caret rather than appending is the
 * point: `@` half-way through a sentence is a normal thing to want.
 *
 * A space is inserted first when the caret is mid-word, because the mention
 * scanner only recognises an `@` that starts a token — without it the control
 * would produce a `foo@` that completes nothing. An `@` already immediately
 * before the caret is left alone rather than doubled.
 */
export function insertMentionToken(
  text: string,
  cursorPos: number,
): { text: string; cursorPos: number } {
  const at = Math.max(0, Math.min(cursorPos, text.length))
  const before = text.slice(0, at)
  if (before.endsWith('@')) return { text, cursorPos: at }

  const needsSpace = before.length > 0 && !/\s$/.test(before)
  const insertion = needsSpace ? ' @' : '@'
  return {
    text: `${before}${insertion}${text.slice(at)}`,
    cursorPos: at + insertion.length,
  }
}
