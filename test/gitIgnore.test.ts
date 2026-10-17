import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gitIgnoredPaths } from '../src/utils/gitIgnore.js'

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
