import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJsonFile } from '../utils/json.js'
import { userHome } from '../utils/paths.js'
import { readSessionIndex, peekSessionIndex } from '../sessions/readonlyReader.js'
import { projectRootKey } from '../runtime/projectDirectory.js'

/**
 * The persisted "added projects" registry — the desktop shell's memory of
 * which projects exist, in the order they were *added* (first added first).
 *
 * The order is stable on purpose: it is exactly the order the sidebar draws its
 * project groups in, so re-opening a project must not move it. It used to be
 * most-recently-opened-first, which meant clicking `+` on a closed project (or
 * opening one of its history rows) bootstrapped it, rewrote the registry, and
 * made its group jump to the top of the sidebar under the user's cursor.
 *
 * Everything the old startup flow knew only through `process.cwd()` lives here:
 * which project a fresh launch opens (the one whose newest session is the
 * newest anywhere — the literal "最近一次会话的目录"), and which projects the
 * sidebar lists even though their runtimes are not open. The home directory is
 * deliberately *not* a member: it is the implicit global workspace every
 * session falls back to, so it is a candidate in every resolution and never
 * needs registering.
 *
 * Plain-node testable on purpose — this is main-process state `main.ts` cannot
 * cover (`app.requestSingleInstanceLock()` runs at module top level), the same
 * reason `ShellHost` and `ProjectDirectory` exist.
 */

/**
 * First-added first; bounded so a year of one-off folders cannot grow it
 * forever. Overflow drops from the *front* — the oldest addition — because the
 * newest one is the project the user is opening right now.
 */
const MAX_PROJECTS = 20

interface ProjectsFile {
  projects: string[]
}

function registryPath(home: string): string {
  return join(home, '.hanekawa', 'projects.json')
}

/** The registry as written, unfiltered: strings only, order preserved. */
export async function loadRecentProjects(home = userHome()): Promise<readonly string[]> {
  const file = await readJsonFile<Partial<ProjectsFile>>(registryPath(home), {})
  if (!Array.isArray(file.projects)) return []
  return file.projects.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Records that `cwd` was opened: appended at the end when it is new, left
 * exactly where it is when it is not — deduplicated by root key (case-folded on
 * the platforms that fold), capped, pruned of directories that no longer exist,
 * and written back atomically-enough for a one-writer file.
 *
 * "Left where it is" is the whole point: this runs on every entry into a
 * project, and the array it writes is the sidebar's group order.
 *
 * Exported for tests; the app-facing wrapper is `main.ts`'s `ensureProject`,
 * which is the only caller that should write.
 */
export async function recordProjectOpen(cwd: string, home = userHome()): Promise<readonly string[]> {
  const key = projectRootKey(cwd)
  const kept = (await loadRecentProjects(home)).filter((entry) => existsSync(entry))
  const known = kept.some((entry) => projectRootKey(entry) === key)
  // `slice(-MAX)` rather than `slice(0, MAX)`: the newest addition is at the
  // tail now, and trimming the tail would drop the project being opened.
  return writeProjects((known ? kept : [...kept, cwd]).slice(-MAX_PROJECTS), home)
}

/**
 * Drops `cwd` from the registry — the sidebar's "从侧边栏移除".
 *
 * Only the registry: the project's `.hanekawa/` and every session in it stay on
 * disk, so re-adding the directory brings its history straight back. Idempotent,
 * and unlike `recordProjectOpen` it does **not** prune roots that no longer
 * exist — forgetting one project should not silently forget others.
 */
export async function forgetRecentProject(
  cwd: string,
  home = userHome(),
): Promise<readonly string[]> {
  const key = projectRootKey(cwd)
  const kept = (await loadRecentProjects(home)).filter((entry) => projectRootKey(entry) !== key)
  return writeProjects(kept, home)
}

/**
 * Temp-then-rename, the `sessions` module's discipline, so a crash mid-write
 * cannot leave the registry truncated. `mkdir` because a first run may not have
 * a `~/.hanekawa` yet.
 */
async function writeProjects(next: readonly string[], home: string): Promise<readonly string[]> {
  const filePath = registryPath(home)
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify({ projects: next }, null, 2)}\n`, 'utf8')
  await rename(tmp, filePath)
  return next
}

/** One index entry's `updatedAt`, as a comparable number. Absent/invalid → 0. */
function touchedAt(updatedAt: unknown): number {
  if (typeof updatedAt !== 'string') return 0
  const parsed = Date.parse(updatedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

interface IndexEntry {
  updatedAt?: unknown
}

/** Newest index timestamp; the shared reader has no store lifecycle side effects. */
export async function peekNewestSessionAt(root: string): Promise<number | undefined> {
  const index = await readSessionIndex(root)
  if (!Array.isArray(index.sessions)) return undefined
  let newest: number | undefined
  for (const entry of index.sessions as IndexEntry[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const touched = touchedAt(entry.updatedAt)
    if (touched === 0) continue
    if (newest === undefined || touched > newest) newest = touched
  }
  return newest
}

/** The whole session list of a not-necessarily-open project, as index rows. */
export interface PeekedSession {
  id: string
  updatedAt: string
  title?: string
  messageCount: number
  lastTurnFailed?: boolean
  /** Only the role: the marker a closed project's rows show. */
  coordination?: { role: 'coordinator' | 'thread' }
}

/**
 * Every session index row under one root, newest first — the read-only
 * `SessionStore.list()` shape for projects whose runtime is not open.
 */
export async function peekSessions(root: string): Promise<PeekedSession[]> {
  return peekSessionIndex(root)
}

export interface StartupResolution {
  /** The directory to open: a registered project, or the home directory. */
  readonly root: string
  /** True when `root` is the global (home) workspace rather than a project. */
  readonly global: boolean
}

/**
 * Which directory a fresh launch opens.
 *
 * The literal reading of the product rule: the working directory of the new
 * empty session is "最近一次会话的目录" — the root whose newest session is the
 * newest anywhere, across the registry *and* the global workspace. When no
 * root has any session (a registry of freshly-added, never-used projects), the
 * most recently added one wins; an empty registry means the global workspace.
 *
 * Roots that no longer exist on disk are skipped, never resolved to.
 */
export async function resolveStartupRoot(home = userHome()): Promise<StartupResolution> {
  const homeKey = projectRootKey(home)
  const registry = (await loadRecentProjects(home)).filter(
    (entry) => projectRootKey(entry) !== homeKey && existsSync(entry),
  )

  // Newest registry entry first, then the global workspace: a strictly-greater
  // comparison makes ties go to whichever root is visited first, and the
  // registry is in *added* order, so it is walked backwards to keep the
  // long-standing answer — a tie goes to the more recently added project.
  let best: { root: string; touched: number } | undefined
  for (const root of [...[...registry].reverse(), home]) {
    const touched = (await peekNewestSessionAt(root)) ?? 0
    if (touched > 0 && (best === undefined || touched > best.touched)) {
      best = { root, touched }
    }
  }

  // The tail is the most recently added project — see `recordProjectOpen`.
  const root = best?.root ?? registry[registry.length - 1] ?? home
  // Against the *passed* home, not `homedir()`: a test home must resolve the
  // same way the real one does.
  return { root, global: projectRootKey(root) === homeKey }
}
