import { readJsonFile, writeJsonFile } from '../utils/json.js'

/**
 * What the window remembers between launches: where it was, and which theme
 * it was showing.
 *
 * The theme half exists for the first frame. The renderer keeps the real
 * preference in `localStorage`, which the main process cannot read before the
 * page loads — and by then the window has already been painted. So the last
 * preference the renderer reported (`set-window-theme`) is written here too,
 * and `main.ts` opens the next window on it: `nativeTheme.themeSource`, the
 * background colour and the Windows caption overlay all start right instead of
 * dark-then-light. A stale copy self-corrects, because the renderer reports
 * again as soon as it boots.
 *
 * The placement half is the usual one, plus the two checks that keep a
 * remembered window reachable: its title strip must still be on some display
 * (a monitor that was unplugged takes its windows with it otherwise), and its
 * size is clamped to the work area it lands on. The minimum size is clamped to
 * that work area as well — 1366×768 at 125% leaves about 580px of height, and a
 * 620px minimum made a window taller than the screen.
 *
 * Electron-free: `main.ts` passes in displays and reads bounds, so every
 * decision here is a pure function the tests drive directly.
 */

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

export type WindowThemePreference = 'system' | 'dark' | 'light'
export type WindowTheme = 'dark' | 'light'

export interface WindowState {
  /** The un-maximized bounds, so a restore from maximized goes back there. */
  bounds?: WindowRect
  maximized: boolean
  fullScreen: boolean
  themePreference: WindowThemePreference
  /** What `themePreference` resolved to when it was saved. */
  theme: WindowTheme
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  maximized: false,
  fullScreen: false,
  themePreference: 'system',
  theme: 'dark',
}

/** A first launch's size, before clamping to the work area. */
export const DEFAULT_WINDOW_SIZE = { width: 1152, height: 738 } as const

/** The layout's floor: sidebar, reading column and side panel side by side. */
export const MIN_WINDOW_SIZE = { width: 1000, height: 620 } as const

/**
 * How much of the title strip has to overlap a work area for the saved
 * position to count as reachable: enough to grab and drag back.
 */
const REACHABLE = { width: 100, height: 20 } as const
const TITLE_STRIP_HEIGHT = 40

export const WINDOW_STATE_FILE = 'window-state.json'

/** The sole interpreter of the file: anything malformed falls back field by field. */
export function parseWindowState(raw: unknown): WindowState {
  const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const preference = value.themePreference
  const theme = value.theme
  const bounds = parseRect(value.bounds)
  return {
    ...(bounds !== undefined ? { bounds } : {}),
    maximized: value.maximized === true,
    fullScreen: value.fullScreen === true,
    themePreference: preference === 'dark' || preference === 'light' || preference === 'system' ? preference : 'system',
    theme: theme === 'light' ? 'light' : 'dark',
  }
}

function parseRect(raw: unknown): WindowRect | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { x, y, width, height } = raw as Record<string, unknown>
  const numbers = [x, y, width, height]
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  if ((width as number) <= 0 || (height as number) <= 0) return undefined
  return { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) }
}

/** The window's floor on a given work area: the layout's, or the screen's when that is smaller. */
export function minimumSize(workArea: WindowRect): { width: number; height: number } {
  return {
    width: Math.min(MIN_WINDOW_SIZE.width, workArea.width),
    height: Math.min(MIN_WINDOW_SIZE.height, workArea.height),
  }
}

function overlap(a: WindowRect, b: WindowRect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  }
}

/**
 * Where the window opens, and on which work area.
 *
 * A saved rectangle is kept when its title strip is still reachable on some
 * display — the one it overlaps most wins — and is then clamped to fit inside
 * that work area. Anything else (no saved bounds, a display that is gone, a
 * strip pushed above the top edge) opens at the default size, centred on the
 * primary display: the same window a first launch gets.
 */
export function placeWindow(
  saved: WindowRect | undefined,
  workAreas: readonly WindowRect[],
  primary: WindowRect,
): { bounds: WindowRect; workArea: WindowRect } {
  if (saved !== undefined) {
    const strip = { x: saved.x, y: saved.y, width: saved.width, height: Math.min(TITLE_STRIP_HEIGHT, saved.height) }
    let best: { area: WindowRect; score: number } | undefined
    for (const area of workAreas) {
      const shared = overlap(strip, area)
      if (shared.width < REACHABLE.width || shared.height < REACHABLE.height) continue
      const score = shared.width * shared.height
      if (best === undefined || score > best.score) best = { area, score }
    }
    if (best !== undefined) return { bounds: clampInto(saved, best.area), workArea: best.area }
  }
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, primary.width)
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, primary.height)
  return {
    bounds: {
      x: primary.x + Math.round((primary.width - width) / 2),
      y: primary.y + Math.round((primary.height - height) / 2),
      width,
      height,
    },
    workArea: primary,
  }
}

/** Fits `rect` inside `area`: no larger than it, no smaller than the floor, no edge outside it. */
export function clampInto(rect: WindowRect, area: WindowRect): WindowRect {
  const floor = minimumSize(area)
  const width = Math.min(area.width, Math.max(floor.width, rect.width))
  const height = Math.min(area.height, Math.max(floor.height, rect.height))
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

export async function loadWindowState(file: string): Promise<WindowState> {
  try {
    return parseWindowState(await readJsonFile<unknown>(file, {}))
  } catch {
    // An unreadable file costs the remembered window, never the launch.
    return { ...DEFAULT_WINDOW_STATE }
  }
}

/**
 * Debounced writes of whatever `read` reports now.
 *
 * Moves and resizes arrive per frame while dragging; one write per pause is
 * plenty. `flush` writes immediately and is what the window's `close` calls —
 * by `closed` the bounds are gone. Writes are chained, so a flush racing a
 * pending timer cannot land an older snapshot over a newer one.
 */
export function createWindowStateWriter(
  file: string,
  read: () => WindowState | undefined,
  delayMs = 400,
): { schedule(): void; flush(): Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  const write = (): Promise<void> => {
    timer = undefined
    const state = read()
    if (state === undefined) return chain
    chain = chain
      .then(() => writeJsonFile(file, state))
      .catch((error: unknown) => console.error('[hanekawa] window state was not saved:', error))
    return chain
  }
  return {
    schedule() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void write(), delayMs)
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer)
      return write()
    },
  }
}
