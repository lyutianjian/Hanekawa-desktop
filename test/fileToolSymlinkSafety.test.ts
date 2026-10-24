import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReadFileState } from '../src/harness/types.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import { editFileTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { deleteFileTool } from '../src/tools/FileDeleteTool/FileDeleteTool.js'
import { classifyToolCall } from '../src/harness/risk/index.js'
import { createRiskContext } from '../src/harness/risk/paths.js'
import { getGlobalMyAgentDir } from '../src/utils/paths.js'
import { assertTargetUnchanged, resolveSafeTarget } from '../src/tools/pathSafety.js'

function context(cwd: string, onTrack?: (filePath: string) => Promise<void>) {
  return {
    cwd,
    sessionId: 's1',
    readFiles: new Set<string>(),
    readFileState: new Map<string, ReadFileState>(),
    ...(onTrack ? { trackFileEdit: onTrack } : {}),
  }
}

/** Under the disposable home: the system temp dirs count as workspace. */
async function scratch(t: test.TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.homedir(), 'link-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('Write works when the working directory itself was opened through a symlink', async (t) => {
  const root = await scratch(t)
  const project = path.join(root, 'project')
  const alias = path.join(root, 'alias')
  await mkdir(project)
  await symlink(project, alias)

  const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'alpha\n' }, context(alias))

  assert.equal(result.ok, true, result.content)
  assert.equal(await readFile(path.join(project, 'a.txt'), 'utf8'), 'alpha\n')
})

test('Write follows a legitimate parent link and keeps new directories under its target', async (t) => {
  const root = await scratch(t)
  const real = path.join(root, 'shared')
  await mkdir(real)
  await symlink(real, path.join(root, 'src'))

  const result = await writeFileTool.execute({ filePath: 'src/a/b/c.txt', content: 'deep\n' }, context(root))

  assert.equal(result.ok, true, result.content)
  assert.equal(await readFile(path.join(real, 'a', 'b', 'c.txt'), 'utf8'), 'deep\n')
})

test('Edit and Delete work through a legitimate parent link', async (t) => {
  const root = await scratch(t)
  const real = path.join(root, 'shared')
  await mkdir(real)
  await symlink(real, path.join(root, 'src'))
  await writeFile(path.join(real, 'a.txt'), 'alpha\n', 'utf8')
  const ctx = context(root)

  await readFileTool.execute({ filePath: 'src/a.txt' }, ctx)
  const edited = await editFileTool.execute({ filePath: 'src/a.txt', oldString: 'alpha', newString: 'beta' }, ctx)
  assert.equal(edited.ok, true, edited.content)
  assert.equal(await readFile(path.join(real, 'a.txt'), 'utf8'), 'beta\n')

  const deleted = await deleteFileTool.execute({ filePath: 'src/a.txt' }, ctx)
  assert.equal(deleted.ok, true, deleted.content)
  await assert.rejects(readFile(path.join(real, 'a.txt')))
})

test('a target that is itself a symlink is still refused', async (t) => {
  const root = await scratch(t)
  const destination = path.join(root, 'destination.txt')
  await writeFile(destination, 'keep\n', 'utf8')
  await symlink(destination, path.join(root, 'link.txt'))
  const ctx = context(root)
  await readFileTool.execute({ filePath: 'link.txt' }, ctx)

  const result = await writeFileTool.execute({ filePath: 'link.txt', content: 'changed\n' }, ctx)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.match(result.content, /target is a symbolic link/)
  assert.equal(await readFile(destination, 'utf8'), 'keep\n')
})

