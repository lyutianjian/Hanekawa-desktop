import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReadFileState, ToolContext } from '../src/harness/types.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { editFileTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { multiEditTool } from '../src/tools/MultiEditTool/MultiEditTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import { deleteFileTool } from '../src/tools/FileDeleteTool/FileDeleteTool.js'
import { notebookEditTool } from '../src/tools/NotebookEditTool/NotebookEditTool.js'
import { bashTool } from '../src/tools/BashTool/BashTool.js'
import { readTextFile } from '../src/tools/textFile.js'

function context(cwd: string, tracked: string[], onTrack?: () => void): ToolContext {
  return {
    cwd,
    sessionId: 's1',
    readFiles: new Set<string>(),
    readFileState: new Map<string, ReadFileState>(),
    async trackFileEdit(filePath) {
      tracked.push(filePath)
      onTrack?.()
    },
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-track-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const NOTEBOOK = JSON.stringify({
  cells: [{ id: 'c1', cell_type: 'code', source: 'print(1)\n', metadata: {}, execution_count: null, outputs: [] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
})

test('write tools report the edited path before touching it', async () => {
  await withTempDir(async (dir) => {
    const tracked: string[] = []
    const ctx = context(dir, tracked)

    await writeFile(path.join(dir, 'a.txt'), 'alpha\n', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'beta\n', 'utf8')
    await writeFile(path.join(dir, 'd.txt'), 'delta\n', 'utf8')
    await writeFile(path.join(dir, 'n.ipynb'), NOTEBOOK, 'utf8')
    for (const name of ['a.txt', 'b.txt', 'd.txt', 'n.ipynb']) {
      await readFileTool.execute({ filePath: name }, ctx)
    }

    assert.equal((await editFileTool.execute({ filePath: 'a.txt', oldString: 'alpha', newString: 'ALPHA' }, ctx)).ok, true)
    assert.equal((await multiEditTool.execute({ filePath: 'b.txt', edits: [{ oldString: 'beta', newString: 'BETA' }] }, ctx)).ok, true)
    assert.equal((await writeFileTool.execute({ filePath: 'c.txt', content: 'gamma\n' }, ctx)).ok, true)
    assert.equal((await deleteFileTool.execute({ filePath: 'd.txt' }, ctx)).ok, true)
    const notebook = await notebookEditTool.execute({ notebook_path: 'n.ipynb', new_source: 'print(2)\n', cell_id: 'c1' }, ctx)
    assert.equal(notebook.ok, true, notebook.content)

    assert.deepEqual(tracked, ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'n.ipynb'].map((name) => path.join(dir, name)))
  })
})

test('Bash reports its redirection target before the command runs', async () => {
  await withTempDir(async (dir) => {
    const tracked: string[] = []
    const ctx = context(dir, tracked, () => {
      // The backup has to happen while the old content is still on disk.
      assert.equal(existsSync(path.join(dir, 'a.txt')), true)
    })
    await writeFile(path.join(dir, 'a.txt'), 'alpha\n', 'utf8')

    const result = await bashTool.execute({ command: 'echo beta > a.txt' }, ctx)
    assert.equal(result.ok, true, result.content)
    assert.deepEqual(tracked, [path.join(dir, 'a.txt')])
    // Windows PowerShell redirection writes UTF-16LE; inspect the text with the
    // same encoding-aware reader as the file tools, independent of shell choice.
    assert.equal((await readTextFile(path.join(dir, 'a.txt'))).content.trim(), 'beta')
  })
})

test('a throwing track hook does not fail the write', async () => {
  await withTempDir(async (dir) => {
    const tracked: string[] = []
    const ctx = context(dir, tracked, () => {
      throw new Error('backup unavailable')
    })

    const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'alpha\n' }, ctx)
    assert.equal(result.ok, true, result.content)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'alpha\n')
  })
})

test('write tools work without a track hook', async () => {
  await withTempDir(async (dir) => {
    const ctx: ToolContext = { cwd: dir, sessionId: 's1', readFiles: new Set(), readFileState: new Map() }
    const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'alpha\n' }, ctx)
    assert.equal(result.ok, true, result.content)
  })
})
