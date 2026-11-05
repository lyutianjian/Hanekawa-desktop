import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const { copyComputerAssets } = await import(new URL('../scripts/copy-computer-assets.mjs', import.meta.url).href)
const run = promisify(execFile)
const macTest = process.platform === 'darwin' ? test : test.skip

macTest('native production mouse dispatch preserves pairs and reports partial clicks as unknown', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'computer-mouse-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  copyComputerAssets(scratch)
  // The actual helper runs injected check/post closures before NSApplication
  // initialization. No events are posted, windows opened or targets activated.
  const { stdout } = await run(join(scratch, 'desktop/computer/native/hanekawa-computer'), ['--self-test'], { timeout: 15_000 })
  assert.deepEqual(JSON.parse(stdout), { passed: true, scope: 'protocol helpers only; no GUI access', mouseInputChecks: 5 })
})
