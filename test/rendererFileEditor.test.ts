import test from 'node:test'
import assert from 'node:assert/strict'
import { FileEditorBuffer, workspaceRelativeLink } from '../src/desktop/renderer/model/fileEditor.js'
import type { WorkspaceSaveResult } from '../src/runtime/protocol/workspaceFiles.js'
import { parseFileMarkdownBlocks, parseMarkdownBlocks } from '../src/desktop/renderer/model/markdown.js'

const file = { kind: 'text' as const, path: 'a.txt', size: 4, content: 'base', revision: 'r1' }

test('typing during an in-flight save drains the newer version without a false clean state', async () => {
  let settle!: (result: WorkspaceSaveResult) => void
  const calls: Array<[string, string]> = []
  const buffer = new FileEditorBuffer(file, (content, revision) => {
    calls.push([content, revision])
    return calls.length === 1 ? new Promise((resolve) => { settle = resolve }) : Promise.resolve({ kind: 'saved', revision: 'r3' })
  }, () => {})
  buffer.edit('first')
  const saving = buffer.flush()
  buffer.edit('second')
  assert.equal(buffer.status, 'saving')
  settle({ kind: 'saved', revision: 'r2' })
  assert.equal(await saving, true)
  assert.deepEqual(calls, [['first', 'r1'], ['second', 'r2']])
  assert.equal(buffer.base.content, 'second')
  assert.equal(buffer.status, 'clean')
  buffer.dispose()
})

test('conflicts suspend autosave and explicit overwrite checks the shown disk revision', async () => {
  const calls: string[] = []
  const disk = { ...file, content: 'external', revision: 'external-r' }
  const buffer = new FileEditorBuffer(file, async (_, revision) => {
    calls.push(revision)
    return calls.length === 1 ? { kind: 'conflict', disk } : { kind: 'saved', revision: 'saved-r' }
  }, () => {}, 5)
  buffer.edit('mine')
  assert.equal(await buffer.flush(), false)
  buffer.edit('mine2')
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(calls.length, 1)
  assert.equal(await buffer.overwrite(), true)
  assert.deepEqual(calls, ['r1', 'external-r'])
  assert.equal(buffer.base.content, 'mine2')
  buffer.dispose()
})

test('IME pauses autosave; composition end saves; failed saves retain input', async () => {
  let attempts = 0
  const buffer = new FileEditorBuffer(file, async () => { attempts++; throw new Error('disk full') }, () => {}, 5)
  buffer.composition(true)
  buffer.edit('中文')
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(attempts, 0)
  buffer.composition(false)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(attempts, 1)
  assert.equal(buffer.status, 'error')
  assert.equal(buffer.content, '中文')
  assert.equal(buffer.dirty, true)
  buffer.dispose()
})

test('external refresh reloads clean buffers and preserves dirty buffers', async () => {
  const buffer = new FileEditorBuffer(file, async () => ({ kind: 'saved', revision: 'saved' }), () => {})
  await buffer.refresh(async () => ({ ...file, content: 'disk', revision: 'r2' }))
  assert.equal(buffer.content, 'disk')
  buffer.edit('mine')
  await buffer.refresh(async () => ({ ...file, content: 'new disk', revision: 'r3' }))
  assert.equal(buffer.content, 'mine')
  assert.equal(buffer.status, 'conflict')
  buffer.dispose()
})

test('a refresh begun before a successful save cannot restore stale disk content', async () => {
  let resolve!: (value: typeof file) => void
  const buffer = new FileEditorBuffer(file, async () => ({ kind: 'saved', revision: 'saved' }), () => {})
  const refreshing = buffer.refresh(() => new Promise((settle) => { resolve = settle }))
  buffer.edit('new version')
  await buffer.flush()
  resolve(file)
  await refreshing
  assert.equal(buffer.content, 'new version')
  assert.equal(buffer.base.revision, 'saved')
  buffer.dispose()
})

test('local Markdown links and images are enabled only for file previews', () => {
  const content = '[file](./other.md) **![photo](../a.png)**'
  const normal = JSON.stringify(parseMarkdownBlocks(content))
  const preview = JSON.stringify(parseFileMarkdownBlocks(content))
  assert.ok(!normal.includes('"kind":"image"'))
  assert.ok(!normal.includes('"href":"./other.md"'))
  assert.ok(preview.includes('"kind":"image"'))
  assert.ok(preview.includes('"href":"./other.md"'))
  assert.equal(workspaceRelativeLink('docs/a.md', '../中文%20file.md'), '中文 file.md')
  assert.equal(workspaceRelativeLink('a.md', '../outside'), undefined)
  assert.equal(workspaceRelativeLink('a.md', 'https://example.com/a'), undefined)
})
