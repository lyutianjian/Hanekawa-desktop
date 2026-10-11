import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/**
 * The build step, verified the only way that means anything: emit, then load
 * the emitted JavaScript in a plain `node` with no tsx.
 *
 * An Electron main process cannot run through `--import tsx` (tsx's load hook
 * breaks `require()` of package.json on Node 22+). So `dist/` is the only path
 * the desktop shell has, and nothing else in the suite exercises it — every
 * other test runs through the tsx loader.
 */

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const dist = path.join(repoRoot, 'dist')

/** Resolved through the package rather than a hoisting guess. */
const tscEntry = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript')), 'tsc.js')

before(async () => {
  await run(process.execPath, [tscEntry, '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  })
})

test('the build emits src/ at the root of dist/, and nothing else', () => {
  // `rootDir: "src"` is load-bearing, not cosmetic: it is what keeps every
  // emitted file at the same depth below the repo root as its source, which is
  // what `otlp.ts`'s `require('../../package.json')` depends on. Without it
  // tsc infers the repo root (`include` spans src/ and test/) and emits
  // `dist/src/**`, one level deeper.
  assert.ok(existsSync(path.join(dist, 'harness', 'otlp.js')), 'expected dist/harness/otlp.js')
  assert.ok(existsSync(path.join(dist, 'runtime', 'protocol', 'host.js')), 'expected dist/runtime/protocol/host.js')
  assert.ok(!existsSync(path.join(dist, 'src')), 'dist/src/ means rootDir was lost')
  assert.ok(!existsSync(path.join(dist, 'test')), 'the build config must not pull in test/')
})

test('the desktop main process lands at dist/desktop/main.js (depth pinned)', () => {
  // `rootDir: "src"` keeps the emit depth aligned with the source layout, which
  // is what lets `desktop/main.ts` import `'../sessions/service.js'` against the
  // actual emitted path. `tsconfig.build.json` excludes the renderer and preload
  // (esbuild handles them), so this assertion belongs here and not in
  // `desktopBuild.test.ts`.
  assert.ok(
    existsSync(path.join(dist, 'desktop', 'main.js')),
    'expected dist/desktop/main.js from the tsc build',
  )
})

test('the emitted version lookup still finds the real package.json', () => {
  // The depth coupling itself, pinned without exporting anything for the test:
  // this is the exact resolution `otlp.js` performs at module load.
  const emitted = createRequire(pathToFileURL(path.join(dist, 'harness', 'otlp.js')))
  const { version } = emitted('../../package.json') as { version?: string }
  const expected = (createRequire(import.meta.url)('../package.json') as { version?: string }).version
  assert.equal(version, expected)
})

for (const entry of [
  // The package.json require, and the one file whose failure mode is a
  // top-level throw rather than a missing export.
  'harness/otlp.js',
  // What an Electron main process imports.
  'runtime/bootstrap.js',
  'runtime/protocol/host.js',
  // What a renderer deep-imports, deliberately not through the barrel.
  'runtime/protocol/client.js',
]) {
  test(`dist/${entry} loads under plain node`, async () => {
    const href = pathToFileURL(path.join(dist, entry)).href
    await importInPlainNode(`import(${JSON.stringify(href)})`)
  })
}

test('the plain-node child really has no loader injected', async () => {
  // Anti-vacuity guard. Every assertion above is worthless if a tsx
  // registration leaked into the child, because then it would be transpiling
  // sources rather than running the emitted output.
  //
  // Checked by asserting the absence of the two things that could inject one,
  // rather than by importing a .ts file and expecting it to fail: Node 22.18+
  // strips TypeScript types natively, so a .ts import succeeds with no loader
  // at all and cannot tell the two situations apart.
  const { stdout } = await importInPlainNode(
    'console.log(JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null }))',
  )
  const { execArgv, nodeOptions } = JSON.parse(stdout) as { execArgv: string[]; nodeOptions: string | null }
  assert.equal(nodeOptions, null)
  // `-e` and its script are in execArgv; a loader would be too.
  const loaders = execArgv.filter((arg) => /^--(import|require|loader|experimental-loader)\b/.test(arg))
  assert.deepEqual(loaders, [])
})

/** A child with no `--import tsx` and no inherited `NODE_OPTIONS`. */
function importInPlainNode(script: string) {
  // NODE_OPTIONS is stripped rather than inherited: a tsx registration leaking
  // in from the environment would make these tests prove nothing. `execFile`
  // does not pass on this process's `execArgv` the way `fork` would.
  const { NODE_OPTIONS: _ignored, ...env } = process.env
  return run(process.execPath, ['-e', script], { cwd: repoRoot, env })
}
