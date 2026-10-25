import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { gitIgnoredPaths } from '../src/utils/gitIgnore.js'

test('gitignore preserves Unicode, whitespace and embedded separators in filenames', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'gitignore-nul-'))
  const ignored = ['中文.txt', ' leading.txt', 'trailing.txt ', 'new\nline.txt', 'tab\tname.txt', 'back\\slash.txt', 'normal.txt']
  try {
    await promisify(execFile)('git', ['init', cwd])
    await writeFile(path.join(cwd, '.gitignore'), '*.txt*\n')
    const result = await gitIgnoredPaths(cwd, [...ignored, 'visible.ts'])
    assert.deepEqual(result, new Set(ignored))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('outside a repository git exits before reading stdin, and the paths still come back unfiltered', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-gitignore-'))
  try {
    // Far more than a pipe buffer, so the write is still pending when git exits.
    const paths = Array.from({ length: 20_000 }, (_, index) => `src/deep/path/file-${index}.ts`)
    assert.equal((await gitIgnoredPaths(dir, paths)).size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
