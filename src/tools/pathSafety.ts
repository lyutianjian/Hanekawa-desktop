import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult } from '../harness/types.js'
import { normalizeCaseForComparison } from '../utils/paths.js'

export interface TargetIdentity {
  kind: 'missing' | 'file' | 'symlink' | 'other'
  dev?: number
  ino?: number
}

export interface SafeTarget {
  /** The path the model addressed, kept for messages and read-state keys. */
  absolute: string
  /**
   * The same file with its parent directory resolved through every symlink.
   *
   * The tools write here. A symlinked parent is legitimate (a project opened
   * through an alias, macOS's `/var` → `/private/var`), and the risk classifier
   * grades the real path for permission. Writing to the resolved path keeps the
   * graded target and the modified file one file.
   */
  canonical: string
  /** The inode (or absence) seen at `absolute` when this target was resolved. */
  identity: TargetIdentity
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
  let canonical: string
  let identity: TargetIdentity
  try {
    canonical = await canonicalParent(absolute)
    identity = await targetIdentity(absolute)
  } catch (error) {
    return { error: unresolvable(absolute, filePath, error) }
  }

  if (identity.kind === 'symlink' && !options.allowTargetSymlink) {
    return {
      error: {
        ok: false,
        content: `Refusing to modify ${filePath}: target is a symbolic link.`,
        errorCode: 'precondition_failed',
        errorDetails: {
          path: absolute,
        },
      },
    }
  }

  return { target: { absolute, canonical, identity } }
}

/**
 * Re-check right before the write, after file history has snapshotted the old
 * contents. Compares both where the parent resolves and what the target is now:
 * a directory turned into a symlink, a substituted file, a link where a file
 * was, and a new file where none existed are all refused.
 */
export async function assertTargetUnchanged(target: SafeTarget, filePath: string): Promise<ToolResult | undefined> {
  let canonical: string
  let identity: TargetIdentity
  try {
    canonical = await canonicalParent(target.absolute)
    identity = await targetIdentity(target.absolute)
  } catch (error) {
    return unresolvable(target.absolute, filePath, error)
  }

  if (normalizeCaseForComparison(canonical) !== normalizeCaseForComparison(target.canonical)) {
    return changed(filePath, 'a directory in the path changed after it was checked', target, canonical, identity)
  }
  if (!sameIdentity(target.identity, identity)) {
    return changed(filePath, 'the target changed after it was checked', target, canonical, identity)
  }
  return undefined
}

function changed(
  filePath: string,
  reason: string,
  target: SafeTarget,
  canonical: string,
  identity: TargetIdentity,
): ToolResult {
  return {
    ok: false,
    content: `Refusing to modify ${filePath}: ${reason}.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      reason: 'target_changed',
      previous: { canonical: target.canonical, ...target.identity },
      current: { canonical, ...identity },
    },
  }
}

function unresolvable(absolute: string, filePath: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    content: `Refusing to modify ${filePath}: the path could not be resolved safely (${message}).`,
    errorCode: 'precondition_failed',
    errorDetails: {
      reason: 'path_unresolvable',
      path: absolute,
    },
  }
}

function sameIdentity(a: TargetIdentity, b: TargetIdentity): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'missing') return true
  return a.dev === b.dev && a.ino === b.ino
}

async function targetIdentity(absolute: string): Promise<TargetIdentity> {
  let entry
  try {
    entry = await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }

  const kind = entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'other'
  return { kind, dev: entry.dev, ino: entry.ino }
}

/**
 * Canonicalize the parent only: the final component is the write's own name,
 * and `rename` never follows a link there. Resolving the whole path would let a
 * concurrently created target link bend the write onto its destination.
 *
 * Only a missing ancestor is skipped; any other resolution failure is an
 * unverifiable path and fails closed rather than being written through.
 */
async function canonicalParent(absolute: string): Promise<string> {
  const missing: string[] = []
  let probe = path.dirname(absolute)

  for (;;) {
    try {
      return path.join(await realpath(probe), ...missing, path.basename(absolute))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    // realpath answers ENOENT for a dangling link too, and that is not a name
    // this write may create through.
    let entry
    try {
      entry = await lstat(probe)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (entry?.isSymbolicLink()) {
      throw new Error(`"${probe}" is a symbolic link that does not resolve`)
    }

    const parent = path.dirname(probe)
    if (parent === probe) {
      throw new Error(`"${absolute}" has no existing ancestor`)
    }
    missing.unshift(path.basename(probe))
    probe = parent
  }
}
