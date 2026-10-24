import { chmod, mkdtemp, rm, writeFile, readFile, readdir, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { notebookEditTool } from '../src/tools/NotebookEditTool/NotebookEditTool.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { editFileTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { multiEditTool } from '../src/tools/MultiEditTool/MultiEditTool.js'
import type { ReadFileState } from '../src/harness/types.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>(), readFileState: new Map<string, ReadFileState>() }
}

function makeNotebook(cells: Array<{ cell_type: string; source: string; id?: string }>, nbformat = 4, nbformat_minor = 4) {
  return {
    cells: cells.map((c, i) => ({
      cell_type: c.cell_type,
      source: c.source.split('\n').map((line, j, arr) => (j < arr.length - 1 ? `${line}\n` : line)),
      metadata: {} as Record<string, unknown>,
      ...(c.cell_type === 'code' ? { execution_count: i + 1, outputs: [] as unknown[] } : {}),
      ...(c.id ? { id: c.id } : {}),
    })),
    metadata: { language_info: { name: 'python' } } as Record<string, unknown>,
    nbformat,
    nbformat_minor,
  }
}

// ── Tool registration ──────────────────────────────────────────────────────────

test('NotebookEdit tool is registered with correct properties', () => {
  assert.equal(notebookEditTool.name, 'NotebookEdit')
  assert.equal(notebookEditTool.riskLevel, 'confirm')
  assert.equal(notebookEditTool.isReadOnly, false)
  assert.ok(notebookEditTool.description.length > 0)
})

// ── Extension validation ───────────────────────────────────────────────────────

test('NotebookEdit rejects non-.ipynb files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    await writeFile(path.join(dir, 'test.txt'), 'hello', 'utf8')
    const result = await notebookEditTool.execute(
      { notebook_path: 'test.txt', new_source: 'hello', edit_mode: 'replace', cell_id: 'cell-0' },
      context(dir),
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /not a \.ipynb file/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Read-before-edit enforcement ───────────────────────────────────────────────

test('NotebookEdit refuses to edit unread notebook', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'print("hello")', id: 'abc' }])
    await writeFile(path.join(dir, 'test.ipynb'), JSON.stringify(nb), 'utf8')

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'print("world")' },
      context(dir),
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── REPLACE mode ──────────────────────────────────────────────────────────────

