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
 *
 * The shapes are Lucide's (https://lucide.dev), ISC License,
 * Copyright (c) 2026 Lucide Icons and Contributors.
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
  // --- a thread row's status mark and its menu trigger ---
  | 'circle'
  | 'check-circle'
  // --- a task card row's running and paused marks ---
  | 'progress-ring'
  | 'circle-ellipsis'
  | 'x-circle'
  | 'alert-circle'
  | 'more'

type ShapeTag = 'path' | 'circle' | 'rect' | 'ellipse' | 'line'

/** A bare string is a `<path>`'s data; anything else is one Lucide primitive. */
type Shape = string | readonly [ShapeTag, Readonly<Record<string, string | number>>]

/** 24×24 shapes, Lucide's copied as drawn so they stay comparable to the source. */
type IconSpec = readonly Shape[]

/** The status dot: Lucide's `circle-small`, filled. */
const DOT: Shape = ['circle', { cx: 12, cy: 12, r: 6, fill: 'currentColor', stroke: 'none' }]
const RING: Shape = ['circle', { cx: 12, cy: 12, r: 10 }]
const FRAME: Shape = ['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }]

/**
 * Keyed `satisfies`, the same drift guard `commandSchema.ts` and
 * `SHELL_COMMAND_SCHEMAS` use: adding a name to `IconName` without drawing it
 * fails the build *by name* rather than rendering an empty box. Each entry is
 * named after the Lucide icon it copies.
 */
const ICONS = {
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  // x
  close: ['M18 6 6 18', 'm6 6 12 12'],
  trash: [
    'M10 11v6',
    'M14 11v6',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M3 6h18',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  ],
  // diamond
  agent: ['M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  file: [
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    'M14 2v5a1 1 0 0 0 1 1h5',
  ],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  // A full arrow, not the chevron: the jump-to-bottom button is the only place
  // that means "go to the end", and a bare chevron there reads as "collapse".
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-left': ['m12 19-7-7 7-7', 'M19 12H5'],
  dot: [DOT],
  check: ['M20 6 9 17l-5-5'],
  // The「最近」filter. A folder would say "project", which is the one thing the
  // global workspace is not.
  clock: [RING, 'M12 6v6l4 2'],
  // loader-circle: an open ring, so a CSS rotation reads as spinning.
  spinner: ['M21 12a9 9 0 1 1-6.219-8.56'],
  // arrow-up
  send: ['m5 12 7-7 7 7', 'M12 19V5'],
  // circle-stop, its square filled so it reads at a glance mid-turn.
  stop: [RING, ['rect', { x: 9, y: 9, width: 6, height: 6, rx: 1, fill: 'currentColor' }]],
  // settings-2: two sliders rather than a cog, which reads as heavy at 14px.
  gear: ['M14 17H5', 'M19 7h-9', ['circle', { cx: 17, cy: 17, r: 3 }], ['circle', { cx: 7, cy: 7, r: 3 }]],
  // git-branch
  branch: ['M15 6a9 9 0 0 0-9 9V3', ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }]],
  // external-link: the hand-off to another app.
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  // panel-left / panel-right: the browser panel is the sidebar's mirror image,
  // and so is the control that opens it.
  sidebar: [FRAME, 'M9 3v18'],
  'panel-right': [FRAME, 'M15 3v18'],
  // circle-question-mark
  help: [RING, 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  // The inline request's leading glyph, chosen by what is being asked for: a
  // shell prompt for a command, a shield for everything else — see
  // `dom/permissionRequestView.ts`. square-terminal and shield.
  terminal: ['m7 11 2-2-2-2', 'M11 13h4', FRAME],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'],
  copy: [['rect', { width: 14, height: 14, x: 8, y: 8, rx: 2 }], 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  // rotate-ccw: a user message's 回退, the way back to before it.
  rewind: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  // The token readout's mark: a store, for a figure that is a session total.
  database: [['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }], 'M3 5V19A9 3 0 0 0 21 19V5', 'M3 12A9 3 0 0 0 21 12'],
  // sparkle: the model chip's stand-in for its own name on narrow rows.
  model: ['M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z'],
  // Hanekawa's own mark rather than Lucide's: the original 16-grid drawing at
  // 1.5×, with the 1.5 stroke it was drawn for.
  cat: [
    'M3.375 18.075V5.925l4.65 3.9c2.595-1.08 5.4-1.08 7.95 0l4.65-3.9v12.15',
    'M1.8 18.075h20.4',
    'M9.075 13.875h.015',
    'M14.925 13.875h.015',
  ].map((d) => ['path', { d, 'stroke-width': 2.25 }] as const),
  // list
  overview: ['M3 5h.01', 'M3 12h.01', 'M3 19h.01', 'M8 5h13', 'M8 12h13', 'M8 19h13'],
  // A thread's state at a glance: an empty ring idles, a ticked one is done, a
  // crossed one failed, a marked one waits. One ring so the four read as a set.
  circle: [RING],
  'check-circle': [RING, 'm16 9-5.5 5.5L8 12'],
  // A faint track with a quarter arc on it; the stylesheet colours the two apart.
  'progress-ring': [RING, 'M12 2a10 10 0 0 1 10 10'],
  'circle-ellipsis': [RING, 'M17 12h.01', 'M12 12h.01', 'M7 12h.01'],
  'x-circle': [RING, 'm15 9-6 6', 'm9 9 6 6'],
  'alert-circle': [RING, ['line', { x1: 12, x2: 12, y1: 8, y2: 12 }], ['line', { x1: 12, x2: 12.01, y1: 16, y2: 16 }]],
  // ellipsis
  more: [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }], ['circle', { cx: 5, cy: 12, r: 1 }]],
} as const satisfies Record<IconName, IconSpec>

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const spec: IconSpec = ICONS[name]
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '24')
  svg.setAttribute('height', '24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  // Decorative by default: every caller sits inside a button that already
  // carries an `aria-label`, and a second name would be read out twice.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  for (const shape of spec) {
    const [tag, attrs] = typeof shape === 'string' ? ['path', { d: shape }] : shape
    const node = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    // `append()` in `dom.ts` is typed for an HTMLElement parent; an SVG element
    // is not one, so this file does its own appending.
    svg.appendChild(node)
  }
  return svg
}
