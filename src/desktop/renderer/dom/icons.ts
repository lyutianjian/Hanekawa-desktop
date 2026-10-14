/**
 * The renderer's icons, built as real SVG nodes.
 *
 * `dom.ts`'s `el()` calls `createElement`, which cannot make an `<svg>` — SVG
 * lives in its own namespace, and an element created in the HTML namespace with
 * the tag name "svg" renders as nothing at all. So this file is the one place
 * that reaches for `createElementNS`. `innerHTML` is not an option here for the
 * same reason it is not an option anywhere in this tree (see `dom.ts`), even
 * though these strings are ours: the ban is worth more than the exception.
 *
 * Why icons at all: 4e moves the chrome to a proportional system font, and the
 * glyphs this shell was drawing — a 🗑 emoji, the U+27E8/27E9 angle brackets —
 * are exactly the characters that font does not have. A colour-emoji trash can
 * that ignores `color` was the single most visible thing in the old sidebar.
 *
 * Every icon inherits `currentColor`, so an icon is coloured by the rule that
 * colours its button. That is what keeps `--accent-*` on `color` rather than on
 * a `fill` the style test would have to special-case.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

export type IconName =
  | 'plus'
  | 'minus'
  | 'close'
  | 'trash'
  | 'folder'
  | 'file'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-down'
  | 'arrow-left'
  | 'dot'
  | 'check'
  | 'clock'
  | 'spinner'
  | 'send'
  | 'stop'
  | 'gear'
  // --- the empty-state screen (5c) ---
  // The mark and the three guidance cards it sat over are gone: the screen's
  // identity is typographic now (see `model/welcome.ts`), so `thought-bubble`,
  // `megaphone`, `hammer` and `refresh` went with them. `monitor` followed when
  // the「本地」pill did. The branch pill draws this one, and so do its rows.
  | 'branch'
  // --- the canvas header (5e) ---
  | 'external'
  // --- the sidebar footer and the title bar (5g) ---
  | 'help'
  | 'sidebar'
  // --- the title bar's right rail (the browser panel) ---
  | 'panel-right'
  // --- the inline permission request ---
  | 'terminal'
  | 'shield'
  // --- a message's meta row ---
  | 'copy'
  | 'rewind'
  // --- the status line's token readout ---
  | 'database'
  // --- the composer's model chip, once the row is too narrow for its name ---
  | 'model'
  // --- the welcome page's mark ---
  | 'cat'
  // --- 概览: the canvas header button, the welcome's chip and the panel's empty state ---
  | 'overview'
  // --- a running sub-agent's capsule ---
  | 'agent'

interface IconSpec {
  /** Path data on a 16×16 grid. */
  readonly paths: readonly string[]
  /** Filled shapes (the dot, the stop square) rather than stroked outlines. */
  readonly filled?: boolean
}

/**
 * Keyed `satisfies`, the same drift guard `commandSchema.ts` and
 * `SHELL_COMMAND_SCHEMAS` use: adding a name to `IconName` without drawing it
 * fails the build *by name* rather than rendering an empty box.
 */