test('NotebookEdit replace updates cell source', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'print("hello")', id: 'cell-0' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'cell-0', new_source: 'print("world")' },
      ctx,
    )
    assert.equal(result.ok, true)
    assert.match(result.metadata?.display?.summary ?? '', /Updated cell/)
    // The patch is over the cell's source, not the .ipynb JSON.
    assert.equal(
      result.metadata?.display?.detail,
      [
        '--- a/test.ipynb#cell-0',
        '+++ b/test.ipynb#cell-0',
        '@@ -1,1 +1,1 @@',
        '-print("hello")',
        '\\ No newline at end of file',
        '+print("world")',
        '\\ No newline at end of file',
      ].join('\n'),
    )

    // Verify the file was updated
    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.deepEqual(updated.cells[0].source, ['print("world")'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit replace resets execution_count and outputs for code cells', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'x = 1', id: 'abc' }])
    nb.cells[0].execution_count = 42
    nb.cells[0].outputs = [{ output_type: 'execute_result', data: { 'text/plain': '1' } }]
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'x = 2' },
      ctx,
    )

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.cells[0].execution_count, null)
    assert.deepEqual(updated.cells[0].outputs, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit replace by cell-N index', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([
      { cell_type: 'code', source: 'a = 1', id: 'id-a' },
      { cell_type: 'code', source: 'b = 2', id: 'id-b' },
    ])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'cell-1', new_source: 'b = 99' },
      ctx,
    )
    assert.equal(result.ok, true)

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.deepEqual(updated.cells[1].source, ['b = 99'])
    // First cell should be unchanged
    assert.deepEqual(updated.cells[0].source, ['a = 1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── INSERT mode ───────────────────────────────────────────────────────────────

test('NotebookEdit insert creates new cell after referenced cell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: '# comment', cell_type: 'markdown', edit_mode: 'insert' },
      ctx,
    )
    assert.equal(result.ok, true)
    assert.match(result.metadata?.display?.summary ?? '', /Inserted/)
    assert.equal(
      result.metadata?.display?.detail,
      [
        '--- a/test.ipynb#cell-1',
        '+++ b/test.ipynb#cell-1',
        '@@ -0,0 +1,1 @@',
        '+# comment',
        '\\ No newline at end of file',
      ].join('\n'),
    )

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.cells.length, 2)
    assert.equal(updated.cells[1].cell_type, 'markdown')
    assert.deepEqual(updated.cells[1].source, ['# comment'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit insert at position 0 when no cell_id', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', new_source: '# header', cell_type: 'markdown', edit_mode: 'insert' },
      ctx,
    )
    assert.equal(result.ok, true)

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.cells.length, 2)
    assert.equal(updated.cells[0].cell_type, 'markdown')
    assert.deepEqual(updated.cells[0].source, ['# header'])
    // Original cell should be at index 1 now
    assert.equal(updated.cells[1].cell_type, 'code')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit insert requires cell_type', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'x', edit_mode: 'insert' },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /cell_type.*required/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit insert generates cell ID for nbformat >= 4.5', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }], 4, 5)
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'b = 2', cell_type: 'code', edit_mode: 'insert' },
      ctx,
    )

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.cells.length, 2)
    assert.ok(updated.cells[1].id, 'Inserted cell should have an ID')
    assert.ok(typeof updated.cells[1].id === 'string')
    assert.ok(updated.cells[1].id.length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── DELETE mode ───────────────────────────────────────────────────────────────

test('NotebookEdit delete removes cell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([
      { cell_type: 'code', source: 'a = 1', id: 'id-a' },
      { cell_type: 'code', source: 'b = 2', id: 'id-b' },
    ])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'id-a', new_source: '', edit_mode: 'delete' },
      ctx,
    )
    assert.equal(result.ok, true)
    assert.match(result.metadata?.display?.summary ?? '', /Deleted/)
    assert.equal(
      result.metadata?.display?.detail,
      [
        '--- a/test.ipynb#cell-0',
        '+++ b/test.ipynb#cell-0',
        '@@ -1,1 +0,0 @@',
        '-a = 1',
        '\\ No newline at end of file',
      ].join('\n'),
    )

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.cells.length, 1)
    assert.deepEqual(updated.cells[0].source, ['b = 2'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit delete requires cell_id', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', new_source: '', edit_mode: 'delete' },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /cell_id.*required/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Error cases ───────────────────────────────────────────────────────────────

test('NotebookEdit rejects non-existent cell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'nonexistent', new_source: 'x' },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'not_found')
    assert.match(result.content, /not found/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit rejects invalid JSON', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, 'not json{', 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'x' },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /not valid JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Preserves notebook metadata ───────────────────────────────────────────────

test('NotebookEdit preserves notebook metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    nb.metadata = { language_info: { name: 'python', version: '3.11' }, kernelspec: { name: 'python3' } }
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'a = 2' },
      ctx,
    )

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.metadata.language_info.name, 'python')
    assert.equal(updated.metadata.language_info.version, '3.11')
    assert.equal(updated.metadata.kernelspec.name, 'python3')
    assert.equal(updated.nbformat, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Append when replace targets past-end index ────────────────────────────────

test('NotebookEdit replace at past-end index converts to append', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'cell-1', new_source: 'b = 2', cell_type: 'code' },
      ctx,
    )
    assert.equal(result.ok, true)
    assert.match(result.content, /Appended/)

    const updated = JSON.parse(await readFile(nbPath, 'utf8'))
    assert.equal(updated.cells.length, 2)
    assert.deepEqual(updated.cells[1].source, ['b = 2'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Edit/MultiEdit .ipynb guard ───────────────────────────────────────────────

test('Edit tool rejects .ipynb files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await editFileTool.execute(
      { filePath: 'test.ipynb', oldString: 'a = 1', newString: 'a = 2' },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /NotebookEdit/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MultiEdit tool rejects .ipynb files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await multiEditTool.execute(
      { filePath: 'test.ipynb', edits: [{ oldString: 'a = 1', newString: 'a = 2' }] },
      ctx,
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /NotebookEdit/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── The notebook's own encoding, line endings and trailing newline ─────────────

test('NotebookEdit preserves BOM, CRLF, the trailing newline and the file mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const body = JSON.stringify(nb, null, 1).replaceAll('\n', '\r\n')
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${body}\r\n`, 'utf8'),
    ]))
    await chmod(nbPath, 0o755)
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'a = 2' },
      ctx,
    )
    assert.equal(result.ok, true, result.content)

    const bytes = await readFile(nbPath)
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    const text = bytes.subarray(3).toString('utf8')
    assert.equal(text.endsWith('\r\n'), true)
    assert.equal(text.replaceAll('\r\n', '').includes('\n'), false)
    assert.deepEqual(JSON.parse(text).cells[0].source, ['a = 2'])
    assert.equal((await stat(nbPath)).mode & 0o777, 0o755)
    assert.deepEqual(await readdir(dir), ['test.ipynb'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit keeps CRLF and a trailing newline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const body = JSON.stringify(nb, null, 1).replaceAll('\n', '\r\n')
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, `${body}\r\n`, 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'a = 2' },
      ctx,
    )
    assert.equal(result.ok, true, result.content)

    const text = await readFile(nbPath, 'utf8')
    assert.equal(text.endsWith('\r\n'), true)
    assert.equal(text.replaceAll('\r\n', '').includes('\n'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NotebookEdit keeps LF and no trailing newline when the notebook had none', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    await writeFile(nbPath, JSON.stringify(nb, null, 1), 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    const result = await notebookEditTool.execute(
      { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'a = 2' },
      ctx,
    )
    assert.equal(result.ok, true, result.content)

    const text = await readFile(nbPath, 'utf8')
    assert.equal(text.endsWith('\n'), false)
    assert.equal(text.includes('\r'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed notebook write leaves the file and its directory clean', async () => {
  if (process.getuid?.() === 0) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-nb-'))
  try {
    const nb = makeNotebook([{ cell_type: 'code', source: 'a = 1', id: 'abc' }])
    const nbPath = path.join(dir, 'test.ipynb')
    const original = `${JSON.stringify(nb, null, 1)}\n`
    await writeFile(nbPath, original, 'utf8')
    const ctx = context(dir)
    await readFileTool.execute({ filePath: 'test.ipynb' }, ctx)

    await chmod(dir, 0o555)
    try {
      await assert.rejects(notebookEditTool.execute(
        { notebook_path: 'test.ipynb', cell_id: 'abc', new_source: 'a = 2' },
        ctx,
      ))
    } finally {
      await chmod(dir, 0o755)
    }

    assert.equal(await readFile(nbPath, 'utf8'), original)
    assert.deepEqual(await readdir(dir), ['test.ipynb'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
