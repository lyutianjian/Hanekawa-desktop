import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { isSafeBranchName } from '../../runtime/gitBranches.js'
import { getThreadWorktreeDir } from '../../utils/paths.js'
import type { ThreadWorktree } from './types.js'

const execFileAsync = promisify(execFile)

/** Runs git without a shell; returns trimmed stdout, throws on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

function slugify(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'thread'
}

/** A new worktree on a new branch `hanekawa/<slug>-<threadId>`, forked from HEAD. */
export async function createThreadWorktree(input: { cwd: string; threadId: string; slug: string }): Promise<ThreadWorktree> {
  const branch = `hanekawa/${slugify(input.slug)}-${input.threadId}`
  if (!isSafeBranchName(branch)) throw new Error(`Unsafe thread branch name "${branch}"`)
  // A project that is not a repository becomes one; never the home directory.
  const inRepo = await git(input.cwd, ['rev-parse', '--show-toplevel']).then(() => true, () => false)
  const hasFiles = (await readdir(input.cwd)).some((name) => name !== '.git')
  const requireBaseline = () => { throw new Error('这个项目尚无可用的源码提交；请先初始化 Git 仓库并提交线程需要的文件，再创建代码线程。') }
  if (!inRepo) {
    if (hasFiles) requireBaseline()
    if (path.resolve(input.cwd) === path.resolve(homedir())) throw new Error('Refusing to turn the home directory into a git repository')
    await git(input.cwd, ['init', '-q'])
  }
  const repoRoot = await git(input.cwd, ['rev-parse', '--show-toplevel'])
  // A repository with no commits has nothing to fork from; give it an empty root
  // commit. `--only` with no paths leaves whatever the user has staged out of it.
  const hasHead = await git(input.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false)
  if (hasFiles && (!hasHead || await git(input.cwd, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.']) === '')) requireBaseline()
  if (!hasHead) await git(repoRoot, ['commit', '--allow-empty', '--only', '--no-verify', '-m', 'Initial commit'])
  const baseRef = await git(input.cwd, ['rev-parse', '--verify', 'HEAD'])
  const prefix = await git(input.cwd, ['rev-parse', '--show-prefix'])
  const dir = getThreadWorktreeDir(input.cwd, input.threadId)
  const exists = await lstat(dir).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return false
  })
  if (exists) throw new Error(`Thread worktree path already exists: ${dir}`)
  await mkdir(path.dirname(dir), { recursive: true })
  await git(repoRoot, ['branch', branch, baseRef])
  try { await git(repoRoot, ['worktree', 'add', dir, branch]) }
  catch (error) {
    try { await removeThreadWorktree(repoRoot, { path: dir, branch }) }
    catch (cleanupError) { console.error('[hanekawa] worktree cleanup:', cleanupError instanceof Error ? cleanupError.message : String(cleanupError)) }
    throw error
  }
  return { path: dir, branch, baseRef, cwd: path.resolve(dir, prefix) }
}

/** Removes the worktree and its branch; every step is best-effort. */
export async function removeThreadWorktree(cwd: string, worktree: Pick<ThreadWorktree, 'path' | 'branch'>): Promise<void> {
  try {
    await git(cwd, ['worktree', 'remove', '--force', worktree.path])
  } catch {
    await rm(worktree.path, { recursive: true, force: true })
    await git(cwd, ['worktree', 'prune']).catch(() => {})
  }
  if (isSafeBranchName(worktree.branch)) await git(cwd, ['branch', '-D', worktree.branch]).catch(() => {})
}

export interface BranchDiff {
  /** Commits on the branch that HEAD lacks. */
  ahead: number
  added: number
  removed: number
  /** The branch tip. */
  head: string
}

export async function branchDiff(cwd: string, branch: string): Promise<BranchDiff> {
  if (!isSafeBranchName(branch)) throw new Error(`Unsafe branch name "${branch}"`)
  const ahead = Number(await git(cwd, ['rev-list', '--count', `HEAD..${branch}`]))
  const numstat = await git(cwd, ['diff', '--numstat', `HEAD...${branch}`, '--'])
  let added = 0
  let removed = 0
  for (const line of numstat.split('\n')) {
    const [a, r] = line.split('\t')
    added += Number(a) || 0 // '-' for binary files
    removed += Number(r) || 0
  }
  const head = await git(cwd, ['rev-parse', branch])
  return { ahead, added, removed, head }
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])) !== ''
}

export interface MergeResult {
  kind: 'merged' | 'dirty' | 'conflict' | 'error'
  message?: string
}

/** Merges `branch` into the checked-out branch of `cwd`; a failed merge leaves the tree clean. */
export async function mergeBranch(cwd: string, branch: string): Promise<MergeResult> {
  if (!isSafeBranchName(branch)) return { kind: 'error', message: `Unsafe branch name "${branch}"` }
  try {
    if (await isDirty(cwd)) return { kind: 'dirty' }
    await git(cwd, ['merge', '--no-edit', branch])
    return { kind: 'merged' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const unmerged = await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
    if (unmerged !== '') {
      await git(cwd, ['merge', '--abort']).catch(() => {})
      return { kind: 'conflict', message }
    }
    await git(cwd, ['merge', '--abort']).catch(() => {})
    return { kind: 'error', message }
  }
}
