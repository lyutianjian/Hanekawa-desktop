import { NO_SESSION_TEXT } from '../model/canvasHeader.js'
import { button } from './controls.js'
import { el } from './dom.js'

/**
 * The canvas with no session in it (`canvasIsEmpty` in `model/canvasHeader.ts`):
 * a line saying so and the two ways out, the same two the title bar's 文件 menu
 * offers. Built once and only shown or hidden.
 */
export interface NoSessionView {
  set(visible: boolean): void
}

export function createNoSessionView(
  mount: HTMLElement,
  actions: { onNewSession: () => void; onOpenProject: () => void },
): NoSessionView {
  const node = el(
    'div',
    'no-session',
    el('div', 'no-session-text', NO_SESSION_TEXT),
    el(
      'div',
      'no-session-actions',
      button('dialog-btn primary', '新建会话', '新建会话', actions.onNewSession),
      button('dialog-btn', '打开项目', '打开项目', actions.onOpenProject),
    ),
  )
  node.hidden = true
  mount.appendChild(node)
  return {
    set(visible) {
      node.hidden = !visible
    },
  }
}
