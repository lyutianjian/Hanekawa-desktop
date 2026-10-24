import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { getBuiltinTools } from '../src/tools/index.js'
import type { ReadFileState, Tool } from '../src/harness/types.js'
import { grepTool } from '../src/tools/GrepTool/GrepTool.js'
import {
  bashTool,
  createBashTool,
  detectSleepPattern,
  isAutobackgroundingAllowed,
  resolveBashTimeoutMs,
  DEFAULT_BASH_TIMEOUT_MS,
} from '../src/tools/BashTool/BashTool.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { editFileTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { multiEditTool } from '../src/tools/MultiEditTool/MultiEditTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import { deleteFileTool } from '../src/tools/FileDeleteTool/FileDeleteTool.js'
import { buildUnifiedPatch } from '../src/tools/editPatch.js'
import { rememberShownFiles } from '../src/tools/fileState.js'
import { toolSearchTool } from '../src/tools/ToolSearchTool/ToolSearchTool.js'
import { getToolSearchMode, getAutoThreshold, resetToolSearchCache, resolveToolSearchState } from '../src/utils/toolSearch.js'
import { BackgroundTaskRegistry, defaultBackgroundTaskRegistry } from '../src/services/backgroundTasks/registry.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>() }
}

function searchTestTool(name: string, options: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
    ...options,
  }
}

