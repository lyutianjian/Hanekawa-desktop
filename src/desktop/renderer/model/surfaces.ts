import { VALID_EFFORT_LEVELS, isEffortSupported, type EffortLevel } from '../../../config/effort.js'
import { EFFORT_LABELS } from './composer.js'
import type { ModelPickerOption } from '../../../runtime/modelPicker.js'
import type { CommandSurface, WireModelsResult } from '../../../runtime/protocol/wire.js'
import type { BackgroundTaskSnapshot } from '../../../services/backgroundTasks/registry.js'
import type { SessionMeta } from '../../../sessions/service.js'

/**
 * The pickers a slash command can ask for, as row lists.
 *
 * A `CommandEffect` of kind `open-surface` names one of six surfaces; a shell
 * that has no panel for one ignores it *by name*, which is why they collapse
 * into a single wire variant. This renderer draws all six, but only four are
 * here — a `false` from `isSupportedSurface` means "not a row list", not "not
 * drawn", and `paneSession.ts` resolves the other two by name before consulting
 * it. `rewind-panel` is a two-screen modal with its own state
 * (`model/rewindPanel.ts`); `provider-panel` is not a panel in the conversation
 * at all but the settings screen's `provider` page, which is window-level
 * (`app.ts`'s `onOpenProviderSettings`) because its endpoints, models and
 * routing come off a `ConfigService` a pane does not own.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

/**
 * What activating a row does.
 *
 * Three of the four pickers resolve to a **slash command line**, not to the
 * matching `SessionClient` method, and that is load-bearing rather than
 * roundabout. `set-model` and `switchModel` are deliberately two layers: the
 * wire command only points the current runtime somewhere else, while `/model`
 * is the user expressing a preference and is what writes the model back to
 * config (`protocol/commandContext.ts` wires `setModel` to `switchModel`).
 * Calling `client.setModel` from here would silently drop that persistence, and
 * would let the two shells drift apart on a decision neither of them owns.
 *
 * `resume-picker` is the exception because `/resume` takes no argument — it
 * exists only to open this panel. The desktop equivalent of switching sessions
 * is already defined by the tab bar: one pane per session, so `open-pane`
 * focuses the window that has it or opens one.
 *
 * `background-tasks` rows peek on Enter or click; stopping is a separate
 * button that takes two presses (`arm-kill`, then `kill-task`), so no key and
 * no stray click ends a process.
 */
export type SurfaceAction =
  | { readonly kind: 'run-command'; readonly line: string }
  | { readonly kind: 'open-pane'; readonly sessionId: string }
  | { readonly kind: 'peek-task'; readonly taskId: string }
  | { readonly kind: 'arm-kill'; readonly taskId: string }
  | { readonly kind: 'kill-task'; readonly taskId: string }

export interface SurfaceRow {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly current?: boolean
  readonly disabled?: boolean
  readonly disabledReason?: string
  /** Absent on a disabled row, which is shown to explain itself, not to be picked. */
  readonly action?: SurfaceAction
  /** A button at the row's end, reachable by pointer only. */
  readonly secondary?: { readonly label: string; readonly action: SurfaceAction; readonly danger?: boolean }
}

export interface SurfaceView {
  readonly surface: CommandSurface
  readonly title: string
  readonly rows: readonly SurfaceRow[]
  readonly emptyMessage: string
}

/**
 * The surfaces this shell draws *as a row list*.
 *
 * `provider-panel` and `rewind-panel` are absent because they are drawn
 * elsewhere — the settings screen and `model/rewindPanel.ts`. See the header.
 */
export type SupportedSurface = 'model-picker' | 'effort-picker' | 'background-tasks' | 'resume-picker'

export const SUPPORTED_SURFACES: readonly SupportedSurface[] = [
  'model-picker',
  'effort-picker',
  'background-tasks',
  'resume-picker',
] as const

/** A predicate, so the caller's switch over the four is exhaustive. */
export function isSupportedSurface(surface: CommandSurface): surface is SupportedSurface {
  return (SUPPORTED_SURFACES as readonly CommandSurface[]).includes(surface)
}

/**
 * Rows built from `WireModelsResult.pickerOptions`, which the *host* computed —
 * `buildModelPickerOptions` needs `ConfigService.getModel`, and anything projected
 * from a `ModelConfig` must be built field by field because `resolveModel` folds
 * the endpoint's `apiKey` and `baseUrl` into what it returns.
 */
export function modelPickerView(result: WireModelsResult): SurfaceView {
  return {
    surface: 'model-picker',
    title: '选择模型',
    rows: result.pickerOptions.map(modelRow),
    emptyMessage: '尚未配置任何模型。',
  }
}

