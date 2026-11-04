import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { copyComputerAssets } = await import(new URL('../scripts/copy-computer-assets.mjs', import.meta.url).href)
const macTest = process.platform === 'darwin' ? test : test.skip
const passed = JSON.stringify({ passed: true, scope: 'protocol helpers only; no GUI access' })

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'computer-assets-'))
  const dest = join(root, 'desktop/computer/native')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'obsolete-driver'), 'old')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, dest }
}

macTest('only a compiled helper that passes its self-test becomes a build artifact', t => {
  const { root, dest } = fixture(t)
  const executable = join(dest, 'hanekawa-computer')
  let staged = ''
  copyComputerAssets(root, (command: string, args: string[]) => {
    assert.equal(existsSync(executable), false, 'no final helper before validation')
    if (command === '/usr/bin/xcrun') {
      staged = args[args.indexOf('-o') + 1]!
      assert.notEqual(staged, executable)
      writeFileSync(staged, 'compiled helper')
      return ''
    }
    assert.equal(command, staged)
    assert.deepEqual(args, ['--self-test'])
    assert.equal(statSync(staged).mode & 0o777, 0o755)
    return passed
  })
  assert.deepEqual(readdirSync(dest), ['hanekawa-computer'])
  assert.equal(statSync(executable).mode & 0o777, 0o755)
  assert.equal(existsSync(dirname(staged)), false, 'compiler cache removed')
})

macTest('compiler and self-test failures leave neither old nor partial native assets', async t => {
  for (const stage of ['compiler', 'self-test', 'malformed', 'failed', 'wrong-scope']) await t.test(stage, t => {
    const { root, dest } = fixture(t)
    let staged = ''
    assert.throws(() => copyComputerAssets(root, (command: string, args: string[]) => {
      if (command === '/usr/bin/xcrun') {
        staged = args[args.indexOf('-o') + 1]!
        writeFileSync(staged, 'partial compiler output')
        if (stage === 'compiler') throw new Error('Compilation failed')
        return ''
      }
      if (stage === 'self-test') throw new Error('Self-test crashed')
      if (stage === 'malformed') return '{invalid'
      return JSON.stringify({ passed: stage !== 'failed', scope: stage === 'wrong-scope' ? 'GUI' : 'protocol helpers only; no GUI access' })
    }))
    assert.equal(existsSync(dest), false)
    assert.equal(existsSync(dirname(staged)), false)
  })
})
