import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const environmentUrl = new URL('../scripts/test-environment.mjs', import.meta.url).href
const runner = fileURLToPath(new URL('../scripts/test.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
// The subprocess is a fresh test run, not a child participating in this runner.
const { NODE_TEST_CONTEXT: _testContext, ...driverEnv } = process.env

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'hanekawa-cleanup-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function reportedRoot(stdout: string): string {
  const match = /CLEANUP_ROOT (.+)/.exec(stdout)
  assert.ok(match, stdout)
  return JSON.parse(match[1]) as string
}

test('a failed exit callback does not skip the remaining cleanup', () => {
  const source = [
    'import { createTestEnvironment, onTestExit } from ' + JSON.stringify(environmentUrl),
    'const environment = createTestEnvironment()',
    "console.log('CLEANUP_ROOT ' + JSON.stringify(environment.root))",
    "onTestExit(() => { throw new Error('expected cleanup failure') })",
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 2)
  assert.equal(existsSync(reportedRoot(result.stdout)), false)
})

const leakingFixture = [
  "import test from 'node:test'",
  "import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from 'node:fs'",
  "import { homedir, tmpdir } from 'node:os'",
  "import { dirname, join } from 'node:path'",
  "mkdirSync(join(homedir(), '.myagent'), { recursive: true })",
  "writeFileSync(join(homedir(), '.myagent/config.json'), '{\"models\":{\"test\":{}}}')",
  "mkdtempSync(join(tmpdir(), 'deliberate-leak-'))",
  "writeSync(1, 'CLEANUP_ROOT ' + JSON.stringify(dirname(homedir())) + '\\n')",
  '',
].join('\n')

for (const fail of [false, true]) {
  test('the unit test entry point removes unclaimed fixtures after ' + (fail ? 'failure' : 'success'), (t) => {
    const root = scratch(t)
    const file = join(root, 'fixture.test.mjs')
    writeFileSync(file, leakingFixture + "test('fixture', () => { " + (fail ? "throw new Error('expected failure')" : '') + ' });')
    const result = spawnSync(process.execPath, [runner, '--test-reporter=tap', file], {
      cwd: repoRoot, env: driverEnv, encoding: 'utf8', timeout: 15_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, fail ? 1 : 0, result.stderr)
    assert.equal(existsSync(reportedRoot(result.stdout)), false)
    assert.equal(existsSync(file), true, 'cleanup must leave fixtures owned by the caller alone')
  })
}

test('interrupting the unit test entry point stops the run and removes its fixtures', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async (t) => {
  const root = scratch(t)
  const file = join(root, 'waiting.test.mjs')
  writeFileSync(file, leakingFixture + "test('waiting', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });")
  const child = spawn(process.execPath, [runner, '--test-reporter=tap', file], { cwd: repoRoot, env: driverEnv })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let output = ''
  let interrupted = false
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
    if (!interrupted && /CLEANUP_ROOT .+\n/.test(output)) {
      interrupted = true
      child.kill('SIGTERM')
    }
  })
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(status, 143)
  assert.equal(existsSync(reportedRoot(output)), false)
})
