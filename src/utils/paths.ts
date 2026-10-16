import path from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

export function getMyAgentDir(cwd: string): string {
  return path.join(cwd, '.myagent')
}

/**
 * The home directory whose `.myagent/` holds the user's config and sessions.
 *
 * Refused to a test run that did not come through `scripts/test.mjs`: a bare
 * `tsx --test` keeps the real HOME, and a test writing its fixture config there
 * once wiped every configured provider. The runner marks the throwaway HOME it
 * hands out; anything else under the test runner fails loudly instead.
 */
export function userHome(): string {
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.HANEKAWA_TEST_HOME === undefined) {
    throw new Error('Run tests through `npm test` (or `node scripts/test.mjs <file>`), which gives them a throwaway HOME.')
  }
  return homedir()
}

/**
 * User-level `.myagent`, shared by every project. Resolved lazily so tests can
 * redirect it via USERPROFILE/HOME.
 */
export function getGlobalMyAgentDir(): string {
  return path.join(userHome(), '.myagent')
}

/**
 * Where a project's runtime data lives: sessions, spilled tool output, image
 * attachments, plans. Under the user's `~/.myagent/projects/` rather than the
 * project's own `.myagent/`, so opening a folder leaves nothing behind in it —
 * `<cwd>/.myagent/` is for the configuration a user put there themselves.
 *
 * Keyed by the resolved path, so a renamed or moved project starts with an
 * empty history; its old data stays under the old key.
 */
export function getProjectDataDir(cwd: string): string {
  return path.join(getGlobalMyAgentDir(), 'projects', projectDataKey(cwd))
}

/**
 * A readable directory name for a project root, e.g. `/Users/me/code/foo` →
 * `Users-me-code-foo-1a2b3c4d`. The hash keeps `/a/b-c` and `/a/b/c` apart
 * (both flatten to the same name); case is folded first on the platforms whose
 * filesystems are case-insensitive, like `projectRootKey`.
 */
export function projectDataKey(cwd: string): string {
  const root = normalizeCaseForComparison(path.resolve(cwd))
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8)
  const readable = root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-80)
  return readable ? `${readable}-${hash}` : hash
}

/**
 * Whether `cwd` is the user's home directory — the workspace sessions fall
 * back to when no project is open (the 全局/「最近」 workspace, whose records
 * are keyed by the home directory under `~/.myagent/projects/`).
 *
 * Case-insensitive on the platforms whose filesystems are, the same discipline
 * `projectRootKey` compares roots with: a home directory reached through a
 * different-but-equivalent casing is still the global workspace.
 */
export function isGlobalWorkspaceRoot(cwd: string): boolean {
  return normalizeCaseForComparison(path.resolve(cwd)) === normalizeCaseForComparison(path.resolve(homedir()))
}

const MAX_PATH_DEPTH = 50
const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin'

const resolvedCwdCache = new Map<string, string>()

export function invalidateResolvedCwdCache(cwd?: string): void {
  if (cwd) {
    resolvedCwdCache.delete(cwd)
    return
  }
  resolvedCwdCache.clear()
}

export function normalizeCaseForComparison(filePath: string): string {
  return CASE_INSENSITIVE_PLATFORM ? filePath.toLowerCase() : filePath
}

function withTrailingSeparator(filePath: string): string {
  return filePath.endsWith(path.sep) ? filePath : filePath + path.sep
}

function relativeSegments(from: string, to: string): string[] {
  const relative = path.relative(from, to)
  return relative === '' ? [] : relative.split(path.sep)
}

export function resolveExistingPrefix(absolute: string): string {
  try {
    return realpathSync(absolute)
  } catch {
    // The target may be new; resolve the deepest existing ancestor instead.
  }

  let probe = absolute
  const missing: string[] = []
  while (true) {
    const parent = path.dirname(probe)
    if (parent === probe) {
      throw new Error(`Unable to resolve path ancestor for "${absolute}"`)
    }

    missing.unshift(path.basename(probe))
    probe = parent

    try {
      return path.join(realpathSync(probe), ...missing)
    } catch {
      // Keep walking upward until an existing ancestor is found.
    }
  }
}

/**
 * Resolves a user-supplied path against cwd and throws if the result
 * escapes the cwd boundary. Follows symlinks before comparing.
 */
