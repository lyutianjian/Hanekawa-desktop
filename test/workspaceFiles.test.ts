import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceFiles, TEXT_LIMIT, readPdfResource } from '../src/services/workspaceFiles/workspaceFiles.js'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-files-'))
  const service = new WorkspaceFiles(root)
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, service }
}

test('directory listing includes hidden, ignored and empty directories; search includes unopened descendants', async (t) => {
  const { root, service } = await fixture(t)
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true })
  await mkdir(path.join(root, 'empty'))
  await mkdir(path.join(root, 'node_modules'))
  await writeFile(path.join(root, '.env'), 'hidden')
  await writeFile(path.join(root, 'src/nested/中文 file.ts'), 'hello')
  await writeFile(path.join(root, 'node_modules/中文.txt'), 'skip')
  const listing = await service.list()
  assert.ok(listing.entries.some((entry) => entry.name === '.env'))
  assert.equal(listing.entries.find((entry) => entry.name === 'empty')?.kind, 'directory')
  assert.equal((await service.search('', '中文')).entries.length, 1)
  assert.equal((await service.search('node_modules', '中文')).entries.length, 1)
})

test('read and save preserve UTF-8 BOM, UTF-16LE, CRLF and file mode', async (t) => {
  const { root, service } = await fixture(t)
  for (const encoding of ['utf8', 'utf16le'] as const) {
    const name = `${encoding}.txt`
    await writeFile(path.join(root, name), Buffer.from('\uFEFF你好\r\nold\r\n', encoding))
    await chmod(path.join(root, name), 0o640)
    const file = await service.read(name)
    assert.equal(file.kind, 'text')
    if (file.kind !== 'text') throw new Error('text expected')
    assert.equal(file.content, '你好\nold\n')
    const saved = await service.save(name, '新文字\nnext\n', file.revision)
    assert.equal(saved.kind, 'saved')
    assert.deepEqual(await readFile(path.join(root, name)), Buffer.from('\uFEFF新文字\r\nnext\r\n', encoding))
    if (process.platform !== 'win32') assert.equal((await stat(path.join(root, name))).mode & 0o777, 0o640)
    const current = await service.read(name)
    assert.ok(current.kind === 'text' && saved.kind === 'saved' && current.revision === saved.revision)
  }
})

test('a stale save or external deletion never overwrites or recreates the file', async (t) => {
  const { root, service } = await fixture(t)
  await writeFile(path.join(root, 'a'), 'base')
  const file = await service.read('a')
  if (file.kind !== 'text') throw new Error('text expected')
  await writeFile(path.join(root, 'a'), 'external')
  const conflict = await service.save('a', 'mine', file.revision)
  assert.ok(conflict.kind === 'conflict' && conflict.disk?.kind === 'text' && conflict.disk.content === 'external')
  assert.equal(await readFile(path.join(root, 'a'), 'utf8'), 'external')
  await rm(path.join(root, 'a'))
  assert.deepEqual(await service.save('a', 'mine', file.revision), { kind: 'conflict', disk: null })
  await assert.rejects(stat(path.join(root, 'a')))
})

test('real paths cannot escape the workspace; internal symlinks write the target', async (t) => {
  const { root, service } = await fixture(t)
  await writeFile(path.join(root, 'file'), 'old')
  await symlink(path.join(root, 'file'), path.join(root, 'link'))
  await symlink(path.dirname(root), path.join(root, 'outside'), 'dir')
  await mkdir(path.join(root, 'directory'))
  await symlink(path.join(root, 'directory'), path.join(root, 'directory-link'), 'dir')
  const entries = (await service.list()).entries
  assert.equal(entries.find((item) => item.name === 'directory-link')?.kind, 'directory')
  assert.equal(entries.find((item) => item.name === 'outside')?.kind, 'link')
  await assert.rejects(service.resolve('../outside'), /工作目录/)
  await assert.rejects(service.resolve('outside'), /目录外/)
  await assert.rejects(service.resolve(root), /相对路径/)
  const file = await service.read('link')
  if (file.kind !== 'text') throw new Error('text expected')
  await service.save('link', 'new', file.revision)
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'new')
})

test('binary, unsupported encoding and oversized text cannot become editable truncated files', async (t) => {
  const { root, service } = await fixture(t)
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]))
  await writeFile(path.join(root, 'encoding'), Buffer.from([0xff, 0x80]))
  await writeFile(path.join(root, 'large'), Buffer.alloc(TEXT_LIMIT + 1, 65))
  for (const name of ['binary', 'encoding', 'large']) assert.equal((await service.read(name)).kind, 'unsupported')
  await assert.rejects(readPdfResource('cMapUrl', '../package.json'), /无效/)
})

test('parent-directory watch observes an atomic save and disposal stops notifications', async (t) => {
  const { root, service } = await fixture(t)
  const events: string[][] = []
  const watcher = new WorkspaceFiles(root, (change) => events.push(change.paths))
  t.after(() => watcher.dispose())
  await writeFile(path.join(root, 'a'), 'old')
  await watcher.setWatch([''])
  const file = await service.read('a')
  if (file.kind !== 'text') throw new Error('text expected')
  await service.save('a', 'new', file.revision)
  for (let i = 0; i < 30 && events.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(events[0], [''])
  watcher.dispose()
  await assert.rejects(watcher.read('a'), /已关闭/)
})
