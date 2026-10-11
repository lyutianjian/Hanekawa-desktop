import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the renderer is allowed to import, and which globals it may not touch.
 *
 * This exists because neither typecheck pass can see either problem:
 *
 * - `tsc -p tsconfig.renderer.json --listFiles` already contains ~130 host files,
 *   pulled in transitively through the wire types, including `src/utils/paths.ts`
 *   — which imports `node:fs` and uses `process`. So `@types/node`'s globals are
 *   in scope for the renderer pass despite `"types": []`, and a renderer file
 *   using `process.env` compiles clean in *both* passes.
 * - esbuild does reject an unresolvable `node:` *import*, but the failure names
 *   esbuild rather than the file, and it cannot see a bare global at all.
 *
 * The value/type distinction matters: a `import type` of anything is free at
 * runtime, so only value imports are policed here.
 */

const rendererRoot = fileURLToPath(new URL('../src/desktop/renderer/', import.meta.url))

/**
 * Shared modules the renderer may value-import.
 *
 * Each earns its place by being pure and *type-only* in its own cross-layer
 * imports. Adding an entry is a decision to keep that module browser-safe — a
 * single value import of `node:fs` inside it breaks the desktop build.
 */
const ALLOWED_SHARED_IMPORTS = [
  '../../runtime/protocol/client.js',
  '../../../runtime/protocol/wire.js',
  // The lane multiplexer both sides of the desktop shell run over one IPC
  // channel. Pure by construction: no imports at all beyond the channel type.
  '../../runtime/protocol/laneChannel.js',
  // The pending-request ledger shared by the protocol client and the shell
  // client. Pure, no imports.
  '../../runtime/protocol/pendingRequests.js',
  // The opening instruction's header, so older coordinator sessions hide it. Types only beside it.
  '../../../runtime/protocol/coordinationHost.js',
  '../../../runtime/permissionPresentation.js',
  '../../../runtime/planPresentation.js',
  '../../../runtime/rewindPresentation.js',
  '../../../runtime/suggestions/commandSuggestions.js',
  // The pure half of `@` file completion. `fileSuggestions.js` is the other half
  // and is *not* here: it value-imports `node:fs/promises`, which is why the two
  // were split at all.
  '../../../runtime/suggestions/atToken.js',
  '../../../config/effort.js',
  // The desktop shell's own shared modules, one directory up. Both are pure:
  // `shellProtocol.ts` is types plus one string constant, `paneBudget.ts` has no
  // imports at all. Listed rather than waved through because they sit *outside*
  // `renderer/` — a relative specifier that escapes this tree used to read as
  // "local" to the check below, which made the allowlist optional for exactly
  // the files most likely to drag the host in.
  '../shellProtocol.js',
  // The same module from one level deeper (`model/settings.ts` reads the context
  // field list from it). Listed per specifier rather than per resolved path
  // because that is what makes each entry a decision about one importer.
  '../../shellProtocol.js',
  '../paneBudget.js',
  // The image-failure copy both shells share (S24). Pure by the same rule
  // `media/types.ts` follows — its only import is that type module — and it is
  // *why* it is shared: the desktop strip and the TUI must not each invent
  // their own words for "this model cannot see images".
  '../../../media/imageErrors.js',
  '../../media/imageErrors.js',
]

/**
 * Bare specifiers that bundle for a browser, all verified in the build test.
 *
 * `marked` earns its place by being dependency-free ESM whose `exports` map has a
 * single entry — and the renderer uses only its *lexer*: the parser's output is an
 * HTML string, which `dom/dom.ts` has nowhere to put.
 *
 * `katex` is here on the same condition, met the same way: dependency-free, an
 * `exports` map with an ESM branch, and the renderer uses only `render()`, which
 * builds a DOM tree. Its string form, `renderToString`, is the one this codebase
 * could not accept — `dom/markdownView.ts` says so at the call site.
 */
const ALLOWED_PACKAGES = ['diff', 'fuse.js', 'katex', 'marked']

const FORBIDDEN_LAYERS = /(^|\/)(harness|services|sessions|commands|tui)\//

