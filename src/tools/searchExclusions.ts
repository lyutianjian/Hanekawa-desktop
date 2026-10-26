import path from 'node:path'
import { getGlobalMyAgentDir, normalizeCaseForComparison, resolveExistingPrefix, userHome } from '../utils/paths.js'

/**
 * Directories Hanekawa owns rather than the user wrote: every project's
 * sessions, spilled tool output, plans, coordination notes and diagnostics
 * (`~/.myagent/projects`), plus the coordination thread worktrees. A search
 * from the home directory must not walk into them — the transcripts are the
 * user's own conversation history, and matching them makes a broad Grep slow
 * for no reason.
 */
export function runtimeDataRoots(): string[] {
  return [path.join(getGlobalMyAgentDir(), 'projects'), path.join(userHome(), '.myagent-worktrees')]
}

/**
 * The runtime-data roots that sit strictly inside `target`, expressed the way
 * both backends take exclusions: relative to `target` with `/` separators.
 *
 * Only a broad search gets these. A search the user pointed somewhere else
 * inside `~/.myagent` — including a session directory — keeps every file there.
 */
export function runtimeDataExclusions(target: string): string[] {
  const result: string[] = []
  for (const root of runtimeDataRoots()) {
    const relative = relativeInside(target, root)
    if (relative) result.push(relative)
  }
  return result
}

/** `root` relative to `target` when it is strictly inside it, else undefined. */
function relativeInside(target: string, root: string): string | undefined {
  const base = resolveExistingPrefix(path.resolve(target))
  const candidate = resolveExistingPrefix(path.resolve(root))
  const relative = path.relative(base, candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  // Case-folded identity, the same discipline the rest of the path helpers use:
  // a home directory reached through another casing still resolves to itself.
  if (normalizeCaseForComparison(base) === normalizeCaseForComparison(candidate)) return undefined
  return relative.split(path.sep).join('/')
}
