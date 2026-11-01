import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('release cleanup removes only its own dist even when launched from another cwd', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hanekawa-clean-dist-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'dist', 'build', 'elsewhere/dist']) await mkdir(join(root, dir), { recursive: true })
  await copyFile(new URL('../scripts/clean-dist.mjs', import.meta.url), join(root, 'scripts/clean-dist.mjs'))
  await writeFile(join(root, 'dist/old.js'), 'old')
  await writeFile(join(root, 'build/icon.png'), 'source')
  await writeFile(join(root, 'elsewhere/dist/keep.js'), 'unrelated')
  const run = promisify(execFile)
  for (let n = 0; n < 2; n++) await run(process.execPath, [join(root, 'scripts/clean-dist.mjs')], { cwd: join(root, 'elsewhere') })
  await assert.rejects(access(join(root, 'dist')))
  assert.equal(await readFile(join(root, 'build/icon.png'), 'utf8'), 'source')
  assert.equal(await readFile(join(root, 'elsewhere/dist/keep.js'), 'utf8'), 'unrelated')
})
