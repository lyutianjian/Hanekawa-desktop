import { button } from './controls.js'
import { el } from './dom.js'
import { trapTab } from './focus.js'
import { icon, type IconName } from './icons.js'
import { createModalPresence } from './presence.js'

/**
 * The 完全访问权限 question.
 *
 * The mode it turns on hands the agent the whole machine for the rest of the
 * session, so picking it in the pill's menu asks here first. It is a modal and
 * not a fifth menu row: the menu closes on the same click that would have
 * enabled it, and a guard that disappears with the menu it was drawn in is not
 * a guard.
 *
 * Drawn over the canvas, like `/rewind`: the sidebar stays usable beneath it,
 * so the layer carries no `aria-modal`. Focus is trapped inside the panel all
 * the same — nothing behind the scrim should be reachable by Tab.
 */
export interface FullAccessConfirmView {
  /** Puts the question up; `onConfirm` runs only when 确认 is pressed. */
  open(onConfirm: () => void): void
  close(): void
  isOpen(): boolean
}

export function createFullAccessConfirmView(
  container: HTMLElement,
  actions: { onLearnMore: () => void },
): FullAccessConfirmView {
  let pending: (() => void) | undefined
  /** Where focus was when the question went up, handed back when it is answered. */
  let returnTo: HTMLElement | undefined
  let open = false

  const cancel = button('full-access-btn', '取消', '取消，保持当前权限模式', () => close())
  const confirm = button('full-access-btn danger', '确认', '开启完全访问权限', () => {
    const run = pending
    close()
    run?.()
  }, { icon: 'triangle-alert' })
  const learnMore = el('button', 'full-access-more', '了解更多')
  learnMore.type = 'button'
  learnMore.addEventListener('click', () => {
    close()
    actions.onLearnMore()
  })

  const title = el('h2', 'full-access-title', icon('triangle-alert'), el('span', 'full-access-title-text', '要开启完全访问权限吗？'))
  title.id = TITLE_ID

  const panel = el(
    'div',
    'full-access-panel',
    title,
    el(
      'p',
      'full-access-lead',
      'Hanekawa 将能够在未经您许可的情况下，在这台计算机上的任何位置运行命令、使用互联网，以及创建和编辑文件。这包括但不限于：',
    ),
    el(
      'ul',
      'full-access-risks',
      risk('folder', 'file', '文件和文件夹', '读取、创建、修改、上传或删除此计算机上任意位置的文件'),
      risk('terminal', 'shell', '终端命令', '运行命令、安装软件和更改系统设置'),
      risk('globe', 'web', '互联网和已连接的应用', '访问网站、发送数据并使用已启用的插件'),
    ),
    el('p', 'full-access-foot', '这会带来敏感数据丢失或泄露、提示注入等风险。你可以随时关闭它。', learnMore),
    el('div', 'full-access-actions', cancel, confirm),
  )
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-labelledby', TITLE_ID)
  // Where focus goes when a paint removes the focused control.
  panel.tabIndex = -1
  container.appendChild(panel)
  const presence = createModalPresence(container, panel, () => {})

  // The scrim, and only the scrim: a press that started inside the panel and
  // bubbled here is not a dismissal.
  container.addEventListener('pointerdown', (event) => {
    if (event.target === container && open) close()
  })
  container.addEventListener('keydown', (event) => {
    if (!open) return
    if (event.key === 'Escape') {
      // Consumed here: at the document, Escape means "stop the turn", and this
      // question is answered, not abandoned, by the same key.
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    trapTab(panel, event)
  })

  function close(): void {
    if (!open) return
    const restore = returnTo
    returnTo = undefined
    pending = undefined
    open = false
    presence.set(false)
    if (restore?.isConnected) restore.focus({ preventScroll: true })
  }

  return {
    open(onConfirm) {
      const active = document.activeElement
      returnTo = active instanceof HTMLElement && !container.contains(active) ? active : undefined
      pending = onConfirm
      open = true
      presence.set(true)
      cancel.focus({ preventScroll: true })
    },
    close,
    isOpen: () => open,
  }
}

const TITLE_ID = 'full-access-title'

function risk(glyph: IconName, tone: string, title: string, detail: string): HTMLElement {
  return el(
    'li',
    'full-access-risk',
    el('span', `full-access-risk-icon ${tone}`, icon(glyph)),
    el('span', 'full-access-risk-text', el('span', 'full-access-risk-title', title), el('span', 'full-access-risk-detail', detail)),
  )
}