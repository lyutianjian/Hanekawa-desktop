import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolInput } from '../src/tools/inputAliases.js'
import { validateToolInput } from '../src/harness/toolValidation.js'
import { getBuiltinTools } from '../src/tools/index.js'

function tool(name: string) {
  const found = getBuiltinTools().find((candidate) => candidate.name === name)
  assert.ok(found, `missing tool ${name}`)
  return found
}

test('a Claude Code shaped Edit call normalizes and then validates', () => {
  const raw = {
    file_path: 'src/a.ts',
    old_string: 'a',
    new_string: 'b',
    replace_all: 'true',
  }
  const normalized = normalizeToolInput('Edit', raw)
  assert.deepEqual(normalized, {
    filePath: 'src/a.ts',
    oldString: 'a',
    newString: 'b',
    replaceAll: true,
  })
  assert.equal(validateToolInput(tool('Edit'), normalized).ok, true)
})

test('a Claude Code shaped Grep call normalizes and then validates', () => {
  const raw = {
    pattern: 'foo',
    path: 'src',
    '-i': true,
    head_limit: '30',
    output_mode: 'content',
    '-C': 3,
    type: 'ts',
  }
  const normalized = normalizeToolInput('Grep', raw)
  assert.deepEqual(normalized, {
    pattern: 'foo',
    path: 'src',
    caseInsensitive: true,
    headLimit: 30,
    outputMode: 'content',
    contextLines: 3,
    type: 'ts',
  })
  assert.equal(validateToolInput(tool('Grep'), normalized).ok, true)
})

test('Grep keeps its own path parameter rather than treating it as a file path', () => {
  const normalized = normalizeToolInput('Grep', { pattern: 'x', path: 'src' }) as Record<string, unknown>
  assert.equal(normalized.path, 'src')
  assert.equal('filePath' in normalized, false)
})

test('MultiEdit rewrites each edit in the array', () => {
  const normalized = normalizeToolInput('MultiEdit', {
    file_path: 'a.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { oldString: 'c', newString: 'd', replace_all: 'false' },
    ],
  })
  assert.deepEqual(normalized, {
    filePath: 'a.ts',
    edits: [
      { oldString: 'a', newString: 'b' },
      { oldString: 'c', newString: 'd', replaceAll: false },
    ],
  })
  assert.equal(validateToolInput(tool('MultiEdit'), normalized).ok, true)
})

test('Read accepts path as an alias and coerces quoted numbers', () => {
  const normalized = normalizeToolInput('Read', { path: 'a.txt', offset: '5', limit: '10' })
  assert.deepEqual(normalized, { filePath: 'a.txt', offset: 5, limit: 10 })
  assert.equal(validateToolInput(tool('Read'), normalized).ok, true)
})

test('an explicit canonical key wins over its alias', () => {
  const normalized = normalizeToolInput('Read', { filePath: 'real.txt', file_path: 'alias.txt' })
  assert.deepEqual(normalized, { filePath: 'real.txt' })
})

test('a non-numeric string is left alone so the schema still rejects it', () => {
  const normalized = normalizeToolInput('Read', { filePath: 'a.txt', offset: 'soon' }) as Record<string, unknown>
  assert.equal(normalized.offset, 'soon')
  assert.equal(validateToolInput(tool('Read'), normalized).ok, false)
})

test('already-canonical input is returned unchanged by identity', () => {
  const input = { filePath: 'a.txt' }
  assert.equal(normalizeToolInput('Read', input), input)
})

test('an unknown tool passes through untouched', () => {
  const input = { anything: 1 }
  assert.equal(normalizeToolInput('NoSuchTool', input), input)
})

test('NotebookEdit takes camelCase aliases toward its snake_case schema', () => {
  const normalized = normalizeToolInput('NotebookEdit', {
    filePath: 'nb.ipynb',
    cellId: 'c1',
    newSource: 'print(1)',
    editMode: 'replace',
  })
  assert.deepEqual(normalized, {
    notebook_path: 'nb.ipynb',
    cell_id: 'c1',
    new_source: 'print(1)',
    edit_mode: 'replace',
  })
  assert.equal(validateToolInput(tool('NotebookEdit'), normalized).ok, true)
})

test('MessageThread and AskCoordinator bodies are renamed onto their real parameter', () => {
  assert.deepEqual(normalizeToolInput('MessageThread', { threadId: 't', message: 'hi' }), { threadId: 't', text: 'hi' })
  assert.deepEqual(normalizeToolInput('MessageThread', { threadId: 't', content: 'hi', text: 'real' }), {
    threadId: 't',
    text: 'real',
  })
  assert.deepEqual(normalizeToolInput('AskCoordinator', { message: 'why?' }), { question: 'why?' })
})

test('a single-task TaskCreate call becomes a one-item batch, and a batch passes through', () => {
  const single = { subject: 'Add schema', description: 'Write the schema' }
  const normalized = normalizeToolInput('TaskCreate', single)
  assert.deepEqual(normalized, { tasks: [single] })
  assert.equal(validateToolInput(tool('TaskCreate'), normalized).ok, true)

  const batch = { tasks: [single, { subject: 'Wire view', description: 'Draw it' }] }
  assert.equal(normalizeToolInput('TaskCreate', batch), batch)
  assert.deepEqual(normalizeToolInput('TaskCreate', { todos: batch.tasks }), batch)
})

test('WebSearch accepts the prior shapes: a bare query, provider-style names, and Codex command objects', () => {
  assert.deepEqual(normalizeToolInput('WebSearch', { query: 'rust async' }), { queries: ['rust async'] })
  assert.deepEqual(
    normalizeToolInput('WebSearch', { query: 'rust async', allowed_domains: ['rust-lang.org'], blocked_domains: ['spam.test'] }),
    { queries: ['rust async'], domains: ['rust-lang.org'], blockedDomains: ['spam.test'] },
  )
  assert.deepEqual(
    normalizeToolInput('WebSearch', { search_query: [{ q: 'tokio release', recency: '30', domains: 'tokio.rs' }] }),
    { queries: [{ q: 'tokio release', recencyDays: 30, domains: ['tokio.rs'] }] },
  )
  // The canonical shape passes through unchanged.
  const canonical = { queries: [{ q: 'a', recencyDays: 7 }], domains: ['a.test'], maxResults: 3 }
  assert.deepEqual(normalizeToolInput('WebSearch', canonical), canonical)
})

test('WebFetch drops the summarizing `prompt` it cannot honour and keeps the rest', () => {
  assert.deepEqual(normalizeToolInput('WebFetch', { url: 'https://example.com', prompt: 'Summarize the page' }), {
    url: 'https://example.com',
  })
  assert.deepEqual(
    normalizeToolInput('WebFetch', { url: 'https://example.com', offset: '120', pattern: ['a', 'b'] }),
    { url: 'https://example.com', offset: 120, pattern: ['a', 'b'] },
  )
})
