import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReadFileState } from '../src/harness/types.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { editFileTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { multiEditTool } from '../src/tools/MultiEditTool/MultiEditTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import { grepTool } from '../src/tools/GrepTool/GrepTool.js'
import { applyLineEndings, detectLineEndings } from '../src/tools/textFile.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>(), readFileState: new Map<string, ReadFileState>() }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-eol-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('detectLineEndings picks the dominant style', () => {
  assert.equal(detectLineEndings('a\r\nb\r\nc'), 'CRLF')
  assert.equal(detectLineEndings('a\nb\nc'), 'LF')
  assert.equal(detectLineEndings('no newlines'), 'LF')
})

test('applyLineEndings does not double a carriage return already present', () => {
  assert.equal(applyLineEndings('a\r\nb', 'CRLF'), 'a\r\nb')
  assert.equal(applyLineEndings('a\nb', 'CRLF'), 'a\r\nb')
  assert.equal(applyLineEndings('a\r\nb', 'LF'), 'a\r\nb')
})

test('Read normalizes CRLF so an LF oldString still edits the file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'clash.yaml')
    await writeFile(file, 'proxies:\r\n  - name: Tokyo\r\n    type: ss\r\n', 'utf8')
    const ctx = context(dir)

    const read = await readFileTool.execute({ filePath: 'clash.yaml' }, ctx)
    assert.equal(read.ok, true)
    assert.equal(read.content.includes('\r'), false)

    // The model writes \n. Before normalization this matched zero times.
    const result = await editFileTool.execute({
      filePath: 'clash.yaml',
      oldString: '  - name: Tokyo\n    type: ss',
      newString: '  - name: Osaka\n    type: vmess',
    }, ctx)

    assert.equal(result.ok, true, result.content)
    const onDisk = await readFile(file, 'utf8')
    assert.equal(onDisk, 'proxies:\r\n  - name: Osaka\r\n    type: vmess\r\n')
  })
})

test('MultiEdit preserves CRLF and matches LF oldStrings', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'alpha\nbeta', newString: 'ALPHA\nBETA' },
        { oldString: 'gamma', newString: 'GAMMA' },
      ],
    }, ctx)

    assert.equal(result.ok, true, result.content)
    assert.equal(await readFile(file, 'utf8'), 'ALPHA\r\nBETA\r\nGAMMA\r\n')
  })
})

test('an LF file stays LF through an edit', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'one\ntwo', newString: 'ONE\nTWO' }, ctx)
    assert.equal(result.ok, true, result.content)
    assert.equal(await readFile(file, 'utf8'), 'ONE\nTWO\n')
  })
})

test('a newString carrying CRLF does not produce a doubled carriage return', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'one\r\ntwo\r\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'one', newString: 'first\r\nline' }, ctx)
    assert.equal(result.ok, true, result.content)
    const onDisk = await readFile(file, 'utf8')
    assert.equal(onDisk.includes('\r\r'), false)
    assert.equal(onDisk, 'first\r\nline\r\ntwo\r\n')
  })
})

test('Write keeps an existing file CRLF and writes a new file LF', async () => {
  await withTempDir(async (dir) => {
    const existing = path.join(dir, 'existing.txt')
    await writeFile(existing, 'one\r\ntwo\r\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'existing.txt' }, ctx)

    const overwrite = await writeFileTool.execute({ filePath: 'existing.txt', content: 'three\nfour\n' }, ctx)
    assert.equal(overwrite.ok, true, overwrite.content)
    assert.equal(await readFile(existing, 'utf8'), 'three\r\nfour\r\n')

    const created = await writeFileTool.execute({ filePath: 'fresh.txt', content: 'a\nb\n' }, ctx)
    assert.equal(created.ok, true, created.content)
    assert.equal(await readFile(path.join(dir, 'fresh.txt'), 'utf8'), 'a\nb\n')
  })
})

test('Edit replaceAll changes every occurrence', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'x\ntarget\ny\ntarget\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'target', newString: 'done', replaceAll: true }, ctx)
    assert.equal(result.ok, true, result.content)
    assert.equal(await readFile(file, 'utf8'), 'x\ndone\ny\ndone\n')
  })
})

test('a zero-match edit says the text is missing and names the whitespace cause', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'def run():\n    return 1\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'def run():\n  return 1', newString: 'x' }, ctx)
    assert.equal(result.ok, false)
    assert.match(result.content, /String to replace not found in file/)
    assert.match(result.content, /whitespace differs/)
    assert.match(result.content, /Lines 1-2 as they appear in the file:\ndef run\(\):\n {4}return 1\n/)
    assert.equal((result.errorDetails as { occurrences?: number }).occurrences, 0)
  })
})

test('Read windows the output with offset and limit but still lets Edit reach the rest', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, ['one', 'two', 'three', 'four', 'five'].join('\n') + '\n', 'utf8')
    const ctx = context(dir)

    const read = await readFileTool.execute({ filePath: 'a.txt', offset: 2, limit: 2 }, ctx)
    assert.equal(read.ok, true)
    assert.match(read.content, /^\s+2\ttwo\n\s+3\tthree/)
    assert.doesNotMatch(read.content, /\bfour\b/)
    assert.match(read.content, /\[Showing lines 2-3 of 5\./)

    // The whole file is remembered, so an unshown line is still editable.
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'five', newString: 'FIVE' }, ctx)
    assert.equal(result.ok, true, result.content)
  })
})

test('Read refuses an offset past the end of the file', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n', 'utf8')
    const result = await readFileTool.execute({ filePath: 'a.txt', offset: 9 }, context(dir))
    assert.equal(result.ok, false)
    assert.match(result.content, /has only 2 lines/)
  })
})

test('Grep accepts a file as its path instead of failing with ENOTDIR', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'clash.yaml')
    await writeFile(file, 'proxies:\n  - name: Tokyo-CF\n  - name: Osaka\n', 'utf8')

    const result = await grepTool.execute({ pattern: 'Tokyo-CF', path: 'clash.yaml' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /clash\.yaml:2:/)
  })
})

test('Grep reports a missing path instead of leaking an fs errno', async () => {
  await withTempDir(async (dir) => {
    const result = await grepTool.execute({ pattern: 'anything', path: 'nope.yaml' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'not_found')
    assert.match(result.content, /does not exist/)
    assert.doesNotMatch(result.content, /ENOENT|ENOTDIR/)
  })
})

test('Grep with no matches answers cleanly rather than falling back', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'a.txt'), 'nothing here\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'zzz-absent-zzz', path: 'a.txt' }, context(dir))
    assert.equal(result.ok, true)
    assert.equal(result.content, 'No matches found.')
  })
})