function rendererFiles(dir = rendererRoot): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return rendererFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** `import ... from 'x'` and `export ... from 'x'`, minus the `type` forms. */
function valueImports(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? ''
    const specifier = match[2] ?? ''
    // `import type { X } from` and `export type { X } from` are erased.
    if (/^type\s/.test(clause)) continue
    // A clause whose every named binding is `type X` is erased too.
    const named = clause.match(/^\{([\s\S]*)\}$/)
    if (named) {
      const bindings = (named[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean)
      if (bindings.length > 0 && bindings.every((binding) => binding.startsWith('type '))) continue
    }
    specifiers.push(specifier)
  }
  return specifiers
}

test('the renderer has files to check, so this test cannot pass vacuously', () => {
  const files = rendererFiles()
  assert.ok(files.length >= 10, `expected the renderer tree, found ${files.length} files`)
  assert.ok(files.some((file) => file.endsWith('app.ts')))
  assert.ok(files.some((file) => file.includes('model')))
})

test('no renderer module value-imports a host layer', () => {
  for (const file of rendererFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const specifier of valueImports(source)) {
      if (specifier.startsWith('.')) {
        // Resolved, not pattern-matched: "is this still inside `renderer/`" is a
        // question about the *path*, and a specifier like `../paneBudget.js`
        // matches none of the forbidden-layer patterns while still leaving the
        // tree. Anything that escapes needs an allowlist entry.
        const resolved = path.resolve(path.dirname(file), specifier)
        if (!resolved.startsWith(rendererRoot)) {
          assert.ok(
            ALLOWED_SHARED_IMPORTS.includes(specifier),
            `${path.relative(rendererRoot, file)} value-imports ${specifier}, which is not on the shared allowlist`,
          )
          continue
        }
        // A local renderer import.
        assert.equal(
          FORBIDDEN_LAYERS.test(specifier),
          false,
          `${path.relative(rendererRoot, file)} value-imports ${specifier}`,
        )
        continue
      }
      assert.ok(
        ALLOWED_PACKAGES.includes(specifier),
        `${path.relative(rendererRoot, file)} value-imports the package ${specifier}, which is not known to bundle for a browser`,
      )
    }
  }
})

test('every allowlisted shared module is actually reachable and pure', () => {
  // A stale allowlist entry is a licence nobody is using; a missing file would
  // make the assertion above pass for the wrong reason.
  //
  // Each entry is resolved against the renderer file that *actually* imports it
  // rather than assumed to hang off `src/`: the entries are written relative to
  // their importer, and two of them (`../shellProtocol.js`, `../paneBudget.js`)
  // live in `src/desktop/` rather than under `src/` directly. Guessing the path
  // is how this check would go green on a file it never opened.
  //
  // `node:crypto` is the one permitted Node import, and only because
  // `build:desktop` aliases it to `renderer/runtime/nodeCryptoShim.ts`
  // (`package.json`, mirrored in `test/desktopBuild.test.ts`). Any other `node:`
  // specifier has no alias and fails the bundle.
  const importers = new Map<string, string>()
  for (const file of rendererFiles()) {
    for (const specifier of valueImports(readFileSync(file, 'utf8'))) {
      if (ALLOWED_SHARED_IMPORTS.includes(specifier) && !importers.has(specifier)) {
        importers.set(specifier, file)
      }
    }
  }

  for (const specifier of ALLOWED_SHARED_IMPORTS) {
    const importer = importers.get(specifier)
    assert.ok(importer, `${specifier} is on the allowlist but nothing value-imports it`)
    const full = path.resolve(path.dirname(importer), specifier).replace(/\.js$/, '.ts')
    const source = readFileSync(full, 'utf8')
    const shown = path.relative(fileURLToPath(new URL('../src/', import.meta.url)), full)
    for (const nested of valueImports(source)) {
      if (!nested.startsWith('node:')) continue
      assert.equal(
        nested,
        'node:crypto',
        `${shown} value-imports ${nested}, which the desktop build has no alias for`,
      )
    }
  }
})

