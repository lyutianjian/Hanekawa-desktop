import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_WINDOW_SIZE,
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_SIZE,
  clampInto,
  createWindowStateWriter,
  loadWindowState,
  minimumSize,
  parseWindowState,
  placeWindow,
  type WindowState,
} from '../src/desktop/windowState.js'

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
const SECOND = { x: 1920, y: 0, width: 1440, height: 860 }

test('parse falls back field by field; a malformed file never costs the launch', () => {
  assert.deepEqual(parseWindowState(null), DEFAULT_WINDOW_STATE)
  assert.deepEqual(parseWindowState('nonsense'), DEFAULT_WINDOW_STATE)
  assert.deepEqual(
    parseWindowState({ bounds: { x: 10.4, y: 20.6, width: 1200, height: 800 }, maximized: true, themePreference: 'light', theme: 'light' }),
    { bounds: { x: 10, y: 21, width: 1200, height: 800 }, maximized: true, fullScreen: false, themePreference: 'light', theme: 'light' },
  )
  // A bad rectangle drops alone; the theme survives it.
  const partial = parseWindowState({ bounds: { x: 0, y: 0, width: 0, height: 800 }, theme: 'light', themePreference: 'sepia' })
  assert.equal(partial.bounds, undefined)
  assert.equal(partial.theme, 'light')
  assert.equal(partial.themePreference, 'system')
  assert.equal(parseWindowState({ bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } }).bounds, undefined)
  assert.equal(parseWindowState({ maximized: 'yes' }).maximized, false)
})

test('a remembered window opens where it was, on the display it overlaps most', () => {
  const saved = { x: 2000, y: 100, width: 1200, height: 700 }
  assert.deepEqual(placeWindow(saved, [PRIMARY, SECOND], PRIMARY), { bounds: saved, workArea: SECOND })
})

test('a window whose display is gone, or whose title strip is unreachable, opens centred on the primary', () => {
  // Unplugged second monitor: the strip overlaps nothing.
  const centred = {
    x: Math.round((PRIMARY.width - DEFAULT_WINDOW_SIZE.width) / 2),
    y: Math.round((PRIMARY.height - DEFAULT_WINDOW_SIZE.height) / 2),
    ...DEFAULT_WINDOW_SIZE,
  }
  assert.deepEqual(placeWindow({ x: 2000, y: 100, width: 1200, height: 700 }, [PRIMARY], PRIMARY).bounds, centred)
  // The body is on screen but the strip sits above the top edge: nothing to grab.
  assert.deepEqual(placeWindow({ x: 100, y: -60, width: 1200, height: 700 }, [PRIMARY], PRIMARY).bounds, centred)
  // Only a sliver of the strip shows: under the 100px it takes to grab it.
  assert.deepEqual(placeWindow({ x: 1850, y: 100, width: 1200, height: 700 }, [PRIMARY], PRIMARY).bounds, centred)
  assert.deepEqual(placeWindow(undefined, [PRIMARY], PRIMARY).bounds, centred)
})

test('a kept window is clamped into its work area, and the floor bends to a small screen', () => {
  // Hanging off the right edge but grabbable: pulled back in, size kept.
  assert.deepEqual(placeWindow({ x: 1500, y: 100, width: 1200, height: 700 }, [PRIMARY], PRIMARY).bounds, {
    x: 720, y: 100, width: 1200, height: 700,
  })
  // 1366×768 at 125% leaves about 580px: the 620px floor would overflow it.
  const small = { x: 0, y: 0, width: 1093, height: 580 }
  assert.deepEqual(minimumSize(small), { width: 1000, height: 580 })
  assert.deepEqual(minimumSize(PRIMARY), MIN_WINDOW_SIZE)
  assert.deepEqual(clampInto({ x: 0, y: 0, width: 1400, height: 900 }, small), { x: 0, y: 0, width: 1093, height: 580 })
  // Smaller than the floor is raised to it.
  assert.deepEqual(clampInto({ x: 10, y: 10, width: 300, height: 200 }, PRIMARY), { x: 10, y: 10, width: 1000, height: 620 })
  // The default size is clamped too when the primary is tiny.
  assert.deepEqual(placeWindow(undefined, [small], small).bounds, { x: 0, y: 0, width: 1093, height: 580 })
})

test('the writer debounces, flush writes the latest now, and an unreadable file loads the default', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hanekawa-window-state-'))
  try {
    const file = path.join(dir, 'window-state.json')
    let current: WindowState = { ...DEFAULT_WINDOW_STATE, theme: 'light' }
    let reads = 0
    const writer = createWindowStateWriter(file, () => {
      reads += 1
      return current
    }, 30)
    writer.schedule()
    writer.schedule()
    current = { ...current, maximized: true }
    await writer.flush()
    assert.equal(reads, 1, 'two schedules and a flush are one write')
    assert.deepEqual(await loadWindowState(file), current)

    // A window already gone reports nothing and nothing is written over the file.
    const gone = createWindowStateWriter(file, () => undefined, 30)
    await gone.flush()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), current)

    await writeFile(file, '{ not json')
    assert.deepEqual(await loadWindowState(file), DEFAULT_WINDOW_STATE)
    assert.deepEqual(await loadWindowState(path.join(dir, 'missing.json')), DEFAULT_WINDOW_STATE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
