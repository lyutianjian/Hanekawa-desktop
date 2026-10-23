import assert from 'node:assert/strict'
import test from 'node:test'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate, isPageMenuChord, type MenuChordInput } from '../src/desktop/appMenu.js'
import type { WireMenuAction } from '../src/desktop/shellProtocol.js'

const chord = (key: string, mods: Partial<Omit<MenuChordInput, 'key'>> = {}): MenuChordInput => ({
  key,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
})

function items(template: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
}

function build(devTools = false): { template: MenuItemConstructorOptions[]; ran: WireMenuAction[] } {
  const ran: WireMenuAction[] = []
  return { template: appMenuTemplate({ appName: 'Hanekawa', devTools, run: (action) => ran.push(action) }), ran }
}

test('the page owns exactly its own chords; every other ⌘ chord stays with the menu', () => {
  // Carried over from the ⌘W-only patch this replaces: ⌘W closes the session,
  // never the window, and the native chords around it are left alone.
  for (const input of [
    chord('w', { meta: true }),
    chord('W', { meta: true }),
    chord('t', { meta: true }),
    chord('O', { meta: true, shift: true }),
    chord('b', { meta: true }),
    chord(',', { meta: true }),
  ]) {
    assert.equal(isPageMenuChord(input), true, JSON.stringify(input))
  }
  for (const input of [
    chord('w'),
    chord('w', { control: true }),
    chord('w', { meta: true, shift: true }),
    chord('w', { meta: true, alt: true }),
    chord('w', { meta: true, control: true }),
    chord('o', { meta: true }),
    chord('q', { meta: true }),
    chord('c', { meta: true }),
    chord('v', { meta: true }),
    chord('r', { meta: true }),
    chord('f', { meta: true, control: true }),
    chord('Meta', { meta: true }),
  ]) {
    assert.equal(isPageMenuChord(input), false, JSON.stringify(input))
  }
})

test('the menu can neither reload nor zoom the document, and no item closes the window on ⌘W', () => {
  // Reload wiped every pane mid-turn; zoom left the embedded browser's native
  // views behind the page. `close` is the role that used to own ⌘W.
  const roles = items(build(true).template).map((item) => item.role).filter((role) => role !== undefined)
  for (const banned of ['reload', 'forceReload', 'zoomIn', 'zoomOut', 'resetZoom', 'close', 'viewMenu', 'fileMenu']) {
    assert.ok(!roles.includes(banned as never), `no ${banned} role`)
  }
  for (const wanted of ['about', 'quit', 'hide', 'copy', 'paste', 'undo', 'minimize', 'togglefullscreen']) {
    assert.ok(roles.includes(wanted as never), `keeps ${wanted}`)
  }
})

test('command items are labels plus a click: the accelerator is shown, never registered', () => {
  const { template, ran } = build()
  const commands = items(template).filter((item) => item.click !== undefined)
  assert.ok(commands.length >= 6)
  for (const item of commands) {
    if (item.accelerator !== undefined) {
      assert.equal(item.registerAccelerator, false, `${item.label} must not take its key from the page`)
      const match = /^(Shift\+)?Command\+(.)$/.exec(String(item.accelerator))
      assert.ok(match, `${item.label}: ${item.accelerator}`)
      assert.equal(
        isPageMenuChord(chord(match[2]!.toLowerCase(), { meta: true, shift: match[1] !== undefined })),
        true,
        `${item.label}'s shown chord is one the page handles`,
      )
    }
    ;(item.click as () => void)()
  }
  assert.deepEqual(
    [...ran].sort(),
    ['close-session', 'new-session', 'open-project', 'open-settings', 'toggle-browser', 'toggle-sidebar'],
  )
  assert.deepEqual(template.map((menu) => menu.label), ['Hanekawa', '文件', '编辑', '视图', '窗口'])
})

test('开发者工具 appears only in development builds', () => {
  const has = (devTools: boolean) => items(build(devTools).template).some((item) => item.role === 'toggleDevTools')
  assert.equal(has(true), true)
  assert.equal(has(false), false)
})
