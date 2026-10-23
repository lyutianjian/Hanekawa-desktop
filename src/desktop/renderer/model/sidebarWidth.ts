/**
 * The sidebar's width: a preference, as data.
 *
 * The rail used to be a hard 280px in two places (`#sidebar`'s `flex-basis` and
 * `.sidebar-shell`'s `width`). Both now resolve from one custom property — the
 * shell reads it directly, while the rail adds the scrollbar's fixed overhang —
 * and this file owns the three decisions that property needs: what it defaults
 * to, what range a drag may land in, and how a stored string becomes a number
 * again.
 *
 * Pure and DOM-free like the rest of `model/`, and stored the way
 * `model/theme.ts` stores the theme preference — the width is a local view
 * preference, not project state, so it never rides the wire.
 */

export const SIDEBAR_WIDTH_STORAGE_KEY = 'hanekawa.sidebarWidth.v2'

/**
 * The resting width, and the value the stylesheet falls back to when nothing has
 * been stored. Pinned against `styles.css` by `rendererStyleTokens.test.ts`.
 */
export const SIDEBAR_WIDTH_DEFAULT = 256
/**
 * The narrow end. Below this the session rows stop being able to show a title
 * *and* its badge, so the rail would be draggable into uselessness.
 */
export const SIDEBAR_WIDTH_MIN = 200
/** The wide end: past this the canvas, not the sidebar, is the narrow column. */
export const SIDEBAR_WIDTH_MAX = 320

/** The CSS custom property both rules read. Spelled once, imported by `app.ts`. */
export const SIDEBAR_WIDTH_VARIABLE = '--sidebar-width'

export function clampSidebarWidth(px: number): number {
  // A non-finite width is not clamped to an edge — `NaN` means the caller has no
  // width at all, and the default is the honest answer.
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)))
}

/**
 * A stored width, or the default.
 *
 * Takes the raw `localStorage` string — including `null` for "nothing stored" —
 * so the one place that can produce a bad value is also the one place that
 * validates it. A value written by an older build outside today's range is
 * clamped rather than discarded.
 */
export function parseSidebarWidth(raw: string | null): number {
  if (raw === null) return SIDEBAR_WIDTH_DEFAULT
  return clampSidebarWidth(Number.parseFloat(raw))
}

/** The property's value, as CSS. Keeps the `px` suffix out of `app.ts`. */
export function sidebarWidthVariable(px: number): string {
  return `${clampSidebarWidth(px)}px`
}

/** One arrow press moves a resizer this far; Shift moves it four times as far. */
export const RESIZER_KEY_STEP = 16

/**
 * The width a key press on a column's drag handle asks for, or `undefined` for
 * a key the handle does not take.
 *
 * A focusable `separator` is a slider to a screen reader, so it answers the
 * slider's keys: the arrows step, Home and End go to the ends. `grows` is the
 * direction that widens the column — right for the rail, left for the side
 * panel, whose handle sits on its left edge. Up and Down follow the reading of
 * a value (up is more), whichever side the column is on.
 */
export function resizerKeyWidth(
  key: string,
  shift: boolean,
  current: number,
  range: { readonly min: number; readonly max: number; readonly grows: 'left' | 'right' },
): number | undefined {
  const step = shift ? RESIZER_KEY_STEP * 4 : RESIZER_KEY_STEP
  switch (key) {
    case 'ArrowRight': return current + (range.grows === 'right' ? step : -step)
    case 'ArrowLeft': return current + (range.grows === 'left' ? step : -step)
    case 'ArrowUp': return current + step
    case 'ArrowDown': return current - step
    case 'Home': return range.min
    case 'End': return range.max
    default: return undefined
  }
}
