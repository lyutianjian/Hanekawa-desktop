import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyFileSuggestion,
  extractAtCompletionToken,
  generateFileSuggestions,
  type FileSuggestion,
} from '../src/runtime/suggestions/fileSuggestions.js'

/**
 * The fixture is never a git repo, so `gitIgnoredPaths` spawns `git check-ignore`
 * outside a work tree, exits non-zero and yields an empty set. That keeps these
 * assertions about the extension/protected-path filters rather than about git.
 */
async function withFixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-filesuggest-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await mkdir(path.join(dir, 'docs'))
    await mkdir(path.join(dir, 'my dir'))
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(path.join(dir, '.git'))
    await mkdir(path.join(dir, 'build'))
    await writeFile(path.join(dir, 'src', 'app.ts'), 'export {}\n')
    await writeFile(path.join(dir, 'src', 'helper.ts'), 'export {}\n')
    await writeFile(path.join(dir, 'my dir', 'thing.ts'), 'export {}\n')
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), '\n')
    await writeFile(path.join(dir, '.git', 'config'), '\n')
    await writeFile(path.join(dir, 'docs', 'notes.md'), '\n')
    await writeFile(path.join(dir, 'root.ts'), 'export {}\n')
    await writeFile(path.join(dir, 'README.md'), '# readme\n')
    await writeFile(path.join(dir, 'image.png'), '\n')
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function paths(suggestions: FileSuggestion[]): string[] {
  return suggestions.map((suggestion) => suggestion.metadata.path)
}

test('at-completion token is extracted at the start of the line and after whitespace', () => {
  assert.deepEqual(extractAtCompletionToken('@src/', 5), { token: '@src/', startPos: 0 })
  assert.deepEqual(extractAtCompletionToken('look at @src/a', 14), { token: '@src/a', startPos: 8 })
})

test('at-completion token is rejected when the @ is not preceded by whitespace', () => {
  assert.equal(extractAtCompletionToken('a@b', 3), null)
  assert.equal(extractAtCompletionToken('user@example.com', 16), null)
})

test('at-completion token is rejected once it contains whitespace', () => {
  assert.equal(extractAtCompletionToken('@my file', 8), null)
})

test('at-completion token spans whitespace while the quote is still open', () => {
  assert.deepEqual(extractAtCompletionToken('@"my dir/', 9), { token: '@"my dir/', startPos: 0 })
  assert.deepEqual(extractAtCompletionToken('see @"my dir/th', 15), { token: '@"my dir/th', startPos: 4 })
})

test('at-completion token is rejected once the quote is closed', () => {
  assert.equal(extractAtCompletionToken('@"my dir/thing.ts"', 18), null)
})

test('file suggestions list directories before files and drop non-text extensions', async () => {
  await withFixture(async (dir) => {
    const suggestions = await generateFileSuggestions('@', 1, dir)

    assert.deepEqual(paths(suggestions), ['docs/', 'my dir/', 'src/', 'README.md', 'root.ts'])
    assert.equal(suggestions[0]?.description, 'directory')
    assert.equal(suggestions.at(-1)?.description, 'file')
  })
})

test('file suggestions skip node_modules, .git and build directories', async () => {
  await withFixture(async (dir) => {
    const suggestions = await generateFileSuggestions('@', 1, dir)

    const listed = paths(suggestions)
    assert.ok(!listed.includes('node_modules/'), 'node_modules must not be suggested')
    assert.ok(!listed.includes('.git/'), '.git must not be suggested')
    assert.ok(!listed.includes('build/'), 'build must not be suggested')
  })
})

test('file suggestions complete markdown and plain-text documents', async () => {
  await withFixture(async (dir) => {
    await writeFile(path.join(dir, 'docs', 'todo.txt'), '\n')

    assert.deepEqual(paths(await generateFileSuggestions('@README', 7, dir)), ['README.md'])
    assert.deepEqual(paths(await generateFileSuggestions('@docs/', 6, dir)), ['docs/notes.md', 'docs/todo.txt'])
  })
})

