/**
 * The side panel's 「线程」 section: a project's coordination threads, one line
 * each, grouped under foldable bands. A row opens the thread's page; its
 * actions live in a menu behind the trailing ⋯, shown on hover.
 *
 * The list is rebuilt only when its model output changed: it repaints on every
 * coordination push, and a button rebuilt under the pointer would swallow the
 * click that is on its way. The row menu is one persistent node beside the list,
 * anchored to the open row by the stylesheet, so a push that redraws the list
 * leaves the menu the user is aiming at alone.
 */

import type { ThreadPanelGroup, ThreadPanelIntent, ThreadPanelMenu, ThreadPanelRow, ThreadPanelView } from '../model/threadPanel.js'
import type { ThreadTone } from '../model/coordinationStatus.js'
import { button } from './controls.js'
import { dismissable } from './dismiss.js'
import { focusByKey, followPointer, heldFocusKey, rovingFocus } from './focus.js'
import { icon, type IconName } from './icons.js'
import { el, replace } from './dom.js'
import { createPresence } from './presence.js'

export interface ThreadPanelDom {
  render(view: ThreadPanelView): void
  /** For a list going off screen: a menu must not outlive the rows it hangs from. */
  closeMenu(): void
}

const TONE_ICON: Readonly<Record<ThreadTone, IconName>> = {
  running: 'spinner',
  attention: 'alert-circle',
  danger: 'x-circle',
  neutral: 'circle',
  muted: 'check-circle',
}

export function createThreadPanelView(root: HTMLElement, onIntent: (intent: ThreadPanelIntent) => void): ThreadPanelDom {
  const list = el('div', 'thread-panel-list')
  const menu = el('div', 'thread-menu')
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  const enabledItems = (): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>('.thread-menu-item')).filter((item) => !item.disabled)
  menu.addEventListener('keydown', (event) => rovingFocus(event, enabledItems(), true, () => {}))
  followPointer(menu, '.thread-menu-item')
  const menuPresence = createPresence(menu, { direction: 'drop', onClosed: () => replace(menu) })
  replace(root, list, menu)

  let drawn: string | undefined
  let menuDrawn: string | undefined
  let menuOpen: ThreadPanelMenu | undefined

  const closeMenu = (): void => onIntent({ kind: 'menu', threadId: undefined })
  // The trigger is kept as well as the menu: its own click toggles.
  dismissable(['.thread-menu', '.thread-row-more'], { isOpen: () => menuOpen !== undefined, close: closeMenu })
  root.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    // `null` is this view's own repaint, not the user leaving.
    if (next === null || menuOpen === undefined) return
    if (next instanceof Node && root.contains(next)) return
    closeMenu()
  })

  function row(item: ThreadPanelRow, menuThreadId: string | undefined): HTMLElement {
    const mark = el('span', `thread-row-mark tone-${item.tone}`, icon(TONE_ICON[item.tone]))
    mark.title = item.statusLabel
    const main = button('thread-row-main', '', `查看线程 ${item.title}（${item.statusLabel}）`, () => onIntent({ kind: 'view', threadId: item.threadId }))
    main.appendChild(mark)
    main.appendChild(el('span', 'thread-row-title', item.title))
    if (item.statusLine !== undefined) main.appendChild(el('span', 'thread-row-line', item.statusLine))
    if (item.unread) main.appendChild(el('span', 'thread-row-dot', icon('dot')))
    main.dataset.focusKey = `v:${item.threadId}`
    if (item.current) main.setAttribute('aria-current', 'true')
    const menuHere = item.threadId === menuThreadId
    const more = button('thread-row-more', '', '线程操作', () => onIntent({ kind: 'menu', threadId: menuHere ? undefined : item.threadId }), { icon: 'more' })
    more.dataset.focusKey = `m:${item.threadId}`
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', String(menuHere))
    const classes = ['thread-row', item.current ? 'current' : '', item.unread ? 'unread' : '', item.pending ? 'pending' : '', menuHere ? 'menu-open' : '']
    return el('div', classes.filter(Boolean).join(' '), main, el('span', 'thread-row-time', item.lastActivity), more)
  }

  function group(section: ThreadPanelGroup, menuThreadId: string | undefined): HTMLElement {
    const head = button('thread-group-head', '', `${section.label}（${section.folded ? '展开' : '收起'}）`, () => onIntent({ kind: 'toggle-group', group: section.group }))
    head.appendChild(el('span', 'thread-group-label', section.label))
    head.appendChild(el('span', 'thread-group-count', String(section.rows.length)))
    head.appendChild(icon('chevron-down'))
    head.setAttribute('aria-expanded', String(!section.folded))
    head.dataset.focusKey = `g:${section.group}`
    return el(
      'section',
      `thread-group ${section.group}`,
      head,
      section.folded ? undefined : el('div', 'thread-group-body', ...section.rows.map((item) => row(item, menuThreadId))),
    )
  }

  const noticeNode = (view: ThreadPanelView): HTMLElement | undefined =>
    view.notice === undefined ? undefined : el('div', view.noticeTone === 'error' ? 'thread-panel-notice error' : 'thread-panel-notice', view.notice)

  const emptyState = (): HTMLElement => el('div', 'thread-panel-empty',
    el('h2', 'thread-panel-empty-title', '概览'),
    el('p', 'thread-panel-empty-lead', '线程开始后，这里会跟踪它们的进展：哪些正在进行、哪些在等你处理、哪些已经完成。'),
    el('div', 'thread-panel-empty-hint', icon('overview'), el('p', undefined, '协调会话开始工作后，线程会显示在这里。')),
  )

  function renderMenu(next: ThreadPanelMenu | undefined): void {
    const signature = next === undefined ? undefined : JSON.stringify(next)
    if (signature === menuDrawn) return
    const opening = menuOpen === undefined && next !== undefined
    menuDrawn = signature
    menuOpen = next
    if (next === undefined) {
      menuPresence.set(false)
      return
    }
    const items = [
      button('thread-menu-item', '在主画布打开', '在主画布打开这个线程', () => {
        closeMenu()
        onIntent({ kind: 'open', sessionId: next.sessionId })
      }),
      next.canStop
        ? button('thread-menu-item danger', '停止', '停止这个线程', () => {
          closeMenu()
          onIntent({ kind: 'stop', threadId: next.threadId })
        }, { enabled: !next.pending })
        : undefined,
      next.canResolve
        ? button('thread-menu-item', '标为完成', '把这个线程标为已完成（之后不能再发消息）', () => {
          closeMenu()
          onIntent({ kind: 'resolve', threadId: next.threadId })
        }, { enabled: !next.pending })
        : undefined,
    ]
    replace(menu, ...items)
    menuPresence.set(true)
    if (opening) enabledItems()[0]?.focus()
  }

  return {
    render(view) {
      const menuThreadId = view.menu?.threadId
      const signature = JSON.stringify({ ...view, menu: menuThreadId })
      if (signature !== drawn) {
        drawn = signature
        const held = heldFocusKey(list)
        if (!view.available) replace(list, noticeNode(view), emptyState())
        else replace(list, el('div', 'thread-panel', noticeNode(view), ...view.groups.map((section) => group(section, menuThreadId))))
        if (held !== undefined) focusByKey(list, held)
      }
      // A closing menu hands the keyboard back to the row it hung from.
      const returning = menuOpen !== undefined && view.menu === undefined && menu.contains(document.activeElement)
      const trigger = menuOpen?.threadId
      renderMenu(view.menu)
      if (returning && trigger !== undefined) focusByKey(list, `m:${trigger}`)
    },
    closeMenu: () => renderMenu(undefined),
  }
}
