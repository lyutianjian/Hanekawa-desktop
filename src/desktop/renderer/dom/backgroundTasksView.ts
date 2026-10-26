import type { BackgroundTaskGroups, BackgroundTaskRow, TaskGroup } from '../model/backgroundTasks.js'
import { formatElapsed } from '../model/commandsPanel.js'
import { modelName } from '../model/modelNames.js'
import { button } from './controls.js'
import { el, replace } from './dom.js'
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
}

export interface BackgroundTasksView {
  render(model: BackgroundTasksModel | undefined): void
}

const POLL_MS = 1000
const EMPTY_OUTPUT = '还没有输出'

/** One list for commands and agents. Only visible commands poll their output. */
export function createBackgroundTasksView(containers: Readonly<Record<TaskGroup, HTMLElement>>, handlers: BackgroundTasksHandlers): BackgroundTasksView {
  let model: BackgroundTasksModel | undefined
  let sessionId: string | undefined
  let drawn: string | undefined
  const expanded = new Set<string>()
  const outputs = new Map<string, string>()
  const outputNodes = new Map<string, HTMLElement>()
  const failures = new Map<string, string>()
  let clocks: Array<{ node: HTMLElement; startedAt: number }> = []
  let timer: ReturnType<typeof setInterval> | undefined

  function load(id: string): void {
    const owner = sessionId
    void handlers.loadOutput(id).then((text) => {
      if (owner !== sessionId || outputs.get(id) === text) return
      outputs.set(id, text)
      const pre = outputNodes.get(id)
      if (pre) pre.textContent = text.length > 0 ? text : EMPTY_OUTPUT
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
    const mark = el('span', `task-mark tone-${row.tone}`, icon(TONE_ICON[row.tone]))
    mark.setAttribute('aria-hidden', 'true')
    const time = el('span', 'task-time', row.durationMs === undefined ? '' : formatElapsed(row.durationMs))
    if (row.running && row.startedAt !== undefined) clocks.push({ node: time, startedAt: row.startedAt })
    const head = button('task-head', '', `${row.title} · ${row.status}，${row.kind === 'agent' ? '查看详情' : open ? '收起输出' : '查看输出'}`, () => {
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
    const status = row.tone === 'attention' || row.tone === 'danger' || row.tone === 'neutral' ? row.status : undefined
    replace(
      head,
      el('div', 'task-title', mark, el('span', 'task-text', row.title), row.running ? undefined : el('span', `task-chevron${open ? ' open' : ''}`, icon('chevron-right'))),
      el('div', 'task-meta',
        status === undefined ? undefined : el('span', 'task-status', status),
        row.model === undefined ? undefined : el('span', 'task-model', modelName(row.model)),
        time,
      ),
    )
    const output = open ? el('pre', 'command-output', outputs.get(row.id) || EMPTY_OUTPUT) : undefined
    if (output) outputNodes.set(row.id, output)
    const failed = open ? failures.get(row.id) : undefined
    const failure = failed === undefined
      ? undefined
      : el('div', 'load-error', el('span', 'load-error-text', `无法读取输出：${failed}`), button('load-retry', '重试', '重新读取输出', () => load(row.id)))
    return el('div', 'task-row',
      head,
      row.running ? button('task-stop', '', `停止 ${row.title}`, () => handlers.onStop(row), { icon: 'stop' }) : undefined,
      open ? el('div', 'task-output-status', row.status) : undefined,
      output,
      failure,
    )
  }

  function stopClock(): void {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  function paint(): void {
    clocks = []
    outputNodes.clear()
    for (const group of ['running', 'finished'] as const) {
      replace(containers[group], ...(model?.open.has(group) ? model.groups[group].map(rowNode) : []))
    }
    tick()
    if (clocks.length === 0 && !visibleRows().some((row) => row.kind === 'shell' && row.running && expanded.has(row.id))) stopClock()
    else timer ??= setInterval(tick, POLL_MS)
  }

  return {
    render(next) {
      model = next
      if (next === undefined) {
        stopClock()
        drawn = undefined
        return
      }
      if (sessionId !== next.sessionId) {
        sessionId = next.sessionId
        expanded.clear()
        outputs.clear()
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
}
