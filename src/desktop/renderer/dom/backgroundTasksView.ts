import { backgroundTaskKey, withoutClearedTasks, type BackgroundTaskGroups, type BackgroundTaskRow, type TaskGroup } from '../model/backgroundTasks.js'
import { formatElapsed } from '../model/commandsPanel.js'
import { modelName } from '../model/modelNames.js'
import { formatTokens } from '../model/usage.js'
import { button } from './controls.js'
import { copyText } from './clipboard.js'
import { copyButton } from './copyButton.js'
import { el, replace } from './dom.js'
import { focusByKey, heldFocusKey } from './focus.js'
import { icon } from './icons.js'
import { TONE_ICON } from './threadPanelView.js'

export interface BackgroundTasksModel {
  readonly sessionId: string
  readonly groups: BackgroundTaskGroups
  readonly open: ReadonlySet<TaskGroup>
}

export interface BackgroundTasksHandlers {
  loadOutput(taskId: string): Promise<string>
  onSelectAgent(id: string): void
  onStop(row: BackgroundTaskRow): void
  onClearFinished(): void
}

export interface BackgroundTasksView {
  readonly clearButton: HTMLButtonElement
  visibleGroups(sessionId: string, groups: BackgroundTaskGroups): BackgroundTaskGroups
  render(model: BackgroundTasksModel | undefined): void
}

const POLL_MS = 1000
const EMPTY_OUTPUT = '还没有输出'

function atBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 1
}

