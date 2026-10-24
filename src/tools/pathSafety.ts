import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult } from '../harness/types.js'
import { normalizeCaseForComparison, resolveExistingPrefix } from '../utils/paths.js'

export interface SafeTarget {
  /** The path the model addressed, kept for messages and read-state keys. */
  absolute: string
  /**
   * The same file with its parent directory resolved through every symlink.
   *
   * The tools write here. A symlinked parent is legitimate (a project opened
   * through an alias, macOS's `/var` → `/private/var`), and the risk classifier
   * already grades the real path for permission. Writing to the same resolved
   * path keeps the graded target and the modified file one file, and means a
   * link swapped into the original path later cannot redirect the write.
   */
  canonical: string
}

/**
 * Resolve the file a write will land on. A symlinked ancestor is followed —
 * authorization is the permission gate's call, made on the same real path — but
 * the file itself must not be a link: renaming over it would replace the link
 * while its destination kept the old contents.
 */
export async function resolveSafeTarget(
  absolute: string,
  filePath: string,
  options: { allowTargetSymlink?: boolean } = {},
): Promise<{ target: SafeTarget } | { error: ToolResult }> {
  if (!options.allowTargetSymlink) {
    const unsafe = await assertFileNotSymlink(absolute, filePath)
    if (unsafe) return { error: unsafe }
  }
  return { target: { absolute, canonical: canonicalTarget(absolute) } }
}

/**
 * Re-check right before the write. Covers the case where a directory on the
 * way became a symlink after the initial resolution, and a target file that
 * became a link: the rename would otherwise replace whatever appeared.
 */
export async function assertTargetUnchanged(target: SafeTarget, filePath: string): Promise<ToolResult | undefined> {
  const current = canonicalTarget(target.absolute)
  if (normalizeCaseForComparison(current) !== normalizeCaseForComparison(target.canonical)) {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: a directory in the path changed or became a symlink while it was being checked.`,
      errorCode: 'precondition_failed',
      errorDetails: {
        previous: target.canonical,
        current,
      },
    }
  }

  const unsafe = await assertFileNotSymlink(target.absolute, filePath)
  if (unsafe) {
    return {
      ...unsafe,
      content: `Refusing to modify ${filePath}: the target became a symbolic link while it was being checked.`,
    }
  }
  return undefined
}

export async function assertFileNotSymlink(absolute: string, filePath: string): Promise<ToolResult | undefined> {
  let fileStat
  try {
    fileStat = await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  if (!fileStat.isSymbolicLink()) return undefined

  return {
    ok: false,
    content: `Refusing to modify ${filePath}: target is a symbolic link.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      path: absolute,
    },
  }
}

/**
 * Canonicalize the parent only: the final component is the write's own name,
 * and `rename` never follows a link there. Resolving the whole path would let a
 * concurrently created target link bend the write onto its destination.
 */
function canonicalTarget(absolute: string): string {
  try {
    return path.join(resolveExistingPrefix(path.dirname(absolute)), path.basename(absolute))
  } catch {
    return absolute
  }
}
