import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReadFileState } from '../src/harness/types.js'
import { globTool } from '../src/tools/GlobTool/GlobTool.js'
import { grepTool } from '../src/tools/GrepTool/GrepTool.js'
import { getProjectPlansDir, userHome } from '../src/utils/paths.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>(), readFileState: new Map<string, ReadFileState>() }
}

async function withProject(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-grep-'))
  try {
    await writeFile(path.join(dir, 'alpha.ts'), 'const target = 1\nconst other = 2\nconst target2 = 3\n', 'utf8')
    await writeFile(path.join(dir, 'beta.ts'), 'no hits here\n', 'utf8')
    await writeFile(path.join(dir, 'gamma.ts'), 'const target = 4\n', 'utf8')
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('outputMode files_with_matches returns paths without line numbers', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target', outputMode: 'files_with_matches' }, context(dir))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n').sort()
    assert.deepEqual(rows, ['alpha.ts', 'gamma.ts'])
  })
})

test('outputMode count returns one path:count row per matching file', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target', outputMode: 'count' }, context(dir))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n').sort()
    assert.deepEqual(rows, ['alpha.ts:2', 'gamma.ts:1'])
  })
})

test('contextLines widens content rows around each match', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'other', path: 'alpha.ts', contextLines: 1 }, context(dir))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n')
    assert.deepEqual(rows, [
      'alpha.ts:1:const target = 1',
      'alpha.ts:2:const other = 2',
      'alpha.ts:3:const target2 = 3',
    ])
  })
})

test('context lines are refused rather than ignored outside content mode', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target', outputMode: 'count', contextLines: 2 }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /outputMode "content"/)
  })
})

test('a pattern containing \\n retries as multiline instead of surfacing ripgrep stderr', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target = 1\\nconst other', path: 'alpha.ts' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /alpha\.ts:1:/)
    assert.doesNotMatch(result.content, /ripgrep failed/)
  })
})

test('the type filter narrows the search the way glob does', async () => {
  await withProject(async (dir) => {
    await writeFile(path.join(dir, 'delta.py'), 'target = 5\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'target', type: 'py', outputMode: 'files_with_matches' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.equal(result.content, 'delta.py')
  })
})

/**
 * Runs `run` with no `rg` on PATH — the fallback scanner's whole trigger — while
 * keeping `git`, which is present on a machine without ripgrep and decides the
 * `.gitignore` filtering both backends share.
 */
async function withoutRipgrep<T>(run: () => Promise<T>): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'myagent-no-rg-'))
  const git = (process.env.PATH ?? '').split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'))
    .find((candidate) => existsSync(candidate))
  const original = process.env.PATH
  try {
    if (git) await symlink(git, path.join(bin, path.basename(git)))
    process.env.PATH = bin
    return await run()
  } finally {
    process.env.PATH = original
    await rm(bin, { recursive: true, force: true })
  }
}

async function withTree(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-grep-tree-'))
  try {
    await mkdir(path.join(dir, 'sub', 'deep'), { recursive: true })
    await mkdir(path.join(dir, '.config'), { recursive: true })
    await writeFile(path.join(dir, 'top.ts'), 'const hit = 1\n', 'utf8')
    await writeFile(path.join(dir, 'sub', 'nested.ts'), 'const hit = 2\n', 'utf8')
    await writeFile(path.join(dir, 'sub', 'deep', 'deep.ts'), 'const hit = 3\n', 'utf8')
    await writeFile(path.join(dir, '.config', 'hidden.ts'), 'const hit = 4\n', 'utf8')
    await writeFile(path.join(dir, '.hidden.ts'), 'const hit = 5\n', 'utf8')
    await writeFile(path.join(dir, 'top.md'), 'const hit = 6\n', 'utf8')
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a bare glob matches the basename at any depth and hidden files, with or without ripgrep', async () => {
  await withTree(async (dir) => {
    const withRg = await grepTool.execute({ pattern: 'hit', glob: '*.ts', outputMode: 'files_with_matches' }, context(dir))
    assert.equal(withRg.ok, true, withRg.content)
    const fromFallback = await withoutRipgrep(async () => {
      const result = await grepTool.execute({ pattern: 'hit', glob: '*.ts', outputMode: 'files_with_matches' }, context(dir))
      assert.equal(result.ok, true, result.content)
      return result
    })
    const rows = (result: { content: string }) => result.content.split('\n').sort()
    assert.deepEqual(rows(fromFallback), rows(withRg))
    assert.deepEqual(rows(withRg), ['.config/hidden.ts', '.hidden.ts', 'sub/deep/deep.ts', 'sub/nested.ts', 'top.ts'])
  })
})

