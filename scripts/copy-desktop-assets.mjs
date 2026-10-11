#!/usr/bin/env node
/**
 * Copy non-TypeScript assets (the renderer's `index.html`, `styles.css`,
 * `fonts.css`, the `fonts/` webfont directory and the working mark's
 * `sprites/`) into the build output after `tsc` and `esbuild` finish. Two prior stages of `npm run build:desktop`
 * already wrote the compiled `.js` files; this script makes the corresponding
 * `.html` available where `desktop/main.ts` reads it
 * (`<dest>/desktop/renderer/index.html`), and everything the HTML links beside
 * it — `loadFile` resolves `./styles.css`, `./fonts.css`, and the
 * `./fonts/*.woff2` referenced by the sheet and the preload tags relative to
 * the page, so a missing copy is an unstyled or fallback-font window rather
 * than a build error.
 *
 * Single files go through the `sources` list (`[from, to]` pairs); whole
 * trees go through `directories` and are mirrored with
 * `cpSync(from, to, { recursive: true })` — Node 22 native, no new dependency.
 * KaTeX's sheet and faces are a third stage at the bottom, because they come
 * from `node_modules` rather than from `src/` and the sheet is rewritten on the
 * way out; the comment there says why.
 *
 * Kept as a standalone file rather than an `npm run` chain to avoid quoting
 * headaches on Windows where `&&` inside JSON script strings is fussy and `cp`
 * is not a builtin.
 *
 * Usage: `node scripts/copy-desktop-assets.mjs [destRoot]`
 *
 * `destRoot` defaults to `<repo>/dist`. It is a parameter because the source
 * path has to stay anchored to this file (so the script works from any cwd)
 * while the destination must be redirectable — `test/desktopBuild.test.ts`
 * builds into a temp directory, and a script that always wrote into the repo's
 * `dist/` would both miss the assertion and scribble on a directory another
 * test file is rebuilding in a sibling process.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const destRoot = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'dist')

const sources = [
  ['src/desktop/renderer/index.html', 'desktop/renderer/index.html'],
  ['src/desktop/renderer/styles.css', 'desktop/renderer/styles.css'],
  ['src/desktop/renderer/fonts.css', 'desktop/renderer/fonts.css'],
]

const directories = [
  ['src/desktop/renderer/fonts', 'desktop/renderer/fonts'],
  ['src/desktop/renderer/sprites', 'desktop/renderer/sprites'],
]

for (const [from, to] of sources) {
  const absoluteFrom = join(repoRoot, from)
  const absoluteTo = join(destRoot, to)
  mkdirSync(dirname(absoluteTo), { recursive: true })
  copyFileSync(absoluteFrom, absoluteTo)
  console.log(`copied ${from} -> ${absoluteTo}`)
}

for (const [from, to] of directories) {
  const absoluteFrom = join(repoRoot, from)
  const absoluteTo = join(destRoot, to)
  mkdirSync(dirname(absoluteTo), { recursive: true })
  cpSync(absoluteFrom, absoluteTo, { recursive: true })
  console.log(`copied ${from}/ -> ${absoluteTo}`)
}

/*
 * KaTeX's stylesheet and the faces it names, taken from the installed package
 * rather than checked in beside the others.
 *
 * That is the one difference from the webfonts above, and it is deliberate: the
 * `@fontsource` packages are devDependencies used once as a source of bytes,
 * while `katex` is a real runtime dependency already bundled into `app.js`. Its
 * CSS and its fonts have to match the version that bundle was built from, so
 * reading them from `node_modules` at copy time is what keeps the three in step
 * — a `npm update katex` that changed a metric would otherwise leave stale
 * glyphs in `src/`.
 *
 * The `woff` and `ttf` sources are dropped and only the woff2 are carried: the
 * three formats are the same 20 faces three times over, 1.2 MB against 296 KB,
 * and Chromium — the only engine this page runs in — has taken woff2 since 36.
 * Stripping the sources as well as the files matters, because `default-src
 * 'self'` turns a fallback `url()` for a file nobody copied into a console error
 * per equation rather than a silent miss.
 *
 * The destination is `desktop/renderer/fonts/`, shared with the app's own
 * faces: the sheet's `url(fonts/KaTeX_…woff2)` is relative to itself, and it
 * sits at `desktop/renderer/katex.css`. So the two families land in one
 * directory and no path in the vendored CSS has to be rewritten.
 */
const katexDist = join(repoRoot, 'node_modules', 'katex', 'dist')
const katexFallbackSource = /,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g

const katexCss = readFileSync(join(katexDist, 'katex.min.css'), 'utf8')
const katexCssDest = join(destRoot, 'desktop/renderer/katex.css')
mkdirSync(dirname(katexCssDest), { recursive: true })
writeFileSync(katexCssDest, katexCss.replace(katexFallbackSource, ''))
console.log(`copied katex.min.css (woff2 only) -> ${katexCssDest}`)

const katexFontsDest = join(destRoot, 'desktop/renderer/fonts')
mkdirSync(katexFontsDest, { recursive: true })
let katexFaces = 0
for (const name of readdirSync(join(katexDist, 'fonts'))) {
  if (!name.endsWith('.woff2')) continue
  copyFileSync(join(katexDist, 'fonts', name), join(katexFontsDest, name))
  katexFaces += 1
}
console.log(`copied ${katexFaces} katex woff2 -> ${katexFontsDest}`)
