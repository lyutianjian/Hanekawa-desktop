import type { MenuItemConstructorOptions } from 'electron'
import type { WireMenuAction } from './shellProtocol.js'

/**
 * The macOS menu bar, in Chinese.
 *
 * Electron's default menu is an English File/Edit/View/Window bar whose 视图
 * carries Reload (⌘R wiped every pane's state mid-turn) and the zoom roles (the
 * embedded browser's native views do not follow a zoomed page, `browser/tabs.ts`).
 * This one carries the app's own commands under the names the rest of the
 * interface uses, the clipboard and window roles macOS users expect, and nothing
 * that can reload or zoom the document.
 *
 * Windows and Linux get no application menu at all — the renderer draws 文件 /
 * 视图 in the title bar there (`renderer/model/titleBar.ts`), and both menus run
 * the same actions.
 *
 * **Who owns a chord.** The app's commands (⌘T, ⇧⌘O, ⌘W, ⌘B, ⌘,) are handled by
 * the page's keydown handler on every platform, because only the renderer knows
 * whether a blocking prompt is up or which lane is active. Here they are labels
 * plus a click. AppKit dispatches a menu's key equivalents before the page sees
 * the key, and Electron's `registerAccelerator: false` is honoured only on
 * Windows and Linux, so `main.ts` calls `setIgnoreMenuShortcuts` for exactly
 * these chords (`isPageMenuChord`) while the window's own document has focus.
 * With the embedded browser focused the page never sees the key, so the menu
 * keeps it and the item's click path runs instead. Every other accelerator
 * (copy, paste, hide, quit, full screen) stays the menu's.
 *
 * Pure: `main.ts` builds the menu from this template and supplies `run`.
 */

export interface AppMenuOptions {
  /** The bold first menu's title, and the name in 关于 / 隐藏 / 退出. */
  readonly appName: string
  /** Development builds keep 开发者工具; a packaged app does not show it. */
  readonly devTools: boolean
  /** A command item was clicked. The renderer decides what that means now. */
  run(action: WireMenuAction): void
}

/** A chord the page handles itself. `key` is lower case; Shift is explicit. */
interface PageChord {
  readonly action: WireMenuAction
  readonly key: string
  readonly shift: boolean
}

const PAGE_CHORDS: readonly PageChord[] = [
  { action: 'new-session', key: 't', shift: false },
  { action: 'open-project', key: 'o', shift: true },
  { action: 'close-session', key: 'w', shift: false },
  { action: 'toggle-sidebar', key: 'b', shift: false },
  { action: 'open-settings', key: ',', shift: false },
]

/** Electron's `Input`, the four modifiers and the key. */
export interface MenuChordInput {
  readonly key: string
  readonly meta: boolean
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
}

/**
 * Whether a key belongs to the page rather than the menu: ⌘ plus one of the
 * chords above, with exactly the Shift it is listed with and no Control or
 * Option. ⇧⌘W, ⌥⌘T and ⌃⌘F are not the page's and stay with the menu.
 */
export function isPageMenuChord(input: MenuChordInput): boolean {
  if (!input.meta || input.control || input.alt) return false
  const key = input.key.toLowerCase()
  return PAGE_CHORDS.some((chord) => chord.key === key && chord.shift === input.shift)
}

function accelerator(action: WireMenuAction): string | undefined {
  const chord = PAGE_CHORDS.find((entry) => entry.action === action)
  if (chord === undefined) return undefined
  const key = chord.key === ',' ? ',' : chord.key.toUpperCase()
  return `${chord.shift ? 'Shift+' : ''}Command+${key}`
}

function command(label: string, action: WireMenuAction, options: AppMenuOptions): MenuItemConstructorOptions {
  const chord = accelerator(action)
  return {
    label,
    ...(chord !== undefined ? { accelerator: chord, registerAccelerator: false } : {}),
    click: () => options.run(action),
  }
}

export function appMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const name = options.appName
  return [
    {
      label: name,
      submenu: [
        { role: 'about', label: `关于 ${name}` },
        { type: 'separator' },
        command('设置…', 'open-settings', options),
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${name}` },
      ],
    },
    {
      label: '文件',
      submenu: [
        command('新建会话', 'new-session', options),
        command('打开项目…', 'open-project', options),
        { type: 'separator' },
        // Closes the session, never the window: the red button does that. No
        // `close` role anywhere — that is the item that used to own ⌘W.
        command('关闭会话', 'close-session', options),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        command('收起 / 展开侧栏', 'toggle-sidebar', options),
        command('显示 / 隐藏浏览器', 'toggle-browser', options),
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏幕' },
        ...(options.devTools
          ? ([{ type: 'separator' }, { role: 'toggleDevTools', label: '开发者工具' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      // `role: 'window'` makes this the menu macOS appends the open windows to.
      label: '窗口',
      role: 'window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ]
}
