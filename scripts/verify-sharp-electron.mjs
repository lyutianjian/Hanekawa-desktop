#!/usr/bin/env node
/**
 * S01 dependency probe, Electron side: load `sharp` inside a real Electron
 * main process and decode the same fixture PNG the Node twin decodes.
 *
 * Run with `npm run verify:sharp:electron` (which is
 * `electron scripts/verify-sharp-electron.mjs`). No window is created: the
 * check runs at module load and leaves through `app.exit()` with the
 * result as the exit code, so it works headless and in CI.
 *
 * Module resolution here is the same resolution `dist/desktop/main.js`
 * uses after `npm run build:desktop` — the Electron binary starts from the
 * repo root and `sharp` resolves out of `node_modules`, native binaries
 * included. `sharp` 0.35 ships N-API binaries, so the ABI matches both
 * Node 24 and Electron 45 without an electron-rebuild.
 */
import { app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'images',
  'transparent.png',
)

await (async () => {
  try {
    // Deliberately a dynamic import: the failure this probe exists to detect is
    // the native binding not loading on some platform, and a static `import`
    // would be hoisted above this `try`. Electron answers a module-load throw by
    // printing "App threw an error during load" and then *hanging* — no
    // `app.exit()`, no message below, a CI job that dies on a timeout instead of
    // reporting which platform failed.
    const { default: sharp } = await import('sharp')
    const meta = await sharp(fixture).metadata()
    if (meta.format !== 'png' || !meta.width || !meta.height) {
      throw new Error(`unexpected metadata: ${meta.format} ${meta.width}x${meta.height}`)
    }
    console.log(
      `[verify-sharp-electron] electron ${process.versions.electron} ` +
        `sharp ${sharp.versions.sharp}: decoded ${meta.format} ${meta.width}x${meta.height}`,
    )
    app.exit(0)
  } catch (error) {
    console.error(`[verify-sharp-electron] FAILED: ${error?.message ?? error}`)
    app.exit(1)
  }
})()
