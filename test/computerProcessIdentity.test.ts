import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const macTest = process.platform === 'darwin' ? test : test.skip
let scratch: string, executable: string

before(async () => {
  if (process.platform !== 'darwin') return
  scratch = mkdtempSync(join(tmpdir(), 'computer-identity-'))
  executable = join(scratch, 'identity-tests')
  await run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', scratch,
    ...['native/computer/ProcessIdentity.swift', 'native/computer/ApplicationBinding.swift',
      'test/fixtures/computer/ProcessIdentityTests.swift'].map(path => fileURLToPath(new URL(`../${path}`, import.meta.url))),
    '-o', executable], { timeout: 120_000 })
})
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

for (const [group, description] of [
  ['sampling', 'kernel sampling rejects incomplete, unstable and zombie identities'],
  ['bind', 'binding requires complete kernel birth and the discovered real executable'],
  ['metadata', 'AppKit registry miss uses pinned metadata only after exact identity validation'],
  ['changes', 'PID, birth second, birth microsecond and executable changes revoke binding'],
  ['unavailable', 'unavailable identity revokes binding despite pinned or registered metadata'],
  ['terminated', 'explicit termination revokes binding even with a matching sample'],
  ['lifecycle', 'real non-GUI exit and restart refuse old bindings and allow a fresh binding'],
  ['exec', 'real same-PID exec preserves birth but invalidates the old executable binding'],
]) {
  macTest(`native identity: ${description}`, async () => {
    const { stdout } = await run(executable, [group!], { timeout: 15_000 })
    assert.deepEqual(JSON.parse(stdout), { passed: true, scope: 'no GUI access', group })
  })
}
