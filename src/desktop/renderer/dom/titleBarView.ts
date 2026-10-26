import { SIDE_MODE_LABELS, type SideMode } from '../model/sidePanel.js'
import {
  itemEnabled,
  sideButtonTitle,
  titleBarRenderSignature,
  toggleMenu,
  type TitleBarAction,
  type TitleBarItem,
  type TitleBarMenu,
  type TitleBarView,
} from '../model/titleBar.js'
import { button } from './controls.js'
import { dismissable } from './dismiss.js'
import { el, reconcile } from './dom.js'
import type { IconName } from './icons.js'
import { followPointer, rovingFocus } from './focus.js'
import { createPresence } from './presence.js'

/**
 * The frameless window's own title bar (5g).
 *
 * Left to right: the sidebar rail toggle and 文件 / 视图 (the lead group,
 * as wide as the sidebar so what follows starts on the canvas's edge), then the
 * canvas header, then the side panel's page buttons at the far end. `dom/windowChrome.ts` reserves the native
 * controls' measured space: left on macOS, normally right on Windows/Linux.
 *
 * The strip is `-webkit-app-region: drag`; every control in it is `no-drag`, or
 * it would move the window instead of being clickable. That pair lives in
 * `styles.css` (`#titlebar` / `#titlebar button`), not here: painting is not this
 * file's job.
 *
 * Menus close on a press outside the menu shells (`dom/dismiss.ts`), on
 * `focusout` from the bar, and on Escape — the same three the canvas header and
 * the composer's popovers use. The press is what covers the hole the other two
 * leave: a click on an unfocusable decoration moves no focus and fires no
 * `focusout`.
 */

export interface TitleBarDom {
  render(view: TitleBarView): void
}

