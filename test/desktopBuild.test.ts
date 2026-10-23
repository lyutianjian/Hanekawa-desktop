import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

import { SHEETS } from '../src/desktop/renderer/model/workingMark.js'

/**
 * Checks the desktop shell build pipeline. Seven artifacts must land at the
 * right depths of the output directory:
 *
 *  - `desktop/main.js` — the Node-targeted main process. `electron` is left
 *    external because the running Electron binary provides it.
 *  - `desktop/preload.js` — the preload, CJS with `electron` external.
 *  - `desktop/renderer/app.js` — the browser-shaped renderer; `node:crypto` is
 *    aliased to a small shim so Web Crypto's `randomUUID` stands in.
 *  - `desktop/renderer/index.html` — copied, because `BrowserWindow.loadFile`
 *    needs it beside `app.js`.
 *  - `desktop/renderer/styles.css` — copied for the same reason: the page links
 *    it relatively, so a missing copy is a silently unstyled window.
 *  - `desktop/renderer/fonts.css` and `desktop/renderer/fonts/*.woff2` — the
 *    webfonts, copied for the same reason: the page links the sheet and
 *    preloads two of the woff2 relatively, so a missing copy is a silently
 *    fallback-font window. The directory ride along through `cpSync`
 *    recursion rather than the per-file `sources` list.
 *
 * Note this file bundles `main.ts` with esbuild while `npm run build:desktop`
 * emits it with `tsc`. That is deliberate: esbuild resolving the whole main
 * graph is a cheap check that no import is unresolvable, and
 * `test/distBuild.test.ts` is what pins the real `tsc` output and its depth.
 */

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// A unique directory per run: the previous fixed name meant two concurrent runs
// shared an output root, and `rmSync(recursive)` on Windows is exactly where
// that surfaces as EPERM/EBUSY.
const buildRoot = mkdtempSync(join(tmpdir(), 'hanekawa-desktop-build-'))

before(async () => {
  // Pin the module classification. This is belt-and-braces rather than
  // load-bearing: esbuild currently inlines the entire graph, so the output has
  // no `import`/`export` syntax left and Node loads it the same either way
  // (verified — dropping this line does not change the outcome today). It
  // matters the moment the bundle retains ESM syntax, e.g. a top-level await or
  // a deliberately external import, at which point a CJS misclassification
  // would turn the test below into a syntax check.
  writeFileSync(join(buildRoot, 'package.json'), JSON.stringify({ type: 'module' }))

  // Main process bundle: Node-targeted, with `electron` external so the
  // running binary supplies it. The bundled imports are the runtime,
  // sessions, harness, etc. — full app graph minus the renderer side.
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ['src/desktop/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(buildRoot, 'desktop', 'main.js'),
    external: ['electron'],
  })
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ['src/desktop/preload.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(buildRoot, 'desktop', 'preload.js'),
    external: ['electron'],
  })
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ['src/desktop/renderer/app.ts'],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    target: 'chrome120',
    mainFields: [],
    alias: { 'node:crypto': './src/desktop/renderer/runtime/nodeCryptoShim.ts' },
    outfile: join(buildRoot, 'desktop', 'renderer', 'app.js'),
  })
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ['src/desktop/renderer/themeBoot.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outfile: join(buildRoot, 'desktop', 'renderer', 'theme-boot.js'),
  })
})

test('main process bundle exists and is non-empty', () => {
  const file = join(buildRoot, 'desktop', 'main.js')
  assert.ok(existsSync(file), 'expected dist/desktop/main.js')
  assert.ok(statSync(file).size > 0, 'main bundle must be non-empty')
})

test('preload bundle exists and is non-empty', () => {
  const file = join(buildRoot, 'desktop', 'preload.js')
  assert.ok(existsSync(file), 'expected dist/desktop/preload.js')
  assert.ok(statSync(file).size > 0, 'preload bundle must be non-empty')
})

test('renderer bundle exists and is non-empty', () => {
  const file = join(buildRoot, 'desktop', 'renderer', 'app.js')
  assert.ok(existsSync(file), 'expected dist/desktop/renderer/app.js')
  assert.ok(statSync(file).size > 0, 'renderer bundle must be non-empty')
})

