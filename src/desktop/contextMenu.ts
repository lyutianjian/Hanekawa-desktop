import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopPlatform } from './types.js'

/**
 * The right-click menu, in Chinese, for the window's own document.
 *
 * Chromium shows nothing on right-click in an Electron window unless the app
 * builds a menu, so selecting a path in the transcript and right-clicking to
 * copy it did nothing at all. This is the menu every text field on both
 * platforms has: spelling suggestions when the word under the pointer is
 * misspelled, the four editing commands in an editable field, 复制 for a
 * selection, plus a link's address and an image.
 *
 * Built from the params Chromium hands `context-menu`, nothing else: enabled
 * states come from `editFlags`, so 粘贴 is grey with an empty clipboard and 剪切
 * is grey in a read-only field, exactly as the native field would draw them.
 * An empty template means "no menu", never an empty popup.
 *
 * Pure; `main.ts` pops it up and supplies the four actions that need a
 * `webContents` or the clipboard.
 */

/** The subset of Electron's `ContextMenuParams` this reads. */
export interface ContextMenuInput {
  readonly x: number
  readonly y: number
  readonly isEditable: boolean
  readonly selectionText: string
  readonly misspelledWord: string
  readonly dictionarySuggestions: readonly string[]
  readonly linkURL: string
  readonly mediaType: string
  readonly hasImageContents: boolean
  readonly editFlags: {
    readonly canCut: boolean
    readonly canCopy: boolean
    readonly canPaste: boolean
    readonly canSelectAll: boolean
  }
}

export interface ContextMenuActions {
  replaceMisspelling(word: string): void
  addToDictionary(word: string): void
  copyText(text: string): void
  copyImageAt(x: number, y: number): void
}

/** At most this many suggestions, the length macOS and Windows both show. */
const MAX_SUGGESTIONS = 5

export function contextMenuTemplate(
  params: ContextMenuInput,
  platform: DesktopPlatform,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  // The platform's own word for it: macOS says 拷贝, Windows and Linux 复制.
  const copyLabel = platform === 'darwin' ? '拷贝' : '复制'
  const groups: MenuItemConstructorOptions[][] = []

  if (params.isEditable && params.misspelledWord !== '') {
    const word = params.misspelledWord
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
    groups.push([
      ...(suggestions.length > 0
        ? suggestions.map((suggestion): MenuItemConstructorOptions => ({
            label: suggestion,
            click: () => actions.replaceMisspelling(suggestion),
          }))
        : [{ label: '没有拼写建议', enabled: false }]),
      { label: '添加到词典', click: () => actions.addToDictionary(word) },
    ])
  }

  if (params.isEditable) {
    groups.push(
      [
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: copyLabel, enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      ],
      [{ role: 'selectAll', label: '全选', enabled: params.editFlags.canSelectAll }],
    )
  } else if (params.selectionText.trim() !== '') {
    groups.push([{ role: 'copy', label: copyLabel }])
  }

  if (params.linkURL !== '') {
    const url = params.linkURL
    groups.push([{ label: '复制链接地址', click: () => actions.copyText(url) }])
  }

  if (params.mediaType === 'image' && params.hasImageContents) {
    groups.push([{ label: '复制图片', click: () => actions.copyImageAt(params.x, params.y) }])
  }

  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ type: 'separator' } as MenuItemConstructorOptions, ...group],
  )
}
