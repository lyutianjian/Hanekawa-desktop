import { existsSync, readdirSync, renameSync, rmdirSync, type Dirent } from 'node:fs'
import path from 'node:path'

/**
 * The names this app used before it was renamed. They are read once at
 * startup to move the old data into place, and never again: no path in the
 * running app resolves through them.
 */
const LEGACY_DATA_DIR = '.myagent'
const LEGACY_WORKSPACE_DIR = 'myagent'
const LEGACY_WORKTREE_DIR = '.myagent-worktrees'
const DATA_DIR = '.hanekawa'
const WORKSPACE_DIR = 'hanekawa'

export type MoveOutcome = 'moved' | 'absent' | 'target-exists' | 'failed'

export interface LegacyDataMigrationResult {
  data: MoveOutcome
  workspace: MoveOutcome
  /** `active`: old thread worktrees still exist, so their directory was kept. */
  worktrees: 'absent' | 'removed' | 'active'
  warnings: string[]
}

/**
 * Moves the old home data and the old global workspace into the current
 * names. A directory is moved only when the target does not exist; when both
 * exist the old one is left alone and the caller reports it, because merging
 * two histories is not something startup may decide on its own.
 *
 * Thread worktrees are not moved: their paths are recorded in git's own
 * administrative files and in coordination records, and an active thread may
 * still be using one. The old root is removed only once nothing is left in it.
 */
export function migrateLegacyGlobalData(home: string): LegacyDataMigrationResult {
  const warnings: string[] = []
  const data = moveDirectory(
    path.join(home, LEGACY_DATA_DIR),
    path.join(home, DATA_DIR),
    '数据目录',
    warnings,
  )
  const workspace = moveDirectory(
    path.join(home, 'Documents', LEGACY_WORKSPACE_DIR),
    path.join(home, 'Documents', WORKSPACE_DIR),
    '工作区',
    warnings,
  )

  const worktreeRoot = path.join(home, LEGACY_WORKTREE_DIR)
  const worktrees = removeIfEmpty(worktreeRoot)

  return { data, workspace, worktrees, warnings }
}

function moveDirectory(source: string, target: string, label: string, warnings: string[]): MoveOutcome {
  if (!existsSync(source)) return 'absent'
  if (existsSync(target)) {
    warnings.push(`${label} ${source} 未迁移：${target} 已存在，旧目录保持原样。`)
    return 'target-exists'
  }
  try {
    renameSync(source, target)
    return 'moved'
  } catch (error) {
    warnings.push(`${label} ${source} 迁移失败：${describe(error)}`)
    return 'failed'
  }
}

/** Removes `dir` if it is empty, including any empty subdirectories. */
function removeIfEmpty(dir: string): 'absent' | 'removed' | 'active' {
  if (!existsSync(dir)) return 'absent'
  return removeEmptyDirectories(dir) ? 'removed' : 'active'
}

function removeEmptyDirectories(dir: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }

  let empty = true
  for (const entry of entries) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!removeEmptyDirectories(child)) empty = false
    } else {
      empty = false
    }
  }

  if (!empty) return false
  try {
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
