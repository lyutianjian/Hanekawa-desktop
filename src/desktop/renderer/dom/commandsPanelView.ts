import { formatElapsed, type CommandRow } from '../model/commandsPanel.js'
import { button } from './controls.js'
import { el, replace } from './dom.js'

/**
 * The task page's 命令 section: one row per background shell process. A row
 * unfolds into the tail of its output, re-read once a second while the process
 * runs. Rows are rebuilt only when what they say changed; the clocks tick in
 * place, so a row is never replaced under the pointer.
 */

export interface CommandsPanelHandlers {
  /** The tail of a process's output. */
  loadOutput(taskId: string): Promise<string>
  onStop(taskId: string): void
}

export interface CommandsPanelView {
  /** `undefined` while the section is off screen: the clocks and reads stop, the folds stay. */
  render(rows: readonly CommandRow[] | undefined): void
}

const POLL_MS = 1000
const EMPTY_OUTPUT = '还没有输出'

export function createCommandsPanelView(container: HTMLElement, handlers: CommandsPanelHandlers): CommandsPanelView {
  let rows: readonly CommandRow[] = []
  let drawn: string | undefined
  const expanded = new Set<string>()
  const outputs = new Map<string, string>()
  const outputNodes = new Map<string, HTMLElement>()
  /** Rows whose last output read failed, with the reason; 重试 sits under the output. */
  const failures = new Map<string, string>()
  let clocks: Array<{ node: HTMLElement; startedAt: number }> = []
  let timer: ReturnType<typeof setInterval> | undefined

  function load(id: string): void {
    void handlers.loadOutput(id).then((text) => {
      if (outputs.get(id) === text) return
      outputs.set(id, text)
      const pre = outputNodes.get(id)
      if (pre) pre.textContent = text.length > 0 ? text : EMPTY_OUTPUT
    }).then(() => {
      if (failures.delete(id)) paint()
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // A running row re-reads every second; the same failure again must not
      // rebuild the button under the pointer.
      if (failures.get(id) === message) return
      failures.set(id, message)
      paint()
    })
  }

  function tick(): void {
    const now = Date.now()
    for (const clock of clocks) clock.node.textContent = formatElapsed(now - clock.startedAt)
    for (const row of rows) if (row.running && expanded.has(row.id)) load(row.id)
  }

  function rowNode(row: CommandRow): HTMLElement {
    const open = expanded.has(row.id)
    const bead = el('span', `step-bead ${row.tone}`)
    bead.setAttribute('aria-hidden', 'true')
    const time = el('span', 'command-time', row.finishedAt === undefined ? '' : formatElapsed(row.finishedAt - row.startedAt))
    if (row.finishedAt === undefined) clocks.push({ node: time, startedAt: row.startedAt })
    const head = button('command-head', '', `${row.command} · ${row.status}，${open ? '收起' : '查看'}输出`, () => {
      if (expanded.has(row.id)) expanded.delete(row.id)
      else {
        expanded.add(row.id)
        load(row.id)
      }
      paint()
    })
    head.setAttribute('aria-expanded', String(open))
    replace(
      head,
      el('div', 'command-title', bead, el('span', 'command-text', row.command)),
      el('div', 'command-meta', el('span', undefined, row.status), time),
    )
    const output = open ? el('pre', 'command-output', outputs.get(row.id) || EMPTY_OUTPUT) : undefined
    if (output) outputNodes.set(row.id, output)
    const failed = open ? failures.get(row.id) : undefined
    const failure = failed === undefined
      ? undefined
      : el('div', 'load-error', el('span', 'load-error-text', `无法读取输出：${failed}`), button('load-retry', '重试', '重新读取输出', () => load(row.id)))
    return el(
      'div',
      'command-row',
      head,
      row.running ? button('command-stop', '停止', '停止这个进程', () => handlers.onStop(row.id)) : undefined,
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
    replace(container, ...rows.map(rowNode))
    tick()
    if (clocks.length === 0) stopClock()
    else timer ??= setInterval(tick, POLL_MS)
  }

  return {
    render(next) {
      if (next === undefined) {
        stopClock()
        drawn = undefined
        return
      }
      rows = next
      for (const id of expanded) if (!next.some((row) => row.id === id)) expanded.delete(id)
      for (const id of failures.keys()) if (!next.some((row) => row.id === id)) failures.delete(id)
      const signature = JSON.stringify(next)
      if (signature === drawn) return
      drawn = signature
      // A process that just ended has the last of its output to show.
      for (const row of next) if (!row.running && expanded.has(row.id)) load(row.id)
      paint()
    },
  }
}
