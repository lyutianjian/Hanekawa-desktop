import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryIndexWatch } from '../src/services/memory/memoryIndexWatch.js'

async function memoryDir(t: test.TestContext, index: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-watch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'MEMORY.md'), index, 'utf8')
  return dir
}

test("another session's index change arrives once, as added and removed lines", async (t) => {
  const dir = await memoryDir(t, '- [A](a.md) — one\n- [B](b.md) — two')
  const watch = createMemoryIndexWatch(dir, '- [A](a.md) — one\n- [B](b.md) — two')
  assert.equal(watch.take(), undefined)

  await writeFile(path.join(dir, 'MEMORY.md'), '- [A](a.md) — one\n- [C](c.md) — three\n', 'utf8')
  const update = watch.take()
  assert.equal(update, [
    `${path.join(dir, 'MEMORY.md')} changed in another session since you last saw it.`,
    '',
    'Added:',
    '- [C](c.md) — three',
    '',
    'Removed:',
    '- [B](b.md) — two',
  ].join('\n'))
  assert.equal(watch.take(), undefined)
})

test("this session's own index write is not reported back", async (t) => {
  const dir = await memoryDir(t, '- [A](a.md) — one')
  const watch = createMemoryIndexWatch(dir, '- [A](a.md) — one')
  watch.noteWrite(path.join(dir, 'a.md'))
  watch.noteWrite(path.join(dir, 'MEMORY.md'))
  await writeFile(path.join(dir, 'MEMORY.md'), '- [A](a.md) — one\n- [B](b.md) — two', 'utf8')
  assert.equal(watch.take(), undefined)

  await writeFile(path.join(dir, 'MEMORY.md'), '- [B](b.md) — two', 'utf8')
  assert.match(watch.take() ?? '', /Removed:\n- \[A\]\(a\.md\) — one$/)
})

test('after compaction every change since the opening snapshot is restated', async (t) => {
  const dir = await memoryDir(t, '- [A](a.md) — one')
  const watch = createMemoryIndexWatch(dir, '- [A](a.md) — one')
  await writeFile(path.join(dir, 'MEMORY.md'), '- [A](a.md) — one\n- [B](b.md) — two', 'utf8')
  assert.ok(watch.take())

  const restore = watch.takeSinceOpening()
  assert.match(restore ?? '', /has changed since the conversation began\.\n\nAdded:\n- \[B\]\(b\.md\) — two$/)
  assert.equal(watch.take(), undefined)
})