export function assertInsideCwd(cwd: string, filePath: string): string {
  const absolute = path.resolve(cwd, filePath)

  let resolvedCwd = resolvedCwdCache.get(cwd)
  if (!resolvedCwd) {
    resolvedCwd = realpathSync(cwd)
    resolvedCwdCache.set(cwd, resolvedCwd)
  }

  const resolvedAbsolute = resolveExistingPrefix(absolute)
  const comparableAbsolute = normalizeCaseForComparison(resolvedAbsolute)
  const comparableCwd = normalizeCaseForComparison(resolvedCwd)

  if (!withTrailingSeparator(comparableAbsolute).startsWith(withTrailingSeparator(comparableCwd)) && comparableAbsolute !== comparableCwd) {
    throw new Error(`Path "${filePath}" resolves outside the working directory`)
  }

  const depth = relativeSegments(resolvedCwd, resolvedAbsolute).length
  if (depth > MAX_PATH_DEPTH) {
    throw new Error(`Path "${filePath}" exceeds maximum depth of ${MAX_PATH_DEPTH}`)
  }

  return absolute
}

export function getConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'config.json')
}

/** Base config layer shared across projects; `getConfigPath` overrides it. */
export function getGlobalConfigPath(): string {
  return path.join(getGlobalMyAgentDir(), 'config.json')
}

/** The user-wide instructions, read ahead of every project's own. */
export function getUserInstructionsPath(): string {
  return path.join(getGlobalMyAgentDir(), 'AGENTS.md')
}

export function getMcpConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'mcp.json')
}

export function getSessionsDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'sessions')
}

/**
 * Where a session spills tool output too large to send inline. The model gets
 * a preview plus this path, so the rest stays reachable with a Read.
 */
export function getToolResultSpillDir(cwd: string, sessionId: string): string {
  return path.join(getProjectDataDir(cwd), 'tool-results', sessionId)
}

/** Where plan mode writes its plan files. See `utils/plans.ts`. */
export function getProjectPlansDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'plans')
}

/** Where the model keeps its cross-session notes for a project. See `services/memory`. */
export function getProjectMemoryDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'memory')
}

/** Shared notes of a project's coordination threads. */
export function getCoordinationNotesDir(projectDir: string): string {
  return path.join(getProjectDataDir(projectDir), 'coordination', 'notes')
}

/**
 * Where a coordination thread's git worktree lives. Outside `~/.myagent` (the
 * file tools' hard wall), outside the project, and not in tmpdir (swept while a
 * thread is still alive).
 */
export function getThreadWorktreeDir(projectDir: string, threadId: string): string {
  return path.join(userHome(), '.myagent-worktrees', projectDataKey(projectDir), threadId)
}

/**
 * The file tools' path guard. The workspace boundary is not decided here: the
 * risk classifier grades a path outside it and the permission gate rules on
 * that grade, as it does for Bash. The one hard wall is Hanekawa's own
 * `~/.myagent` — only the places there the model is *told* to use stay
 * reachable: this session's spilled tool output (the preview hands it the path
 * to Read), the project's plan files (plan mode has it Write them), its
 * memory directory and the user's global instructions file. The session
 * transcripts least of all.
 */
export function resolveToolPath(context: { cwd: string; projectDir?: string; sessionId?: string }, filePath: string): string {
  const absolute = path.resolve(context.cwd, filePath)
  if (!isUnderRoot(getGlobalMyAgentDir(), absolute)) return absolute
  const projectDir = context.projectDir ?? context.cwd
  const roots = [getProjectPlansDir(projectDir), getProjectMemoryDir(projectDir), getCoordinationNotesDir(projectDir), getUserInstructionsPath()]
  if (context.sessionId) roots.push(getToolResultSpillDir(projectDir, context.sessionId))
  if (roots.some((root) => isUnderRoot(root, absolute))) return absolute
  throw new Error(`Path "${filePath}" is inside Hanekawa's runtime data (~/.myagent), which file tools cannot reach`)
}

function isUnderRoot(root: string, absolute: string): boolean {
  let a: string
  let r: string
  try {
    a = normalizeCaseForComparison(resolveExistingPrefix(absolute))
    r = normalizeCaseForComparison(resolveExistingPrefix(path.resolve(root)))
  } catch {
    return false
  }
  return withTrailingSeparator(a).startsWith(withTrailingSeparator(r))
}

export function getSkillsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'skills')
}

/** Cross-tool skills folder (`~/.agents/skills`), read alongside the project's own. */
export function getSharedSkillsDir(): string {
  return path.join(userHome(), '.agents', 'skills')
}

export function getAgentsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'agents')
}

/** Personal agent definitions: this user's, not the project's, so not in the project. */
export function getLocalAgentsDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), 'agents.local')
}