test('the renderer bundle is self-contained: no module specifier survives', () => {
  // The property the renderer's whole layering rests on. `client.ts` may only
  // *type*-import the harness, the barrel is deep-imported to keep `node:fs`
  // out, and `node:crypto` is aliased to a browser shim — if any of that
  // regresses, esbuild leaves a specifier behind and Chromium cannot resolve it.
  // Checked by reading the bundle rather than by importing it, because a
  // `ReferenceError` from the first DOM access would mask a later import.
  const bundle = readFileSync(join(buildRoot, 'desktop', 'renderer', 'app.js'), 'utf8')
  assert.doesNotMatch(bundle, /^\s*(?:import|export)\s/m, 'everything must be inlined')
  assert.doesNotMatch(bundle, /require\(/, 'no CommonJS require may survive')
  assert.doesNotMatch(bundle, /['"]node:/, 'no node: builtin may survive into the renderer')
})

test('the bundled renderer loads and fails only for want of a DOM', async () => {
  // That the import resolves at all proves the graph is complete; that it fails
  // with a *DOM* error proves it got as far as executing module top level —
  // `app.ts` reads `window.hanekawa` on its first line.
  //
  // Asserting the specific failure is the point. "Throws something without
  // MODULE_NOT_FOUND in the message" was the previous condition, and a
  // `SyntaxError` from a CJS/ESM misclassification satisfied it without ever
  // running a line of the bundle.
  const url = pathToFileURL(join(buildRoot, 'desktop', 'renderer', 'app.js')).href
  let caught: unknown = null
  try {
    await import(url)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error, 'importing the renderer must surface something')
  const error = caught as Error & { code?: string }
  assert.ok(
    error instanceof ReferenceError,
    `expected a missing-DOM ReferenceError, got ${error.name}: ${error.message}`,
  )
  assert.match(
    error.message,
    /window|document/,
    `expected the DOM global to be what is missing, got: ${error.message}`,
  )
  assert.notEqual(error.code, 'ERR_MODULE_NOT_FOUND', 'the bundle must not resolve anything at runtime')
})

test('theme-boot.js is a classic script that writes the first frame\'s attributes', () => {
  // Loaded by a plain `<script src>` in `<head>`, so it must not be a module:
  // an `import`/`export` left in it is a SyntaxError before the first paint,
  // and the dark flash it exists to prevent comes straight back. Run here in a
  // bare context with only the globals it reads, which also pins that a
  // throwing `localStorage` costs the stored theme and nothing else.
  const source = readFileSync(join(buildRoot, 'desktop', 'renderer', 'theme-boot.js'), 'utf8')
  assert.doesNotMatch(source, /^\s*(import|export)\b/m)
  const runWith = (storage: () => string | null, dark: boolean, platform?: string) => {
    const dataset: Record<string, string> = {}
    const window = {
      localStorage: { getItem: storage },
      matchMedia: () => ({ matches: dark }),
      ...(platform === undefined ? {} : { hanekawa: { platform } }),
    }
    runInNewContext(source, { window, document: { documentElement: { dataset } } })
    return dataset
  }
  assert.deepEqual(runWith(() => 'light', true, 'win32'), { theme: 'light', platform: 'win32' })
  assert.deepEqual(runWith(() => 'system', false, 'darwin'), { theme: 'light', platform: 'darwin' })
  assert.deepEqual(runWith(() => null, true), { theme: 'dark' }, 'no bridge: the platform waits for app.ts')
  assert.deepEqual(runWith(() => { throw new Error('locked') }, false), { theme: 'light' })
})

test('copy-desktop-assets mirrors the renderer assets next to the bundle', async () => {
  // The renderer is a `BrowserWindow.loadFile` away — the HTML must live next to
  // `app.js`, and so must everything the HTML references relatively. The copy
  // script takes the destination root as an argument, so this stays inside the
  // temp build and never touches the repo's `dist/`.
  const rendererDir = join(buildRoot, 'desktop', 'renderer')
  const copied = ['index.html', 'styles.css', 'fonts.css']
  for (const name of copied) rmSync(join(rendererDir, name), { force: true })
  rmSync(join(rendererDir, 'fonts'), { recursive: true, force: true })
  rmSync(join(rendererDir, 'sprites'), { recursive: true, force: true })

  await run(process.execPath, ['scripts/copy-desktop-assets.mjs', buildRoot], { cwd: repoRoot })

  for (const name of copied) {
    const dest = join(rendererDir, name)
    assert.ok(existsSync(dest), `expected ${name} to be copied next to app.js`)
    assert.ok(statSync(dest).size > 0, `copy of ${name} must be non-empty`)
  }

  // The webfont directory arrives via the recursive branch of the copy script.
  // "At least one woff2" rather than an exact count, so adding a subset does
  // not churn this test — the referenced-assets loop below pins the specific
  // files the page asks for by name, and the source directory is what says how
  // many there are.
  const fontsDir = join(rendererDir, 'fonts')
  assert.ok(existsSync(fontsDir), 'expected desktop/renderer/fonts/ to be copied')
  const woff2 = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2'))
  assert.ok(woff2.length > 0, 'expected at least one woff2 under desktop/renderer/fonts/')
  for (const name of woff2) {
    assert.ok(statSync(join(fontsDir, name)).size > 0, `copy of fonts/${name} must be non-empty`)
  }

  // Every sheet the working mark can ask for, by the name it asks for.
  for (const clip of Object.keys(SHEETS)) {
    const sheet = join(rendererDir, 'sprites', `${clip}.png`)
    assert.ok(existsSync(sheet) && statSync(sheet).size > 0, `expected sprites/${clip}.png to be copied`)
  }

  // The generalisation that keeps `sources` honest as the page grows: an asset
  // added to `index.html` but not to the copy script is a stylesheet that 404s
  // — an unstyled window, with nothing failing at build time to say so.
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf8')
  const referenced = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((match) => match[1]!)
  assert.ok(referenced.length >= 2, `expected the page to reference its assets, saw ${referenced.length}`)
  for (const name of referenced) {
    assert.ok(
      existsSync(join(rendererDir, name)),
      `index.html references ./${name}; add it to copy-desktop-assets.mjs`,
    )
  }
})
