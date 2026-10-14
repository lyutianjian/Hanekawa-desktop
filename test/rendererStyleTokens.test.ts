import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { parseCss, rendererRoot, stylesheetPath, type Block } from './helpers/rendererCss.js'
import { SIDEBAR_COLLAPSE_FALLBACK_MS } from '../src/desktop/renderer/model/sidebar.js'
import { SIDEBAR_WIDTH_DEFAULT } from '../src/desktop/renderer/model/sidebarWidth.js'
import { MARQUEE_GAP } from '../src/desktop/renderer/model/marquee.js'
import { PRESENCE_FALLBACK_MS, type PresenceKind } from '../src/desktop/renderer/model/presence.js'
import { TASK_LOCATE_FALLBACK_MS } from '../src/desktop/renderer/model/tasks.js'

/**
 * The renderer's stylesheet, asserted at source level.
 *
 * Same reasoning as `test/tuiTheme.test.ts`: a view asks for a *name*, never for
 * a colour, so the two shells can be re-skinned independently. The TUI can be
 * checked by importing its frozen `theme` object; CSS has no such handle, so
 * this file parses the sheet instead — through `helpers/rendererCss.ts`, shared
 * with the settings view's clipping assertion so there is one notion of "a rule".
 *
 * CSS is worth this trouble because it fails **silently**. A typo'd
 * `var(--text-primry)` is not an error anywhere — the property just inherits,
 * and the only report is that something looks slightly wrong on a screen nobody
 * is looking at. Neither typecheck pass opens this file and no bundler validates
 * it.
 */

const MOTION_TOKENS = {
  "--motion-press": "0ms",
  "--motion-release": "300ms",
  "--motion-micro": "60ms",
  "--motion-popover-in": "200ms",
  "--motion-popover-out": "120ms",
  "--motion-disclosure": "200ms",
  "--motion-layout": "280ms",
  "--motion-panel-in": "300ms",
  "--motion-text-in": "300ms",
  "--motion-panel-out": "200ms",
  "--motion-scrim-in": "200ms",
  "--motion-scrim-out": "120ms",
  "--motion-running": "2000ms",
  "--motion-locate": "600ms",
  "--motion-hover-delay": "500ms"
}

const htmlPath = path.join(rendererRoot, 'index.html')

/**
 * Inline style properties the renderer is allowed to set from TypeScript.
 *
 * A closed set rather than a list of forbidden ones: the point is that painting
 * belongs in the stylesheet, and every exception should be a decision on the
 * record. `height` is here because the composer's autosize measures
 * `scrollHeight` and clamps it — a number no stylesheet can know.
 */
const ALLOWED_INLINE_STYLE_PROPS = ['height']

/**
 * Identifiers a `setProperty` call may name instead of a `'--literal'`.
 *
 * The scan below cannot follow an import to see what a constant holds, so the
 * few that carry a custom-property name are listed here — one line per
 * exception, which is the point: a `setProperty(SOME_CONST, …)` that is *not*
 * on this list fails, and adding it is a decision on the record.
 */
const ALLOWED_STYLE_PROPERTY_CONSTANTS = [
  'SIDEBAR_WIDTH_VARIABLE',
  'SIDE_WIDTH_VARIABLES',
  // Native window controls are measured by Chromium, including zoom/fullscreen.
  'TITLEBAR_LEFT_INSET_VARIABLE',
  'TITLEBAR_RIGHT_INSET_VARIABLE',
  // The hover marquee's distance and duration: measured per row, so no token can
  // hold them. `model/marquee.ts` owns both names.
  'MARQUEE_SHIFT_VARIABLE',
  'MARQUEE_DURATION_VARIABLE',
  // The context indicator's ring sweep, a fraction recomputed per snapshot. Same
  // exception for the same reason: no token can hold a measured value.
  // `model/usage.ts` owns the name.
  'CONTEXT_RATIO_VARIABLE',
  // The blank under the conversation, measured per paint against the viewport so
  // the newest question can be lifted to the top of it.
  // `model/transcriptAnchor.ts` owns the name.
  'TRANSCRIPT_PAD_VARIABLE',
  // The fullscreen image viewer's geometry: zoom measured against the viewport,
  // pan measured against the pointer. Same exception for the same reason — no
  // token can hold a measured value. `model/imageViewer.ts` owns the names.
  'VIEWER_ZOOM_VARIABLE',
  'VIEWER_PAN_X_VARIABLE',
  'VIEWER_PAN_Y_VARIABLE',
]

function rendererFiles(dir = rendererRoot): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return rendererFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** Comments may legitimately name a colour; code may not. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const css = readFileSync(stylesheetPath, 'utf8')
const html = readFileSync(htmlPath, 'utf8')
const blocks = parseCss(css)
const declarations = blocks.flatMap((block) => block.decls)

/**
 * The two token blocks. Dark is the bare `:root` (the primary palette); light
 * overrides a subset under an attribute selector. `app.ts` resolves the
 * preference and writes `[data-theme]`, so there is no `@media` — the parser
 * stays flat and the nested-at-rule prohibition below still holds.
 */
const LIGHT_SELECTOR = ':root[data-theme="light"]'
const TOKEN_SELECTORS = new Set([':root', LIGHT_SELECTOR])

function tokensForSelector(selector: string): Map<string, string> {
  return new Map(
    declarations.filter((d) => d.selector === selector && d.prop.startsWith('--')).map((d) => [d.prop, d.value]),
  )
}

const tokens = tokensForSelector(':root') // the dark palette
const lightOverrides = tokensForSelector(LIGHT_SELECTOR)
/** The effective light palette: dark defaults with the light block layered on. */
const lightTokens = new Map([...tokens, ...lightOverrides])

/** Both themes, with the direction their foreground brightness runs (see the ladder test). */
const THEMES = [
  { name: 'dark', tokens, sign: 1 },
  { name: 'light', tokens: lightTokens, sign: -1 },
] as const

const COLOUR_LITERAL = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(/

test('the stylesheet parses exactly, so nothing below can pass vacuously', () => {
  // The failure this guards against is a parser that silently returns nothing:
  // every loop in this file iterates what it produced, so an empty result makes
  // the whole suite green. Same device as `rendererImports.test.ts`'s
  // "the renderer has files to check".
  assert.ok(blocks.length >= 100, `expected the renderer stylesheet, parsed ${blocks.length} blocks`)
  assert.ok(declarations.length >= 300, `parsed only ${declarations.length} declarations`)
  assert.ok(tokens.size >= 15, `expected the token block, found ${tokens.size} custom properties`)

  // Conditional rules are parsed, not flattened: each one's prelude rides on the
  // block (see `helpers/rendererCss.ts`), which is what keeps `blockFor` on the
  // unconditional rule. The list is pinned so a new condition is a decision
  // someone takes here rather than a rule that quietly stops applying.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const atRules = [...withoutComments.matchAll(/@(?:media|supports|container|layer|scope)\b[^;{]*\{/g)]
  assert.deepEqual(
    atRules.map((match) => match[0].replace(/\s+/g, ' ').trim()),
    [
      '@container composer-bar (inline-size < 320px) {',
      '@media (prefers-reduced-motion: reduce) {',
    ],
    'a conditional rule belongs in this list',
  )

  const files = rendererFiles()
  assert.ok(files.length >= 10, `expected the renderer tree, found ${files.length} files`)
  assert.ok(files.some((file) => file.endsWith('app.ts')))

  // The light theme is a second token block, not an at-rule. If it stops parsing
  // (or someone reintroduces it as `@media`), the per-theme assertions below would
  // quietly run against an empty override map.
  assert.ok(
    blocks.some((block) => block.selector === LIGHT_SELECTOR),
    `expected a ${LIGHT_SELECTOR} block; the light palette is missing or nested`,
  )
  assert.ok(lightOverrides.size >= 18, `parsed only ${lightOverrides.size} light overrides`)
})

test('the page links the stylesheet and carries no CSS of its own', () => {
  // Extracting the sheet is only worth anything if the page cannot grow a second
  // copy. `<style>` and `style="` are the two ways it would.
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/?>/)
  assert.doesNotMatch(html, /<style[\s>]/, 'CSS belongs in styles.css')
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attribute; add a rule instead')
})

test('title bar uses measured native insets and keeps entire menus clickable', () => {
  const bar = blocks.find((block) => block.selector === '#titlebar')
  assert.ok(bar)
  assert.ok(bar.decls.some((decl) => decl.prop === 'height' && decl.value === '40px'))
  assert.ok(bar.decls.some((decl) => decl.prop === '-webkit-app-region' && decl.value === 'drag'))
  const padding = bar.decls.find((decl) => decl.prop === 'padding')?.value ?? ''
  assert.match(padding, /var\(--titlebar-inset-left\)/)
  assert.match(padding, /var\(--titlebar-inset-right\)/)
  for (const selector of ['#titlebar button', '.titlebar-menu-shell', '.titlebar-menu']) {
    assert.ok(blocks.some((block) => block.selector.split(',').map((part) => part.trim()).includes(selector)
      && block.decls.some((decl) => decl.prop === '-webkit-app-region' && decl.value === 'no-drag')),
    `${selector} must receive pointer events, including the menu's empty padding`)
  }
})

test('every token is used and every use is declared', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]!))

  for (const name of tokens.keys()) {
    assert.ok(used.has(name), `${name} is declared but nothing uses it`)
  }

  // The direction CSS itself will never report. A misspelled custom property
  // resolves to nothing and the declaration is simply dropped.
  for (const name of used) {
    assert.ok(tokens.has(name), `var(${name}) has no declaration in :root`)
  }
})

test('colours live in the token block, not in the rules', () => {
  for (const { selector, prop, value } of declarations) {
    if (TOKEN_SELECTORS.has(selector)) continue
    assert.doesNotMatch(
      value,
      COLOUR_LITERAL,
      `${selector} { ${prop}: ${value} } hard-codes a colour; add a token instead`,
    )
  }
})

