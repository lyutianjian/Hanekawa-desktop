import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

test('Write keeps the mode of the file it replaces', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'run.sh')
    await writeFile(file, 'one\n', 'utf8')
    await chmod(file, 0o755)
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'run.sh' }, ctx)

    const result = await writeFileTool.execute({ filePath: 'run.sh', content: 'two\n' }, ctx)

    assert.equal(result.ok, true, result.content)
    assert.equal((await stat(file)).mode & 0o777, 0o755)
  })
})

test('Edit keeps a 0600 file private', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'secret.env')
    await writeFile(file, 'TOKEN=one\n', 'utf8')
    await chmod(file, 0o600)
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'secret.env' }, ctx)

    const result = await editFileTool.execute({ filePath: 'secret.env', oldString: 'one', newString: 'two' }, ctx)

    assert.equal(result.ok, true, result.content)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  })
})

test('a new file keeps the umask default mode', async () => {
  await withTempDir(async (dir) => {
    const result = await writeFileTool.execute({ filePath: 'fresh.txt', content: 'x\n' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.equal((await stat(path.join(dir, 'fresh.txt'))).mode & 0o777, 0o666 & ~process.umask())
  })
})

test('a failed atomic write leaves no temp file behind', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'not-a-file')
    await mkdir(target)

    await assert.rejects(writeFileTool.execute({ filePath: 'not-a-file', content: 'x\n' }, context(dir)))

    assert.deepEqual(await readdir(dir), ['not-a-file'])
    assert.deepEqual(await readdir(target), [])
  })
})

test('a UTF-16LE file keeps exactly one BOM and its CRLF through Read, Write and Edit', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cn.txt')
    await writeFile(file, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('标题\r\n第二行\r\n', 'utf16le'),
    ]))
    const ctx = context(dir)

    const read = await readFileTool.execute({ filePath: 'cn.txt' }, ctx)
    assert.equal(read.ok, true, read.content)
    assert.equal(read.content.includes('\uFEFF'), false)

    const overwrite = await writeFileTool.execute({ filePath: 'cn.txt', content: '标题\n第三行\n' }, ctx)
    assert.equal(overwrite.ok, true, overwrite.content)

    const bytes = await readFile(file)
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe])
    assert.equal(bytes.subarray(2).toString('utf16le'), '标题\r\n第三行\r\n')

    const reread = await readFileTool.execute({ filePath: 'cn.txt' }, ctx)
    assert.equal(reread.ok, true, reread.content)
    assert.equal(reread.content.includes('\uFFFD'), false)

    const edited = await editFileTool.execute({ filePath: 'cn.txt', oldString: '第三行', newString: '第四行' }, ctx)
    assert.equal(edited.ok, true, edited.content)

    const after = await readFile(file)
    assert.deepEqual([...after.subarray(0, 2)], [0xff, 0xfe])
    assert.equal(after.subarray(2).toString('utf16le'), '标题\r\n第四行\r\n')
  })
})

test('a UTF-8 BOM is not shown to the model and is not doubled on write', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'bom.txt')
    await writeFile(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('one\ntwo\n', 'utf8'),
    ]))
    const ctx = context(dir)

    const read = await readFileTool.execute({ filePath: 'bom.txt' }, ctx)
    assert.equal(read.ok, true, read.content)
    assert.equal(read.content.includes('\uFEFF'), false)

    const edited = await editFileTool.execute({ filePath: 'bom.txt', oldString: 'two', newString: 'TWO' }, ctx)
    assert.equal(edited.ok, true, edited.content)

    const bytes = await readFile(file)
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(bytes.subarray(3).toString('utf8'), 'one\nTWO\n')
  })
})

test('UTF-8 without a BOM stays without one', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'plain.txt')
    await writeFile(file, 'one\ntwo\n', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'plain.txt' }, ctx)

    await editFileTool.execute({ filePath: 'plain.txt', oldString: 'two', newString: 'TWO' }, ctx)

    assert.deepEqual([...(await readFile(file)).subarray(0, 3)], [...Buffer.from('one')])
  })
})

test('a U+FEFF in the body of a file is preserved, not mistaken for a BOM', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'zero-width.txt')
    await writeFile(file, 'alpha\uFEFFbeta\n', 'utf8')
    const ctx = context(dir)

    const read = await readFileTool.execute({ filePath: 'zero-width.txt' }, ctx)
    assert.equal(read.ok, true, read.content)
    assert.equal(read.content.includes('alpha\uFEFFbeta'), true)

    await editFileTool.execute({ filePath: 'zero-width.txt', oldString: 'beta', newString: 'gamma' }, ctx)

    assert.equal(await readFile(file, 'utf8'), 'alpha\uFEFFgamma\n')
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

test('a failed atomic write keeps the original bytes, mode and read state', async () => {
  if (process.getuid?.() === 0) return
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'old\n', 'utf8')
    await chmod(file, 0o600)
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const remembered = ctx.readFileState?.get(file)

    await chmod(dir, 0o555)
    try {
      await assert.rejects(writeFileTool.execute({ filePath: 'a.txt', content: 'new\n' }, ctx))
    } finally {
      await chmod(dir, 0o755)
    }

    assert.equal(await readFile(file, 'utf8'), 'old\n')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(dir), ['a.txt'])
    assert.equal(ctx.readFileState?.get(file), remembered)
  })
})
