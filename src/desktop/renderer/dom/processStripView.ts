import { threadStripText, type ThreadStripView } from '../model/sidePanel.js'
import { el, replace } from './dom.js'
import { icon } from './icons.js'

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