test('file suggestions descend into a directory prefix', async () => {
  await withFixture(async (dir) => {
    const suggestions = await generateFileSuggestions('@src/', 5, dir)

    assert.deepEqual(paths(suggestions), ['src/app.ts', 'src/helper.ts'])
  })
})

test('file suggestions fuzzy-match the leaf against the basename', async () => {
  await withFixture(async (dir) => {
    const suggestions = await generateFileSuggestions('@src/app', 8, dir)

    assert.equal(suggestions[0]?.metadata.path, 'src/app.ts')
  })
})

test('file suggestions refuse to escape the working directory', async () => {
  await withFixture(async (dir) => {
    assert.deepEqual(await generateFileSuggestions('@../', 4, dir), [])
    assert.deepEqual(await generateFileSuggestions('@../../etc/', 11, dir), [])
  })
})

test('file suggestions refuse to descend into a protected path', async () => {
  await withFixture(async (dir) => {
    assert.deepEqual(await generateFileSuggestions('@.git/', 6, dir), [])
    assert.deepEqual(await generateFileSuggestions('@.hanekawa/', 10, dir), [])
  })
})

test('file suggestions are capped at fifteen entries', async () => {
  await withFixture(async (dir) => {
    const many = path.join(dir, 'many')
    await mkdir(many)
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(many, `file${String(index).padStart(2, '0')}.ts`), 'export {}\n')
    }

    const suggestions = await generateFileSuggestions('@many/', 6, dir)

    assert.equal(suggestions.length, 15)
  })
})

test('file suggestions quote paths containing a space', async () => {
  await withFixture(async (dir) => {
    const [directory] = await generateFileSuggestions('@my', 3, dir)
    assert.equal(directory?.metadata.replacementText, '@"my dir/')

    const [file] = await generateFileSuggestions('@"my dir/thing', 14, dir)
    assert.equal(file?.metadata.replacementText, '@"my dir/thing.ts"')
  })
})

test('applying a directory suggestion leaves the token open for further completion', () => {
  const suggestion: FileSuggestion = {
    id: 'file:directory:src/',
    displayText: 'src/',
    description: 'directory',
    metadata: { replacementText: '@src/', path: 'src/', kind: 'directory' },
  }

  assert.deepEqual(applyFileSuggestion('@sr', 3, suggestion), { text: '@src/', cursorPos: 5 })
})

test('applying a file suggestion appends a trailing space', () => {
  const suggestion: FileSuggestion = {
    id: 'file:file:src/app.ts',
    displayText: 'src/app.ts',
    description: 'file',
    metadata: { replacementText: '@src/app.ts', path: 'src/app.ts', kind: 'file' },
  }

  assert.deepEqual(applyFileSuggestion('read @src/a', 11, suggestion), {
    text: 'read @src/app.ts ',
    cursorPos: 17,
  })
})

test('applying a suggestion preserves the text after the cursor', () => {
  const suggestion: FileSuggestion = {
    id: 'file:file:root.ts',
    displayText: 'root.ts',
    description: 'file',
    metadata: { replacementText: '@root.ts', path: 'root.ts', kind: 'file' },
  }

  assert.deepEqual(applyFileSuggestion('@ro and then some', 3, suggestion), {
    text: '@root.ts  and then some',
    cursorPos: 9,
  })
})

test('applying a suggestion without a token is a no-op', () => {
  const suggestion: FileSuggestion = {
    id: 'file:file:root.ts',
    displayText: 'root.ts',
    description: 'file',
    metadata: { replacementText: '@root.ts', path: 'root.ts', kind: 'file' },
  }

  assert.deepEqual(applyFileSuggestion('no token here', 13, suggestion), {
    text: 'no token here',
    cursorPos: 13,
  })
})