const ICONS = {
  plus: { paths: ['M8 3.5v9', 'M3.5 8h9'] },
  // The zoom control's other half, and the `plus` above with one stroke removed.
  minus: { paths: ['M3.5 8h9'] },
  // The image viewer's way out. A drawn ✕ rather than the glyph the composer's
  // small controls use: it sits on a scrim at the window's corner, where a text
  // character renders at the font's mercy instead of the icon grid's.
  close: { paths: ['M4 4l8 8', 'M12 4l-8 8'] },
  trash: {
    paths: [
      'M3 4.5h10',
      'M6.5 4.5V3h3v1.5',
      'M4.6 4.5l.5 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-8',
    ],
  },
  // An outlined diamond: the running sub-agent's capsule.
  agent: { paths: ['M8 2.8 13.2 8 8 13.2 2.8 8z'] },
  folder: { paths: ['M2 5a1.5 1.5 0 0 1 1.5-1.5h2.2L7 5h5.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z'] },
  // A sheet with a folded corner, for the inline file pills in a user message.
  file: {
    paths: [
      'M4 2.6h4.4L12 6.2v7.2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z',
      'M8.4 2.6v3.6H12',
    ],
  },
  'chevron-left': { paths: ['M10 3.5 5.5 8l4.5 4.5'] },
  'chevron-right': { paths: ['M6 3.5 10.5 8 6 12.5'] },
  'chevron-down': { paths: ['M3.5 6 8 10.5 12.5 6'] },
  // A full arrow, not the chevron: the jump-to-bottom button is the only place
  // that means "go to the end", and a bare chevron there reads as "collapse".
  'arrow-down': { paths: ['M8 3.2v9.6', 'M4 8.8 8 12.8l4-4'] },
  // The settings screen's way out. A full arrow for the same reason
  // `arrow-down` is one: `chevron-left` beside a label reads as "collapse this",
  // not as "go back".
  'arrow-left': { paths: ['M12.8 8H3.2', 'M7.2 4 3.2 8l4 4'] },
  dot: { paths: ['M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'], filled: true },
  // The chip menu's "this is the one in force" mark. A tick rather than the
  // `dot` the `#surface` rows use: there the mark sits in a fixed column before
  // the label, here it trails a flyout row the way a menu check does.
  check: { paths: ['M3.5 8.6 6.6 11.7 12.5 4.8'] },
  // A dial with two hands — the「最近」filter. A folder would say "project",
  // which is the one thing the global workspace is not.
  clock: { paths: ['M8 2.4a5.6 5.6 0 1 1 0 11.2A5.6 5.6 0 0 1 8 2.4z', 'M8 5.1V8l2.1 1.6'] },
  // A three-quarter ring with a gap, so a CSS rotation reads as spinning. Stroked
  // (not filled) so it inherits `currentColor` like every other outline.
  spinner: { paths: ['M8 3.5a4.5 4.5 0 1 1-4.5 4.5'] },
  send: { paths: ['M8 13V3.6', 'M3.8 7.8 8 3.5l4.2 4.3'] },
  // A ring around a small square, one path so the nonzero rule punches the
  // ring's hole: the outer circle runs clockwise, the inner one counter.
  stop: {
    paths: ['M8 1.25a6.75 6.75 0 1 1 0 13.5a6.75 6.75 0 1 1 0-13.5zM8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM5.9 5.9h4.2v4.2H5.9z'],
    filled: true,
  },
  // The settings mark: two sliders, outlined like every other icon here. It
  // replaced a polygon gear that read as heavy and jagged at 14px.
  gear: {
    paths: [
      'M2.5 4.5H8.5',
      'M11.5 4.5H13.5',
      'M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M2.5 11.5H4.5',
      'M7.5 11.5H13.5',
      'M6 10a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    ],
  },
  // --- the empty-state screen ---
  // One glyph now, on the branch pill and on every row of the switcher it opens.
  // The screen's mark and its three card icons were dropped with the cards
  // themselves — see `model/welcome.ts`.
  branch: {
    paths: [
      'M4.5 2.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M4.5 10.4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M11.5 2.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M4.5 5.6v4.8',
      'M11.5 5.6v1.4a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 0-2.5 2.5',
    ],
  },
  // A box with an arrow leaving it: "open this in another app". It replaced
  // `</>`, which beside 「打开位置」 read as "view the source" rather than as the
  // hand-off to VS Code the button is. Monochrome like every other icon here.
  external: { paths: ['M7 3.2H4.2a1 1 0 0 0-1 1v7.6a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V9', 'M9.4 3.2h3.4v3.4', 'M12.8 3.2 7.6 8.4'] },
  // A panel with its left column ruled off: the rail toggle. The same mark the
  // reference builds put in the same corner.
  sidebar: {
    paths: [
      'M2.6 4a1.4 1.4 0 0 1 1.4-1.4h8a1.4 1.4 0 0 1 1.4 1.4v8a1.4 1.4 0 0 1-1.4 1.4H4A1.4 1.4 0 0 1 2.6 12z',
      'M6.4 2.6v10.8',
    ],
  },
  // The same frame with the divider on the other side: the browser panel is the
  // sidebar's mirror image, and so is the control that opens it.
  'panel-right': {
    paths: [
      'M2.6 4a1.4 1.4 0 0 1 1.4-1.4h8a1.4 1.4 0 0 1 1.4 1.4v8a1.4 1.4 0 0 1-1.4 1.4H4A1.4 1.4 0 0 1 2.6 12z',
      'M9.6 2.6v10.8',
    ],
  },
  // A ringed question mark: the sidebar footer's shortcut panel. The ring is what
  // makes it read as a control at 14px, where a bare `?` reads as punctuation.
  help: {
    paths: [
      'M8 2.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z',
      'M6.4 6.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1v.3',
      'M8 11.4v.6',
    ],
  },
  // The inline request's leading glyph, chosen by what is being asked for: a
  // shell prompt in a window for a command, a shield for everything else. It
  // names the *kind* of thing the agent wants, the way the sidebar heading's
  // glyph names the kind of group — see `dom/permissionRequestView.ts`.
  terminal: {
    paths: [
      'M2.4 4.2a1.2 1.2 0 0 1 1.2-1.2h8.8a1.2 1.2 0 0 1 1.2 1.2v7.6a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z',
      'M5 6.6 6.9 8.3 5 10',
      'M8.6 10.2h2.6',
    ],
  },
  shield: {
    paths: [
      'M8 2.2 12.8 4v3.4c0 3-2 5.2-4.8 6.4C5.2 12.6 3.2 10.4 3.2 7.4V4z',
    ],
  },
  // Two offset sheets — the copy affordance every text surface draws. Its front
  // sheet is the `file` glyph's box without the folded corner, so the two read as
  // the same family at 14px.
  copy: {
    paths: [
      'M5.6 5.6a1 1 0 0 1 1-1h5.2a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1z',
      'M10.4 4.6V4.2a1 1 0 0 0-1-1H4.2a1 1 0 0 0-1 1v5.2a1 1 0 0 0 1 1h.4',
    ],
  },
  // A user message's 回退: a counter-clockwise arc, the way back to before it.
  rewind: { paths: ['M3.4 6.2A5 5 0 1 1 3 8.8', 'M3.2 3.2v3.2h3.2'] },
  // The token readout's one mark. It replaced a set of three — two arrows and a
  // stack, one per direction — when the line stopped naming directions and
  // started naming a total. A cylinder is the mark for "accumulated store",
  // which is what a session total is; an arrow would still be claiming a
  // direction the figure beside it no longer has.
  //
  // One band rather than two: at 11px a second one closes the gaps into a smudge.
  database: {
    paths: [
      'M3.4 4c0-1 2-1.8 4.6-1.8s4.6.8 4.6 1.8-2 1.8-4.6 1.8S3.4 5 3.4 4z',
      'M3.4 4v8c0 1 2 1.8 4.6 1.8s4.6-.8 4.6-1.8V4',
      'M12.6 8c0 1-2 1.8-4.6 1.8S3.4 9 3.4 8',
    ],
  },
  // The model chip's stand-in for its own name, for the widths where the name
  // would render as half a glyph. A four-point spark — the mark this interface
  // already reads as "the model", and the one shape in the row that is not a
  // control's own affordance.
  model: { paths: ['M8 2.4 9.5 6.5 13.6 8 9.5 9.5 8 13.6 6.5 9.5 2.4 8 6.5 6.5Z'] },
  cat: { paths: ['M2.25 12.05V3.95l3.1 2.6c1.73-.72 3.6-.72 5.3 0l3.1-2.6v8.1', 'M1.2 12.05h13.6', 'M6.05 9.25h.01', 'M9.95 9.25h.01'] },
  overview: { paths: ['M3 4.5h.01', 'M3 8h.01', 'M3 11.5h.01', 'M6 4.5h7', 'M6 8h7', 'M6 11.5h7'] },
} as const satisfies Record<IconName, IconSpec>

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const spec: IconSpec = ICONS[name]
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  // Decorative by default: every caller sits inside a button that already
  // carries an `aria-label`, and a second name would be read out twice.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  for (const data of spec.paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', data)
    if (spec.filled) {
      path.setAttribute('fill', 'currentColor')
    } else {
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
    }
    // `append()` in `dom.ts` is typed for an HTMLElement parent; an SVG element
    // is not one, so this file does its own appending.
    svg.appendChild(path)
  }
  return svg
}