test('no renderer module reaches for a Node-only global', () => {
  // Not visible to either typecheck pass: `@types/node` is in the renderer
  // program regardless of `"types": []`.
  const forbidden: Array<[RegExp, string]> = [
    [/\bprocess\s*\./, 'process.*'],
    [/\bBuffer\b/, 'Buffer'],
    [/\b__dirname\b/, '__dirname'],
    [/\b__filename\b/, '__filename'],
    [/\brequire\s*\(/, 'require('],
    [/\bglobal\s*\./, 'global.*'],
  ]

  for (const file of rendererFiles()) {
    const source = readFileSync(file, 'utf8')
    // Comments may legitimately discuss these; strip them first.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

    for (const [pattern, name] of forbidden) {
      assert.equal(
        pattern.test(code),
        false,
        `${path.relative(rendererRoot, file)} uses ${name}, which does not exist in Chromium`,
      )
    }
  }
})

test('the renderer deep-imports the protocol client, never the barrel', () => {
  for (const file of rendererFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const specifier of valueImports(source)) {
      assert.equal(
        /runtime\/protocol\/index\.js$/.test(specifier) || /runtime\/protocol['"]?$/.test(specifier),
        false,
        `${path.relative(rendererRoot, file)} imports the protocol barrel, which pulls node:fs through host.ts`,
      )
    }
  }
})

test('every element the renderer requires exists in index.html', () => {
  // `required()` throws on a miss, and the misses happen at *module scope* in
  // `app.ts` — so a renamed or dropped id is a blank window with one line in the
  // console, not a degraded feature. Neither typecheck pass can see it and no
  // other test opens the HTML, which makes restructuring the page (4b moved
  // everything into `#shell > #sidebar + #canvas`) the exact moment to have this.
  //
  // Lives here rather than in `desktopBuild.test.ts` so it walks the renderer
  // tree through `rendererFiles()` — the one place that scan is spelled.
  const html = readFileSync(new URL('../src/desktop/renderer/index.html', import.meta.url), 'utf8')
  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))
  assert.ok(present.size >= 10, `expected the page's ids, found ${present.size}`)

  const requested = new Map<string, string>()
  for (const file of rendererFiles()) {
    // `required('x')` and `required<HTMLFormElement>('x')`; the declaration in
    // `dom.ts` takes an identifier, so it never matches the string-literal form.
    for (const match of readFileSync(file, 'utf8').matchAll(/\brequired\s*(?:<[^>]*>)?\s*\(\s*'([^']+)'/g)) {
      requested.set(match[1]!, file)
    }
  }

  assert.ok(requested.size >= 10, `expected the renderer's required ids, found ${requested.size}`)
  for (const [id, file] of requested) {
    assert.ok(
      present.has(id),
      `${path.relative(rendererRoot, file)} calls required('${id}'), which index.html does not define`,
    )
  }
})

test('a test that needs the DOM lib is excluded from the base program and checked by the DOM one', () => {
  // Two lists that have to move together. The base program's `lib` is `ES2022`
  // only — that absence is what stops host code from touching `document` — so a
  // test importing `dom/` must be excluded there and picked up by
  // `tsconfig.domtest.json` instead. Miss the first and `npm run typecheck` goes
  // red on a DOM global; miss the second and nothing type-checks the file at all.
  //
  // Importing `helpers/domStub.ts` counts the same way, and not by analogy: the
  // stub's one `HTMLElement` cast needs the DOM lib, and `tsc` type-checks a file
  // reached through an import whether or not `exclude` names it. A test may reach
  // the stub without naming `dom/` at all — `rendererBoot.test.ts` imports the
  // built bundle — so keying only on `dom/` would leave those uncovered.
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const readJsonc = (name: string): { include?: string[]; exclude?: string[] } =>
    // Comments only; no trailing commas in either file.
    JSON.parse(readFileSync(path.join(repoRoot, name), 'utf8').replace(/^\s*\/\/.*$/gm, ''))

  const base = readJsonc('tsconfig.json')
  const domtest = readJsonc('tsconfig.domtest.json')
  const covered = (patterns: readonly string[], file: string): boolean =>
    patterns.some((pattern) => pattern === file || (pattern.includes('*')
      && new RegExp(`^${pattern.replace(/\*\*\/\*/g, '.*').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`).test(file)))

  const importers = readdirSync(path.join(repoRoot, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => /from '(?:\.\.\/src\/desktop\/renderer\/dom\/|\.\/helpers\/domStub)/.test(
      readFileSync(path.join(repoRoot, 'test', name), 'utf8'),
    ))

  assert.ok(importers.length >= 1, 'no test needs the DOM lib — this guard has nothing to hold')
  for (const name of importers) {
    const file = `test/${name}`
    assert.ok(covered(base.exclude ?? [], file), `${file} must be in tsconfig.json's exclude`)
    assert.ok(covered(domtest.include ?? [], file), `${file} must be in tsconfig.domtest.json's include`)
  }
})
