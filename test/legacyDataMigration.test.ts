import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyGlobalData } from '../src/utils/legacyDataMigration.js'

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false)
}

async function scratch(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-legacy-data-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('moves the old data directory and workspace into the current names', async (t) => {
  const home = await scratch(t)
  await mkdir(path.join(home, '.myagent', 'projects', 'p'), { recursive: true })
  await writeFile(path.join(home, '.myagent', 'config.json'), '{"models":[]}', 'utf8')
  await mkdir(path.join(home, 'Documents', 'myagent'), { recursive: true })
  await writeFile(path.join(home, 'Documents', 'myagent', 'note.md'), 'kept', 'utf8')

  const result = migrateLegacyGlobalData(home)

  assert.equal(result.data, 'moved')
  assert.equal(result.workspace, 'moved')
  assert.equal(result.worktrees, 'absent')
  assert.deepEqual(result.warnings, [])
  assert.equal(await readFile(path.join(home, '.hanekawa', 'config.json'), 'utf8'), '{"models":[]}')
  assert.equal(await readFile(path.join(home, 'Documents', 'hanekawa', 'note.md'), 'utf8'), 'kept')
  assert.equal(await exists(path.join(home, '.myagent')), false)
  assert.equal(await exists(path.join(home, 'Documents', 'myagent')), false)
})

test('leaves both directories alone when the current name already exists', async (t) => {
  const home = await scratch(t)
  await mkdir(path.join(home, '.myagent'), { recursive: true })
  await writeFile(path.join(home, '.myagent', 'config.json'), 'old', 'utf8')
  await mkdir(path.join(home, '.hanekawa'), { recursive: true })
  await writeFile(path.join(home, '.hanekawa', 'config.json'), 'current', 'utf8')

  const result = migrateLegacyGlobalData(home)

  assert.equal(result.data, 'target-exists')
  assert.equal(result.workspace, 'absent')
  assert.equal(result.warnings.length, 1)
  assert.equal(await readFile(path.join(home, '.myagent', 'config.json'), 'utf8'), 'old')
  assert.equal(await readFile(path.join(home, '.hanekawa', 'config.json'), 'utf8'), 'current')
})

test('is a no-op on a fresh home', async (t) => {
  const home = await scratch(t)

  const result = migrateLegacyGlobalData(home)

  assert.deepEqual(result, { data: 'absent', workspace: 'absent', worktrees: 'absent', warnings: [] })
})

test('removes an empty old worktree root and keeps one a thread still uses', async (t) => {
  const emptyHome = await scratch(t)
  await mkdir(path.join(emptyHome, '.myagent-worktrees', 'key', 'thread'), { recursive: true })

  assert.equal(migrateLegacyGlobalData(emptyHome).worktrees, 'removed')
  assert.equal(await exists(path.join(emptyHome, '.myagent-worktrees')), false)

  const busyHome = await scratch(t)
  await mkdir(path.join(busyHome, '.myagent-worktrees', 'key', 'thread'), { recursive: true })
  await writeFile(path.join(busyHome, '.myagent-worktrees', 'key', 'thread', 'file'), 'x', 'utf8')

  assert.equal(migrateLegacyGlobalData(busyHome).worktrees, 'active')
  assert.equal(await exists(path.join(busyHome, '.myagent-worktrees', 'key', 'thread', 'file')), true)
})
