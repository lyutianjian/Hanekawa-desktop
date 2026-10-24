import { lstat } from 'node:fs/promises'
import type { ToolResult } from '../harness/types.js'
import { resolveWriteTarget } from '../harness/risk/paths.js'
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
  /** The target the permission gate bound this call to, when a gate ran. */
  approvedTarget?: string | null
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
  options: { allowTargetSymlink?: boolean; approvedTarget?: string | null } = {},
): Promise<{ target: SafeTarget } | { error: ToolResult }> {
  let canonical: string
  let identity: TargetIdentity
  try {
    canonical = resolveWriteTarget(absolute)
    identity = await targetIdentity(absolute)
  } catch (error) {
    return { error: unresolvable(absolute, filePath, error) }
  }

  const unbound = bindingFailure(canonical, options.approvedTarget, filePath)
  if (unbound) return { error: unbound }

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

  return {
    target: {
      absolute,
      canonical,
      identity,
      ...(options.approvedTarget === undefined ? {} : { approvedTarget: options.approvedTarget }),
    },
  }
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
    canonical = resolveWriteTarget(target.absolute)
    identity = await targetIdentity(target.absolute)
  } catch (error) {
    return unresolvable(target.absolute, filePath, error)
  }

  const unbound = bindingFailure(canonical, target.approvedTarget, filePath)
  if (unbound) return unbound

  if (normalizeCaseForComparison(canonical) !== normalizeCaseForComparison(target.canonical)) {
    return changed(filePath, 'a directory in the path changed after it was checked', target, canonical, identity)
  }
  if (!sameIdentity(target.identity, identity)) {
    return changed(filePath, 'the target changed after it was checked', target, canonical, identity)
  }
  return undefined
}

function bindingFailure(
  canonical: string,
  approvedTarget: string | null | undefined,
  filePath: string,
): ToolResult | undefined {
  if (approvedTarget === undefined) return undefined
  if (approvedTarget === null) {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: the path could not be resolved when permission was checked.`,
      errorCode: 'precondition_failed',
      errorDetails: {
        reason: 'target_unbound',
        current: canonical,
      },
    }
  }
  if (normalizeCaseForComparison(canonical) === normalizeCaseForComparison(approvedTarget)) return undefined
  return {
    ok: false,
    content: `Refusing to modify ${filePath}: the path changed after permission was checked.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      reason: 'target_changed',
      approvedTarget,
      current: canonical,
    },
  }
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
