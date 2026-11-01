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
  | 'square-pen'
  | 'square'
  | 'minus'
  | 'close'
  | 'trash'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'message-circle'
  | 'file-code'
  | 'file-image'
  | 'file-text'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'rotate-cw'
  | 'mouse-pointer'
  | 'maximize'
  | 'minimize'
  | 'dot'
  | 'check'
  | 'check-check'
  | 'clock'
  | 'spinner'
  | 'send'
  | 'stop'
  | 'gear'
  | 'sliders-horizontal'
  | 'palette'
  | 'cpu'
  | 'plug'
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
  // --- the title bar's side panel buttons ---
  | 'tasks'
  | 'diff'
  | 'globe'
  // --- the sidebar's 项目调度 row and the title bar's 线程 button ---
  | 'network'
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
  | 'info'
  // --- the full-access confirmation: the question's mark and its warning glyph ---
  | 'triangle-alert'
  | 'more'
  // --- the provider dialog's API key reveal ---
  | 'eye'
  | 'eye-off'
  // --- the transcript's compaction line ---
  | 'fold-vertical'
  // --- a skill's settings row and the 技能 card's 导入 button ---
  | 'package'

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
  // Lucide icons/info.svg, copied without changing its geometry.
  info: [RING, 'M12 16v-4', 'M12 8h.01'],
  plus: ['M5 12h14', 'M12 5v14'],
  square: [FRAME],
  'square-pen': [
    'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7',
    'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z',
  ],
  minus: ['M5 12h14'],
  // x
  close: ['M18 6 6 18', 'm6 6 12 12'],
  'check-check': ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
  trash: [
    'M10 11v6',
    'M14 11v6',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M3 6h18',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  ],
  // diamond
  agent: ['M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z'],
  'folder-open': ['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  file: [
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    'M14 2v5a1 1 0 0 0 1 1h5',
  ],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  // The 展开 row's pair: the same glyph turned over.
  'chevron-up': ['m18 15-6-6-6 6'],
  // A full arrow, not the chevron: the jump-to-bottom button is the only place
  // that means "go to the end", and a bare chevron there reads as "collapse".
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-left': ['m12 19-7-7 7-7', 'M19 12H5'],
  'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
  'rotate-cw': ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  maximize: ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'],
  minimize: ['m14 10 7-7', 'M20 10h-6V4', 'm3 21 7-7', 'M4 14h6v6'],
  'mouse-pointer': [
    'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z',
  ],
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
  gear: [
    'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915',
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  'sliders-horizontal': ['M10 5H3', 'M12 19H3', 'M14 3v4', 'M16 17v4', 'M21 12h-9', 'M21 19h-5', 'M21 5h-7', 'M8 10v4', 'M8 12H3'],
  palette: [
    'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z',
    ['circle', { cx: 13.5, cy: 6.5, r: .5, fill: 'currentColor' }],
    ['circle', { cx: 17.5, cy: 10.5, r: .5, fill: 'currentColor' }],
    ['circle', { cx: 6.5, cy: 12.5, r: .5, fill: 'currentColor' }],
    ['circle', { cx: 8.5, cy: 7.5, r: .5, fill: 'currentColor' }],
  ],
  cpu: [
    'M12 20v2', 'M12 2v2', 'M17 20v2', 'M17 2v2', 'M2 12h2', 'M2 17h2', 'M2 7h2', 'M20 12h2', 'M20 17h2', 'M20 7h2', 'M7 20v2', 'M7 2v2',
    ['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }],
    ['rect', { x: 8, y: 8, width: 8, height: 8, rx: 1 }],
  ],
  plug: ['M12 22v-5', 'M15 8V2', 'M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z', 'M9 8V2'],
  // git-branch
  branch: ['M15 6a9 9 0 0 0-9 9V3', ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }]],
  // external-link: the hand-off to another app.
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  // panel-left
  sidebar: [FRAME, 'M9 3v18'],
  // list-todo
  tasks: ['M13 5h8', 'M13 12h8', 'M13 19h8', 'm3 17 2 2 4-4', ['rect', { x: 3, y: 4, width: 6, height: 6, rx: 1 }]],
  // file-diff
  diff: ['M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', 'M9 10h6', 'M12 13V7', 'M9 17h6'],
  // globe
  globe: [RING, 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  // One node fanning out to two: a coordinator over its threads, unlike the folder of 打开项目….
  network: [
    ['rect', { x: 16, y: 16, width: 6, height: 6, rx: 1 }],
    ['rect', { x: 2, y: 16, width: 6, height: 6, rx: 1 }],
    ['rect', { x: 9, y: 2, width: 6, height: 6, rx: 1 }],
    'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3',
    'M12 12V8',
  ],
  // circle-question-mark
  // keyboard: the button opens the shortcut list.
  help: [
    ['rect', { width: 20, height: 16, x: 2, y: 4, rx: 2 }],
    'M6 8h.01', 'M10 8h.01', 'M14 8h.01', 'M18 8h.01', 'M8 12h.01', 'M12 12h.01', 'M16 12h.01', 'M7 16h10',
  ],
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
  'triangle-alert': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  // ellipsis
  more: [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }], ['circle', { cx: 5, cy: 12, r: 1 }]],
  eye: [
    'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  'eye-off': [
    'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
    'M14.084 14.158a3 3 0 0 1-4.242-4.242',
    'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
    'm2 2 20 20',
  ],
  'fold-vertical': ['M12 22v-6', 'M12 8V2', 'M4 12H2', 'M10 12H8', 'M16 12h-2', 'M22 12h-2', 'm15 19-3-3-3 3', 'm15 5-3 3-3-3'],
  // package: a skill is a folder of instructions, not a document.
  package: [
    'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z',
    'M12 22V12',
    'm3.3 7 8.7 5 8.7-5',
    'm7.5 4.27 9 5.15',
  ],
  'message-circle': ["M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"],
  'file-code': ["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "M14 2v5a1 1 0 0 0 1 1h5", "M10 12.5 8 15l2 2.5", "m14 12.5 2 2.5-2 2.5"],
  'file-image': ["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "M14 2v5a1 1 0 0 0 1 1h5", ["circle", {"cx": "10", "cy": "12", "r": "2"}], "m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"],
  'file-text': ["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "M14 2v5a1 1 0 0 0 1 1h5", "M10 9H8", "M16 13H8", "M16 17H8"],
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