export function createTitleBarView(
  container: HTMLElement,
  onAction: (action: TitleBarAction) => void,
  /** Reports the menu the user opened or closed; `app.ts` owns the flag. */
  onOpenMenu: (id: string | undefined) => void,
  /** The canvas header's host, owned by `canvasHeaderView.ts`; this view only places it. */
  center?: HTMLElement,
): TitleBarDom {
  let openMenu: string | undefined
  let drawn: string | undefined

  // Every menu shell, not the bar: a press on 视图 while 文件 is open has to reach
  // `toggleMenu` and swap them rather than be answered here as a close, and a
  // press on the bar's own blank strip has to shut whatever is open — which a
  // bar-wide scope treated as "inside" and left standing.
  dismissable(['.titlebar-menu-shell'], {
    isOpen: () => openMenu !== undefined,
    close: () => onOpenMenu(undefined),
  })

  container.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    // `null` is this view's own repaint destroying the focused node — the same
    // reasoning `sidebarView.ts` spells out. A real departure lands somewhere.
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    if (openMenu !== undefined) onOpenMenu(undefined)
  })

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || openMenu === undefined) return
    event.stopPropagation()
    onOpenMenu(undefined)
  })

  const itemNode = (item: TitleBarItem, view: TitleBarView): HTMLElement => {
    const node = button(
      'titlebar-menu-item',
      item.label,
      item.chord ? `${item.label}（${item.chord}）` : item.label,
      () => {
        // Close first, then act: several of these swap the whole canvas, and a
        // menu left open would hang over the screen that replaced it.
        onOpenMenu(undefined)
        onAction(item.action)
      },
      { enabled: itemEnabled(item, view) },
    )
    if (item.chord) node.appendChild(el('span', 'titlebar-menu-chord', item.chord))
    return node
  }

  const menuNode = (menu: TitleBarMenu) => {
    const shell = el('div', 'titlebar-menu-shell')
    const trigger = button('titlebar-menu-trigger', menu.label, menu.label,
      () => onOpenMenu(toggleMenu(openMenu, menu.id)))
    trigger.setAttribute('aria-haspopup', 'menu')
    const list = el('div', 'titlebar-menu')
    list.setAttribute('role', 'menu')
    const presence = createPresence(list, { direction: 'drop' })
    reconcile(shell, [trigger, list])
    // Disabled items cannot take focus, so the arrow keys skip them.
    const enabled = (): HTMLElement[] => entry.items.filter((node) => !(node as HTMLButtonElement).disabled)
    shell.addEventListener('keydown', (event) => rovingFocus(event, enabled(), openMenu === menu.id,
      () => onOpenMenu(toggleMenu(openMenu, menu.id))))
    followPointer(list, '.titlebar-menu-item')
    const entry = { menu, shell, trigger, list, presence, items: [] as HTMLElement[] }
    return entry
  }
  let menuSource: readonly TitleBarMenu[] | undefined
  let menus: ReturnType<typeof menuNode>[] = []
  const lead = el('div', 'titlebar-lead')
  const rail = button('titlebar-rail', '', '', () => onAction('toggle-sidebar'), { icon: 'sidebar' })
  // The side panel's pages, one button each, at the far end of the strip — the
  // panel they open is on that side. 浏览器 is also 视图 →「显示 / 隐藏浏览器」;
  // the menu item stays, because that is where a user looks for a name.
  const sideGroup = el('div', 'titlebar-side')
  const sideButtons = Object.fromEntries((Object.keys(SIDE_ICONS) as SideMode[]).map((mode) => {
    const node = button('titlebar-rail titlebar-side-button', '', SIDE_MODE_LABELS[mode], () => onAction(`toggle-${mode}`), { icon: SIDE_ICONS[mode] })
    node.dataset.mode = mode
    return [mode, node]
  })) as Record<SideMode, HTMLButtonElement>
  const runningDot = el('span', 'titlebar-side-dot')
  sideButtons.tasks.appendChild(runningDot)
  const threadsBadge = el('span', 'titlebar-side-badge')
  sideButtons.threads.appendChild(threadsBadge)

  return {
    render(view) {
      const signature = titleBarRenderSignature(view)
      const menusChanged = menuSource !== view.menus
      if (signature === drawn && !menusChanged) return
      drawn = signature
      const previous = openMenu
      openMenu = view.openMenu
      if (menusChanged) {
        for (const entry of menus) entry.presence.dispose()
        menuSource = view.menus
        menus = view.menus.map(menuNode)
        reconcile(lead, [rail, ...menus.map((entry) => entry.shell)])
        reconcile(container, [lead, center, sideGroup])
      }
      const chord = view.railChord
      rail.title = `${view.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}${chord ? `（${chord}）` : ''}`
      rail.setAttribute('aria-label', rail.title)
      reconcile(sideGroup, view.side.modes.map((mode) => sideButtons[mode]))
      for (const mode of view.side.modes) {
        const node = sideButtons[mode]
        node.title = sideButtonTitle(mode, view.side.open)
        node.setAttribute('aria-label', node.title)
        node.setAttribute('aria-pressed', String(view.side.open === mode))
        node.classList.toggle('open', view.side.open === mode)
      }
      runningDot.hidden = !view.side.running
      threadsBadge.textContent = view.side.threadsBadge
      threadsBadge.hidden = view.side.threadsBadge === ''
      let focus: HTMLElement | undefined
      for (const entry of menus) {
        const open = openMenu === entry.menu.id
        if (open && entry.items.length === 0) {
          entry.items = entry.menu.items.map((item) => itemNode(item, view))
          reconcile(entry.list, entry.items)
        }
        entry.items.forEach((node, index) => { (node as HTMLButtonElement).disabled = !itemEnabled(entry.menu.items[index]!, view) })
        entry.trigger.classList.toggle('open', open)
        entry.trigger.setAttribute('aria-expanded', String(open))
        if (!open && entry.list.contains(document.activeElement)) focus = entry.trigger
        entry.presence.set(open)
        if (open && (previous !== openMenu || menusChanged)) focus = entry.items.find((node) => !(node as HTMLButtonElement).disabled)
      }
      focus?.focus()
    },
  }
}

const SIDE_ICONS: Readonly<Record<SideMode, IconName>> = {
  tasks: 'tasks',
  threads: 'network',
  changes: 'diff',
  browser: 'globe',
}