test('no renderer view paints from TypeScript', () => {
  // Painting is the stylesheet's job. A view that reaches for `.style.color`
  // is a colour no token can re-skin and no assertion above can see.
  for (const file of rendererFiles()) {
    const shown = path.relative(rendererRoot, file)
    const code = stripComments(readFileSync(file, 'utf8'))

    assert.doesNotMatch(code, COLOUR_LITERAL, `${shown} contains a colour literal`)
    assert.doesNotMatch(
      code,
      /setAttribute\(\s*['"]style['"]/,
      `${shown} sets a style attribute; add a class and a rule`,
    )

    // `setProperty` is not an inline property assignment; it has its own rule
    // below, and matching it here would report it as `.style.setProperty`.
    for (const match of code.matchAll(/\.style\.(?!setProperty\b)([A-Za-z]+)/g)) {
      const prop = match[1]!
      assert.ok(
        ALLOWED_INLINE_STYLE_PROPS.includes(prop),
        `${shown} sets .style.${prop} inline; only ${ALLOWED_INLINE_STYLE_PROPS.join(', ')} are allowed`,
      )
    }

    // `setProperty` is the other door into the style attribute, and the scan
    // above cannot see through it. Only custom properties may go this way: a
    // property the stylesheet *declares* is one it still owns — every rule that
    // reads it, and its fallback, stay in the sheet where the tests can see them.
    for (const match of code.matchAll(/setProperty\(\s*([A-Za-z_$][\w$]*|['"][^'"]*['"])/g)) {
      const argument = match[1]!
      const named = /^['"]/.test(argument) ? argument.slice(1, -1) : undefined
      assert.ok(
        named === undefined
          ? ALLOWED_STYLE_PROPERTY_CONSTANTS.includes(argument)
          : named.startsWith('--'),
        `${shown} sets ${argument} through setProperty; only custom properties may be written from TypeScript`,
      )
    }
  }
})

// --- the palette ------------------------------------------------------------

function parseHex(value: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(value)
  assert.ok(match, `unsupported colour format: ${value}`)
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  ]
}

/** How far a colour is from grey. Zero for any `#xyxyxy`. */
function saturation(value: string): number {
  const channels = parseHex(value)
  return Math.max(...channels) - Math.min(...channels)
}

function luminance(value: string): number {
  const [red, green, blue] = parseHex(value)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/**
 * WCAG relative luminance — the gamma-corrected one, not the ordering helper
 * above. Contrast is a threshold business: without the sRGB transfer curve the
 * light theme's 5.6:1 pair measures as 2.5:1, and the assertion below would be
 * pinning the wrong physics while still looking rigorous.
 */
function relativeLuminance(value: string): number {
  const channels = parseHex(value).map((channel) => {
    const scaled = channel / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

/** WCAG contrast ratio — `(L1 + 0.05) / (L2 + 0.05)`, lighter rung over darker. */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  )
  return (lighter + 0.05) / (darker + 0.05)
}

function tokenValue(name: string, from: Map<string, string> = tokens): string {
  const value = from.get(name)
  assert.ok(value, `${name} is not declared`)
  return value
}

test('the palette is the one that was agreed, value for value', () => {
  // Pinned the way `test/tuiTheme.test.ts` pins the terminal palette: the point
  // of a token is that it is a decision, and a decision that can be edited
  // without anything noticing is a preference. The 2026 redesign's values
  // (design_guidance.md 二.2/二.3): one warm-neutral ladder, a two-rung clay
  // brand, no wash. `--link` and `--focus-ring` are pinned as the aliases they
  // now are — links are brand-coloured *text* (the strong rung), the focus ring
  // is the brand at hairline weight — so these pins are the equality itself,
  // and the tokens they resolve to carry the hexes.
  assert.deepEqual(
    Object.fromEntries([...tokens].filter(([name]) => !name.startsWith('--diff-'))),
    {
      '--surface-base': '#242424',
      '--surface-canvas': '#1c1c1c',
      '--surface-card': '#262626',
      '--surface-hover': '#2e2e2d',
      '--surface-active': '#393938',
      '--surface-knob': '#ffffff',
      '--surface-scrim': 'rgba(0, 0, 0, 0.55)',
      // The image viewer's own dim: a viewer asks nothing, so nothing behind it
      // needs to stay readable. See `#lightbox.modal-layer::before`.
      '--surface-scrim-strong': 'rgba(0, 0, 0, 0.88)',
      '--text-primary': '#ebebea',
      '--text-secondary': '#a6a6a5',
      '--text-tertiary': '#858584',
      '--link': 'var(--accent-brand-strong)',
      '--accent-brand': '#d4806a',
      '--accent-brand-strong': '#d4806a',
      '--on-brand': '#1c1c1c',
      '--accent-info': '#6fa5dc',
      '--accent-tool': '#a690d8',
      '--accent-review': '#8dbd6a',
      '--accent-warn': '#d5ad4c',
      '--accent-danger': '#e5707f',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#2f2f2e',
      '--border-strong': '#414140',
      '--focus-ring': 'var(--accent-brand)',
      '--shadow-float': '0 6px 20px rgba(0, 0, 0, 0.45)',
      '--shadow-modal': '0 16px 48px rgba(0, 0, 0, 0.6)',
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '24px',
      '--space-6': '32px',
      '--space-7': '48px',
      '--radius-lg': '20px',
      '--radius-bubble': '13px',
      '--radius-md': '12px',
      '--radius-sm': '8px',
      '--radius-pill': '9999px',
      ...MOTION_TOKENS,
    '--presence-x': '0px',
    '--presence-y': '8px',
    '--presence-scale': '0.985',
      '--ease-out': 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      '--ease-snap': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--ease-overshoot': 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      '--spring': 'linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1)',
      '--ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
      '--reading-measure': '760px',
      '--reading-gutter': 'clamp(16px, 4cqi, 40px)',
      '--composer-overhang': '16px',
      // The rail's resting width. A layout number, not a colour: `app.ts`
      // re-declares it on the document element when the handle is dragged, and
      // this declaration is the fallback every fresh profile resolves.
      '--sidebar-width': '256px',
      // The browser panel's resting width, the same kind of exception as the
      // rail's above: a layout number `app.ts` re-declares on the document
      // element when the handle between the canvas and the panel is dragged.
      '--browser-panel-width': 'clamp(240px, (100vw - var(--sidebar-width)) / 2, 900px)',
      '--overview-panel-width': '320px',
      '--titlebar-inset-left': '0px',
      '--titlebar-inset-right': '138px',
      // The sidebar seam, and the 7px slice its scrollbar overhangs (2px of air
      // plus the 1px sash line).
      '--sidebar-gutter': '10px',
      '--sidebar-scrollbar-overhang': 'calc(var(--sidebar-gutter) - 3px)',
      // The task panel's progress, same shape of exception: a number the view
      // writes and the sheet's own rule reads.
      '--task-progress': '0',
      // The sidebar marquee's distance and duration, third of the same kind:
      // per-row numbers written by `dom/sidebarView.ts` from `model/marquee.ts`,
      // declared here so an un-hovered row resolves to a still animation.
      '--marquee-shift': '0px',
      '--marquee-duration': '0s',
      '--marquee-gap': '48px',
      '--mark-size': '20px',
      '--mark-sheet': 'none',
      '--mark-frames': '1',
      '--mark-frame': '0',
      // The context indicator's ring, fourth of the same kind: a fraction of
      // the usable window written per paint by `dom/composerView.ts`.
      '--context-ratio': '0',
      // The transcript's bottom pad, fifth of the same kind: the room the newest
      // question needs to be liftable to the top of the viewport, measured per
      // paint by `dom/transcriptView.ts` from `model/transcriptAnchor.ts`.
      '--transcript-pad': '0px',
      // The fullscreen image viewer's geometry, sixth of the same kind: zoom
      // measured against the stage and pan against the pointer, written per
      // paint by `dom/imageViewerView.ts` from `model/imageViewer.ts`.
      '--viewer-zoom': '1',
      '--viewer-pan-x': '0px',
      '--viewer-pan-y': '0px',
      '--font-ui':
        '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif',
      '--font-mono':
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace',
      '--font-serif':
        '"Source Serif 4 Variable", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
      '--type-display': '28px',
      '--type-title': '20px',
      '--type-body': '15px',
      '--type-reading': '14px',
      '--type-ui': '14px',
      '--type-meta': '12.5px',
      '--type-micro': '11px',
      '--type-code': '13px',
    },
  )

  // The light palette, pinned the same way. It is the dark palette with the light
  // block layered on: the aliases (`--text-*`, `--link`, `--focus-ring` — they
  // follow the overridden accents), `--surface-knob`, the space/shape/type
  // scales, motion and fonts are theme-independent and carry through from
  // `:root`. The scrim and both
  // shadows no longer are: light dims with a warm cast and shadows with the
  // paper's own pigment (design_guidance.md 二.2).
  assert.deepEqual(
    Object.fromEntries([...lightTokens].filter(([name]) => !name.startsWith('--diff-'))),
    {
      '--surface-base': '#f3f3f2',
      '--surface-canvas': '#fdfdfd',
      '--surface-card': '#f8f8f7',
      '--surface-hover': '#eeeeed',
      '--surface-active': '#e6e6e5',
      // Carried through from `:root`, deliberately: the knob sits on the
      // accent track in both themes, so it is white in both.
      '--surface-knob': '#ffffff',
      '--surface-scrim': 'rgba(26, 26, 26, 0.3)',
      '--surface-scrim-strong': 'rgba(26, 26, 26, 0.92)',
      '--text-primary': '#1a1a1a',
      '--text-secondary': '#575756',
      '--text-tertiary': '#777776',
      '--link': 'var(--accent-brand-strong)',
      '--accent-brand': '#c2603f',
      '--accent-brand-strong': '#a44d30',
      '--on-brand': '#ffffff',
      '--accent-info': '#33689f',
      '--accent-tool': '#6e4fa3',
      '--accent-review': '#44752a',
      '--accent-warn': '#8a6604',
      '--accent-danger': '#b02e46',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#e5e5e4',
      '--border-strong': '#d3d3d2',
      '--focus-ring': 'var(--accent-brand)',
      '--shadow-float': '0 6px 20px rgba(26, 26, 26, 0.08), 0 1px 2px rgba(26, 26, 26, 0.06)',
      '--shadow-modal': '0 16px 48px rgba(26, 26, 26, 0.16)',
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '24px',
      '--space-6': '32px',
      '--space-7': '48px',
      '--radius-lg': '20px',
      '--radius-bubble': '13px',
      '--radius-md': '12px',
      '--radius-sm': '8px',
      '--radius-pill': '9999px',
      ...MOTION_TOKENS,
    '--presence-x': '0px',
    '--presence-y': '8px',
    '--presence-scale': '0.985',
      '--ease-out': 'cubic-bezier(0.165, 0.84, 0.44, 1)',
      '--ease-snap': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--ease-overshoot': 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      '--spring': 'linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1)',
      '--ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
      '--reading-measure': '760px',
      '--reading-gutter': 'clamp(16px, 4cqi, 40px)',
      '--composer-overhang': '16px',
      // The rail's resting width. A layout number, not a colour: `app.ts`
      // re-declares it on the document element when the handle is dragged, and
      // this declaration is the fallback every fresh profile resolves.
      '--sidebar-width': '256px',
      // The browser panel's resting width, the same kind of exception as the
      // rail's above: a layout number `app.ts` re-declares on the document
      // element when the handle between the canvas and the panel is dragged.
      '--browser-panel-width': 'clamp(240px, (100vw - var(--sidebar-width)) / 2, 900px)',
      '--overview-panel-width': '320px',
      '--titlebar-inset-left': '0px',
      '--titlebar-inset-right': '138px',
      // The sidebar seam, and the 7px slice its scrollbar overhangs (2px of air
      // plus the 1px sash line).
      '--sidebar-gutter': '10px',
      '--sidebar-scrollbar-overhang': 'calc(var(--sidebar-gutter) - 3px)',
      // The task panel's progress, same shape of exception: a number the view
      // writes and the sheet's own rule reads.
      '--task-progress': '0',
      // The sidebar marquee's distance and duration, third of the same kind:
      // per-row numbers written by `dom/sidebarView.ts` from `model/marquee.ts`,
      // declared here so an un-hovered row resolves to a still animation.
      '--marquee-shift': '0px',
      '--marquee-duration': '0s',
      '--marquee-gap': '48px',
      '--mark-size': '20px',
      '--mark-sheet': 'none',
      '--mark-frames': '1',
      '--mark-frame': '0',
      // The context indicator's ring, fourth of the same kind: a fraction of
      // the usable window written per paint by `dom/composerView.ts`.
      '--context-ratio': '0',
      // The transcript's bottom pad, fifth of the same kind: the room the newest
      // question needs to be liftable to the top of the viewport, measured per
      // paint by `dom/transcriptView.ts` from `model/transcriptAnchor.ts`.
      '--transcript-pad': '0px',
      // The fullscreen image viewer's geometry, sixth of the same kind: zoom
      // measured against the stage and pan against the pointer, written per
      // paint by `dom/imageViewerView.ts` from `model/imageViewer.ts`.
      '--viewer-zoom': '1',
      '--viewer-pan-x': '0px',
      '--viewer-pan-y': '0px',
      '--font-ui':
        '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif',
      '--font-mono':
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace',
      '--font-serif':
        '"Source Serif 4 Variable", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
      '--type-display': '28px',
      '--type-title': '20px',
      '--type-body': '15px',
      '--type-reading': '14px',
      '--type-ui': '14px',
      '--type-meta': '12.5px',
      '--type-micro': '11px',
      '--type-code': '13px',
    },
  )
})

test('the light block overrides only colours, and adds no token the dark palette lacks', () => {
  // Every override must shadow a real dark token — a light-only token would be a
  // colour the dark theme silently drops to nothing. And the theme-independent
  // tokens (the knob, space, shape, type, motion, and the aliases that follow
  // their accent)
  // must NOT be redeclared, or the two themes could drift on something that is
  // not a colour. The scrim and both shadows are theme-*dependent* under the
  // redesign, so they are absent from this list on purpose.
  for (const name of lightOverrides.keys()) {
    assert.ok(tokens.has(name), `${LIGHT_SELECTOR} declares ${name}, which has no dark default`)
  }
  const THEME_INDEPENDENT = [
    '--surface-knob',
    '--text-danger',
    '--text-warn',
    '--text-success',
    '--link',
    '--focus-ring',
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-5',
    '--space-6',
    '--space-7',
    '--radius-lg',
    '--radius-bubble',
    '--radius-md',
    '--radius-sm',
    '--radius-pill',
    ...Object.keys(MOTION_TOKENS),
    '--ease-out',
    '--ease-snap',
    '--ease-overshoot',
    '--spring',
    '--ease-exit',
    '--font-ui',
    '--font-mono',
    '--font-serif',
    '--type-display',
    '--type-title',
    '--type-body',
    '--type-reading',
    '--type-ui',
    '--type-meta',
    '--type-micro',
    '--type-code',
  ]
  for (const name of THEME_INDEPENDENT) {
    assert.ok(
      !lightOverrides.has(name),
      `${name} is theme-independent; the light block must not redeclare it`,
    )
  }
})

test('the surface ladder climbs and the text ladder descends, in both themes', () => {
  // The half that carries meaning rather than values. `design_guidance.md` asks
  // for depth built from canvas → card → active. The `sign` captures that light
  // inverts it: dark reads brightest-forward, light darkest-forward.
  //
  // `--surface-base` is asserted separately because it is not the bottom of that
  // ladder — it is a rung *on* it, between the canvas and hover. The canvas is
  // the extreme of the theme (deepest in dark, pure white in light) and the
  // window frame steps one rung away from it, so in dark the frame is lighter
  // than the canvas and in light it is darker. Naming it "darkest first" was
  // what made that read as a contradiction; it is one rule under `sign`.
  for (const { name, tokens: palette, sign } of THEMES) {
    const base = luminance(tokenValue('--surface-base', palette))
    assert.ok(
      sign * (base - luminance(tokenValue('--surface-canvas', palette))) > 0,
      `${name}: the window frame must step off the canvas, away from it`,
    )
    assert.ok(
      sign * (luminance(tokenValue('--surface-hover', palette)) - base) > 0,
      `${name}: the frame must stay below hover, or a hovered row vanishes into it`,
    )

    const surfaces = ['--surface-canvas', '--surface-card', '--surface-hover', '--surface-active']
    for (let index = 1; index < surfaces.length; index += 1) {
      const below = surfaces[index - 1]!
      const above = surfaces[index]!
      assert.ok(
        sign * (luminance(tokenValue(above, palette)) - luminance(tokenValue(below, palette))) > 0,
        `${name}: ${above} must step past ${below} in the surface ladder`,
      )
    }

    const texts = ['--text-primary', '--text-secondary', '--text-tertiary']
    for (let index = 1; index < texts.length; index += 1) {
      const stronger = texts[index - 1]!
      const weaker = texts[index]!
      assert.ok(
        sign * (luminance(tokenValue(weaker, palette)) - luminance(tokenValue(stronger, palette))) < 0,
        `${name}: ${weaker} must read fainter than ${stronger}`,
      )
    }
  }
})

test('the brand rungs clear the contrast they are pinned to, in both themes', () => {
  // design_guidance 二.2's promise, made executable. The brand is two tokens
  // precisely because the clay itself is ~3.9:1 on the paper — enough for a
  // glyph, a hairline or an indicator bar, never for text. The *strong* rung is
  // the one cleared for text (links are it: `--link` aliases it) and for fills,
  // and `--on-brand` is the text cleared to sit on that fill (`#submit`). These
  // two margins are the only thing standing between those decisions and an edit
  // that quietly repaints body text in `--accent-brand`: AA asks 4.5:1 for text,
  // and the pinned values hold ~5.6 in light and ~5.5 in dark — real margin,
  // not a rounding accident.
  for (const { name, tokens: palette } of THEMES) {
    const strong = tokenValue('--accent-brand-strong', palette)
    const onPaper = contrast(strong, tokenValue('--surface-canvas', palette))
    assert.ok(
      onPaper >= 4.5,
      `${name}: --accent-brand-strong on --surface-canvas reads ${onPaper.toFixed(2)}:1; brand text must clear the 4.5:1 AA threshold`,
    )
    const onFill = contrast(tokenValue('--on-brand', palette), strong)
    assert.ok(
      onFill >= 4.5,
      `${name}: --on-brand on --accent-brand-strong reads ${onFill.toFixed(2)}:1; a brand fill owes its own label 4.5:1`,
    )
  }
})

test('surfaces and text stay neutral; accents and links do not, in both themes', () => {
  // `--on-brand` is named in full rather than as a prefix: it is the one token
  // outside the surface/text/border families that is still a *surface* — the
  // colour that sits on a brand fill, white on clay in light and the canvas's
  // near-black in dark. It must not fall into the chromatic group just because
  // it is declared beside the brand accents.
  const NEUTRAL_PREFIXES = ['--surface-', '--text-', '--border-', '--on-brand']
  const CHROMATIC = ['--accent-', '--link', '--focus-ring']

  for (const { name: themeName, tokens: palette } of THEMES) {
    let neutrals = 0
    let chromatics = 0
    for (const [name, value] of palette) {
      if (!value.startsWith('#')) continue // aliases resolve to a token checked below
      if (name.startsWith('--diff-')) continue // content colours, exempt (see the sheet)

      const isNeutral = NEUTRAL_PREFIXES.some((prefix) => name.startsWith(prefix))
      const isChromatic = CHROMATIC.some((prefix) => name.startsWith(prefix))
      // Neither list matching means a new token slipped in unclassified, which is
      // how this test would quietly stop covering the palette.
      assert.notEqual(
        isNeutral,
        isChromatic,
        `${themeName}: ${name} is in neither the neutral nor the chromatic group; classify it`,
      )

      if (isNeutral) {
        neutrals += 1
        assert.ok(
          saturation(value) <= 20,
          `${themeName}: ${name} (${value}) is a tinted surface; the interface stays neutral`,
        )
      } else {
        chromatics += 1
        assert.ok(
          saturation(value) >= 40,
          `${themeName}: ${name} (${value}) is too grey to read as a semantic colour`,
        )
      }
    }
    assert.ok(
      neutrals >= 8 && chromatics >= 5,
      `${themeName}: classified ${neutrals} neutral / ${chromatics} chromatic`,
    )
  }
})

test('accents are for icons and state rules, never for fills', () => {
  // `design_guidance.md`'s "95% neutral" rule, made executable. An accent may
  // colour a glyph, a hairline or a 3px tone stripe; the moment one becomes a
  // `background` the interface starts drifting back to being a coloured one.
  const PAINTABLE = [
    'color',
    'fill',
    'stroke',
    'border-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'caret-color',
    // The five aliases, spelled out rather than allowing every custom property:
    // aliasing an accent into `--surface-x` would otherwise slip past the
    // neutrality check, which only sees literal values. `--link` and
    // `--focus-ring` joined the aliases with the redesign — both point at the
    // brand, and both are inherently paint roles (a text colour and a ring
    // colour), not surfaces.
    '--text-danger',
    '--text-warn',
    '--text-success',
    '--link',
    '--focus-ring',
  ]

  /**
   * The fills the rule allows, named rather than inferred.
   *
   * A switch carries no label: the coloured track *is* the state, which is what
   * the neutral version could not say — it read as "disabled" at a glance
   * (design_guidance 六 and 七.4). `#submit` is the redesign's one brand solid,
   * the "this app belongs to its brand" signal (六.4) — the strong rung, under
   * `--on-brand`. The session bar is a 3px indicator, not a surface — it is the
   * weak rung's proper shape, and it is listed because the parser sees a
   * `background` either way. All three are exact selector/property pairs so
   * widening the list is an edit here rather than a side effect: every other
   * control stays under the rule.
   */
  const ACCENT_FILL_EXCEPTIONS: readonly { selector: string; prop: string }[] = [
    { selector: '.settings-toggle.on', prop: 'background' },
    { selector: '#submit', prop: 'background' },
    { selector: '.ask-chip', prop: 'background' },
    { selector: '#composer-request.tone-danger .dialog-btn.primary', prop: 'background' },
    // The usage card's data marks: heatmap cells and share bars are the chart.
    { selector: '.usage-heat.level-1', prop: 'background' },
    { selector: '.usage-heat.level-2', prop: 'background' },
    { selector: '.usage-heat.level-3', prop: 'background' },
    { selector: '.usage-heat.level-4', prop: 'background' },
    { selector: '.usage-share-bar::-webkit-progress-value', prop: 'background' },
  ]

  let seen = 0
  let exceptionsSeen = 0
  for (const { selector, prop, value } of declarations) {
    if (!/var\(\s*--accent-/.test(value)) continue
    seen += 1
    if (ACCENT_FILL_EXCEPTIONS.some((one) => one.selector === selector && one.prop === prop)) {
      exceptionsSeen += 1
      continue
    }
    assert.ok(
      PAINTABLE.includes(prop),
      `${selector} { ${prop} } paints with an accent; accents are for icons, hairlines and switches`,
    )
  }
  // Non-vacuity: an exception that no longer matches anything is a hole left
  // open for a rule that has since moved.
  assert.equal(
    exceptionsSeen,
    ACCENT_FILL_EXCEPTIONS.length,
    'an accent-fill exception matches no declaration; drop it or fix the selector',
  )
  assert.ok(seen >= 8, `expected the accents to be in use, found ${seen} declarations`)
})

test('the weak brand rung never carries text', () => {
  // The other half of the two-rung rule the contrast test pins. `--accent-brand`
  // holds ~3.9:1 on the paper in light — a glyph, a hairline, an indicator bar,
  // not a paragraph. Brand-coloured *text* is the strong rung's job (`--link`,
  // `#submit`), and this is the assertion that keeps the rungs from converging
  // as rules land in later stages. `--focus-ring` is checked alongside it
  // because it is pinned as the weak rung's alias: text painted in it would be
  // brand text by another name, invisible to a check on the token itself.
  const TEXT_PROPS = ['color', 'caret-color']
  const WEAK_RUNG = /var\(\s*(?:--accent-brand|--focus-ring)\s*\)/
  let nonText = 0
  for (const { selector, prop, value } of declarations) {
    if (TOKEN_SELECTORS.has(selector)) continue // the token block's own alias
    if (!WEAK_RUNG.test(value)) continue
    assert.ok(
      !TEXT_PROPS.includes(prop),
      `${selector} { ${prop} } carries the weak brand rung; brand text belongs to --accent-brand-strong`,
    )
    nonText += 1
  }
  // Non-vacuity: the focus ring alone supplies several of these today. Zero
  // means the weak rung fell out of use entirely and this guard went quiet.
  assert.ok(nonText >= 3, `expected the weak brand rung in use, found ${nonText} declarations`)
})

// --- type and structure -----------------------------------------------------

/**
 * Selectors that must stay monospaced. Every one of them shows text the user
 * reads character by character — a shell command, a diff, a fenced block, a
 * tool's output. The chrome around them is proportional.
 */
const MONOSPACED = [
  '.md .md-code',
  '.md .md-inline-code',
  '.diff',
  '.diff-row .gutter',
  '.step-terminal',
  '.step-search',
  '.step-code',
  '.transcript .item.tool',
  '.file-chip-label',
]

/** The unconditional rule: a block nested in an at-rule is a conditional override. */
function blockFor(selector: string): Block {
  const found = blocks.find((block) => block.selector === selector && block.at === undefined)
  assert.ok(found, `no rule for ${selector}; the selector moved and this list did not`)
  return found
}

/** The same lookup, inside one at-rule's body. */
function blockIn(at: string, selector: string): Block {
  const found = blocks.find((block) => block.selector === selector && block.at === at)
  assert.ok(found, `no rule for ${selector} under ${at}`)
  return found
}

function declares(block: Block, prop: string, value: string): boolean {
  return block.decls.some((decl) => decl.prop === prop && decl.value === value)
}

test('everything read character by character stays monospaced', () => {
  for (const selector of MONOSPACED) {
    assert.ok(
      declares(blockFor(selector), 'font-family', 'var(--font-mono)'),
      `${selector} must declare font-family: var(--font-mono) — inheriting it is not enough, ` +
        'because the rule that supplies it is one refactor away from moving',
    )
  }

  // The chrome. `font` shorthand rather than `font-family` because it carries
  // the size and line-height too.
  const body = blockFor('body')
  assert.ok(
    body.decls.some((decl) => decl.prop === 'font' && decl.value.includes('var(--font-ui)')),
    'body must set the chrome font from the token',
  )

  // No stack may be spelled outside the three tokens, or a fourth font appears
  // and the list above stops meaning anything. `--font-serif` is display-only;
  // which selectors may name it is the serif whitelist's question, not this
  // test's.
  for (const { selector, prop, value } of declarations) {
    if (prop === 'font-family') {
      assert.ok(
        value === 'var(--font-mono)' || value === 'var(--font-ui)' || value === 'var(--font-serif)',
        `${selector} { font-family: ${value} } spells a stack instead of naming a token`,
      )
    }
    if (prop === 'font' && selector !== ':root') {
      assert.ok(
        value === 'inherit' || value.includes('var(--font-'),
        `${selector} { font: ${value} } spells a stack instead of naming a token`,
      )
    }
    // And not through a custom property either: the two checks above read
    // `font-family`/`font`, so a rule declaring `--font-mono: <its own stack>`
    // slips past both and becomes a fourth font the tokens know nothing about.
    // `.settings-input.mono` carried exactly that until the redesign collapsed
    // the sheet to one spelling per stack.
    if (prop.startsWith('--font-')) {
      assert.ok(
        TOKEN_SELECTORS.has(selector),
        `${selector} declares ${prop} outside the token blocks; a font stack belongs to :root`,
      )
    }
  }
})

test('the serif is display-only, and only in the whitelisted spots', () => {
  // design_guidance 三.4: the serif may carry a short, pure heading and nothing
  // else. Body text in it drops mixed CJK into a Songti — the fallback stack's
  // own next entry — and the run breaks visibly mid-sentence. There is no way to
  // see that in a DOM test, so the discipline lives here as a whitelist of
  // spots, spelled out, and every other selector naming `--font-serif` fails.
  const SERIF_WHITELIST = [
    '.welcome-title', // the home page's greeting
    '.thread-panel-empty-title', // 概览's empty state, the same kind of greeting
    '#rewind-panel .title',
  ]

  const seen = new Set<string>()
  for (const { selector, prop, value } of declarations) {
    if (TOKEN_SELECTORS.has(selector)) continue // the token's own declaration
    if (!/var\(\s*--font-serif\s*\)/.test(value)) continue
    assert.ok(
      SERIF_WHITELIST.includes(selector),
      `${selector} { ${prop} } takes the serif; it is whitelisted to headings only`,
    )
    seen.add(selector)
  }

  // Non-vacuity, per entry: a whitelisted selector that no longer names the
  // serif is a licence left lying around for whatever moves into that name.
  for (const selector of SERIF_WHITELIST) {
    assert.ok(seen.has(selector), `${selector} no longer uses the serif; drop it from the whitelist`)
  }
})

test('the canvas is a flush clipped pane divided by a hairline', () => {
  const canvas = blockFor('#canvas')
  assert.ok(declares(canvas, 'overflow', 'hidden'), '#canvas must clip its scrolling contents')
  assert.ok(declares(canvas, 'margin', '0'), '#canvas must not float as a card')
  assert.ok(!canvas.decls.some((decl) => decl.prop === 'border-radius'))
  // A shadow, not a border: a border would inset the `absolute; inset: 0` scrims.
  const line = canvas.decls.find((decl) => decl.prop === 'box-shadow')
  assert.ok(line, '#canvas needs the divider against the sidebar')
  assert.match(line.value, /var\(--border-subtle\)/)
  assert.ok(
    !canvas.decls.some((decl) => decl.prop === 'border' || decl.prop.startsWith('border-width')),
    '#canvas must not use a border: it would move the modal scrim off the canvas edge',
  )
})

test('the settings screen scrolls full width and reads in a column', () => {
  // todo V7: two nodes, two jobs. Merging them back into one gives the reading
  // measure a scrollbar of its own, floating mid-canvas.
  const column = blockFor('.settings-column')
  assert.ok(
    column.decls.some((decl) => decl.prop === 'max-width'),
    '.settings-column is the reading measure and must bound its width',
  )
  assert.ok(declares(column, 'margin', '0 auto'), '.settings-column must be centred in its scroller')
  assert.ok(
    !column.decls.some((decl) => decl.prop.startsWith('overflow')),
    '.settings-column is on an open dropdown’s ancestor chain and must not clip',
  )
  assert.ok(
    declares(blockFor('.settings-body'), 'overflow-y', 'auto'),
    '.settings-body stays the scroller, so its scrollbar keeps to the canvas edge',
  )
})

test('the newest question owns the screen, and a long one still scrolls from the top', () => {
  // A session with a short history used to hang one bubble under the canvas
  // header with 900px of nothing below it. The first fix pushed the column down
  // against the composer with an auto margin; what is here now lifts the newest
  // *question* to the top instead, with the pad below it as the room to do so —
  // the turn in flight is the thing the reader is looking at.
  const scroller = blockFor('.transcript')
  assert.ok(declares(scroller, 'display', 'flex'), '.transcript must be a flex column holding one reading column')
  assert.ok(declares(scroller, 'flex-direction', 'column'), '.transcript stacks one reading column; the axis has to say so')
  assert.ok(declares(scroller, 'overflow-y', 'auto'), '.transcript stays the scroller')
  // `dom/transcriptView.ts` measures the *leading* inset and spends it as the
  // trailing one — a scroller whose vertical padding came in two values would
  // put the lifted question a few pixels off its gap, in a direction nothing
  // would name. Two-value shorthand: vertical first, horizontal second.
  const inset = scroller.decls.find((decl) => decl.prop === 'padding')
  assert.ok(inset, '.transcript must state its inset in one place')
  assert.equal(
    inset.value.trim().split(/\s+/).length,
    2,
    '.transcript needs one vertical inset for both edges; the lift measures the top and spends it at the bottom',
  )
  // The alternative that looks equivalent and is not: in a scroll container,
  // `justify-content: flex-end` puts the *top* of overflowing content out of
  // reach, so a long session could never be scrolled back to its first message.
  assert.ok(
    !scroller.decls.some((decl) => decl.prop.startsWith('justify-content')),
    '.transcript must not bottom-align with justify-content: it makes overflowing content unreachable at the top',
  )

  const column = blockFor('.transcript-column')
  const margin = column.decls.find((decl) => decl.prop === 'margin')
  assert.ok(margin, '.transcript-column must set a margin: the side ones are what centre it')
  // It used to be `auto auto 0`. Nothing on this axis may be `auto` now: the pad
  // below places the column, and it is measured against a layout an auto margin
  // would be moving underneath it — the first paint of a turn would measure a
  // column the margin had shoved to the bottom of the scroller, and the pad
  // computed from that overshoots by exactly the space the margin ate.
  assert.doesNotMatch(
    margin.value,
    /^auto\b/,
    '.transcript-column must not claim free space with margin-top: auto; --transcript-pad owns this axis',
  )
  assert.ok(
    column.decls.some((decl) => decl.prop === 'max-width'),
    '.transcript-column is the reading measure and must bound its width',
  )
  // The other half of the vertical bargain, and the one that does the work now:
  // the pad is what a new question is lifted *over*, so a scroller with no room
  // under its last turn is one that cannot put that turn at the top of the view.
  // Written per paint through the custom property; see `model/transcriptAnchor.ts`.
  assert.ok(
    declares(column, 'padding-bottom', 'var(--transcript-pad)'),
    '.transcript-column must read --transcript-pad, or the newest question can never be lifted',
  )
  // The horizontal `auto` margins that centre it also cancel the flex item's
  // default cross-axis stretch, so the width has to be stated: otherwise a short
  // conversation shrink-to-fits into a narrow strip against the right edge.
  assert.ok(
    declares(column, 'width', '100%'),
    '.transcript-column needs width: 100% — auto side margins turn off the flex stretch that used to size it',
  )
  // Without this the column is squeezed to the scroller's height and its content
  // spills out of a box nothing scrolls — the long-session half of the bargain.
  assert.ok(
    declares(column, 'flex-shrink', '0'),
    '.transcript-column must not shrink: as a flex item it would otherwise be capped at the scroller height',
  )

  // The empty state is a different layout and must stay one: it takes the
  // scroller out of the stretch, so there is no free space to push anything into
  // and the Hero keeps the canvas.
  assert.ok(
    declares(blockFor('.pane.empty .transcript'), 'flex', '0 0 auto'),
    '.pane.empty keeps the welcome screen centred; it does not take part in the bottom alignment',
  )
})

test('the session on screen is painted, and the four row states stack in order', () => {
  // The row the user is *looking at* carries `--surface-active`, the same
  // surface `.settings-nav-item.selected` uses: one way of saying "you are on
  // this one" across the app. Everything else about a row stays unpainted —
  // being open in a background lane is not a state the user asked to see, so
  // `.open` remains data (`aria-selected`, the smoke probes) and styles nothing.
  //
  // Verified by mutation: dropping `.session-row.active`, moving it above
  // `.selected`, or re-adding any of the forbidden tiers below reds this test
  // and nothing else.
  assert.ok(
    declares(blockFor('.session-row.active'), 'background', 'var(--surface-active)'),
    'the session on screen must be the one row that is filled',
  )
  for (const selector of [
    '.session-row.active .session-open',
    '.session-row:not(.open) .session-open',
    '.project-group.own > .project-heading',
  ]) {
    assert.equal(
      blocks.find((block) => block.selector === selector),
      undefined,
      `${selector} must not exist; only the active row's own fill paints`,
    )
  }

  // All four are one class on `.session-row`, so the sheet's order *is* the
  // precedence: hover under the cursor, the cursor under the active fill (a row
  // that is both keeps the fill and gains the hairline), and confirming last —
  // the row asking "delete this?" must be the one row that looks like it is.
  const order = (selector: string): number => {
    const index = blocks.findIndex((block) => block.selector === selector)
    assert.notEqual(index, -1, `no rule for ${selector}`)
    return index
  }
  assert.ok(
    declares(blockFor('.session-row.selected'), 'background', 'var(--surface-hover)'),
    'the keyboard cursor keeps its hover fill and hairline',
  )
  assert.ok(
    order('.session-row:hover') < order('.session-row.selected'),
    '.session-row.selected must come after :hover, or the cursor is invisible under the pointer',
  )
  assert.ok(
    order('.session-row.selected') < order('.session-row.active'),
    '.session-row.active must come after .selected, or the cursor fill hides which session is open',
  )
  assert.ok(
    order('.session-row.active') < order('.session-row.confirming'),
    '.session-row.confirming must come last, or the active paint hides the question',
  )
})

test('a long session name cannot widen its row out of the rail', () => {
  // `.project-body` is a grid so the fold can animate to content height, and a
  // grid's implicit column is an `auto` track — sized to its item's *max-content*,
  // which here is the widest un-wrapped session title. Measured in Electron
  // against this sheet, a 40-character name grew the track to 650px inside the
  // 280px rail; `overflow: hidden` then cropped the row's right end, which is
  // where `.session-actions` lives, so 🗑 sat at x=626 and could not be reached.
  // The name did not truncate either — it had all the room it asked for.
  const body = blockFor('.project-body')
  assert.ok(
    declares(body, 'grid-template-columns', 'minmax(0, 1fr)'),
    'the fold’s column must be capped at the rail, or the widest title sizes it',
  )
  assert.ok(declares(body, 'overflow', 'hidden'), 'the crop this protects against is still here')
  assert.ok(
    declares(blockFor('.project-rows'), 'min-width', '0'),
    'the grid item must be allowed to shrink below its own max-content',
  )

  // With the row capped, these are what spend the width: the actions slot keeps
  // its size and the name is the half that gives way.
  const title = blockFor('.session-title')
  assert.ok(declares(title, 'min-width', '0'), 'the title must be allowed to shrink below its text')
  assert.ok(declares(title, 'text-overflow', 'ellipsis'), 'the truncation is the ellipsis')
  assert.ok(
    declares(blockFor('.session-actions'), 'flex', '0 0 auto'),
    'the actions slot never shrinks, so the delete button keeps its place',
  )
})

test('the hover marquee loops in one direction, inside the clip', () => {
  // Three halves that only work together: `.session-title` is the box with the
  // ellipsis, `.session-title-text` is the track that travels inside it, and
  // `.session-title-echo` is the second copy the loop wraps onto. Animating the
  // box would slide the already-truncated result out of view instead of revealing
  // anything, and without the echo the restart is a visible jump.
  assert.ok(
    declares(blockFor('.session-title'), 'overflow', 'hidden'),
    'the title is the clipper the text moves behind',
  )
  assert.ok(
    declares(blockFor('.session-title-text'), 'display', 'inline'),
    'at rest the track is a plain inline, or it would change the resting layout',
  )
  assert.ok(
    declares(blockFor('.session-title-echo'), 'display', 'none'),
    'the echo must not be in the layout at rest; sidebarView measures one copy',
  )

  const moving = blockFor(
    '.session-row:hover .session-title.marquee > .session-title-text, .session-row:focus-within .session-title.marquee > .session-title-text',
  )
  assert.ok(
    declares(moving, 'display', 'inline-flex'),
    'transform does not apply to a non-replaced inline box, and the gap needs a flex box',
  )
  assert.ok(declares(moving, 'gap', 'var(--marquee-gap)'), 'the two copies are spaced by the token')
  assert.ok(
    declares(moving, 'animation', 'session-marquee var(--marquee-duration) linear var(--motion-hover-delay) infinite'),
    'linear and infinite: an eased marquee hesitates once per pass',
  )
  assert.ok(
    declares(
      blockFor('.session-row:hover .session-title.marquee .session-title-echo, .session-row:focus-within .session-title.marquee .session-title-echo'),
      'display',
      'block',
    ),
    'the echo joins the track only while it is moving',
  )
  assert.ok(
    declares(
      blockFor('.session-row:hover .session-title.marquee, .session-row:focus-within .session-title.marquee'),
      'text-overflow',
      'clip',
    ),
    'the ellipsis and the scroll must never describe the same frame',
  )

  // One direction, and exactly two steps. A third would mean somebody
  // reintroduced the shuttle — a marquee that scrolls back is reading backwards.
  // Found by declaration rather than by step name: `from`/`to` are shared with
  // the entrance and sweep keyframes, and percentages keep this one out of the
  // entrance scan below.
  const ends = blocks.filter((block) =>
    block.decls.some((decl) => decl.value === 'translateX(var(--marquee-shift))'),
  )
  assert.equal(ends.length, 1, 'the marquee has one far end, not one per leg')
  assert.equal(ends[0]?.selector, '100%', 'and it is where the pass ends')
  assert.equal(
    tokenValue('--marquee-gap'),
    `${MARQUEE_GAP}px`,
    'the sheet spaces the copies by exactly the gap the model adds to the distance',
  )
})

test('the search box and the composer chips are grooves at rest, not outlined fields', () => {
  // design_guidance 六.2 / 六.4. Three bordered capsules — the search box on the
  // sidebar's paper, the two chips over the composer's own hairline — read as
  // line noise; the fill alone says "this is a control". The border stays in the
  // box as `transparent` so raising it on hover cannot move anything.
  const search = blockFor('.sidebar-search')
  assert.ok(declares(search, 'background', 'var(--surface-card)'), 'the search box is a card groove')
  assert.ok(declares(search, 'border', '0'), 'the search box carries no border at rest')
  assert.ok(
    declares(blockFor('.sidebar-search:focus'), 'box-shadow', '0 0 0 1px var(--focus-ring)'),
    'focus rings the groove with a shadow, not a border that would resize the box',
  )

  for (const chip of ['#chip-permission', '#chip-runtime']) {
    const rest = blockFor(chip)
    assert.ok(declares(rest, 'background', 'var(--surface-card)'), `${chip} is a card capsule`)
    assert.ok(
      declares(rest, 'border', '1px solid transparent'),
      `${chip} must reserve its border, or hover reflows the composer's bottom row`,
    )
    assert.ok(
      declares(blockFor(`${chip}:hover:enabled`), 'border-color', 'var(--border-subtle)'),
      `${chip} raises a hairline on hover`,
    )
    assert.ok(
      declares(blockFor(`${chip}.open`), 'border-color', 'var(--border-strong)'),
      `${chip} raises a strong hairline while its menu is open`,
    )
  }

  const context = blockFor('#composer-context')
  assert.ok(declares(context, 'background', 'var(--surface-card)'), 'the context indicator is the same card groove')
  assert.ok(
    declares(context, 'border', '1px solid transparent'),
    'the context indicator reserves its border, so hover cannot reflow the composer row',
  )
  assert.ok(
    declares(blockFor('#composer-context:hover'), 'border-color', 'var(--border-subtle)'),
    'the context indicator raises the same hover hairline',
  )
})

test('a composer row too narrow for the model name swaps it for an icon, not for half a glyph', () => {
  const CONDITION = '@container composer-bar (inline-size < 320px) {'
  assert.ok(
    declares(blockFor('#composer-bar'), 'container', 'composer-bar / inline-size'),
    'the bar has to be the query container the chip collapses against',
  )
  assert.ok(
    declares(blockFor('.chip-model-icon'), 'display', 'none'),
    'the icon is drawn at every width and hidden until the labels go',
  )
  assert.ok(
    declares(blockIn(CONDITION, '.chip-model-icon'), 'display', 'inline-flex'),
    'the narrow row shows the icon',
  )
  assert.ok(
    declares(blockIn(CONDITION, '.chip-model-label, .chip-effort-label'), 'display', 'none'),
    'both labels go together — an effort level with no model beside it names nothing',
  )
  // The other controls are round and fixed at every width; only the chip gives.
  for (const selector of ['#composer-attach', '#composer-permission', '#submit, #stop']) {
    assert.ok(declares(blockFor(selector), 'flex', '0 0 auto'), `${selector} cannot be squeezed`)
  }
})

test('the independent context gauge sweeps a ring, not a filled disc', () => {
  const gauge = blockFor('.context-gauge')
  // Thick enough to read at a glance: a 3px band on a 14px disc, its filled arc
  // a full step away from the track rather than the neighbouring grey.
  assert.ok(declares(gauge, 'width', '14px') && declares(gauge, 'height', '14px'), 'the ring is 14px')
  assert.ok(declares(gauge, 'color', 'var(--text-secondary)'), 'the filled arc is a foreground colour')
  assert.ok(
    gauge.decls.some((decl) => decl.prop === 'mask-image' && decl.value.includes('calc(100% - 3px)')),
    'the band is 3px, not a hairline',
  )
  assert.ok(
    gauge.decls.some((decl) =>
      decl.prop === 'background' &&
      decl.value.includes('conic-gradient') &&
      decl.value.includes('var(--context-ratio)')
    ),
    'the sweep must stay the ratio-driven conic gradient',
  )
  assert.ok(
    gauge.decls.some((decl) =>
      decl.prop === 'mask-image' &&
      decl.value.includes('radial-gradient') &&
      decl.value.includes('closest-side')
    ),
    'the centre must be masked out so the gauge reads as a ring',
  )
})

test('the readouts draw their own rounded hover card with measured typography', () => {
  const tooltip = blockFor('.hover-card')
  for (const [prop, value] of [
    ['background', 'var(--surface-card)'],
    ['border', '1px solid var(--border-strong)'],
    ['border-radius', 'var(--radius-md)'],
    ['box-shadow', 'var(--shadow-float)'],
    ['pointer-events', 'none'],
  ] as const) {
    assert.ok(declares(tooltip, prop, value), `the hover card declares ${prop}: ${value}`)
  }

  assert.ok(declares(blockFor('.presence[data-presence]'), 'opacity', '1'), 'presence owns the reveal')
  assert.equal(css.includes('#composer-context:hover .hover-card'), false, 'hover cannot override Escape dismissal')

  const value = blockFor('.hover-card-value')
  assert.ok(
    declares(value, 'font-family', 'var(--font-mono)'),
    'token counts are read character by character and use the mono stack',
  )
  assert.ok(
    declares(value, 'font-variant-numeric', 'tabular-nums'),
    'aligned figures keep the key-value rows readable',
  )
  assert.ok(
    declares(blockFor('.hover-card-note'), 'font-size', 'var(--type-micro)'),
    'the reserve note stays metadata-sized',
  )
})

test('a collapsed sidebar is gone, and the column inside it does not resize with it', () => {
  // The 44px rail existed so `.sidebar-collapse` stayed clickable; that control
  // moved to the title bar, so collapsing now means zero width (todo D8).
  // Verified by mutation: restoring `44px` reds the first assertion, giving the
  // shell a flexible basis reds the second.
  assert.ok(
    declares(blockFor('#sidebar.collapsed'), 'flex-basis', '0'),
    'a collapsed sidebar must take no width; the rail it used to keep is now in the title bar',
  )
  // The regions ride out on opacity and travel instead of being re-laid out at
  // every width between 280 and 0 — a reflow per frame is the collapse reading
  // as the list tearing itself up.
  // One axis, and it is the property the drag handle writes: the shell and the
  // rail must resolve their width from the *same* custom property, or a resized
  // sidebar would crop its own column. The rail is wider only by the scrollbar's
  // 7px overhang, so the rows themselves keep the stored width.
  assert.ok(
    declares(blockFor('.sidebar-shell'), 'width', 'var(--sidebar-width)'),
    'the shell must hold the open width while `#sidebar` animates around it',
  )
  assert.ok(
    declares(
      blockFor('#sidebar'),
      'flex',
      '0 0 calc(var(--sidebar-width) + var(--sidebar-scrollbar-overhang))',
    ),
    'the rail and the shell must read one width; the rail adds only the scrollbar overhang',
  )
  // The default lives in the token block, where a first run (and every test that
  // never touches localStorage) resolves it. Pinned against the model's constant
  // so the two cannot drift.
  assert.equal(
    tokens.get('--sidebar-width'),
    `${SIDEBAR_WIDTH_DEFAULT}px`,
    'the stylesheet default and model/sidebarWidth.ts must agree',
  )
  // ...and it holds that width through `width`, not through a flex basis:
  // `#sidebar` is a column, so a basis there is a fixed *height*. `0 0 280px`
  // capped the shell at 280px tall, which left `.sidebar-list` nothing to grow
  // into and stranded `.sidebar-footer` — the settings row — in mid-column.
  assert.ok(
    declares(blockFor('.sidebar-shell'), 'flex', '1 1 auto'),
    'the shell must fill the sidebar on the main axis; a basis here is a height, not a width',
  )
  assert.ok(
    declares(blockFor('#sidebar.collapsed .sidebar-shell'), 'opacity', '0'),
    'the column has to fade, or the crop slices legible text',
  )
  // The canvas owns its margin on all four sides now. The two rules that used to
  // hand it back a left inset (a collapsed sidebar, and the settings screen)
  // animated an inset against a column that was itself animating, and the gap
  // between them pumped.
  assert.equal(
    blocks.find((block) => block.selector === '#sidebar.collapsed + #canvas'),
    undefined,
    '#canvas must not borrow its left inset back from the sidebar',
  )

  // --- the gutter between the two columns ---
  // Four rules make one 10px seam, and each is meaningless without the others:
  // the scrollbar overhang, the canvas's left inset, the handle's basis, and
  // where the handle draws its line. Written together because the numbers only
  // add up together.
  assert.equal(tokens.get('--sidebar-gutter'), '10px')
  assert.equal(
    tokens.get('--sidebar-scrollbar-overhang'),
    'calc(var(--sidebar-gutter) - 3px)',
    'the overhang is the gutter minus the 2px gap and the 1px sash line',
  )
  const canvasPanel = blockFor('#canvas')
  assert.ok(declares(canvasPanel, 'margin', '0'), '#canvas is flush against the sidebar')
  const resizer = blockFor('#sidebar-resizer')
  assert.ok(
    declares(
      resizer,
      'flex',
      '0 0 calc(var(--sidebar-gutter) - var(--sidebar-scrollbar-overhang))',
    ),
    'the handle owns the gutter the scrollbar has not overhung, or part of the seam looks grabbable and is not',
  )
  assert.ok(
    declares(
      resizer,
      'margin-right',
      'calc(-1 * (var(--sidebar-gutter) - var(--sidebar-scrollbar-overhang)))',
    ),
    'the handle reaches across the canvas inset without widening the gutter',
  )
  // The hover line belongs on the canvas edge; the scrollbar is the element that
  // moves toward it.
  const line = blockFor('#sidebar-resizer::after')
  assert.ok(
    declares(line, 'right', '0'),
    "the sash's line stays on the canvas edge",
  )
  assert.ok(
    !line.decls.some((decl) => decl.prop === 'left'),
    'the sash must not also anchor on the left; two anchors and a width is one too many',
  )
  // The scroller overhang moves the native rail 7px into the gutter while the
  // matching padding keeps its rows on the original column grid.
  const list = blockFor('.sidebar-list')
  assert.ok(
    declares(list, 'width', 'calc(100% + var(--sidebar-scrollbar-overhang))'),
    'the scroller, not the sidebar shell, extends toward the sash',
  )
  assert.ok(
    declares(list, 'margin-right', 'calc(-1 * var(--sidebar-scrollbar-overhang))'),
    'the overhang must not widen the shell',
  )
  assert.ok(
    declares(
      list,
      'padding',
      'var(--space-1) var(--sidebar-scrollbar-overhang) var(--space-1) 0',
    ),
    'the rows keep the shell width; only the scrollbar moves',
  )
  // The rail's own slider is read against the sash, so it hugs the scroller's
  // right edge instead of stopping at the global thumb's 3px inset.
  const thumb = blockFor('.sidebar-list::-webkit-scrollbar-thumb')
  assert.ok(
    declares(thumb, 'border-right-width', '0'),
    "the rail's thumb must reach its column's edge",
  )
  assert.ok(
    declares(thumb, 'border-left-width', '6px'),
    'and keep its 4px thickness: the inset it dropped on the right moves to the left',
  )
})

test('the fold falls back on a timer just past the slow token', () => {
  // `transitionend` is not a guarantee — a hidden window runs no transitions and
  // reduced motion cuts them to 1ms — so the view arms a timer beside it. Pinned
  // here because the two live in different files: a token retimed without this
  // would leave the fold unmounting its rows before the animation had finished.
  const slow = Number.parseInt(tokens.get('--motion-layout') ?? '', 10)
  assert.ok(Number.isFinite(slow), '--motion-layout must be a ms duration')
  assert.ok(
    SIDEBAR_COLLAPSE_FALLBACK_MS > slow && SIDEBAR_COLLAPSE_FALLBACK_MS <= slow + 100,
    `the fallback (${SIDEBAR_COLLAPSE_FALLBACK_MS}ms) must sit just past --motion-layout (${slow}ms)`,
  )
})

test('presence fallbacks outlast their CSS motion tokens', () => {
  const sources: Record<PresenceKind, string> = {
    popover: '--motion-popover-in', panel: '--motion-panel-in', disclosure: '--motion-disclosure',
    layout: '--motion-layout', backdrop: '--motion-scrim-in',
  }
  for (const [kind, token] of Object.entries(sources)) {
    const duration = Number.parseInt(tokens.get(token) ?? '', 10)
    assert.equal(PRESENCE_FALLBACK_MS[kind as PresenceKind], duration + 60)
  }
})

test('the composer raises its panels, and they no longer span the canvas', () => {
  // todo V3: `#surface`, `#suggestions` and `#queue` were full-bleed blocks in
  // the canvas's flex column — `margin: 0 8px 8px`, square-ish corners, no edge —
  // opened by a chip in the composer's bottom right and drawn a screen away from
  // it, pushing the transcript around on the way. S9 makes them one stack
  // anchored to the composer's upper edge, on the reading column's axis.
  //
  // Verified by mutation: `position: static` on the shell, dropping its
  // `pointer-events`, or giving `.composer-column` an `overflow` each red this
  // test and nothing else.
  const shell = blockFor('#composer-popovers')
  assert.ok(declares(shell, 'position', 'absolute'), 'the stack floats; it must not take flow space')
  assert.ok(declares(shell, 'bottom', '100%'), 'the stack sits on the composer’s upper edge')
  // The shell outlives every panel it holds: with all three hidden it is still a
  // box over the transcript, and the `gap` between two open ones is its own area.
  assert.ok(
    declares(shell, 'pointer-events', 'none'),
    '#composer-popovers must not eat clicks meant for the transcript underneath',
  )

  const column = blockFor('.composer-column')
  assert.ok(declares(column, 'position', 'relative'), '.composer-column is the containing block')
  assert.ok(
    !column.decls.some((decl) => decl.prop.startsWith('overflow')),
    '.composer-column is on the stack’s ancestor chain and must not clip it — same rule as .settings-column',
  )

  for (const selector of ['#surface', '#suggestions']) {
    const panel = blockFor(selector)
    assert.ok(
      declares(panel, 'border-radius', 'var(--radius-lg)'),
      `${selector} is a floating panel now, not a strip ruled off the canvas`,
    )
    assert.ok(
      declares(panel, 'border', '1px solid var(--border-subtle)'),
      `${selector} needs the hairline that separates it from the transcript behind it`,
    )
    assert.ok(
      declares(panel, 'box-shadow', 'var(--shadow-float)'),
      `${selector} floats over other content and must carry var(--shadow-float)`,
    )
    assert.ok(
      declares(panel, 'pointer-events', 'auto'),
      `${selector} has to opt back in; its shell is pointer-events: none`,
    )
    // The shell owns the spacing now. A leftover margin would offset the panel
    // from the reading column the composer sits on.
    assert.ok(
      !panel.decls.some((decl) => decl.prop.startsWith('margin')),
      `${selector} must not keep a margin of its own; #composer-popovers spaces the stack`,
    )
  }

  // The three used to be listed as direct children of `#canvas.settings-open`.
  // They hang off the composer now, so hiding `#input-row` hides them — and a
  // stale rule would still match nothing, silently.
  for (const selector of blocks.map((block) => block.selector)) {
    assert.ok(
      !/#canvas\.settings-open > #(surface|suggestions|queue)\b/.test(selector),
      `${selector} matches nothing: those three are no longer children of #canvas`,
    )
  }
})

test('activity lines carry one running mark, which moves and stays readable', () => {
  // The working mark is a fixed square showing one frame of its sprite strip;
  // the view only names the sheet and the frame. Until the sheets decode it is a
  // dot in the brand colour.
  const carrier = blockFor('.line-mark')
  assert.ok(declares(carrier, 'flex', 'none'))
  assert.ok(declares(carrier, 'width', 'var(--mark-size)'))
  assert.ok(declares(carrier, 'height', 'var(--mark-size)'))
  assert.ok(declares(blockFor('.mark-layer'), 'overflow', 'clip'))
  assert.ok(declares(blockFor('.mark-layer.is-warm'), 'opacity', '0.001'), 'warm layers stay composited, so not 0')
  const strip = blockFor('.mark-strip')
  assert.match(strip.decls.find((decl) => decl.prop === 'transform')!.value, /var\(--mark-frame\) \/ var\(--mark-frames\)/)
  assert.match(strip.decls.find((decl) => decl.prop === 'background')!.value, /^var\(--mark-sheet\)/)
  assert.ok(declares(blockFor('.mark.is-dot::after'), 'color', 'var(--accent-brand-strong)'))
  // A card is a card and its rows are not: no row carries a shadow.
  for (const block of blocks) {
    if (!/^\.step\b|^\.run\b|^\.run-card\b/.test(block.selector.trim())) continue
    for (const decl of block.decls) {
      assert.notEqual(decl.prop, 'box-shadow', `${block.selector} gives a step a card's depth`)
    }
  }
  const source = stripComments(css)
  for (const name of ['breathe', 'blink']) {
    const frame = source.match(new RegExp(`@keyframes ${name} \\{ 50% \\{ ([^}]+)`))?.[1]
    if (name === 'breathe') {
      assert.ok(frame)
      assert.match(frame, /opacity: 0\.65;/)
    }
  }
  for (const block of blocks) {
    for (const decl of block.decls) {
      if (decl.prop === 'animation' && /^spin /.test(decl.value)) assert.match(decl.value, /linear infinite$/)
    }
  }
})

test("the shell family's command bubble is card-shelled and its output reddens whole on failure", () => {
  // §6.2/T14: a Bash step opens into the command in a bubble on the same
  // card-and-hairline content shell a fenced block or a diff gets, and the
  // output bare beneath it, scrolling inside itself so a long log never turns
  // the group into a scroll window. Failure turns the whole output to the
  // danger colour, and the error code above it is danger on its own, because
  // the only step that shows one is a failed step.
  const bubble = blockFor('.step-command')
  assert.ok(
    declares(bubble, 'background', 'var(--surface-card)'),
    'the command bubble sits on the card surface (§6.2)',
  )
  assert.ok(
    declares(bubble, 'border', '1px solid var(--border-subtle)'),
    'the command bubble carries the content hairline',
  )
  assert.ok(
    declares(bubble, 'border-radius', 'var(--radius-md)'),
    'the command bubble joins the fenced block and the diff on their radius rung, not a third one',
  )
  const terminal = blockFor('.step-terminal')
  assert.ok(
    declares(terminal, 'overflow-y', 'auto'),
    'a long output scrolls inside the block, never the group (§6.2 块内滚动) — vertically only',
  )
  assert.ok(
    terminal.decls.some((decl) => decl.prop === 'max-height'),
    'the terminal block must be capped, or it never scrolls',
  )
  assert.ok(
    declares(blockFor('.step.failed .step-terminal'), 'color', 'var(--text-danger)'),
    'a failed command reddens the whole block',
  )
  assert.ok(
    declares(blockFor('.step-error'), 'color', 'var(--text-danger)'),
    "the error code's own line is the failure it names",
  )
})

test("the search family's grouped list shares the content shell and its rows are controls", () => {
  // §6.2/T15: a Grep/Glob step opens into its results grouped by file, on the
  // same card-and-hairline content shell the terminal block and the diff get —
  // capped and scrolling inside itself, never a third depth rung. The rows are
  // the transcript's one control shape: a hover tint and nothing else, because
  // the design draws no pointer glyph anywhere in a group (§9).
  const list = blockFor('.step-search')
  assert.ok(
    declares(list, 'background', 'var(--surface-card)'),
    'the search list sits on the card surface (§6.2)',
  )
  assert.ok(
    declares(list, 'border', '1px solid var(--border-subtle)'),
    'the search list carries the content hairline',
  )
  assert.ok(
    declares(list, 'border-radius', 'var(--radius-md)'),
    'the search list joins the fenced block, the diff and the terminal on their radius rung',
  )
  assert.ok(
    declares(list, 'overflow-y', 'auto'),
    'a long result scrolls inside the list, never the group (§6.2 块内滚动) — vertically only',
  )
  assert.ok(
    list.decls.some((decl) => decl.prop === 'max-height'),
    'the search list must be capped, or it never scrolls',
  )

  // The hover is the whole affordance, on both row kinds, and the focus ring is
  // the same one every transcript control raises.
  for (const selector of ['.search-file-head:hover', '.search-hit:hover']) {
    assert.ok(
      declares(blockFor(selector), 'background', 'var(--surface-hover)'),
      `${selector} must raise the hover tint — it is the only affordance the row has`,
    )
  }
})

test('disclosure transitions intrinsic height both ways without fading text', () => {
  const body = blockFor('.presence[data-presence="disclosure"]')
  assert.ok(declares(body, 'interpolate-size', 'allow-keywords'))
  assert.ok(declares(body, 'height', 'auto'))
  assert.ok(declares(body, 'opacity', '1'))
  assert.ok(body.decls.some((decl) => decl.prop === 'transition' && decl.value.includes('height var(')))
  const closed = blockFor('.presence[data-presence="disclosure"].presence-closed, .presence[data-presence="disclosure"].presence-closing')
  assert.ok(declares(closed, 'height', '0'))
  assert.ok(declares(closed, 'padding-block', '0'), 'spacing must not jump on removal')
  assert.ok(declares(closed, 'opacity', '1'), 'text is not faded to conceal a rebuild')
})

test('every floating menu is lifted off the page it covers', () => {
  // The dropdowns are the same object at several sizes, and a menu without the
  // float shadow does not look wrong so much as *flat*: in light mode
  // `--surface-card` is a hair off the body it covers, and the border alone is
  // not enough to say the panel is above rather than in the text. `.settings-menu`
  // was the one that shipped without it. `.chip-flyout` is the one that floats
  // over another menu rather than over the page, and needs it most.
  for (const selector of [
    '.titlebar-menu',
    '.canvas-menu',
    '.composer-menu',
    '.settings-menu',
    '.chip-menu',
    '.chip-flyout',
  ]) {
    assert.ok(
      declares(blockFor(selector), 'box-shadow', 'var(--shadow-float)'),
      `${selector} floats over other content and must carry var(--shadow-float)`,
    )
  }
})

test('depth is two steps: menus float, modals sit deeper, and the composer joins them on focus', () => {
  // Three surfaces, two shadows. Menus and the focused composer are *over the
  // page*; the two dialog panels are over a dimmed app and carry the heavier
  // `--shadow-modal`. Anything that reaches for a third depth is inventing one.
  for (const selector of ['.titlebar-menu', '.canvas-menu', '.composer-menu', '.settings-menu', '.chip-menu', '.chip-flyout', '.project-menu']) {
    assert.ok(
      declares(blockFor(selector), 'border-radius', 'var(--radius-md)'),
      `${selector} is a menu card and takes the menu radius`,
    )
  }
  for (const selector of ['#rewind-panel']) {
    const panel = blockFor(selector)
    assert.ok(
      declares(panel, 'border-radius', 'var(--radius-lg)'),
      `${selector} is a modal panel, not a menu: it takes --radius-lg`,
    )
    assert.ok(
      declares(panel, 'box-shadow', 'var(--shadow-modal)'),
      `${selector} sits over a dimmed app and must carry var(--shadow-modal)`,
    )
  }

  const focused = blockFor('#composer:focus-within')
  assert.ok(
    declares(focused, 'border-color', 'var(--border-strong)'),
    'the focused composer firms its hairline',
  )
  assert.ok(
    declares(focused, 'box-shadow', 'var(--shadow-float)'),
    'the focused composer lifts off the page instead of only recolouring',
  )
  // A shadow that snaps on is a flicker at every focus change; `#composer`
  // outlives the state, so it is a legal carrier for the transition.
  assert.ok(
    blockFor('#composer').decls.some((decl) => decl.prop === 'transition'),
    '#composer must animate into its focused depth',
  )

  // The layering the popovers were built against: composer stack under every
  // menu, menus under the modal layer.
  for (const [selector, z] of [
    ['#composer-popovers', '4'],
    ['.composer-menu', '5'],
    ['.chip-menu', '5'],
    ['.hover-card', '5'],
    ['.settings-menu', '5'],
    ['.canvas-menu', '5'],
    ['.chip-flyout', '6'],
    ['#rewind', '9'],
  ] as const) {
    assert.ok(declares(blockFor(selector), 'z-index', z), `${selector} belongs on layer ${z}`)
  }

  // Every popover here is absolute against one of these shells; an `overflow`
  // on any of them clips the card the moment it hangs past the shell's box.
  for (const selector of [
    '.chip-menu-shell',
    '.canvas-menu-shell',
    '.settings-menu-shell',
    '.titlebar-menu-shell',
  ]) {
    assert.ok(
      !blockFor(selector).decls.some((decl) => decl.prop.startsWith('overflow')),
      `${selector} is on a popover's ancestor chain and must not clip it`,
    )
  }
})

test('location fallbacks track their semantic durations', () => {
  assert.equal(TASK_LOCATE_FALLBACK_MS, Number.parseInt(MOTION_TOKENS['--motion-locate']) + 60)
  for (const block of blocks) {
    for (const decl of block.decls) {
      if (decl.prop !== 'animation' || /^none(?: !important)?$/.test(decl.value)) continue
      assert.match(decl.value, /var\(--(?:motion-[a-z-]+|marquee-duration)\)/, `${block.selector} must use a semantic duration`)
      assert.doesNotMatch(decl.value, /(?:^|\s)[\d.]+m?s(?:\s|$)/, `${block.selector} has a literal animation duration`)
    }
  }
})

test('composer height handoff survives the later interaction rules', () => {
  // The first rule had height, but a later grouped shorthand silently removed it.
  const transitions = blocks.filter((block) => block.selector.split(',').some((part) => part.trim() === '#composer'))
    .flatMap((block) => block.decls.filter((decl) => decl.prop === 'transition'))
  assert.match(transitions.at(-1)!.value, /height var\(--motion-layout\)/)
})

test('motion comes from the tokens, and the things that rebuild themselves have none', () => {
  // Same argument as the palette: a duration written beside the control that
  // happens to use it is a duration nobody can compare, and a sheet with a dozen
  // ad-hoc timings reads as several interfaces.
  let transitions = 0
  for (const block of blocks) {
    for (const decl of block.decls) {
      if (decl.prop !== 'transition') continue
      // `none` is the one value that is not a timing: it *suspends* a transition
      // declared elsewhere (the sidebar's collapse, while its edge is being
      // dragged), and there is no duration or curve for it to name.
      if (/^none(?: !important)?$/.test(decl.value.trim())) continue
      transitions += 1
      assert.match(
        decl.value,
        /var\(--motion-[a-z-]+\)/,
        `${block.selector} { transition: ${decl.value} } spells its own duration`,
      )
      assert.match(
        decl.value,
        /var\(--(?:ease-(?:out|snap|overshoot|exit)|spring)\)/,
        `${block.selector} { transition: ${decl.value} } spells its own curve`,
      )
    }
  }
  assert.ok(transitions >= 3, `expected the motion rules, found ${transitions} transitions`)

  // Text updates do not replay entrances. Dialogs use reversible presence
  // transitions on stable panels, independently of the scrim.
  const ENTRANCES = /\b(fade-in|drop-in|rise-in|slide-in)\b/
  for (const block of blocks) {
    const animated = block.decls.some(
      (decl) => decl.prop === 'animation' && ENTRANCES.test(decl.value),
    )
    if (!animated) continue
    assert.ok(
      !/^(\.transcript \.item|#rewind-panel)\b/.test(block.selector),
      `${block.selector} is rebuilt on every render; an entrance animation there replays forever`,
    )
  }

  // The three entrance keyframes travel one distance and arrive from one scale.
  // The parser flattens `@keyframes`, so its `from` steps come through as blocks
  // named `from` — every one of them that moves is one of these three. The
  // looping sweeps (the sheens) start at `0%` so they stay out of this count.
  let entranceSteps = 0
  for (const block of blocks) {
    if (block.selector !== 'from') continue
    for (const decl of block.decls) {
      if (decl.prop !== 'transform') continue
      entranceSteps += 1
      assert.match(
        decl.value,
        /^translate[XY]\(-?8px\)(?: scale\(0\.985\))?$/,
        `from { transform: ${decl.value} } is not the 8px + 0.98 entrance`,
      )
    }
  }
  assert.equal(entranceSteps, 3, 'expected drop-in, rise-in and slide-in to move')

  // The reduced-motion override. `1ms` rather than `0s`: a zero-length
  // transition never fires `transitionend`, and no listener should have to know
  // about the setting.
  const reduced = blockIn('@media (prefers-reduced-motion: reduce) {', '*, *::before, *::after')
  assert.ok(declares(reduced, 'transition-duration', '1ms !important'), 'transitions must collapse')
  assert.ok(declares(reduced, 'animation-duration', '1ms !important'), 'animations must collapse')
  assert.ok(
    declares(reduced, 'animation-iteration-count', '1 !important'),
    'the infinite animations (spin, breathe, blink, sheen) must stop as well',
  )
})

test('ch units survive only where the font is monospaced', () => {
  // `ch` is the advance width of a `0`. Under the proportional chrome font it
  // silently narrows and stops being a stable column — which is why every other
  // `ch` in this sheet became a rem when the font changed.
  let seen = 0
  for (const block of blocks) {
    for (const decl of block.decls) {
      if (!/\b[\d.]+ch\b/.test(decl.value)) continue
      seen += 1
      assert.ok(
        declares(block, 'font-family', 'var(--font-mono)'),
        `${block.selector} { ${decl.prop}: ${decl.value} } sizes in ch without declaring the monospace font`,
      )
    }
  }
  assert.ok(seen >= 1, 'expected at least one ch measurement to still exist, or delete this test')
})

test('every button the renderer builds is styled by this sheet', () => {
  // An unstyled `<button>` does not disappear — it falls back to the user agent's
  // own control, which under Chromium is a filled light-grey box with the icon
  // out of line. That is how 4d's settings button became the single
  // highest-contrast fill in a 95%-neutral interface, the one thing `#submit` is
  // supposed to be, and neither typecheck pass nor any other test could see it.
  //
  // `controls.ts`'s `button()` takes the class list first, so the call sites are
  // the complete list of controls this sheet has to cover. A modifier (`selected`,
  // `danger`) may be unstyled on its own; what must exist is a rule for at least
  // one class of every button.
  // A resting-state rule, not merely *a* rule: `.x:hover` and `.x:disabled` say
  // nothing about how the control looks before it is touched, which is exactly
  // the state that fell back to the user agent. The lookahead rejects a class
  // that only ever appears with a pseudo-class attached, and forbidding `-` and
  // word characters as well is what stops the regex backtracking into a shorter
  // name to satisfy itself.
  const styled = new Set<string>()
  for (const block of blocks) {
    for (const match of block.selector.matchAll(/\.([A-Za-z][\w-]*)(?![\w-:])/g)) {
      if (match[1]) styled.add(match[1])
    }
  }

  let seen = 0
  for (const file of rendererFiles()) {
    if (file.endsWith(path.join('dom', 'controls.ts'))) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const match of code.matchAll(/\bbutton\(\s*'([^']+)'/g)) {
      const classes = (match[1] ?? '').split(/\s+/).filter(Boolean)
      seen += 1
      assert.ok(
        classes.some((name) => styled.has(name)),
        `${path.basename(file)} builds button('${match[1]}') and styles.css has no rule for any of its classes`,
      )
    }
  }
  assert.ok(seen >= 5, `expected the renderer to build buttons through button(); found ${seen}`)
})

test('the transcript controls carry a rule of their own, not only a contextual one', () => {
  // The scan above cannot see the difference. Its lookahead rejects a class that
  // only ever appears with a pseudo-class attached, but `.thinking-header .icon`
  // and `.item.thinking.live .thinking-header` both satisfy it while saying nothing
  // about how the control looks at rest — which is the user-agent fallback the whole
  // guard exists to catch. Closing that hole in general needs a notion of "state
  // qualifier" the parser does not have (`todo.md` records it), so the two controls
  // 5d adds are named here and required to own a selector outright.
  // Verified by mutation: deleting any one rule reds this test and nothing else.
  // The two activity-group heads join the list for the same reason and one of
  // their own: the row *is* the switch (§9 draws no disclosure chevron), so the
  // hover tint is the only affordance either control has, and a contextual rule
  // like `.activity-group.collapsed .group-head` would leave it a bare user-agent
  // button at rest — which on a row with no glyph reads as plain text. The two
  // search-list rows (T15) join for the same reason: their hover is the whole
  // clickable affordance, so they cannot live on a rule that is only ever
  // contextual either.
  for (const selector of ['.run-line', '.scroll-bottom', '.step-head', '.search-file-head', '.search-hit']) {
    const block = blocks.find((candidate) => candidate.selector === selector)
    assert.ok(block, `no rule whose whole selector is ${selector}; a descendant rule is not a resting state`)
    assert.ok(block.decls.length >= 3, `${selector} has ${block.decls.length} declarations; that cannot be a control`)
  }
})

test('the 5e chrome controls carry a rule of their own, not only a contextual one', () => {
  // Same hole as the transcript controls above, one stage later: the header's
  // menu items and the composer's mode menu are `button()` call sites, so the
  // general scan sees them — but it would accept `.canvas-menu .canvas-menu-item`
  // or `.canvas-menu-item.danger` alone, neither of which says how the control
  // looks at rest. Named here and required to own a selector outright, with the
  // stricter lookahead 5f introduced (no trailing `.` either).
  // Verified by mutation: deleting any one of these rules reds this test.
  const restingRule = (name: string): boolean =>
    blocks.some((block) => new RegExp(`^\\.${name}(?![\\w\\-:.\\[])`).test(block.selector.trim()))

  for (const name of [
    'canvas-menu-trigger',
    'canvas-menu-item',
    'canvas-open-location',
    'canvas-title-input',
    'composer-menu-item',
  ]) {
    assert.ok(restingRule(name), `styles.css has no resting rule for .${name}`)
  }
})

test('the dialog action buttons carry a rule of their own, not only a contextual one', () => {
  // The fourth named list, and the same hole as the two above: the general scan
  // sees `button('dialog-btn primary', …)` in `actionBar.ts` and would be
  // satisfied by `.dialog-btn.primary` alone — a control whose only rule is one
  // of its variants, which at rest is still the user agent's grey box. The bar
  // and the key badge are not `button()` call sites at all, so nothing else
  // covers them.
  // Verified by mutation: deleting any one of these three rules reds this test.
  //
  // These live under `#rewind-panel` / `#composer-request` (the bar is shared by the
  // modal and the docked cards and belongs to neither), so the shape required is "the selector
  // *ends* in exactly `.name`" — an ancestor is fine, a trailing `.primary`,
  // `.danger` or `:hover` is not.
  const restingRule = (name: string): boolean =>
    blocks.some((block) =>
      block.decls.length >= 3
      && block.selector.split(',').some((one) => new RegExp(`\\.${name}$`).test(one.trim())))

  for (const name of ['dialog-actions', 'dialog-btn', 'kbd']) {
    assert.ok(restingRule(name), `styles.css has no resting rule for .${name}`)
  }
})

test('the controls built inside controls.ts are styled too', () => {
  // The scan above skips `controls.ts`, because that file's own `button()` is the
  // helper being scanned for. Everything it builds internally is therefore
  // invisible to it — including 5f's pill dropdown, which is exactly the shape of
  // control that fell back to the user agent in 4d. Named explicitly instead.
  // A *lone* occurrence of the class, stricter than the scan above: that one's
  // lookahead forbids a trailing pseudo-class but not a trailing `.`, so
  // `.settings-pill.open` alone would satisfy it — and a control whose only rule
  // is its open state is exactly the user-agent fallback this guards against.
  // Verified by mutation: deleting `.settings-pill { … }` reds this test.
  const restingRule = (name: string): boolean =>
    blocks.some((block) => new RegExp(`\\.${name}(?![\\w\\-:.\\[])`).test(block.selector))

  const built = ['settings-toggle', 'settings-pill', 'settings-menu-item', 'settings-menu-shell']
  const source = readFileSync(path.join(rendererRoot, 'dom', 'controls.ts'), 'utf8')
  for (const name of built) {
    // Non-vacuity: the class has to still be built there, or this list is a
    // decoration that outlived the control it was guarding.
    assert.ok(source.includes(`'${name}'`), `controls.ts no longer builds .${name}`)
    assert.ok(restingRule(name), `controls.ts builds .${name} and styles.css has no resting rule for it`)
  }
})

test('nothing switches scroll anchoring off', () => {
  // The transcript folds its own steps when a turn ends (§8), which shortens the
  // content above a reader who asked for nothing. `overflow-anchor` is what holds
  // their place, `dom/transcriptView.ts` reuses nodes by id so the anchor node
  // survives the paint — and a single `overflow-anchor: none` anywhere above the
  // steps would undo both halves silently. There is no visual symptom to review
  // for, so the sheet is asserted instead.
  // Verified by mutation: adding `overflow-anchor: none` to `.transcript` reds it.
  const off = blocks.filter((block) =>
    block.decls.some((decl) => decl.prop === 'overflow-anchor' && decl.value.trim() !== 'auto'))
  assert.deepEqual(off.map((block) => block.selector), [])
  const scroller = blocks.find((block) => block.selector === '.transcript')
  assert.ok(
    scroller?.decls.some((decl) => decl.prop === 'overflow-anchor'),
    '.transcript no longer says which anchoring behaviour it depends on',
  )
})

test('nothing in a turn can widen the transcript', () => {
  // `.transcript` scrolls vertically, and `overflow-y: auto` computes
  // `overflow-x` to `auto` as well — so one row wider than the reading column
  // turned the whole conversation into a window that had to be dragged left and
  // right to be read. A long tool path did it: `.search-file-head` is a flex
  // container, where `text-overflow: ellipsis` truncates nothing, and its
  // `.btn-label` is `nowrap` with no `min-width: 0`, so the path was that block's
  // own floor.
  //
  // Three assertions, in the order the width travels: the scroller refuses the
  // axis, every link in the chain is allowed to shrink, and each row that
  // truncates has the pair of declarations that truncation actually needs.
  assert.ok(
    declares(blockFor('.transcript'), 'overflow-x', 'clip'),
    'the scroller must refuse the horizontal axis outright; it is the backstop for all of the below',
  )

  const CHAIN = [
    '.transcript-column',
    '.run',
    '.run-card',
    '.step',
    '.step-head',
    '.step-body',
    '.search-file',
    '.search-hit',
    '.step-code-row',
  ]
  for (const selector of CHAIN) {
    assert.ok(
      declares(blockFor(selector), 'min-width', '0'),
      `${selector} must declare min-width: 0 — one link without it hands the column its widest ` +
        'unbroken token as a floor, and the clip above then eats the text instead',
    )
  }

  // **Nothing in a group truncates.** A head's arguments used to be one
  // ellipsized line, on the reasoning that the row is a skim line — but for a
  // `Grep` or a `Bash` the arguments *are* the step, the ellipsis fell on the end
  // of the path (the file name), and the body below answers a different question.
  // Every row folds instead, on the heads' own `flex-wrap`; `min-width: 0` is
  // what stops the fold from being optional, because a flex item that will not
  // shrink is the column's floor whether or not its text may wrap.
  for (const selector of [
    '.step-summary',
    '.search-file-head .btn-label',
    '.search-hit-text',
  ]) {
    const row = blockFor(selector)
    assert.ok(declares(row, 'min-width', '0'), `${selector} must be allowed to shrink under its own text`)
    assert.ok(
      !row.decls.some((decl) => decl.prop === 'text-overflow'),
      `${selector} is inside a group and may not hide any of its text behind an ellipsis`,
    )
    assert.ok(
      row.decls.some((decl) => decl.prop === 'overflow-wrap' && decl.value === 'anywhere'),
      `${selector} must fold an unbroken path, which is the one thing wrapping alone will not do`,
    )
  }
})

test('a diff is the only block in a turn that scrolls sideways', () => {
  // Everything else wraps: a second axis to read one line in is worse than a
  // folded line. A diff keeps it because its gutter and columns line up down the
  // block, and a wrapped `+`/`-` line loses the alignment that makes it readable.
  //
  // Both lists are exhaustive on purpose — a new body that reaches for
  // `white-space: pre` or its own horizontal scrollbar reds this instead of
  // shipping a scrollbar nobody reviewed for.
  const preserving = blocks
    .filter((block) => block.decls.some((decl) => decl.prop === 'white-space' && decl.value === 'pre'))
    .map((block) => block.selector)
  assert.deepEqual(preserving, ['.diff-row'], 'only the diff may refuse to wrap')

  // `.request-block` is the composer's approval well, outside the transcript
  // entirely, and it is `pre-wrap` + `word-break: break-all` — the `auto` there
  // is the vertical cap, and no horizontal overflow can reach it.
  //
  // `.md-math-display` is the second real exception, admitted for a narrower
  // reason than the diff's: a typeset equation has no wrapping points at all, so
  // the choice is a scrollbar or a clipped formula. It is `overflow-x: auto`
  // with `overflow-y: hidden`, so only the one axis is in play.
  const SCROLLS_BOTH_AXES = [
    '.request-block, #composer-request .block',
    '.md .md-math-display',
    '.diff',
  ]
  const scrolling = blocks
    .filter((block) =>
      block.decls.some(
        (decl) =>
          (decl.prop === 'overflow' && decl.value === 'auto') ||
          (decl.prop === 'overflow-x' && decl.value === 'auto'),
      ))
    .map((block) => block.selector)
  assert.deepEqual(scrolling, SCROLLS_BOTH_AXES, 'a block in a turn scrolls vertically only')

  // The capped bodies say so themselves rather than inheriting it.
  for (const selector of [
    '.step-terminal',
    '.step-body-text',
    '.step-search',
    '.step-code',
    '.step-web',
  ]) {
    const body = blockFor(selector)
    assert.ok(declares(body, 'overflow-y', 'auto'), `${selector} keeps its vertical cap`)
    assert.ok(declares(body, 'overflow-x', 'clip'), `${selector} must not grow a horizontal scrollbar`)
  }
})
