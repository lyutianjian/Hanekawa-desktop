import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { branchDiff, createThreadWorktree, isDirty, mergeBranch, removeThreadWorktree } from '../src/services/coordination/threadWorktree.js'
import { getThreadWorktreeDir } from '../src/utils/paths.js'

async function fixture(): Promise<{ repo: string; git: (...a: string[]) => string; dispose: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'thread-wt-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@example.com')
  await writeFile(path.join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { repo, git, dispose: () => rm(repo, { recursive: true, force: true }) }
}

async function commitIn(dir: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(dir, file), content)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir })
  g('add', '.')
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'c')
}

test('create and remove a thread worktree', async () => {
  const { repo, git, dispose } = await fixture()
  try {
    const wt = await createThreadWorktree({ cwd: repo, threadId: 'thr_x', slug: 'Fix Bug!' })
    assert.equal(wt.branch, 'hanekawa/fix-bug-thr_x')
    assert.equal(wt.path, getThreadWorktreeDir(repo, 'thr_x'))
    assert.equal(wt.baseRef, git('rev-parse', 'HEAD'))
    assert.ok(existsSync(path.join(wt.path, 'a.txt')))
    await removeThreadWorktree(repo, wt)
    assert.ok(!existsSync(wt.path))
    assert.equal(git('branch', '--list', wt.branch), '')
  } finally {
    await dispose()
  }
})

test('a repository with uncommitted source refuses a thread until the user commits a baseline', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'thread-wt-empty-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 't')
    git('config', 'user.email', 't@example.com')
    await writeFile(path.join(repo, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    await assert.rejects(createThreadWorktree({ cwd: repo, threadId: 'thr_e', slug: 'e' }), /提交/)
    assert.equal(git('status', '--porcelain'), 'A  a.txt')
    assert.equal(existsSync(getThreadWorktreeDir(repo, 'thr_e')), false)
    git('commit', '-q', '-m', 'explicit baseline')
    const wt = await createThreadWorktree({ cwd: repo, threadId: 'thr_e', slug: 'e' })
    assert.equal(existsSync(path.join(wt.path, 'a.txt')), true)
    await removeThreadWorktree(repo, wt)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('a nonempty non-Git directory refuses a thread without initializing or committing user files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'thread-wt-plain-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  const env = { ...process.env }
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' })
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\n')
    await assert.rejects(createThreadWorktree({ cwd: dir, threadId: 'thr_p', slug: 'p' }), /提交/)
    assert.equal(existsSync(path.join(dir, '.git')), false)
    assert.equal(existsSync(getThreadWorktreeDir(dir, 'thr_p')), false)
  } finally {
    process.env = env
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty project can still start a thread, while an empty HEAD with untracked source is refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'thread-empty-baseline-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  const env = { ...process.env }
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' })
  try {
    const wt = await createThreadWorktree({ cwd: dir, threadId: 'thr_empty', slug: 'empty' })
    await removeThreadWorktree(dir, wt)
    await writeFile(path.join(dir, 'source.ts'), 'source')
    await assert.rejects(createThreadWorktree({ cwd: dir, threadId: 'thr_source', slug: 'source' }), /提交/)
    assert.equal(git('branch', '--list', 'hanekawa/*'), '')
    assert.equal(existsSync(getThreadWorktreeDir(dir, 'thr_source')), false)
  } finally { process.env = env; await rm(dir, { recursive: true, force: true }) }
})

test('branchDiff counts commits and lines; merge succeeds on a clean tree', async () => {
  const { repo, git, dispose } = await fixture()
  try {
    const wt = await createThreadWorktree({ cwd: repo, threadId: 'thr_m', slug: 'm' })
    await commitIn(wt.path, 'b.txt', 'x\ny\n')
    const d = await branchDiff(repo, wt.branch)
    assert.deepEqual({ ahead: d.ahead, added: d.added, removed: d.removed }, { ahead: 1, added: 2, removed: 0 })
    assert.equal(d.head, git('rev-parse', wt.branch))
    assert.deepEqual(await mergeBranch(repo, wt.branch), { kind: 'merged' })
    assert.ok(existsSync(path.join(repo, 'b.txt')))
    await removeThreadWorktree(repo, wt)
  } finally {
    await dispose()
  }
})

test('a dirty tree refuses the merge untouched', async () => {
  const { repo, dispose } = await fixture()
  try {
    const wt = await createThreadWorktree({ cwd: repo, threadId: 'thr_d', slug: 'd' })
    await commitIn(wt.path, 'b.txt', 'x\n')
    await writeFile(path.join(repo, 'a.txt'), 'dirty\n')
    assert.deepEqual(await mergeBranch(repo, wt.branch), { kind: 'dirty' })
    assert.ok(await isDirty(repo))
    assert.ok(!existsSync(path.join(repo, 'b.txt')))
    await removeThreadWorktree(repo, wt)
  } finally {
    await dispose()
  }
})

test('a conflicting merge is aborted and leaves the tree clean', async () => {
  const { repo, dispose } = await fixture()
  try {
    const wt = await createThreadWorktree({ cwd: repo, threadId: 'thr_c', slug: 'c' })
    await commitIn(wt.path, 'a.txt', 'theirs\n')
    await commitIn(repo, 'a.txt', 'ours\n')
    const result = await mergeBranch(repo, wt.branch)
    assert.equal(result.kind, 'conflict')
    assert.ok(!(await isDirty(repo)))
    assert.ok(!existsSync(path.join(repo, '.git', 'MERGE_HEAD')))
    await removeThreadWorktree(repo, wt)
  } finally {
    await dispose()
  }
})