test('a link out of the workspace is still judged by where it lands', async (t) => {
  const cwd = await scratch(t)
  const outside = await scratch(t)
  await symlink(outside, path.join(cwd, 'escape'))

  const unauthorized = classifyToolCall(
    writeFileTool,
    { filePath: 'escape/x.txt', content: 'x' },
    createRiskContext({ cwd }),
  )
  assert.equal(unauthorized.level, 'risky')

  const authorized = classifyToolCall(
    writeFileTool,
    { filePath: 'escape/x.txt', content: 'x' },
    createRiskContext({ cwd, additionalDirectories: [outside] }),
  )
  assert.equal(authorized.level, 'normal')

  // The gate already approved this outside path; the tool must not refuse it a
  // second time just because the route to it is a symlink.
  const result = await writeFileTool.execute({ filePath: 'escape/x.txt', content: 'allowed\n' }, context(cwd))
  assert.equal(result.ok, true, result.content)
  assert.equal(await readFile(path.join(outside, 'x.txt'), 'utf8'), 'allowed\n')
})

test('a link into Hanekawa runtime data is still refused', async (t) => {
  const root = await scratch(t)
  const runtime = path.join(getGlobalMyAgentDir(), 'projects', 'nope')
  await mkdir(runtime, { recursive: true })
  await symlink(runtime, path.join(root, 'escape'))

  await assert.rejects(
    writeFileTool.execute({ filePath: 'escape/x.txt', content: 'x' }, context(root)),
    /runtime data/,
  )
})
test('a directory swapped for a symlink before the write is refused', async (t) => {
  const root = await scratch(t)
  const real = path.join(root, 'real')
  const dir = path.join(root, 'sub')
  await mkdir(real)
  await mkdir(dir)

  const safe = await resolveSafeTarget(path.join(dir, 'file.txt'), 'sub/file.txt')
  assert.equal('target' in safe, true)
  if (!('target' in safe)) return
  assert.equal(await assertTargetUnchanged(safe.target, 'sub/file.txt'), undefined)

  // The directory the write was resolved against becomes a link elsewhere.
  await rename(dir, path.join(root, 'sub-moved'))
  await symlink(real, dir)

  const changed = await assertTargetUnchanged(safe.target, 'sub/file.txt')
  assert.equal(changed?.ok, false)
  assert.match(changed!.content, /changed after it was checked/)
})

test('a target that becomes a symlink before the write is refused', async (t) => {
  const root = await scratch(t)
  const destination = path.join(root, 'destination.txt')
  await writeFile(destination, 'keep\n', 'utf8')
  const file = path.join(root, 'a.txt')
  await writeFile(file, 'old\n', 'utf8')

  const safe = await resolveSafeTarget(file, 'a.txt')
  assert.equal('target' in safe, true)
  if (!('target' in safe)) return

  await rm(file)
  await symlink(destination, file)

  const changed = await assertTargetUnchanged(safe.target, 'a.txt')
  assert.equal(changed?.ok, false)
  assert.match(changed!.content, /changed after it was checked/)
  assert.equal(await readFile(destination, 'utf8'), 'keep\n')
})
test('a write is refused when the parent becomes a link after the snapshot', async (t) => {
  const root = await scratch(t)
  const project = path.join(root, 'project')
  const sub = path.join(project, 'sub')
  const outside = path.join(root, 'outside')
  await mkdir(sub, { recursive: true })
  await mkdir(outside)

  const ctx = context(project, async () => {
    await rename(sub, path.join(project, 'sub-moved'))
    await symlink(outside, sub)
  })

  const result = await writeFileTool.execute({ filePath: 'sub/a.txt', content: 'x\n' }, ctx)

  assert.equal(result.ok, false)
  assert.match(result.content, /changed after it was checked/)
  assert.deepEqual(await readdir(outside), [])
})

test('a write is refused when a file appears where none was at resolution', async (t) => {
  const root = await scratch(t)
  const file = path.join(root, 'a.txt')
  const ctx = context(root, async () => {
    await writeFile(file, 'other\n', 'utf8')
  })

  const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'x\n' }, ctx)

  assert.equal(result.ok, false)
  assert.match(result.content, /changed after it was checked/)
  assert.equal(await readFile(file, 'utf8'), 'other\n')
})

