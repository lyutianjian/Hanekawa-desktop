import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertInsideCwd, getConfigPath, getHanekawaDir, invalidateResolvedCwdCache } from '../src/utils/paths.js'
import { parseJsonLinesWithDiagnostics, readJsonFile, writeJsonFile } from '../src/utils/json.js'

test('path helpers resolve .hanekawa paths under cwd', () => {
  const cwd = path.join('tmp', 'project')
  assert.equal(getHanekawaDir(cwd), path.join(cwd, '.hanekawa'))
  assert.equal(getConfigPath(cwd), path.join(cwd, '.hanekawa', 'config.json'))
})

test('json helpers read fallback and write formatted json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-json-'))
  try {
    const file = path.join(dir, 'nested', 'config.json')
    assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: false })
    await writeJsonFile(file, { ok: true })
    assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalidateResolvedCwdCache invalidates a specific cached cwd', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-paths-'))
  try {
    assert.equal(assertInsideCwd(dir, 'next.txt'), path.join(dir, 'next.txt'))
    await rm(dir, { recursive: true, force: true })

    assert.equal(assertInsideCwd(dir, 'next.txt'), path.join(dir, 'next.txt'))
    invalidateResolvedCwdCache(dir)
    assert.throws(() => assertInsideCwd(dir, 'next.txt'), /ENOENT/)
  } finally {
    invalidateResolvedCwdCache(dir)
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalidateResolvedCwdCache clears all cached cwd entries when called without cwd', async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-paths-first-'))
  const second = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-paths-second-'))
  try {
    await writeFile(path.join(first, 'existing.txt'), 'first', 'utf8')
    await writeFile(path.join(second, 'existing.txt'), 'second', 'utf8')
    assert.equal(assertInsideCwd(first, 'existing.txt'), path.join(first, 'existing.txt'))
    assert.equal(assertInsideCwd(second, 'existing.txt'), path.join(second, 'existing.txt'))

    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })

    assert.equal(assertInsideCwd(first, 'next.txt'), path.join(first, 'next.txt'))
    assert.equal(assertInsideCwd(second, 'next.txt'), path.join(second, 'next.txt'))
    invalidateResolvedCwdCache()
    assert.throws(() => assertInsideCwd(first, 'next.txt'), /ENOENT/)
    assert.throws(() => assertInsideCwd(second, 'next.txt'), /ENOENT/)
  } finally {
    invalidateResolvedCwdCache()
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('assertInsideCwd follows symlink parents for new files', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-paths-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-outside-'))
  const link = path.join(dir, 'linked')
  try {
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }

    assert.throws(
      () => assertInsideCwd(dir, path.join('linked', 'new.txt')),
      /outside the working directory/,
    )
  } finally {
    invalidateResolvedCwdCache(dir)
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('parseJsonLinesWithDiagnostics keeps valid records and reports malformed lines', () => {
  const parsed = parseJsonLinesWithDiagnostics<{ id: string }>([
    JSON.stringify({ id: 'a' }),
    '{not valid json',
    '',
    JSON.stringify({ id: 'b' }),
  ].join('\n'))

  assert.deepEqual(parsed.records, [{ id: 'a' }, { id: 'b' }])
  assert.equal(parsed.diagnostics.length, 1)
  assert.equal(parsed.diagnostics[0]?.line, 2)
  assert.equal(parsed.diagnostics[0]?.raw, '{not valid json')
})
