import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { MenuItemConstructorOptions, NativeImage, Tray } from 'electron'
import { DesktopTray } from '../src/desktop/tray.js'
import { closeWindowAction, focusBackgroundWindow } from '../src/desktop/backgroundWindow.js'

function harness(options: { empty?: boolean; menuFails?: boolean } = {}) {
  const events = new EventEmitter()
  let destroyed = false, available = true, balloons = 0, errors = 0
  let menu: MenuItemConstructorOptions[] = []
  const actions: string[] = []
  const fake = Object.assign(events, {
    setToolTip() {},
    isDestroyed: () => destroyed,
    destroy() { destroyed = true },
    displayBalloon() { balloons++ },
  }) as unknown as Tray
  const tray = new DesktopTray({
    loadImage: () => ({ isEmpty: () => options.empty ?? false }) as NativeImage,
    create: () => fake,
    setMenu(_tray, template) {
      if (options.menuFails) throw new Error('menu failed')
      menu = template
    },
  }, {
    available: () => available,
    show: () => { actions.push('show') },
    run: (action) => { actions.push(action) },
    quit: () => { actions.push('quit') },
    error: () => { errors++ },
  })
  return {
    tray, events, actions, menu: () => menu,
    state: () => ({ destroyed, balloons, errors }),
    stopActions: () => { available = false },
  }
}

test('Windows tray offers recovery, existing menu intents and explicit quit', () => {
  const h = harness()
  h.tray.create('win32', 'tray.png')
  assert.equal(h.tray.isAvailable(), true)
  h.events.emit('click')
  for (const item of h.menu()) item.click?.({} as never, undefined, {} as never)
  assert.deepEqual(h.actions, ['show', 'show', 'new-session', 'open-project', 'quit'])
  h.tray.explainBackground()
  h.tray.explainBackground()
  assert.equal(h.state().balloons, 1)
  h.stopActions()
  h.events.emit('click')
  h.menu()[1]!.click?.({} as never, undefined, {} as never)
  assert.equal(h.actions.length, 5, 'draining/recovery cannot reopen a lane')
  h.tray.dispose()
  h.tray.dispose()
  assert.equal(h.tray.isAvailable(), false)
})

test('empty assets and partially initialized trays never allow hiding', () => {
  const empty = harness({ empty: true })
  empty.tray.create('win32', 'bad.png')
  assert.equal(empty.tray.isAvailable(), false)
  assert.equal(empty.state().errors, 1)
  const failed = harness({ menuFails: true })
  failed.tray.create('win32', 'tray.png')
  assert.equal(failed.tray.isAvailable(), false)
  assert.equal(failed.state().destroyed, true)
  const mac = harness()
  mac.tray.create('darwin', 'tray.png')
  assert.equal(mac.tray.isAvailable(), false)
})

test('close policy keeps native interactions visible and releases quit/system shutdown', () => {
  const base = { platform: 'win32', quitting: false, nativeInteraction: false, trayAvailable: true }
  assert.equal(closeWindowAction(base), 'hide')
  assert.equal(closeWindowAction({ ...base, trayAvailable: false }), 'tray-unavailable')
  assert.equal(closeWindowAction({ ...base, nativeInteraction: true }), 'keep')
  assert.equal(closeWindowAction({ ...base, quitting: true, trayAvailable: false }), 'close')
  assert.equal(closeWindowAction({ ...base, platform: 'darwin', trayAvailable: false }), 'hide')
  assert.equal(closeWindowAction({ ...base, platform: 'linux' }), 'close')
})

test('recovery restores and shows the same hidden window before focusing', () => {
  const calls: string[] = []
  focusBackgroundWindow({
    isDestroyed: () => false, isMinimized: () => true, isVisible: () => false,
    restore: () => { calls.push('restore') }, show: () => { calls.push('show') }, focus: () => { calls.push('focus') },
  })
  assert.deepEqual(calls, ['restore', 'show', 'focus'])
})