test('a directory glob still matches the path from the search root in both backends', async () => {
  await withTree(async (dir) => {
    const run = () => grepTool.execute({ pattern: 'hit', glob: 'sub/*.ts', outputMode: 'files_with_matches' }, context(dir))
    const withRg = await run()
    const fromFallback = await withoutRipgrep(run)
    assert.equal(withRg.content, 'sub/nested.ts')
    assert.equal(fromFallback.content, withRg.content)
  })
})

test('a search with no glob still honours .gitignore in the fallback', async () => {
  await withTree(async (dir) => {
    // ripgrep only reads .gitignore inside a repository.
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['init', '-q', dir], (error) => (error ? reject(error) : resolve()))
    })
    await mkdir(path.join(dir, 'ignored'), { recursive: true })
    await writeFile(path.join(dir, 'ignored', 'kept.ts'), 'const hit = 7\n', 'utf8')
    await writeFile(path.join(dir, '.gitignore'), 'ignored/\n', 'utf8')
    const run = () => grepTool.execute({ pattern: 'hit', outputMode: 'files_with_matches' }, context(dir))
    const withRg = await run()
    const fromFallback = await withoutRipgrep(run)
    assert.deepEqual(fromFallback.content.split('\n').sort(), withRg.content.split('\n').sort())
    assert.doesNotMatch(withRg.content, /ignored/)
  })
})

