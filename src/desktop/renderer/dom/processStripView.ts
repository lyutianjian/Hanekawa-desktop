import { threadStripText, type ThreadStripView } from '../model/sidePanel.js'
import { el, replace } from './dom.js'
import { icon } from './icons.js'

/**
 * The tags above the composer: "N 个后台进程", and in a coordination session
 * "N 个线程运行中 · N 个需要你". Empty when neither has anything to say, which
 * `#process-strip:empty` turns into no box at all. Repaints only when a value
 * moves, so a stream of snapshot ticks does not rebuild a button under the pointer.
 */
export interface ProcessStripView {
  render(count: number): void
  renderThreads(view: ThreadStripView | undefined): void
}

export function createProcessStripView(
  container: HTMLElement,
  onOpen: () => void,
  onOpenThreads: (target: ThreadStripView['target']) => void,
): ProcessStripView {
  let processes = 0
  let threads: ThreadStripView | undefined
  let drawn = ''

  function paint(): void {
    const signature = `${processes}|${threads ? JSON.stringify(threads) : ''}`
    if (signature === drawn) return
    drawn = signature
    const chips: HTMLElement[] = []
    if (threads) {
      const text = threadStripText(threads)
      const chip = el(
        'button',
        'process-chip thread-chip',
        icon('spinner'),
        text.running ? el('span', undefined, text.running) : undefined,
        text.blocked ? el('span', 'thread-chip-blocked', text.blocked) : undefined,
      )
      chip.type = 'button'
      chip.title = threads.target.kind === 'thread' ? '在主画布打开需要你的线程' : '查看概览'
      const target = threads.target
      chip.addEventListener('click', () => onOpenThreads(target))
      chips.push(chip)
    }
    if (processes > 0) {
      const chip = el('button', 'process-chip', icon('dot'), el('span', undefined, `${processes} 个后台进程`))
      chip.type = 'button'
      chip.title = '查看后台任务'
      chip.addEventListener('click', onOpen)
      chips.push(chip)
    }
    replace(container, ...chips)
  }

  return {
    render(count) {
      processes = count
      paint()
    },
    renderThreads(view) {
      threads = view
      paint()
    },
  }
}
