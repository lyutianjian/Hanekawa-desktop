import type { DesktopPlatform } from '../../types.js'
import { desktopShortcut } from './desktopShortcuts.js'
import { SIDE_MODE_LABELS, type SideMode } from './sidePanel.js'

/**
 * The title bar's menus, as data.
 *
 * The window is frameless (5g), so this row replaces both Electron's default
 * English menu and the OS caption: on Windows the three buttons are still drawn
 * by the system into `titleBarOverlay`, and everything to the left of them is
 * ours. The rest of the strip is a drag region — see `styles.css`.
 *
 * Every item maps to an intent the app **already** has, deliberately: a menu is a
 * second way to reach a command, never a first. That is also why there is no
 * 编辑 menu — cut/copy/paste in a textarea are the platform's own accelerators,
 * and a renderer-drawn 编辑 would either duplicate them or lie about them.
 *
 * DOM-free, like every other `model/` module: decisions here, nodes in
 * `dom/titleBarView.ts`.
 */

/** What a menu item asks the app to do. Each one exists elsewhere already. */
export type TitleBarAction =
  | 'new-session'
  | 'open-project'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'toggle-help'
  /** One of the side panel's pages; `toggle-browser` is also the 视图 menu's item. */
  | `toggle-${SideMode}`

export interface TitleBarItem {
  readonly action: TitleBarAction
  readonly label: string
  /** The chord that does the same thing, shown right-aligned. */
  readonly chord: string
  /** Greyed while the window cannot open anything (a blocking dialog is up). */
  readonly needsProject?: boolean
}

export interface TitleBarMenu {
  /** Stable across renders, so "which menu is open" survives a repaint. */
  readonly id: string
  readonly label: string
  readonly items: readonly TitleBarItem[]
}

export function titleBarMenus(platform: DesktopPlatform): readonly TitleBarMenu[] {
  return [
    {
      id: 'file',
      label: '文件',
      items: [
        { action: 'new-session', label: '新建会话', chord: desktopShortcut(platform, 'new-session'), needsProject: true },
        { action: 'open-project', label: '打开项目…', chord: desktopShortcut(platform, 'open-project'), needsProject: true },
        { action: 'open-settings', label: '设置', chord: desktopShortcut(platform, 'open-settings') },
      ],
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { action: 'toggle-sidebar', label: '收起 / 展开侧栏', chord: desktopShortcut(platform, 'toggle-sidebar') },
        // No chord: the browser panel has no accelerator yet, and inventing one
        // here would show the user a shortcut nothing listens for. Same reason
        // 快捷键 below carries an empty one.
        { action: 'toggle-browser', label: '显示 / 隐藏浏览器', chord: '' },
      ],
    },
  ]
}

export interface TitleBarView {
  readonly menus: readonly TitleBarMenu[]
  /** The open menu's id, or `undefined`. At most one is open. */
  readonly openMenu: string | undefined
  readonly sidebarCollapsed: boolean
  /** The side panel's buttons at the strip's far end. */
  readonly side: SideRailView
  /** False while a blocking dialog is up; greys the items that open something. */
  readonly canCreate: boolean
}

export interface SideRailView {
  /** Left to right; 线程 only where the project has coordination. */
  readonly modes: readonly SideMode[]
  /** The page on screen, `undefined` while the panel is closed. */
  readonly open: SideMode | undefined
  /** A command or sub-agent is running: a dot on 任务. */
  readonly running: boolean
  /** Threads waiting on someone, on 线程: `9+` past nine, empty for none. */
  readonly threadsBadge: string
}

export function sideRailView(input: {
  modes: readonly SideMode[]
  open: SideMode | undefined
  running: boolean
  blockedThreads: number
}): SideRailView {
  const blocked = input.blockedThreads
  return {
    modes: input.modes,
    open: input.open,
    running: input.running,
    threadsBadge: blocked <= 0 ? '' : blocked > 9 ? '9+' : String(blocked),
  }
}

/** A side button's tooltip: what pressing it does now. */
export function sideButtonTitle(mode: SideMode, open: SideMode | undefined): string {
  return `${open === mode ? '隐藏' : '显示'}${SIDE_MODE_LABELS[mode]}`
}

/**
 * Opening a menu is idempotent per id: clicking the open one closes it.
 *
 * A single field rather than a set — the same shape `SettingsState.openMenu`
 * uses, and for the same reason: two menus open at once is a state the view
 * would have to be able to draw, and nothing wants it.
 */
export function toggleMenu(open: string | undefined, id: string): string | undefined {
  return open === id ? undefined : id
}

/** Whether an item can be activated in this view's state. */
export function itemEnabled(item: TitleBarItem, view: TitleBarView): boolean {
  return item.needsProject !== true || view.canCreate
}

/**
 * The signature the view repaints against.
 *
 * The title bar is drawn from the same shell snapshot the sidebar is, which
 * fires on every `isStreaming` tick — and rebuilding an open menu under the
 * pointer would close it on the next token.
 */
export function titleBarRenderSignature(view: TitleBarView): string {
  return [
    view.openMenu ?? '-',
    view.sidebarCollapsed ? 'c' : '-',
    view.side.modes.join(','),
    view.side.open ?? '-',
    view.side.running ? 'r' : '-',
    view.side.threadsBadge,
    view.canCreate ? 'n' : '-',
  ].join('|')
}