function modelRow(option: ModelPickerOption): SurfaceRow {
  const detail = [
    option.modelId,
    option.providerName,
    option.isDefault ? '默认' : undefined,
    // Host-resolved (`resolveImageCapability` via `buildModelPickerOptions`):
    // the row answers "can I send images to this one", which is exactly the
    // moment a user opens this picker — right after a model refused an image.
    option.supportsImageInput ? '视觉' : undefined,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')

  return {
    // The model key: it is the row's stable id and exactly what `/model` takes.
    id: option.key,
    label: `${option.label}${option.modelKey ? ` — ${option.modelKey}` : ''}`,
    detail,
    ...(option.isCurrent ? { current: true } : {}),
    ...(option.disabledReason
      ? { disabled: true, disabledReason: option.disabledReason }
      : { action: { kind: 'run-command', line: `/model ${option.key}` } as const }),
  }
}

/**
 * Effort levels, with anything the model does not accept shown as unavailable
 * rather than hidden — a user who set `max` in config should see why it is not
 * in force.
 */
export function effortPickerView(input: {
  current: string
  supportedEfforts?: readonly EffortLevel[]
  configured?: string
}): SurfaceView {
  return {
    surface: 'effort-picker',
    title: '选择思考强度',
    rows: VALID_EFFORT_LEVELS.map((level) => {
      const unsupported = !isEffortSupported(level, input.supportedEfforts)
      return {
        id: level,
        // The same label the composer's chip shows. One concept, one spelling:
        // the picker used to print the raw `low`/`medium`/`high` next to a chip
        // saying 低/中/高 (`todo.md`'s 4f accounting). The *command* is still
        // built from the raw level — that is an argument, not a label.
        label: EFFORT_LABELS[level],
        detail: input.configured === level && input.configured !== input.current ? '已配置' : '',
        ...(level === input.current ? { current: true } : {}),
        ...(unsupported
          ? { disabled: true, disabledReason: '该模型不支持这一档' }
          : { action: { kind: 'run-command', line: `/effort ${level}` } as const }),
      }
    }),
    emptyMessage: '',
  }
}

const TASK_STATUS_LABELS: Record<BackgroundTaskSnapshot['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已结束',
  orphaned: '已脱管',
}

/** Running shell processes — what the composer's chip counts. Agents have their own panel. */
export function runningProcessCount(tasks: readonly BackgroundTaskSnapshot[]): number {
  return tasks.filter((task) => task.kind === 'shell' && task.status === 'running').length
}

/** Every running background task, agents included — what the status line's button counts. */
export function runningTaskCount(tasks: readonly BackgroundTaskSnapshot[]): number {
  return tasks.filter((task) => task.status === 'running').length
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/** Running first, then newest. `armedKillId` is the row whose stop button awaits its second press. */
export function backgroundTasksView(
  tasks: readonly BackgroundTaskSnapshot[],
  now: number,
  armedKillId?: string,
): SurfaceView {
  const sorted = [...tasks].sort((a, b) =>
    Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
  return {
    surface: 'background-tasks',
    title: '后台任务',
    rows: sorted.map((task) => {
      const running = task.status === 'running'
      return {
        id: task.id,
        label: task.kind === 'agent'
          ? `${task.agentType ?? 'agent'}: ${task.description ?? task.agentId ?? task.id}`
          : task.command ?? task.id,
        detail: [
          TASK_STATUS_LABELS[task.status],
          formatElapsed((task.finishedAt ?? now) - task.startedAt),
          task.exitCode !== undefined && task.exitCode !== null ? `exit ${task.exitCode}` : undefined,
          task.unreadBytes > 0 ? `${task.unreadBytes} 字节新输出` : undefined,
        ].filter((part): part is string => typeof part === 'string').join(' · '),
        action: { kind: 'peek-task', taskId: task.id } as const,
        ...(running
          ? {
              secondary: armedKillId === task.id
                ? { label: '确认结束', action: { kind: 'kill-task', taskId: task.id } as const, danger: true }
                : { label: '结束', action: { kind: 'arm-kill', taskId: task.id } as const },
            }
          : {}),
      }
    }),
    emptyMessage: '没有后台任务。',
  }
}

export function resumePickerView(input: {
  sessions: readonly SessionMeta[]
  currentSessionId?: string
}): SurfaceView {
  return {
    surface: 'resume-picker',
    title: '恢复会话',
    rows: input.sessions.map((session) => ({
      id: session.id,
      label: session.title ?? session.shortId,
      detail: `${session.messageCount} 条消息 · ${session.updatedAt}`,
      ...(session.id === input.currentSessionId ? { current: true } : {}),
      action: { kind: 'open-pane', sessionId: session.id } as const,
    })),
    emptyMessage: '还没有其他会话。',
  }
}

// --- selection --------------------------------------------------------------

/**
 * Moving through the rows, skipping the ones that cannot be picked.
 *
 * A disabled row is still *drawn* — a model key that cannot be loaded should say
 * why — but stepping onto it would leave Enter doing nothing, which reads as the
 * app having hung. Wraps like the completion dropdown does.
 *
 * Returns the same index when nothing is selectable, so a panel of nothing but
 * disabled rows is inert rather than looping forever.
 */
export function moveSurfaceSelection(
  view: SurfaceView,
  selectedIndex: number,
  direction: 'up' | 'down',
): number {
  const total = view.rows.length
  if (total === 0) return selectedIndex
  const step = direction === 'up' ? -1 : 1
  let index = selectedIndex
  for (let hops = 0; hops < total; hops += 1) {
    index = ((index + step) % total + total) % total
    if (view.rows[index]?.action) return index
  }
  return selectedIndex
}

/** The first row a freshly opened panel should sit on. */
export function initialSurfaceSelection(view: SurfaceView): number {
  const current = view.rows.findIndex((row) => row.current && row.action)
  if (current >= 0) return current
  const first = view.rows.findIndex((row) => row.action)
  return first >= 0 ? first : 0
}

/** The action for a row, or undefined when the row is disabled or absent. */
export function activateSurfaceRow(view: SurfaceView, selectedIndex: number): SurfaceAction | undefined {
  return view.rows[selectedIndex]?.action
}

/** Same answer, addressed by row id — the shape a click handler has. */
export function activateSurfaceRowById(view: SurfaceView, id: string): SurfaceAction | undefined {
  return view.rows.find((row) => row.id === id)?.action
}