test('a match set larger than one page keeps an exact total', async () => {
  await withProject(async (dir) => {
    const lines = Array.from({ length: 300 }, (_, index) => `target ${index}`).join('\n')
    await writeFile(path.join(dir, 'many.ts'), `${lines}\n`, 'utf8')
    const result = await grepTool.execute({ pattern: 'target', path: 'many.ts', headLimit: 10, offset: 5 }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.equal(result.content.split('\n').filter((row) => row.startsWith('many.ts:')).length, 10)
    assert.match(result.content, /\[Showing results 6\.\.15 of 300 total matches\]/)
  })
})

test('a match set past the old 10 MiB stdout ceiling no longer fails', async () => {
  await withProject(async (dir) => {
    // 1.2M rows of `target …` is ~12 MiB of stdout: over execFile's maxBuffer,
    // and nothing the model could ever read whole.
    const chunk = Array.from({ length: 20_000 }, (_, index) => `target ${index}`).join('\n')
    await writeFile(path.join(dir, 'huge.ts'), `${`${chunk}\n`.repeat(60)}`, 'utf8')
    const result = await grepTool.execute({ pattern: '^target', path: 'huge.ts', headLimit: 3 }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /of 1200000 total matches/)
  })
})

test('a broad search from the workspace root skips Hanekawa\'s own runtime data', async () => {
  const home = userHome()
  const data = path.join(home, '.myagent', 'projects', 'demo-key')
  const worktree = path.join(home, '.myagent-worktrees', 'demo-key', 'thr_1')
  const project = path.join(home, 'src', 'demo')
  try {
    await mkdir(path.join(data, 'sessions'), { recursive: true })
    await mkdir(worktree, { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(path.join(data, 'sessions', 's1.jsonl'), 'const needle = 1\n', 'utf8')
    await writeFile(path.join(worktree, 'work.ts'), 'const needle = 2\n', 'utf8')
    await writeFile(path.join(project, 'app.ts'), 'const needle = 3\n', 'utf8')

    const result = await grepTool.execute({ pattern: 'needle', outputMode: 'files_with_matches' }, context(home))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n').sort()
    assert.deepEqual(rows, ['src/demo/app.ts'])
  } finally {
    await rm(path.join(home, '.myagent-worktrees'), { recursive: true, force: true })
    await rm(path.join(home, '.myagent', 'projects', 'demo-key'), { recursive: true, force: true })
    await rm(path.join(home, 'src'), { recursive: true, force: true })
  }
})

test('home aliases and both search backends exclude runtime data while explicit allowed roots remain searchable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'myagent-search-alias-'))
  const home = path.join(root, 'home')
  const alias = path.join(root, 'home-link')
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  const verify = async () => {
    for (const cwd of [home, alias]) {
      const grep = await grepTool.execute({ pattern: 'alias-needle', outputMode: 'files_with_matches' }, context(cwd))
      assert.equal(grep.ok, true, grep.content)
      assert.match(grep.content, /source\.txt/)
      assert.doesNotMatch(grep.content, /private\.jsonl|thread\.txt/)
      const glob = await globTool.execute({ pattern: '.myagent/**/*' }, context(cwd))
      assert.equal(glob.ok, true, glob.content)
      assert.match(glob.content, /settings\.json/)
      assert.doesNotMatch(glob.content, /private\.jsonl/)
      const ownContext = { ...context(cwd), projectDir: home }
      const explicit = getProjectPlansDir(home)
      const internalGrep = await grepTool.execute({ pattern: 'alias-needle', path: explicit }, ownContext)
      const internalGlob = await globTool.execute({ pattern: '**/*.md', path: explicit }, ownContext)
      assert.match(internalGrep.content, /plan\.md/)
      assert.match(internalGlob.content, /plan\.md/)
      const sessions = path.join(cwd, '.myagent', 'projects', 'demo', 'sessions')
      assert.match((await grepTool.execute({ pattern: 'alias-needle', path: sessions }, ownContext)).content, /private\.jsonl/)
      assert.match((await globTool.execute({ pattern: '**/*', path: sessions }, ownContext)).content, /private\.jsonl/)
    }
  }
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    await mkdir(path.join(home, '.myagent', 'projects', 'demo', 'sessions'), { recursive: true })
    await mkdir(path.join(home, '.myagent-worktrees', 'demo'), { recursive: true })
    await writeFile(path.join(home, 'source.txt'), 'alias-needle')
    await writeFile(path.join(home, '.myagent', 'settings.json'), '{}')
    await writeFile(path.join(home, '.myagent', 'projects', 'demo', 'sessions', 'private.jsonl'), 'alias-needle')
    await writeFile(path.join(home, '.myagent-worktrees', 'demo', 'thread.txt'), 'alias-needle')
    await mkdir(getProjectPlansDir(home), { recursive: true })
    await writeFile(path.join(getProjectPlansDir(home), 'plan.md'), 'alias-needle')
    await symlink(home, alias, 'junction')
    await verify()
    await withoutRipgrep(verify)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('Glob narrows with the pattern before the cap, and reports the real count', async () => {
  await withTree(async (dir) => {
    const withRg = await globTool.execute({ pattern: 'sub/**/*.ts' }, context(dir))
    assert.equal(withRg.ok, true, withRg.content)
    assert.deepEqual(withRg.content.split('\n').sort(), ['sub/deep/deep.ts', 'sub/nested.ts'])
    const fromFallback = await withoutRipgrep(async () => {
      const result = await globTool.execute({ pattern: 'sub/**/*.ts' }, context(dir))
      assert.equal(result.ok, true, result.content)
      return result
    })
    assert.deepEqual(fromFallback.content.split('\n').sort(), withRg.content.split('\n').sort())
  })
})

test('Glob caps at 200 rows but still counts every match', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-glob-cap-'))
  try {
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(path.join(dir, `f${String(index).padStart(3, '0')}.ts`), '', 'utf8')))
    const result = await globTool.execute({ pattern: '*.ts' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.equal(result.content.split('\n').filter((row) => row.endsWith('.ts')).length, 200)
    assert.match(result.content, /\[Showing 200 of 205 files; narrow the pattern or path\.\]/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