test('an edit is refused when the target file is replaced after the snapshot', async (t) => {
  const root = await scratch(t)
  const file = path.join(root, 'a.txt')
  await writeFile(file, 'old\n', 'utf8')
  const ctx = context(root, async () => {
    await rm(file)
    await writeFile(file, 'replacement\n', 'utf8')
  })
  await readFileTool.execute({ filePath: 'a.txt' }, ctx)

  const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'old', newString: 'new' }, ctx)

  assert.equal(result.ok, false)
  assert.match(result.content, /changed after it was checked/)
  assert.equal(await readFile(file, 'utf8'), 'replacement\n')
})

test('a delete is refused when the parent becomes a link after the snapshot', async (t) => {
  const root = await scratch(t)
  const project = path.join(root, 'project')
  const sub = path.join(project, 'sub')
  const outside = path.join(root, 'outside')
  await mkdir(sub, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(sub, 'a.txt'), 'keep\n', 'utf8')
  await writeFile(path.join(outside, 'a.txt'), 'outside\n', 'utf8')

  const ctx = context(project, async () => {
    await rename(sub, path.join(project, 'sub-moved'))
    await symlink(outside, sub)
  })
  await readFileTool.execute({ filePath: 'sub/a.txt' }, ctx)

  const result = await deleteFileTool.execute({ filePath: 'sub/a.txt' }, ctx)

  assert.equal(result.ok, false)
  assert.match(result.content, /changed after it was checked/)
  assert.equal(await readFile(path.join(project, 'sub-moved', 'a.txt'), 'utf8'), 'keep\n')
  assert.equal(await readFile(path.join(outside, 'a.txt'), 'utf8'), 'outside\n')
})

test('delete still unlinks the symlink itself', async (t) => {
  const root = await scratch(t)
  const destination = path.join(root, 'destination.txt')
  await writeFile(destination, 'keep\n', 'utf8')
  const link = path.join(root, 'link.txt')
  await symlink(destination, link)
  const ctx = context(root)
  await readFileTool.execute({ filePath: 'link.txt' }, ctx)

  const result = await deleteFileTool.execute({ filePath: 'link.txt' }, ctx)

  assert.equal(result.ok, true, result.content)
  await assert.rejects(lstat(link), /ENOENT/)
  assert.equal(await readFile(destination, 'utf8'), 'keep\n')
})

test('an unreadable ancestor fails closed instead of being written through', async (t) => {
  if (process.getuid?.() === 0) return
  const root = await scratch(t)
  const inner = path.join(root, 'locked', 'inner')
  await mkdir(inner, { recursive: true })
  await chmod(path.join(root, 'locked'), 0o000)
  try {
    const result = await writeFileTool.execute({ filePath: 'locked/inner/a.txt', content: 'x\n' }, context(root))

    assert.equal(result.ok, false)
    assert.match(result.content, /could not be resolved safely/)
    assert.equal(result.errorDetails && (result.errorDetails as { reason?: string }).reason, 'path_unresolvable')
  } finally {
    await chmod(path.join(root, 'locked'), 0o700)
  }
})

test('a dangling symlink ancestor fails closed', async (t) => {
  const root = await scratch(t)
  await symlink(path.join(root, 'missing'), path.join(root, 'dangling'))

  const result = await writeFileTool.execute({ filePath: 'dangling/a.txt', content: 'x\n' }, context(root))

  assert.equal(result.ok, false)
  assert.match(result.content, /could not be resolved safely/)
  assert.match(result.content, /does not resolve/)
  await assert.rejects(lstat(path.join(root, 'dangling', 'a.txt')))
})

test('a path whose parent is a file fails closed', async (t) => {
  const root = await scratch(t)
  const file = path.join(root, 'file.txt')
  await writeFile(file, 'x\n', 'utf8')

  const result = await writeFileTool.execute({ filePath: 'file.txt/a.txt', content: 'y\n' }, context(root))

  assert.equal(result.ok, false)
  assert.match(result.content, /could not be resolved safely/)
  assert.equal(await readFile(file, 'utf8'), 'x\n')
})
