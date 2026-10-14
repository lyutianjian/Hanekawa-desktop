import { button } from './controls.js'
import { el } from './dom.js'

/**
 * The page a window falls back to when its first pull from the host fails.
 *
 * Everything behind it is built but empty, so the page covers the window rather
 * than replacing the body: 「重试」 lifts it and asks again, with every view
 * still where it was.
 */
export function showStartupFailure(parent: HTMLElement, detail: string, onRetry: () => void): HTMLElement {
  const page = el(
    'div',
    'startup-failure',
    el('h1', 'startup-failure-title', '启动失败'),
    el('p', 'startup-failure-detail', detail),
    button('startup-failure-retry', '重试', '重新连接', () => {
      page.remove()
      onRetry()
    }),
  )
  page.setAttribute('role', 'alert')
  parent.appendChild(page)
  return page
}
