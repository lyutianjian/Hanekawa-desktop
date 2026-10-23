import type { DesktopPlatform } from '../../types.js'
import type { KeyChord } from './keymap.js'

/** The same labels feed the title bar, sidebar tooltips and shortcut help. */
const SHORTCUTS = {
  'new-session': { key: 'T' },
  'open-project': { key: 'O', shift: true },
  'open-settings': { key: ',' },
  'toggle-sidebar': { key: 'B' },
  'close-session': { key: 'W' },
  'switch-session': { key: '1-9' },
} as const

export type DesktopShortcut = keyof typeof SHORTCUTS

export function desktopShortcut(platform: DesktopPlatform, action: DesktopShortcut): string {
  const chord: { key: string; shift?: boolean } = SHORTCUTS[action]
  return platform === 'darwin'
    ? `${chord.shift ? '⇧' : ''}⌘${chord.key}`
    : `Ctrl+${chord.shift ? 'Shift+' : ''}${chord.key}`
}

/**
 * Whether the platform's command modifier — and only it — is held: ⌘ on macOS,
 * Ctrl everywhere else. Shift may ride along; the chord decides what it means.
 *
 * Every window chord goes through this. Accepting either modifier on every
 * platform let macOS's Control chords, which are Cocoa's own text-editing keys
 * in every field (Ctrl+B back a character, Ctrl+T transpose, Ctrl+O open a
 * line), fold the sidebar and open sessions instead; and on Windows the ⊞ key
 * belongs to the system. Alt is refused on both: Ctrl+Alt is AltGr on many
 * Windows layouts, which is how `@`, `{` and `€` are typed.
 */
export function isPrimaryModifier(chord: KeyChord, platform: DesktopPlatform): boolean {
  if (chord.altKey === true) return false
  return platform === 'darwin'
    ? chord.metaKey === true && chord.ctrlKey !== true
    : chord.ctrlKey === true && chord.metaKey !== true
}

/**
 * Enter, alone or under the primary modifier and Shift, written the way the
 * platform writes it: `⇧⌘⏎` beside a macOS button, `Ctrl+Shift+Enter` beside a
 * Windows one. macOS orders its modifier glyphs ⌃⌥⇧⌘, so Shift comes first.
 */
export function enterChordLabel(platform: DesktopPlatform, chord: { primary?: boolean; shift?: boolean } = {}): string {
  if (platform === 'darwin') return `${chord.shift === true ? '⇧' : ''}${chord.primary === true ? '⌘' : ''}⏎`
  return [chord.primary === true && 'Ctrl', chord.shift === true && 'Shift', 'Enter'].filter(Boolean).join('+')
}

/** Only this native menu accelerator conflicts with the renderer's session close. */
export function isMacSessionCloseShortcut(chord: KeyChord): boolean {
  return chord.metaKey === true
    && chord.ctrlKey !== true
    && chord.shiftKey !== true
    && chord.altKey !== true
    && chord.key.toUpperCase() === SHORTCUTS['close-session'].key
}
