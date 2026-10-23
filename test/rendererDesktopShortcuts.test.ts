import assert from 'node:assert/strict'
import test from 'node:test'
import {
  desktopShortcut,
  enterChordLabel,
  isMacSessionCloseShortcut,
  isPrimaryModifier,
  type DesktopShortcut,
} from '../src/desktop/renderer/model/desktopShortcuts.js'
import type { KeyChord } from '../src/desktop/renderer/model/keymap.js'

test('desktop shortcut labels use the host platform, including Shift and punctuation', () => {
  const labels: [DesktopShortcut, string, string][] = [
    ['toggle-sidebar', '⌘B', 'Ctrl+B'],
    ['new-session', '⌘T', 'Ctrl+T'],
    ['close-session', '⌘W', 'Ctrl+W'],
    ['switch-session', '⌘1-9', 'Ctrl+1-9'],
    ['open-project', '⇧⌘O', 'Ctrl+Shift+O'],
    ['open-settings', '⌘,', 'Ctrl+,'],
  ]
  for (const [action, mac, other] of labels) {
    assert.equal(desktopShortcut('darwin', action), mac)
    assert.equal(desktopShortcut('win32', action), other)
    assert.equal(desktopShortcut('linux', action), other)
  }
})

test('only plain Command+W bypasses the native Close Window accelerator', () => {
  assert.equal(isMacSessionCloseShortcut({ key: 'w', metaKey: true }), true)
  assert.equal(isMacSessionCloseShortcut({ key: 'W', metaKey: true }), true)

  const nativeOrUnmodified: KeyChord[] = [
    { key: 'w' },
    { key: 'w', ctrlKey: true },
    { key: 'w', metaKey: true, shiftKey: true },
    { key: 'w', metaKey: true, altKey: true },
    { key: 'w', metaKey: true, ctrlKey: true },
    { key: 'q', metaKey: true },
    { key: 'c', metaKey: true },
    { key: 'v', metaKey: true },
    { key: 'f', metaKey: true, ctrlKey: true },
    { key: 'Meta', metaKey: true },
  ]
  for (const chord of nativeOrUnmodified) assert.equal(isMacSessionCloseShortcut(chord), false)
})

test('the primary modifier is ⌘ on macOS and Ctrl elsewhere, never both and never with Alt', () => {
  assert.equal(isPrimaryModifier({ key: 'b', metaKey: true }, 'darwin'), true)
  assert.equal(isPrimaryModifier({ key: 'O', metaKey: true, shiftKey: true }, 'darwin'), true, 'Shift may ride along')
  assert.equal(isPrimaryModifier({ key: 'b', ctrlKey: true }, 'win32'), true)
  assert.equal(isPrimaryModifier({ key: 'b', ctrlKey: true }, 'linux'), true)

  // Control on macOS is the text-editing modifier (Ctrl+B back a character,
  // Ctrl+T transpose); ⊞ on Windows is the system's.
  assert.equal(isPrimaryModifier({ key: 'b', ctrlKey: true }, 'darwin'), false)
  assert.equal(isPrimaryModifier({ key: 'b', metaKey: true }, 'win32'), false)
  assert.equal(isPrimaryModifier({ key: 'b', ctrlKey: true, metaKey: true }, 'darwin'), false)
  assert.equal(isPrimaryModifier({ key: 'b', ctrlKey: true, metaKey: true }, 'win32'), false)
  // Ctrl+Alt is AltGr on many Windows layouts — how `@` and `{` are typed.
  assert.equal(isPrimaryModifier({ key: '{', ctrlKey: true, altKey: true }, 'win32'), false)
  assert.equal(isPrimaryModifier({ key: 'b', metaKey: true, altKey: true }, 'darwin'), false)
  assert.equal(isPrimaryModifier({ key: 'b' }, 'darwin'), false)
  assert.equal(isPrimaryModifier({ key: 'b' }, 'win32'), false)
})

test('Enter chords are labelled the way each platform writes them', () => {
  assert.equal(enterChordLabel('darwin'), '⏎')
  assert.equal(enterChordLabel('darwin', { primary: true }), '⌘⏎')
  assert.equal(enterChordLabel('darwin', { primary: true, shift: true }), '⇧⌘⏎', 'macOS orders ⌃⌥⇧⌘')
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(enterChordLabel(platform), 'Enter')
    assert.equal(enterChordLabel(platform, { primary: true }), 'Ctrl+Enter')
    assert.equal(enterChordLabel(platform, { primary: true, shift: true }), 'Ctrl+Shift+Enter')
  }
})
