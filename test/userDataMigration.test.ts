import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyUserData } from '../src/desktop/userDataMigration.js'

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false)
}

async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-user-data-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('moves the old userData directory when the current one is missing', async (t) => {
  const root = await scratch(t)
  const legacy = path.join(root, 'myagent')
  const current = path.join(root, 'hanekawa')
  await mkdir(path.join(legacy, 'Local Storage', 'leveldb'), { recursive: true })
  await writeFile(path.join(legacy, 'window-state.json'), '{"theme":"dark"}', 'utf8')
  await writeFile(path.join(legacy, 'Local Storage', 'leveldb', 'LOG'), 'x', 'utf8')

  assert.equal(migrateLegacyUserData(legacy, current), 'moved')
  assert.equal(await readFile(path.join(current, 'window-state.json'), 'utf8'), '{"theme":"dark"}')
  assert.equal(await exists(path.join(current, 'Local Storage', 'leveldb', 'LOG')), true)
  assert.equal(await exists(legacy), false)
})

test('copies missing entries without overwriting or merging existing ones', async (t) => {
  const root = await scratch(t)
  const legacy = path.join(root, 'myagent')
  const current = path.join(root, 'hanekawa')
  await mkdir(path.join(legacy, 'Local Storage'), { recursive: true })
  await writeFile(path.join(legacy, 'window-state.json'), 'old', 'utf8')
  await writeFile(path.join(legacy, 'Preferences'), 'prefs', 'utf8')
  await writeFile(path.join(legacy, 'Local Storage', 'old-entry'), 'carried', 'utf8')
  await mkdir(path.join(current, 'Local Storage'), { recursive: true })
  await writeFile(path.join(current, 'window-state.json'), 'current', 'utf8')
  await writeFile(path.join(current, 'Local Storage', 'existing-entry'), 'kept', 'utf8')

  assert.equal(migrateLegacyUserData(legacy, current), 'copied')
  assert.equal(await readFile(path.join(current, 'window-state.json'), 'utf8'), 'current')
  assert.equal(await readFile(path.join(current, 'Preferences'), 'utf8'), 'prefs')
  assert.equal(await exists(path.join(current, 'Local Storage', 'old-entry')), false)
  assert.equal(await readFile(path.join(current, 'Local Storage', 'existing-entry'), 'utf8'), 'kept')
  assert.equal(await exists(legacy), true)
})

test('is a no-op when the old userData directory does not exist', async (t) => {
  const root = await scratch(t)
  assert.equal(migrateLegacyUserData(path.join(root, 'myagent'), path.join(root, 'hanekawa')), 'absent')
  assert.equal(await exists(path.join(root, 'hanekawa')), false)
})
