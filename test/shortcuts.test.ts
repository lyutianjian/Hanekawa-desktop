import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { filePathCompleter } from '../src/utils/pathCompleter.js'

// ─── filePathCompleter ──────────────────────────────────────────────────

describe('filePathCompleter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hanekawa-completer-'))
    mkdirSync(join(tmpDir, 'subdir'))
    writeFileSync(join(tmpDir, 'file-a.txt'), '')
    writeFileSync(join(tmpDir, 'file-b.txt'), '')
    writeFileSync(join(tmpDir, 'other.log'), '')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completes file names by prefix', () => {
    const line = join(tmpDir, 'file')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 2)
    assert(completions.some((c) => c.endsWith('file-a.txt')))
    assert(completions.some((c) => c.endsWith('file-b.txt')))
  })

  it('completes directory names with trailing slash', () => {
    const line = join(tmpDir, 'sub')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 1)
    assert(completions[0].endsWith('/'))
  })

  it('returns empty for no matches', () => {
    const line = join(tmpDir, 'nonexistent')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 0)
  })

  it('shows all files in cwd for empty token', () => {
    // Change to temp directory so we can control the entries
    const originalCwd = process.cwd()
    try {
      process.chdir(tmpDir)
      // Empty token lists all entries in temp dir (subdir, file-a.txt, file-b.txt, other.log)
      const [completions] = filePathCompleter('')
      assert(completions.length >= 4)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('completes partial paths after a space (multi-word input)', () => {
    const line = 'some text ' + join(tmpDir, 'file')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 2)
  })

  it('handles nonexistent directory gracefully', () => {
    const line = '/nonexistent/path/file'
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 0)
  })

  it('resolves relative tokens against an explicit cwd, not process.cwd()', () => {
    // No chdir: the completer must not consult the process working directory.
    const [empty] = filePathCompleter('', tmpDir)
    assert(empty.length >= 4)

    const [prefixed] = filePathCompleter('file', tmpDir)
    assert.deepEqual(prefixed.sort(), ['file-a.txt', 'file-b.txt'])

    const [nested] = filePathCompleter('subdir/', tmpDir)
    assert.equal(nested.length, 0)
  })
})

// ─── History functions ──────────────────────────────────────────────────