/** One list for commands and agents. Only visible commands poll their output. */
export function createBackgroundTasksView(containers: Readonly<Record<TaskGroup, HTMLElement>>, handlers: BackgroundTasksHandlers): BackgroundTasksView {
  let model: BackgroundTasksModel | undefined
  let sessionId: string | undefined
  let drawn: string | undefined
  const cleared = new Map<string, Set<string>>()
  const clearButton = button('side-action bt-clear', '', '清空已完成任务（仅隐藏，不删除）', () => {
    if (model === undefined || model.groups.finished.length === 0) return
    const ids = cleared.get(model.sessionId) ?? new Set<string>()
    for (const row of model.groups.finished) ids.add(backgroundTaskKey(row))
    cleared.set(model.sessionId, ids)
    view.render(model)
    handlers.onClearFinished()
  }, { icon: 'trash' })
  clearButton.setAttribute('aria-disabled', 'true')
  const expanded = new Set<string>()
  const outputs = new Map<string, string>()
  const outputNodes = new Map<string, HTMLElement>()
  const failures = new Map<string, string>()
  let clocks: Array<{ node: HTMLElement; startedAt: number }> = []
  let timer: ReturnType<typeof setInterval> | undefined

  function visibleGroups(owner: string, groups: BackgroundTaskGroups): BackgroundTaskGroups {
    return withoutClearedTasks(groups, cleared.get(owner))
  }

  function load(id: string): void {
    const owner = sessionId
    void handlers.loadOutput(id).then((text) => {
      if (owner !== sessionId || outputs.get(id) === text) return
      outputs.set(id, text)
      const pre = outputNodes.get(id)
      if (pre) {
        const following = atBottom(pre)
        pre.textContent = text.length > 0 ? text : EMPTY_OUTPUT
        if (following) pre.scrollTop = pre.scrollHeight
      }
    }).then(() => {
      if (owner === sessionId && failures.delete(id)) paint()
    }, (error: unknown) => {
      if (owner !== sessionId) return
      const message = error instanceof Error ? error.message : String(error)
      if (failures.get(id) === message) return
      failures.set(id, message)
      paint()
    })
  }

  function visibleRows(): readonly BackgroundTaskRow[] {
    return model === undefined ? [] : [...model.open].flatMap((group) => model!.groups[group])
  }

  function tick(): void {
    const now = Date.now()
    for (const clock of clocks) clock.node.textContent = formatElapsed(now - clock.startedAt)
    for (const row of visibleRows()) if (row.kind === 'shell' && row.running && expanded.has(row.id)) load(row.id)
  }

  function rowNode(row: BackgroundTaskRow): HTMLElement {
    const open = row.kind === 'shell' && expanded.has(row.id)
    const mark = el('span', `bt-mark tone-${row.tone}`, icon(TONE_ICON[row.tone]))
    mark.setAttribute('aria-hidden', 'true')
    const metric = row.kind === 'agent'
      ? row.tokens === undefined ? undefined : el('span', 'bt-tokens', `${formatTokens(row.tokens)} token`)
      : el('span', 'bt-time', row.durationMs === undefined ? '' : formatElapsed(row.durationMs))
    if (row.kind === 'shell' && row.running && row.startedAt !== undefined && metric !== undefined) clocks.push({ node: metric, startedAt: row.startedAt })
    const head = button('bt-head', '', `${row.title} · ${row.status}，${open ? '收起详情' : '查看详情'}`, () => {
      if (row.kind === 'agent') handlers.onSelectAgent(row.id)
      else {
        if (expanded.has(row.id)) expanded.delete(row.id)
        else {
          expanded.add(row.id)
          load(row.id)
        }
        paint()
      }
    })
    if (row.kind === 'shell') head.setAttribute('aria-expanded', String(open))
    head.dataset.focusKey = `task:${row.id}:head`
    replace(
      head,
      el('div', 'bt-title', mark, el('span', 'bt-text', row.title), row.kind === 'shell' ? el('span', `bt-chevron${open ? ' open' : ''}`, icon('chevron-right')) : undefined),
      el('div', 'bt-meta',
        el('span', 'bt-status', row.status),
        row.model === undefined ? undefined : el('span', 'bt-model', modelName(row.model)),
        metric,
      ),
    )
    const command = open ? el('pre', 'bt-command step-terminal', row.command ?? row.title) : undefined
    if (command) {
      command.setAttribute('tabindex', '0')
      command.setAttribute('role', 'region')
      command.setAttribute('aria-label', '完整命令')
      command.dataset.focusKey = `task:${row.id}:command`
    }
    const pre = open ? el('pre', 'command-output step-terminal', outputs.get(row.id) || EMPTY_OUTPUT) : undefined
    if (pre) {
      pre.setAttribute('tabindex', '0')
      pre.setAttribute('role', 'region')
      pre.setAttribute('aria-label', `${row.title} 的输出`)
      pre.dataset.focusKey = `task:${row.id}:output`
      outputNodes.set(row.id, pre)
    }
    const copy = copyButton('step-output-copy', '复制输出', () => copyText(outputs.get(row.id) ?? ''))
    copy.dataset.focusKey = `task:${row.id}:copy`
    const output = pre === undefined ? undefined : el('div', 'bt-output step-output', pre, copy)
    const failed = open ? failures.get(row.id) : undefined
    const retry = failed === undefined
      ? undefined
      : button('load-retry', '重试', '重新读取输出', () => load(row.id))
    if (retry !== undefined) retry.dataset.focusKey = `task:${row.id}:retry`
    const failure = failed === undefined
      ? undefined
      : el('div', 'load-error', el('span', 'load-error-text', `无法读取输出：${failed}`), retry)
    const stop = row.running
      ? button('bt-stop', '', `停止 ${row.title}`, () => handlers.onStop(row), { icon: 'stop' })
      : undefined
    if (stop !== undefined) stop.dataset.focusKey = `task:${row.id}:stop`
    return el('div', 'bt-row', head, stop, command, output, failure)
  }

  function stopClock(): void {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  function paint(): void {
    const positions = new Map([...outputNodes].map(([id, node]) => [id, { top: node.scrollTop, following: atBottom(node) }]))
    // Expanding a row or receiving a new task rebuilds the focused button; Chromium
    // moves focus to <body> without a blur. Put it back on the node that replaced it.
    const focusRoot = [containers.running, containers.finished].find((root) => root.contains(document.activeElement))
    const focusKey = focusRoot === undefined ? undefined : heldFocusKey(focusRoot)
    clocks = []
    outputNodes.clear()
    for (const group of ['running', 'finished'] as const) {
      replace(containers[group], ...(model?.open.has(group) ? model.groups[group].map(rowNode) : []))
    }
    for (const [id, pre] of outputNodes) {
      const position = positions.get(id)
      pre.scrollTop = position?.following === false ? position.top : pre.scrollHeight
    }
    // A finished task moves between the two containers, so try both.
    if (focusKey !== undefined) {
      focusByKey(containers.running, focusKey) || focusByKey(containers.finished, focusKey)
    }
    tick()
    if (clocks.length === 0 && !visibleRows().some((row) => row.kind === 'shell' && row.running && expanded.has(row.id))) stopClock()
    else timer ??= setInterval(tick, POLL_MS)
  }

  const view: BackgroundTasksView = {
    clearButton,
    visibleGroups,
    render(next) {
      if (next !== undefined) next = { ...next, groups: visibleGroups(next.sessionId, next.groups) }
      model = next
      clearButton.setAttribute('aria-disabled', String(next === undefined || next.groups.finished.length === 0))
      if (next === undefined) {
        stopClock()
        drawn = undefined
        return
      }
      if (sessionId !== next.sessionId) {
        sessionId = next.sessionId
        expanded.clear()
        outputs.clear()
        outputNodes.clear()
        failures.clear()
      }
      const rows = [...next.groups.running, ...next.groups.finished]
      for (const id of expanded) if (!rows.some((row) => row.kind === 'shell' && row.id === id)) expanded.delete(id)
      for (const id of failures.keys()) if (!rows.some((row) => row.kind === 'shell' && row.id === id)) failures.delete(id)
      const signature = JSON.stringify([next.sessionId, next.groups, [...next.open]])
      if (signature === drawn) return
      drawn = signature
      for (const row of visibleRows()) if (row.kind === 'shell' && !row.running && expanded.has(row.id)) load(row.id)
      paint()
    },
  }
  return view
}
