import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate, permissionRulesFromSettings } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { ReadFileState, ToolContext } from '../src/harness/types.js'
import { classifyToolCall } from '../src/harness/risk/index.js'
import { createRiskContext } from '../src/harness/risk/paths.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import { deleteFileTool } from '../src/tools/FileDeleteTool/FileDeleteTool.js'
import { notebookEditTool } from '../src/tools/NotebookEditTool/NotebookEditTool.js'

/** Under the disposable home: a sibling of the project is outside the workspace. */
async function scratch(t: test.TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.homedir(), 'binding-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function context(cwd: string): ToolContext {
  return { cwd, sessionId: 's1', readFiles: new Set<string>(), readFileState: new Map<string, ReadFileState>() }
}

function runner(cwd: string, gate: PermissionGate, hooks?: ConstructorParameters<typeof ToolRunner>[3]): ToolRunner {
  return new ToolRunner(
    [writeFileTool, readFileTool, deleteFileTool, notebookEditTool],
    gate,
    { onRecord: async () => {} },
    hooks,
  )
}

const NOTEBOOK = JSON.stringify({
  cells: [{ id: 'abc', cell_type: 'code', source: 'a = 1', metadata: {}, execution_count: null, outputs: [] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
}, null, 1)

test('classification binds a delete to the link while the risk stays on its target', async (t) => {
  const root = await scratch(t)
  const sshDir = path.join(os.homedir(), '.ssh')
  await mkdir(sshDir, { recursive: true })
  const secret = path.join(sshDir, 'id_rsa')
  await writeFile(secret, 'PRIVATE\n', 'utf8')
  const link = path.join(root, 'key-link')
  await symlink(secret, link)

  const risk = classifyToolCall(deleteFileTool, { filePath: 'key-link' }, createRiskContext({ cwd: root }))

  assert.equal(risk.level, 'critical')
  assert.equal(risk.writeTarget, link)
})

test('every approval path carries the target resolved at classification', async (t) => {
  const cwd = await scratch(t)
  const file = path.join(cwd, 'a.txt')
  const input = { filePath: 'a.txt', content: 'x\n' }
  const expected = file

  const auto = await new PermissionGate(async () => false, [], { mode: 'auto', cwd }).approveDetailed(writeFileTool, input)
  assert.equal(auto.approved, true)
  assert.equal(auto.writeTarget, expected)

  const asked = await new PermissionGate(async () => true, [], { mode: 'default', cwd }).approveDetailed(writeFileTool, input)
  assert.equal(asked.approved, true)
  assert.equal(asked.writeTarget, expected)

  const ruled = await new PermissionGate(async () => false, permissionRulesFromSettings({ allow: ['Write'] }), { mode: 'default', cwd })
    .approveDetailed(writeFileTool, input)
  assert.equal(ruled.approved, true)
  assert.equal(ruled.writeTarget, expected)

  const bypass = await new PermissionGate(async () => false, [], { mode: 'bypass', cwd }).approveDetailed(writeFileTool, input)
  assert.equal(bypass.approved, true)
  assert.equal(bypass.writeTarget, expected)
})

test('a swap during the approval prompt writes neither the approved nor the new target', async (t) => {
  const root = await scratch(t)
  const cwd = path.join(root, 'project')
  const approved = path.join(root, 'approved')
  const other = path.join(root, 'other')
  await mkdir(cwd)
  await mkdir(approved)
  await mkdir(other)
  const link = path.join(cwd, 'escape')
  await symlink(approved, link)

  let prompted = 0
  const gate = new PermissionGate(async () => {
    prompted += 1
    await unlink(link)
    await symlink(other, link)
    return true
  }, [], { mode: 'auto', cwd })

  const result = await runner(cwd, gate).run(
    { id: 'c1', name: 'Write', input: { filePath: 'escape/x.txt', content: 'x\n' } },
    context(cwd),
  )

  assert.equal(prompted, 1)
  assert.equal(result.ok, false)
  assert.match(result.content, /changed after permission was checked/)
  assert.deepEqual(await readdir(approved), [])
  assert.deepEqual(await readdir(other), [])
})

test('a pre-tool hook cannot re-point a normal workspace write', async (t) => {
  const root = await scratch(t)
  const cwd = path.join(root, 'project')
  const sub = path.join(cwd, 'sub')
  const outside = path.join(root, 'outside')
  await mkdir(sub, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(sub, 'a.txt'), 'old\n', 'utf8')
  await writeFile(path.join(cwd, 'swap.mjs'), [
    "import { renameSync, symlinkSync } from 'node:fs'",
    "renameSync('sub', 'sub-moved')",
    "symlinkSync('../outside', 'sub', 'dir')",
  ].join('\n'))

  const ctx = context(cwd)
  await readFileTool.execute({ filePath: 'sub/a.txt' }, ctx)
  const gate = new PermissionGate(async () => false, [], { mode: 'auto', cwd })
  const hooks = { preToolUse: [{ matcher: 'Write', command: 'node swap.mjs' }] }

  const result = await runner(cwd, gate, hooks).run(
    { id: 'c1', name: 'Write', input: { filePath: 'sub/a.txt', content: 'new\n' } },
    ctx,
  )

  assert.equal(result.ok, false)
  assert.match(result.content, /changed after permission was checked/)
  assert.deepEqual(await readdir(outside), [])
  assert.equal(await readFile(path.join(cwd, 'sub-moved', 'a.txt'), 'utf8'), 'old\n')
})

test('a pre-tool hook cannot re-point a notebook edit', async (t) => {
  const root = await scratch(t)
  const cwd = path.join(root, 'project')
  const nb = path.join(cwd, 'nb')
  const outside = path.join(root, 'outside')
  await mkdir(nb, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(nb, 'note.ipynb'), NOTEBOOK, 'utf8')
  await writeFile(path.join(outside, 'note.ipynb'), NOTEBOOK, 'utf8')
  await writeFile(path.join(cwd, 'swap.mjs'), [
    "import { renameSync, symlinkSync } from 'node:fs'",
    "renameSync('nb', 'nb-moved')",
    "symlinkSync('../outside', 'nb', 'dir')",
  ].join('\n'))

  const ctx = context(cwd)
  await readFileTool.execute({ filePath: 'nb/note.ipynb' }, ctx)
  const gate = new PermissionGate(async () => false, [], { mode: 'auto', cwd })
  const hooks = { preToolUse: [{ matcher: 'NotebookEdit', command: 'node swap.mjs' }] }

  const result = await runner(cwd, gate, hooks).run(
    { id: 'c1', name: 'NotebookEdit', input: { notebook_path: 'nb/note.ipynb', cell_id: 'abc', new_source: 'a = 2' } },
    ctx,
  )

  assert.equal(result.ok, false)
  assert.match(result.content, /changed after permission was checked/)
  assert.equal(await readFile(path.join(outside, 'note.ipynb'), 'utf8'), NOTEBOOK)
  assert.equal(await readFile(path.join(cwd, 'nb-moved', 'note.ipynb'), 'utf8'), NOTEBOOK)
})

test('an explicitly authorized external path is still written through a link', async (t) => {
  const root = await scratch(t)
  const cwd = path.join(root, 'project')
  const outside = path.join(root, 'outside')
  await mkdir(cwd)
  await mkdir(outside)
  await symlink(outside, path.join(cwd, 'escape'))

  const gate = new PermissionGate(async () => false, [], {
    mode: 'auto',
    cwd,
    additionalDirectories: [outside],
  })

  const result = await runner(cwd, gate).run(
    { id: 'c1', name: 'Write', input: { filePath: 'escape/x.txt', content: 'allowed\n' } },
    context(cwd),
  )

  assert.equal(result.ok, true, result.content)
  assert.equal(await readFile(path.join(outside, 'x.txt'), 'utf8'), 'allowed\n')
})

test('deleting a link itself still works through the gate', async (t) => {
  const cwd = await scratch(t)
  const destination = path.join(cwd, 'destination.txt')
  await writeFile(destination, 'keep\n', 'utf8')
  const link = path.join(cwd, 'link.txt')
  await symlink(destination, link)

  const ctx = context(cwd)
  await readFileTool.execute({ filePath: 'link.txt' }, ctx)
  const gate = new PermissionGate(async () => true, [], { mode: 'auto', cwd })

  const result = await runner(cwd, gate).run(
    { id: 'c1', name: 'Delete', input: { filePath: 'link.txt' } },
    ctx,
  )

  assert.equal(result.ok, true, result.content)
  await assert.rejects(readFile(link, 'utf8'))
  assert.equal(await readFile(destination, 'utf8'), 'keep\n')
})