test('grep finds matching lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\nworld\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'hello', glob: '**/*.txt' }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /a.txt:1/)
    assert.equal(result.metadata?.display?.summary, 'Found 1 match across 1 file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep headLimit caps total matches across files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hit a1\nhit a2\nhit a3\n', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'hit b1\nhit b2\nhit b3\n', 'utf8')

    const result = await grepTool.execute({ pattern: 'hit', glob: '**/*.txt', headLimit: 4 }, context(dir))

    assert.equal(result.ok, true)
    const matchLines = result.content.split('\n').filter((line) => /^[ab]\.txt:\d+:/.test(line))
    assert.equal(matchLines.length, 4)
    assert.equal(result.metadata?.display?.summary, 'Found 4 matches across 2 files')
    // 6 matches exist; the model must be told the list was cut short.
    assert.match(result.content, /\[Showing results 1\.\.4 of 6 total matches\]/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('read and glob tools return structured TUI summaries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'other\n', 'utf8')

    const readResult = await readFileTool.execute({ filePath: 'a.txt' }, context(dir))
    assert.equal(readResult.ok, true)
    assert.equal(readResult.metadata?.display?.summary, 'Read 3 lines')

    const globResult = await getBuiltinTools()
      .find((tool) => tool.name === 'Glob')!
      .execute({ pattern: '*.txt' }, context(dir))
    assert.equal(globResult.ok, true)
    assert.equal(globResult.metadata?.display?.summary, 'Found 2 files')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob skips gitignored trees, keeps dotfiles opt-in and caps results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const glob = getBuiltinTools().find((tool) => tool.name === 'Glob')!
    await mkdir(path.join(dir, '.git'))
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(path.join(dir, 'src'))
    await mkdir(path.join(dir, '.myagent'))
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8')
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.ts'), '', 'utf8')
    await writeFile(path.join(dir, 'src', 'a.ts'), '', 'utf8')
    await writeFile(path.join(dir, 'top.ts'), '', 'utf8')
    await writeFile(path.join(dir, '.myagent', 'notes.md'), '', 'utf8')

    const all = await glob.execute({ pattern: '**/*.ts' }, context(dir))
    assert.deepEqual(all.content.split('\n').sort(), ['src/a.ts', 'top.ts'])
    const top = await glob.execute({ pattern: '*.ts' }, context(dir))
    assert.equal(top.content, 'top.ts')
    assert.equal((await glob.execute({ pattern: '**/*.md' }, context(dir))).content, 'No files found.')
    assert.equal((await glob.execute({ pattern: '.myagent/**/*.md' }, context(dir))).content, '.myagent/notes.md')

    assert.equal((await glob.execute({ pattern: './src/*.ts' }, context(dir))).content, 'src/a.ts')
    assert.equal((await glob.execute({ pattern: 'missing/**/*.ts' }, context(dir))).content, 'No files found.')
    assert.equal((await glob.execute({ pattern: 'README.md' }, context(dir))).content, 'No files found.')
    assert.equal((await glob.execute({ pattern: `${dir}/src/*.ts` }, context(dir))).content, `${dir}/src/a.ts`)
    assert.equal((await glob.execute({ pattern: '../*.ts' }, context(path.join(dir, 'src')))).content, '../top.ts')
    assert.equal((await glob.execute({ pattern: 'node_modules/pkg/*.ts' }, context(dir))).content, 'node_modules/pkg/index.ts')

    for (let i = 0; i < 205; i += 1) await writeFile(path.join(dir, 'src', `f${i}.txt`), '', 'utf8')
    const many = await glob.execute({ pattern: 'src/*.txt' }, context(dir))
    assert.match(many.content, /\[Showing 200 of 205 files;/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash reports nonzero exits as command_failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'exit 7' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'command_failed')
    assert.deepEqual((result.errorDetails as { exitCode?: number }).exitCode, 7)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveBashTimeoutMs defaults to 60s and has no max unless the environment sets one', () => {
  assert.equal(resolveBashTimeoutMs(undefined, {}), DEFAULT_BASH_TIMEOUT_MS)
  assert.equal(resolveBashTimeoutMs(50, {}), 50)
  assert.equal(resolveBashTimeoutMs(3_600_000, {}), 3_600_000)
  assert.equal(resolveBashTimeoutMs(undefined, { MYAGENT_BASH_DEFAULT_TIMEOUT_MS: '5000' }), 5_000)
  assert.equal(resolveBashTimeoutMs(8000, { MYAGENT_BASH_MAX_TIMEOUT_MS: '6000', MYAGENT_BASH_DEFAULT_TIMEOUT_MS: '1000' }), 6_000)
})

test('isAutobackgroundingAllowed rejects leading sleep only', () => {
  assert.equal(isAutobackgroundingAllowed('sleep 5'), false)
  assert.equal(isAutobackgroundingAllowed('/bin/sleep 5'), false)
  assert.equal(isAutobackgroundingAllowed('bash -c "sleep 30"'), true)
  assert.equal(isAutobackgroundingAllowed('node -e "setTimeout(()=>{}, 1000)"'), true)
})

test('bash hard-timeouts leading sleep that is allowed to run', async () => {
  // sleep < 2s is not blocked by detectSleepPattern, but must not auto-background.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({
      command: 'sleep 1',
      timeout: 50,
    }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'timeout')
    assert.deepEqual((result.errorDetails as { timeoutMs?: number }).timeoutMs, 50)
    assert.doesNotMatch(result.content, /Task ID:/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash timeout auto-backgrounds long non-sleep commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  const registry = new BackgroundTaskRegistry()
  const tool = createBashTool(registry)
  const ctx = { ...context(dir), sessionId: 'auto-bg-1' }
  try {
    const started = Date.now()
    const result = await tool.execute({
      command: 'node -e "setTimeout(() => {}, 5000)"',
      timeout: 100,
    }, ctx)
    const elapsed = Date.now() - started
    assert.equal(result.ok, true)
    assert.match(result.content, /moved to the background/)
    assert.match(result.content, /Task ID: bash_\d+/)
    assert.ok(elapsed < 2_000, `auto-bg hung for ${elapsed}ms`)

    const idMatch = /Task ID: (bash_\d+)/.exec(result.content)
    assert.ok(idMatch?.[1])
    const task = registry.getTask(ctx.sessionId, idMatch[1]!)
    assert.ok(task)
    assert.equal(task.status, 'running')
  } finally {
    await registry.stopAll(ctx.sessionId, 'test cleanup')
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash timeout auto-background preserves process output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  const registry = new BackgroundTaskRegistry()
  const tool = createBashTool(registry)
  const ctx = { ...context(dir), sessionId: 'auto-bg-out' }
  try {
    const result = await tool.execute({
      command: 'node -e "setTimeout(() => { console.log(\'late-output\') }, 400)"',
      timeout: 80,
    }, ctx)
    assert.equal(result.ok, true)
    const idMatch = /Task ID: (bash_\d+)/.exec(result.content)
    assert.ok(idMatch?.[1])

    const outputPath = registry.getTask(ctx.sessionId, idMatch[1]!)?.outputPath
    assert.ok(outputPath)
    for (let i = 0; i < 100 && registry.getTask(ctx.sessionId, idMatch[1]!)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.match(await readFile(outputPath, 'utf8'), /late-output/)
  } finally {
    await registry.stopAll(ctx.sessionId, 'test cleanup')
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash nested sleep timeout auto-backgrounds promptly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  const registry = new BackgroundTaskRegistry()
  const tool = createBashTool(registry)
  const ctx = { ...context(dir), sessionId: 'nested-bg' }
  try {
    // Nested sleep is not blocked by detectSleepPattern; timeout should
    // auto-background (not hang waiting for 'close').
    const started = Date.now()
    const result = await tool.execute({
      command: 'bash -c "sleep 30"',
      timeout: 200,
    }, ctx)
    const elapsed = Date.now() - started
    assert.equal(result.ok, true)
    assert.match(result.content, /Task ID: bash_\d+/)
    assert.ok(elapsed < 4_000, `nested bash auto-bg hung for ${elapsed}ms`)
  } finally {
    await registry.stopAll(ctx.sessionId, 'test cleanup')
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash subshell sleep timeout auto-backgrounds promptly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  const registry = new BackgroundTaskRegistry()
  const tool = createBashTool(registry)
  const ctx = { ...context(dir), sessionId: 'subshell-bg' }
  try {
    const started = Date.now()
    const result = await tool.execute({
      command: '( sleep 30 )',
      timeout: 200,
    }, ctx)
    const elapsed = Date.now() - started
    assert.equal(result.ok, true)
    assert.match(result.content, /Task ID: bash_\d+/)
    assert.ok(elapsed < 4_000, `subshell auto-bg hung for ${elapsed}ms`)
  } finally {
    await registry.stopAll(ctx.sessionId, 'test cleanup')
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses editing before readFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, context(dir))
    assert.equal(result.ok, false)
    assert.match(result.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile edits after readFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'hi\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile caps lines, long lines and tokens while Edit still reaches the whole file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`)
    await writeFile(path.join(dir, 'long.txt'), `${lines.join('\n')}\n`, 'utf8')
    const result = await readFileTool.execute({ filePath: 'long.txt' }, ctx)
    assert.match(result.content, /\[Showing lines 1-2000 of 3000\./)
    assert.doesNotMatch(result.content, /line 2001/)
    const edit = await editFileTool.execute({ filePath: 'long.txt', oldString: 'line 2500\n', newString: 'changed\n' }, ctx)
    assert.equal(edit.ok, true)

    await writeFile(path.join(dir, 'wide.txt'), `${'x'.repeat(5000)}\n`, 'utf8')
    const wide = await readFileTool.execute({ filePath: 'wide.txt' }, ctx)
    assert.match(wide.content, /\.\.\. \[line truncated\]/)
    assert.ok(wide.content.length < 2100)

    await writeFile(path.join(dir, 'big.txt'), `${Array.from({ length: 500 }, () => 'y'.repeat(1000)).join('\n')}\n`, 'utf8')
    const big = await readFileTool.execute({ filePath: 'big.txt' }, ctx)
    const shown = Number(/Showing lines 1-(\d+) of 500/.exec(big.content)?.[1])
    assert.ok(shown > 0 && shown < 500)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile treats dollar sequences in replacement as literal text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'let total = a + b;\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({
      filePath: 'a.txt',
      oldString: 'a + b',
      newString: 'price$1 + tax$$ + $&',
    }, ctx)

    assert.equal(result.ok, true)
    assert.equal(await readFile(file, 'utf8'), 'let total = price$1 + tax$$ + $&;\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile reports nearby context when oldString matches multiple times', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), [
      'one',
      'target',
      'two',
      'three',
      'target',
      'four',
    ].join('\n'), 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'target', newString: 'done' }, ctx)

    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /Found 2 matches for oldString, but replaceAll is false\./)
    assert.match(result.content, /Match 1 at line 2, column 1:/)
    assert.match(result.content, /> 2 \| target/)
    assert.match(result.content, /Match 2 at line 5, column 1:/)
    assert.equal((result.errorDetails as { occurrences?: number }).occurrences, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile truncates oldString match context after five matches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), 'x\nx\nx\nx\nx\nx\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'x', newString: 'y' }, ctx)

    assert.equal(result.ok, false)
    assert.match(result.content, /Showing first 5 of 6 matches\./)
    assert.equal((result.errorDetails as { truncated?: boolean }).truncated, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiEdit applies multiple replacements atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'alpha', newString: 'ALPHA' },
        { oldString: 'gamma', newString: 'GAMMA' },
      ],
    }, ctx)

    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Applied 2 edits to a.txt')
    assert.equal(
      result.metadata?.display?.detail,
      [
        `--- a/${path.join(await realpath(dir), 'a.txt')}`,
        `+++ b/${path.join(await realpath(dir), 'a.txt')}`,
        '@@ -1,3 +1,3 @@',
        '-alpha',
        '+ALPHA',
        ' beta',
        '-gamma',
        '+GAMMA',
      ].join('\n'),
    )
    assert.equal(await readFile(file, 'utf8'), 'ALPHA\nbeta\nGAMMA\n')
    assert.equal(ctx.readFileState.get(file)?.content, 'ALPHA\nbeta\nGAMMA\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiEdit treats dollar sequences in replacements as literal text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'first = value\nsecond = value\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'first = value', newString: 'first = price$1 + tax$$ + $&' },
        { oldString: 'second = value', newString: "second = ${value} + $` + $'" },
      ],
    }, ctx)

    assert.equal(result.ok, true)
    assert.equal(await readFile(file, 'utf8'), "first = price$1 + tax$$ + $&\nsecond = ${value} + $` + $'\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiEdit does not write when any replacement is ambiguous', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'alpha\nbeta\nbeta\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'alpha', newString: 'ALPHA' },
        { oldString: 'beta', newString: 'BETA' },
      ],
    }, ctx)

    assert.equal(result.ok, false)
    assert.match(result.content, /Found 2 matches for edits\[1\]\.oldString, but replaceAll is false\./)
    assert.equal(await readFile(file, 'utf8'), 'alpha\nbeta\nbeta\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile tracks content for post-compact restoration', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    const result = await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    assert.equal(result.ok, true)
    assert.equal(ctx.readFileState.get(file)?.content, 'hello\n')
    assert.equal(typeof ctx.readFileState.get(file)?.timestamp, 'number')
    assert.equal(typeof ctx.readFileState.get(file)?.mtimeMs, 'number')
    assert.equal(ctx.readFileState.get(file)?.size, 6)
    assert.equal(typeof ctx.readFileState.get(file)?.ctimeMs, 'number')
    assert.equal(typeof ctx.readFileState.get(file)?.dev, 'number')
    assert.equal(typeof ctx.readFileState.get(file)?.ino, 'number')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile evicts read tracking and read state together', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const firstFile = path.join(dir, 'first.txt')
    await writeFile(firstFile, 'first\n', 'utf8')
    await readFileTool.execute({ filePath: 'first.txt' }, ctx)

    for (let index = 0; index < 100; index += 1) {
      const fileName = `file-${index}.txt`
      await writeFile(path.join(dir, fileName), `${index}\n`, 'utf8')
      await readFileTool.execute({ filePath: fileName }, ctx)
    }

    assert.equal(ctx.readFileState.has(firstFile), false)
    assert.equal(ctx.readFiles.has(firstFile), false)
    assert.equal(ctx.readFileState.size, 100)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile reports missing read state separately from unread files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    ctx.readFiles.add(file)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, ctx)

    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /read state is no longer available/)
    assert.equal((result.errorDetails as { reason?: string }).reason, 'read_state_missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile refreshes recency timestamp on repeated reads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const firstTimestamp = ctx.readFileState.get(file)?.timestamp ?? 0

    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const secondTimestamp = ctx.readFileState.get(file)?.timestamp ?? 0

    assert.ok(secondTimestamp > firstTimestamp)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses files replaced after read even when size matches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    const replacement = path.join(dir, 'replacement.txt')
    await writeFile(file, 'alpha\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    await writeFile(replacement, 'bravo\n', 'utf8')
    await rename(replacement, file)

    const stale = await editFileTool.execute({ filePath: 'a.txt', oldString: 'bravo', newString: 'charl' }, ctx)
    assert.equal(stale.ok, false)
    assert.equal(stale.errorCode, 'stale_file')
    assert.match(stale.content, /changed since it was last read/)
    assert.equal((stale.errorDetails as { current?: { size?: number } }).current?.size, 6)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile accepts a file whose metadata changed but whose text did not', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'alpha\nbeta\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await chmod(file, 0o600)
    await utimes(file, new Date(), new Date(Date.now() + 5_000))

    const first = await editFileTool.execute({ filePath: 'a.txt', oldString: 'alpha', newString: 'gamma' }, ctx)
    assert.equal(first.ok, true, first.content)
    const second = await editFileTool.execute({ filePath: 'a.txt', oldString: 'beta', newString: 'delta' }, ctx)
    assert.equal(second.ok, true, second.content)
    assert.equal(await readFile(file, 'utf8'), 'gamma\ndelta\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rememberShownFiles counts only files shown whole and unchanged as read', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const whole = path.join(dir, 'AGENTS.md')
    const cut = path.join(dir, 'MEMORY.md')
    await writeFile(whole, '# Rules\n\n- one\n', 'utf8')
    await writeFile(cut, '- a\n- b\n', 'utf8')
    await rememberShownFiles([
      'Codebase and user instructions are shown below.',
      `Contents of ${whole} (project instructions, checked into the codebase):\n\n# Rules\n\n- one`,
      `Contents of ${cut} (user's auto-memory, persists across conversations):\n\n- a\n\n> The index has more than 200 lines`,
    ].join('\n\n'), ctx)

    assert.equal(ctx.readFileState.get(whole)?.shownInContext, true, 'compaction must not restore a file the reminder already shows')
    const edited = await editFileTool.execute({ filePath: whole, oldString: '- one', newString: '- two' }, ctx)
    assert.equal(edited.ok, true, edited.content)
    const refused = await editFileTool.execute({ filePath: cut, oldString: '- a', newString: '- c' }, ctx)
    assert.equal(refused.ok, false)
    assert.match(refused.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile points a missed oldString at the most similar lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    await writeFile(path.join(dir, 'a.ts'), 'const a = 1\nfunction total(items) {\n  return items.reduce((sum, x) => sum + x, 0)\n}\nconst b = 2\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.ts' }, ctx)

    const missed = await editFileTool.execute({
      filePath: 'a.ts',
      oldString: 'function total(list) {\n  return list.reduce((sum, x) => sum + x, 0)',
      newString: 'x',
    }, ctx)
    assert.equal(missed.ok, false)
    assert.match(missed.content, /most similar text in the file is lines 2-3/)
    assert.match(missed.content, /return items\.reduce/)

    const unrelated = await editFileTool.execute({ filePath: 'a.ts', oldString: 'zzzz qqqq', newString: 'x' }, ctx)
    assert.match(unrelated.content, /Read the file again/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses stale files until they are read again', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    await writeFile(file, 'hello world\n', 'utf8')

    const stale = await editFileTool.execute({ filePath: 'a.txt', oldString: 'world', newString: 'there' }, ctx)
    assert.equal(stale.ok, false)
    assert.equal(stale.errorCode, 'stale_file')
    assert.match(stale.content, /changed since it was last read/)

    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'world', newString: 'there' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Edited a.txt')
    assert.equal(
      result.metadata?.display?.detail,
      [
        `--- a/${path.join(await realpath(dir), 'a.txt')}`,
        `+++ b/${path.join(await realpath(dir), 'a.txt')}`,
        '@@ -1,1 +1,1 @@',
        '-hello world',
        '+hello there',
      ].join('\n'),
    )
    assert.equal(await readFile(file, 'utf8'), 'hello there\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile creates parent directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await writeFileTool.execute({ filePath: 'nested/a.txt', content: 'hello' }, context(dir))
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Created nested/a.txt')
    assert.equal(
      result.metadata?.display?.detail,
      [
        `--- a/${path.join(await realpath(dir), 'nested', 'a.txt')}`,
        `+++ b/${path.join(await realpath(dir), 'nested', 'a.txt')}`,
        '@@ -0,0 +1,1 @@',
        '+hello',
        '\\ No newline at end of file',
      ].join('\n'),
    )
    assert.equal(await readFile(path.join(dir, 'nested', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile refuses new file when parent has a case-insensitive name collision', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'Existing.txt'), 'hello', 'utf8')
    const result = await writeFileTool.execute({ filePath: 'existing.txt', content: 'updated' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /different casing/)
    assert.equal(await readFile(path.join(dir, 'Existing.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile refuses to overwrite unread existing files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello', 'utf8')
    const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'updated' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile overwrites fresh reads and updates read state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'updated' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Overwrote a.txt')
    assert.equal(
      result.metadata?.display?.detail,
      [
        `--- a/${path.join(await realpath(dir), 'a.txt')}`,
        `+++ b/${path.join(await realpath(dir), 'a.txt')}`,
        '@@ -1,1 +1,1 @@',
        '-hello',
        '\\ No newline at end of file',
        '+updated',
        '\\ No newline at end of file',
      ].join('\n'),
    )
    assert.equal(await readFile(file, 'utf8'), 'updated')
    assert.equal(ctx.readFileState.get(file)?.content, 'updated')
    assert.equal(ctx.readFileState.get(file)?.size, 7)
    assert.equal(ctx.readFileState.get(file)?.ino, (await stat(file)).ino)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile follows a legitimate symlink parent to its target', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await mkdir(path.join(dir, 'real'))
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }

    const result = await writeFileTool.execute({ filePath: path.join('link', 'a.txt'), content: 'hello' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.equal(await readFile(path.join(dir, 'real', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile follows a legitimate symlink parent to its target', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    await mkdir(path.join(dir, 'real'))
    await writeFile(path.join(dir, 'real', 'a.txt'), 'hello', 'utf8')
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }
    await readFileTool.execute({ filePath: path.join('link', 'a.txt') }, ctx)

    const result = await editFileTool.execute({ filePath: path.join('link', 'a.txt'), oldString: 'hello', newString: 'bye' }, ctx)
    assert.equal(result.ok, true, result.content)
    assert.equal(await readFile(path.join(dir, 'real', 'a.txt'), 'utf8'), 'bye')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile removes files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await deleteFileTool.execute({ filePath: 'a.txt' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Deleted a.txt')
    assert.equal(ctx.readFiles.has(file), false)
    assert.equal(ctx.readFileState.has(file), false)
    await assert.rejects(() => readFile(file, 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile refuses unread files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello', 'utf8')
    const result = await deleteFileTool.execute({ filePath: 'a.txt' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile follows a legitimate symlink parent to its target', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    await mkdir(path.join(dir, 'real'))
    await writeFile(path.join(dir, 'real', 'a.txt'), 'hello', 'utf8')
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }
    await readFileTool.execute({ filePath: path.join('link', 'a.txt') }, ctx)

    const result = await deleteFileTool.execute({ filePath: path.join('link', 'a.txt') }, ctx)
    assert.equal(result.ok, true, result.content)
    await assert.rejects(() => readFile(path.join(dir, 'real', 'a.txt'), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('concurrency-safe builtin tools are read-only and write tools remain barriers', () => {
  const tools = getBuiltinTools()
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  for (const tool of tools) {
    if (tool.isConcurrencySafe) {
      assert.equal(tool.isReadOnly, true, `${tool.name} must be read-only to be concurrency safe`)
    }
  }

  for (const toolName of ['Write', 'Edit', 'MultiEdit', 'Delete']) {
    assert.notEqual(byName.get(toolName)?.isConcurrencySafe, true, `${toolName} must be a write barrier`)
  }
})

// ── Edit fuzzy matching (quote normalization) ──────────────────────────

test('editFile succeeds with straight quotes when file has curly quotes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'quotes.txt')
    await writeFile(file, '“hello world”\n', 'utf8')
    await readFileTool.execute({ filePath: 'quotes.txt' }, ctx)

    const result = await editFileTool.execute(
      { filePath: 'quotes.txt', oldString: '"hello world"', newString: '"goodbye world"' },
      ctx,
    )
    assert.equal(result.ok, true)
    // The file should now have curly quotes in the new string too
    const content = await readFile(file, 'utf8')
    assert.equal(content, '“goodbye world”\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile preserves curly quotes in newString when matched via normalization', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'quotes.txt')
    await writeFile(file, 'she said “hello”\n', 'utf8')
    await readFileTool.execute({ filePath: 'quotes.txt' }, ctx)

    // Model provides straight quotes, file has curly quotes
    const result = await editFileTool.execute(
      { filePath: 'quotes.txt', oldString: '"hello"', newString: '"goodbye"' },
      ctx,
    )
    assert.equal(result.ok, true)
    const content = await readFile(file, 'utf8')
    // newString should have curly quotes matching the file's style
    assert.equal(content, 'she said “goodbye”\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile handles apostrophe normalization (contractions)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'contract.txt')
    await writeFile(file, 'I don’t know\n', 'utf8')
    await readFileTool.execute({ filePath: 'contract.txt' }, ctx)

    const result = await editFileTool.execute(
      { filePath: 'contract.txt', oldString: "don't", newString: "can't" },
      ctx,
    )
    assert.equal(result.ok, true)
    const content = await readFile(file, 'utf8')
    // Apostrophe should be preserved as right single curly quote
    assert.equal(content, 'I can’t know\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile exact match still works (no regression)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'exact.txt')
    await writeFile(file, 'hello world\n', 'utf8')
    await readFileTool.execute({ filePath: 'exact.txt' }, ctx)

    const result = await editFileTool.execute(
      { filePath: 'exact.txt', oldString: 'hello', newString: 'goodbye' },
      ctx,
    )
    assert.equal(result.ok, true)
    const content = await readFile(file, 'utf8')
    assert.equal(content, 'goodbye world\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Grep pagination ────────────────────────────────────────────────────

test('grep offset skips correct number of results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'line', path: dir, offset: 2 }, context(dir))
    assert.equal(result.ok, true)
    // Should skip first 2 results (line1, line2) and return line3, line4, line5
    assert.match(result.content, /line3/)
    assert.match(result.content, /line4/)
    assert.match(result.content, /line5/)
    assert.doesNotMatch(result.content, /line1:/)
    assert.doesNotMatch(result.content, /line2:/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep headLimit caps total results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'line1\nline2\nline3\nline4\nline5\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'line', path: dir, headLimit: 2 }, context(dir))
    assert.equal(result.ok, true)
    const lines = result.content.split('\n').filter(l => l.startsWith('a.txt:'))
    assert.equal(lines.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep pagination notice appears when results are truncated', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'line', path: dir, headLimit: 1, offset: 1 }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /\[Showing results/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── WebFetch/WebSearch basic validation ────────────────────────────────

test('WebFetch tool is registered and has correct properties', () => {
  const tools = getBuiltinTools()
  const webFetch = tools.find(t => t.name === 'WebFetch')
  assert.ok(webFetch, 'WebFetch tool should be registered')
  assert.equal(webFetch.isReadOnly, true)
  assert.equal(webFetch.isConcurrencySafe, true)
  assert.equal(webFetch.shouldDefer, true)
  // Not `safe`: only the preapproved documentation hosts skip the prompt.
  assert.equal(webFetch.riskLevel, 'confirm')
})

test('WebSearch tool is registered and has correct properties', () => {
  const tools = getBuiltinTools()
  const webSearch = tools.find(t => t.name === 'WebSearch')
  assert.ok(webSearch, 'WebSearch tool should be registered')
  assert.equal(webSearch.isReadOnly, true)
  assert.equal(webSearch.isConcurrencySafe, true)
  assert.equal(webSearch.shouldDefer, true)
  assert.equal(webSearch.riskLevel, 'safe')
})

test('ToolSearch prompt text has no mojibake artifacts', () => {
  assert.doesNotMatch(toolSearchTool.description, /鈥|鈹|—/)
  assert.match(toolSearchTool.description, /select:Read,Edit,Grep/)
  assert.match(toolSearchTool.description, /<functions>/)
})

// ToolSearch mode and auto:N threshold

test('getToolSearchMode returns always by default', () => {
  const orig = process.env.HANEKAWA_TOOL_SEARCH
  try {
    delete process.env.HANEKAWA_TOOL_SEARCH
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'always')
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', orig)
  }
})

test('getToolSearchMode returns off for false/0', () => {
  const orig = process.env.HANEKAWA_TOOL_SEARCH
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'false'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'off')
    process.env.HANEKAWA_TOOL_SEARCH = '0'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'off')
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', orig)
  }
})

test('getToolSearchMode returns auto for plain auto', () => {
  const orig = process.env.HANEKAWA_TOOL_SEARCH
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'auto')
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', orig)
  }
})

test('auto:0 maps to always, auto:100 maps to off', () => {
  const orig = process.env.HANEKAWA_TOOL_SEARCH
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto:0'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'always')

    process.env.HANEKAWA_TOOL_SEARCH = 'auto:100'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'off')
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', orig)
  }
})

test('auto:N uses N as threshold percentage', () => {
  const origSearch = process.env.HANEKAWA_TOOL_SEARCH
  const origPercent = process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto:5'
    delete process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'auto')
    // 5% of 200000 = 10000
    assert.equal(getAutoThreshold(200_000), 10_000)

    process.env.HANEKAWA_TOOL_SEARCH = 'auto:50'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'auto')
    // 50% of 200000 = 100000
    assert.equal(getAutoThreshold(200_000), 100_000)
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', origSearch)
    setEnv('HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', origPercent)
  }
})

test('auto:N takes priority over HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', () => {
  const origSearch = process.env.HANEKAWA_TOOL_SEARCH
  const origPercent = process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto:25'
    process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT = '80'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'auto')
    // auto:N=25 takes priority over AUTO_PERCENT=80.
    assert.equal(getAutoThreshold(200_000), 50_000)
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', origSearch)
    setEnv('HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', origPercent)
  }
})

test('auto mode without N falls back to HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', () => {
  const origSearch = process.env.HANEKAWA_TOOL_SEARCH
  const origPercent = process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto'
    process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT = '30'
    resetToolSearchCache()
    assert.equal(getToolSearchMode(), 'auto')
    assert.equal(getAutoThreshold(200_000), 60_000)
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', origSearch)
    setEnv('HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', origPercent)
  }
})

test('auto mode defaults to 10% when no config set', () => {
  const origSearch = process.env.HANEKAWA_TOOL_SEARCH
  const origPercent = process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto'
    delete process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
    resetToolSearchCache()
    assert.equal(getAutoThreshold(200_000), 20_000)
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', origSearch)
    setEnv('HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', origPercent)
  }
})

test('resolveToolSearchState enables auto only above schema-size threshold', () => {
  const origSearch = process.env.HANEKAWA_TOOL_SEARCH
  const origPercent = process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
  const deferred = searchTestTool('DeferredTool', {
    shouldDefer: true,
    description: 'x'.repeat(200),
  })
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'auto:50'
    delete process.env.HANEKAWA_TOOL_SEARCH_AUTO_PERCENT
    resetToolSearchCache()
    assert.equal(resolveToolSearchState({
      tools: [deferred, toolSearchTool],
      contextWindowSize: 100_000,
      providerSupportsDynamicToolSearch: true,
    }).enabled, false)

    process.env.HANEKAWA_TOOL_SEARCH = 'auto:1'
    resetToolSearchCache()
    assert.equal(resolveToolSearchState({
      tools: [deferred, toolSearchTool],
      contextWindowSize: 1_000,
      providerSupportsDynamicToolSearch: true,
    }).enabled, true)
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', origSearch)
    setEnv('HANEKAWA_TOOL_SEARCH_AUTO_PERCENT', origPercent)
  }
})

test('resolveToolSearchState excludes alwaysLoad tools from deferred names', () => {
  const origSearch = process.env.HANEKAWA_TOOL_SEARCH
  try {
    process.env.HANEKAWA_TOOL_SEARCH = 'true'
    resetToolSearchCache()
    const deferred = searchTestTool('DeferredTool', { shouldDefer: true })
    const alwaysLoad = searchTestTool('AlwaysLoadTool', { shouldDefer: true, alwaysLoad: true })

    const state = resolveToolSearchState({
      tools: [deferred, alwaysLoad, toolSearchTool],
      contextWindowSize: 100_000,
      providerSupportsDynamicToolSearch: true,
    })

    assert.equal(state.enabled, true)
    assert.deepEqual([...(state.allDeferredToolNames ?? new Set())], ['DeferredTool'])
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', origSearch)
  }
})

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key as keyof typeof process.env]
  } else {
    process.env[key] = value
  }
}

// Bash sleep detection

test('detectSleepPattern returns null for short sleep', () => {
  assert.equal(detectSleepPattern('sleep 1'), null)
  assert.equal(detectSleepPattern('sleep 0.5'), null)
  assert.equal(detectSleepPattern('sleep 1.9'), null)
})

test('detectSleepPattern detects standalone sleep >= 2s', () => {
  assert.equal(detectSleepPattern('sleep 2'), 2)
  assert.equal(detectSleepPattern('sleep 5'), 5)
  assert.equal(detectSleepPattern('sleep 300'), 300)
  assert.equal(detectSleepPattern('sleep 2.5'), 2.5)
})

test('detectSleepPattern detects sleep with trailing chain', () => {
  assert.equal(detectSleepPattern('sleep 5 && echo done'), 5)
  assert.equal(detectSleepPattern('sleep 3; echo done'), 3)
  assert.equal(detectSleepPattern('sleep 5 || echo fail'), 5)
  assert.equal(detectSleepPattern('sleep 5 | cat'), 5)
  assert.equal(detectSleepPattern('sleep 5 # comment'), 5)
})

test('detectSleepPattern does not match sleep inside compound commands', () => {
  assert.equal(detectSleepPattern('for i in 1 2; do sleep 1; done'), null)
  assert.equal(detectSleepPattern('echo hello && sleep 5'), null)
  assert.equal(detectSleepPattern('if true; then sleep 10; fi'), null)
})

test('detectSleepPattern does not match non-sleep commands', () => {
  assert.equal(detectSleepPattern('echo hello'), null)
  assert.equal(detectSleepPattern('ls -la'), null)
  assert.equal(detectSleepPattern(''), null)
})

test('bash blocks sleep without run_in_background', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'sleep 5' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /run_in_background/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash blocks sleep with || operator', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'sleep 5 || echo fail' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash blocks sleep with pipe operator', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'sleep 5 | cat' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash allows sleep with run_in_background', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    // Use a very short background sleep to not slow down tests
    const result = await bashTool.execute({ command: 'sleep 0.1', run_in_background: true }, context(dir))
    assert.equal(result.ok, true)
  } finally {
    await defaultBackgroundTaskRegistry.stopAll('s1', 'test cleanup')
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash allows short sleep without run_in_background', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'sleep 0.1' }, context(dir))
    assert.equal(result.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash allows non-sleep commands normally', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'echo hello' }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /hello/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Bash tool has run_in_background in schema', () => {
  const tools = getBuiltinTools()
  const bash = tools.find(t => t.name === 'Bash')
  assert.ok(bash, 'Bash tool should be registered')
  // Verify the schema accepts run_in_background
  const parsed = bash.inputSchema.parse({ command: 'echo hi', run_in_background: true })
  assert.equal((parsed as { run_in_background?: boolean }).run_in_background, true)
})

test('Config tool is registered in builtin tools', () => {
  const tools = getBuiltinTools()
  const config = tools.find(t => t.name === 'Config')
  assert.ok(config, 'Config tool should be registered')
  assert.equal(config.shouldDefer, true)
})

test('buildUnifiedPatch emits a standard unified diff and skips no-op edits', () => {
  assert.equal(buildUnifiedPatch('a.txt', 'same\n', 'same\n'), undefined)

  const patch = buildUnifiedPatch('src\\foo.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')
  assert.equal(patch, [
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
  ].join('\n'))
})

test('buildUnifiedPatch caps oversized patches on a hunk boundary', () => {
  const oldText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
  // Every tenth line changes, so the patch is a long run of small hunks.
  const newText = oldText.split('\n').map((line, i) => (i % 10 === 0 ? `${line} changed` : line)).join('\n')

  const patch = buildUnifiedPatch('a.txt', oldText, newText, { maxLines: 20, maxChars: 4000 })
  assert.ok(patch)
  const lines = patch.split('\n')
  assert.equal(lines[0], '--- a/a.txt')
  assert.equal(lines[1], '+++ b/a.txt')
  assert.match(lines[lines.length - 1]!, /^… \d+ more lines not shown \(\+6 -6\)$/)
  // The kept body ends where a hunk ends, never mid-hunk.
  assert.ok(lines.length <= 21)
  const hunkStarts = lines.filter(line => line.startsWith('@@')).length
  assert.ok(hunkStarts >= 1)
  for (const line of lines.slice(2, -1)) {
    assert.match(line, /^[-+ @\\]/)
  }
})

test('buildUnifiedPatch keeps a truncated first hunk rather than nothing', () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const newText = oldText.replaceAll('line', 'row')

  const patch = buildUnifiedPatch('a.txt', oldText, newText, { maxLines: 8, maxChars: 4000 })
  assert.ok(patch)
  const lines = patch.split('\n')
  assert.equal(lines[2], '@@ -1,40 +1,40 @@')
  assert.ok(lines.length > 3, 'a single oversized hunk still ships its first lines')
  assert.match(lines[lines.length - 1]!, /more lines not shown \(\+40 -40\)$/)
})
