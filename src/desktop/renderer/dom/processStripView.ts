import { threadStripText, type ThreadStripView } from '../model/sidePanel.js'
import { el, replace } from './dom.js'
import { icon } from './icons.js'

/**
 * The tag above the composer: "N 个后台进程". Empty when there is nothing to
 * say, which `#process-strip:empty` turns into no box at all. Repaints only when
 * the count moves, so a stream of snapshot ticks does not rebuild a button under
 * the pointer.
 */
export interface ProcessStripView {
  render(count: number): void
}

export function createProcessStripView(container: HTMLElement, onOpen: () => void): ProcessStripView {
  let drawn = -1
  return {
    render(count) {
      if (count === drawn) return
      drawn = count
      if (count === 0) {
        replace(container)
        return
      }
      const chip = el('button', 'process-chip', icon('dot'), el('span', undefined, `${count} 个后台进程`))
      chip.type = 'button'
      chip.title = '查看后台任务'
      chip.addEventListener('click', onOpen)
      replace(container, chip)
    },
  }
}

/** The thread chip under a coordination session's messages: "N 个线程 · N 个运行中 · N 个需要你". */
export function threadChip(view: ThreadStripView, onOpen: (target: ThreadStripView['target']) => void): HTMLElement {
  const text = threadStripText(view)
  const chip = el(
    'button',
    `thread-chip${view.running > 0 ? ' running' : ''}`,
    icon(view.running > 0 ? 'spinner' : 'overview'),
    el('span', undefined, text.total),
    text.running ? el('span', undefined, text.running) : undefined,
    text.blocked ? el('span', 'thread-chip-blocked', text.blocked) : undefined,
  )
  chip.type = 'button'
  chip.title = view.target.kind === 'thread' ? '在主画布打开需要你的线程' : '查看线程'
  chip.addEventListener('click', () => onOpen(view.target))
  return el('div', 'thread-chip-row', chip)
}
