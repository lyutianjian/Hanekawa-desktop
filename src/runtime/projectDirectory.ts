import { basename, resolve } from 'node:path'
import { isGlobalWorkspaceRoot, normalizeCaseForComparison } from '../utils/paths.js'
import type { SessionMeta } from '../sessions/service.js'
import type { WirePaneInfo } from './protocol/wire.js'
import type { SessionWorkspace } from './sessionWorkspace.js'
import type { RuntimeHost } from './types.js'

/**
 * Every project open in one process, and the pane bookkeeping that spans them.
 *
 * A {@link SessionWorkspace} is one project's panes; this is the tier above it —
 * the answer to "which projects are open", "which project owns this pane", and
 * "what does the whole tab topology look like". It exists because the Electron
 * main process cannot be tested (`app.requestSingleInstanceLock()` runs at module
 * top level, so `main.ts` cannot even be imported under plain node), and every
 * decision that used to live in a module-level variable there is a decision
 * nothing could cover. Windows, dialogs and channels stay in the shell; the
 * bookkeeping lives here.
 *
 * What is deliberately *not* here: `bootstrap()`. The shell owns the MCP trust
 * prompt and the error dialogs, so it builds the project and hands the assembled
 * halves to {@link ProjectDirectory.add}. That keeps this module free of the
 * filesystem and makes the tests plain object literals.
 */

/**
 * The slice of `SessionPane` this module touches, declared structurally for the
 * same reason `PaneRegistry` is (`protocol/host.ts`): it documents the surface
 * by type, and a test does not have to build a real pane — which would mean a
 * real controller, a real runtime slot and a real scope.
 *
 * `getSession()` rather than a stored id, because the id moves: `/clear` and
 * `/resume` retarget the controller, and the pane reads through to it.
 */
export interface PaneLike {
  getSession(): SessionMeta
  isTitlePending?(): boolean
}

/** The project half: a root to key on, and the one call that stops background work. */
export interface DirectoryProject {
  readonly cwd: string
  shutdown(reason: string): Promise<void>
}

/** The pane half. `closeAll` is the fixed-order teardown `SessionWorkspace` owns. */
export interface DirectoryWorkspace {
  list(): readonly PaneLike[]
  closeAll(): void
}

export interface ProjectEntry<
  P extends DirectoryProject = RuntimeHost,
  W extends DirectoryWorkspace = SessionWorkspace,
> {
  /**
   * The normalized key, not the path the caller passed. Kept on the entry so a
   * shell that wants to log or compare roots uses the same string the map does.
   */
  readonly root: string
  /** As the caller gave it, for display: `projectName` is derived from this. */
  readonly cwd: string
  readonly project: P
  readonly workspace: W
}

/**
 * Two roots are the same project when they resolve to the same path, modulo
 * case on the platforms where the filesystem does not care.
 *
 * `normalizeCaseForComparison` is `src/utils/paths.ts`'s, so this agrees with
 * the rest of the codebase about what "the same directory" means — the whole
 * point of a single key is that opening `C:\Repo` twice does not bootstrap a
 * second `ProjectRuntime` over the same `.myagent/`.
 */
export function projectRootKey(cwd: string): string {
  return normalizeCaseForComparison(resolve(cwd))
}

/**
 * How long a quit waits for every project to drain before going anyway.
 *
 * Eight seconds rather than five because six of them can be legitimate:
 * `terminateProcessTree` gives a shell task `FORCE_KILL_DELAY_MS` (5s) after
 * SIGTERM and `FINAL_WAIT_MS` (1s) after SIGKILL
 * (`services/backgroundTasks/processTree.ts`), so a shorter deadline would fire
 * on the *working* kill path and orphan the child it was about to reap. What it
 * is actually guarding is the unbounded half of `ProjectRuntime.shutdown()` —
 * a subagent's `stop()` and `mcpClient.close()` have no timeout of their own,
 * and a promise that never settles used to mean the second `app.quit()` was
 * never sent: window gone, process still running.
 *
 * Lives here rather than in `main.ts` because `main.ts` cannot be imported
 * under plain node, and a constant nothing can read is a constant nothing can
 * test.
 */
export const SHUTDOWN_DEADLINE_MS = 8_000

/**
 * A directory entry's display name.
 *
 * `basename` is empty for a filesystem root (`C:\`, `/`), so those fall back to
 * the path itself rather than rendering a nameless tab group.
 */
export function projectDisplayName(cwd: string): string {
  // The home directory is not "a project like any other": it is the workspace
  // sessions fall back to when nothing is opened, and its basename (a username)
  // says nothing. One name for it everywhere — sidebar groups, lane info, hello.
  if (isGlobalWorkspaceRoot(cwd)) return GLOBAL_WORKSPACE_NAME
  const resolved = resolve(cwd)
  return basename(resolved) || resolved
}

/** What the home-rooted (global) workspace is called wherever a name is drawn. */
export const GLOBAL_WORKSPACE_NAME = '最近'

/**
 * The generic parameters default to the real types, so the shell writes
 * `new ProjectDirectory()` and gets `entry.project` typed as a full
 * `RuntimeHost` (it needs `store`, `openScope`, `initialModelKey`, …).
 *
 * A test writes `new ProjectDirectory<FakeProject, FakeWorkspace>()` and needs
 * **no `as unknown as`** — the constraints still check that the fake has the
 * members this class actually calls, which is exactly the compiler help a cast
 * would have thrown away.
 */
export class ProjectDirectory<
  P extends DirectoryProject = RuntimeHost,
  W extends DirectoryWorkspace = SessionWorkspace,
> {
  /** Insertion-ordered by construction (`Map`), which is "the order projects were opened". */
  private readonly entries_ = new Map<string, ProjectEntry<P, W>>()
  /**
   * Roots whose teardown is in flight, mapped to it.
   *
   * A `Set` would be enough for the dedup, but not for the quit: `closeProject`
   * removes the entry from {@link entries_} before it awaits, so a close started
   * by `ShellHost.settleAfterLastLane` (a bare `void closeProject(...)`) is
   * invisible to {@link shutdownAll} — which would then skip it and let the app
   * exit *concurrently* with a project that is still stopping child processes.
   * Holding the promise is what makes "wait for the ones already leaving"
   * expressible.
   */
  private readonly closing = new Map<string, Promise<void>>()

  get size(): number {
    return this.entries_.size
  }

  /**
   * Registers an already-bootstrapped project.
   *
   * Throws on a duplicate root instead of replacing: two `ProjectRuntime`s over
   * one `.myagent/` means two `SessionStore`s appending to the same JSONL files
   * and two MCP connection sets. A caller that wants "open or focus" checks
   * {@link get} first — which is what makes the shell's dialog path idempotent.
   */
  add(project: P, workspace: W): ProjectEntry<P, W> {
    const root = projectRootKey(project.cwd)
    if (this.entries_.has(root)) {
      throw new Error(`Project is already open: ${project.cwd}`)
    }
    const entry: ProjectEntry<P, W> = { root, cwd: project.cwd, project, workspace }
    this.entries_.set(root, entry)
    return entry
  }

  get(cwd: string): ProjectEntry<P, W> | undefined {
    return this.entries_.get(projectRootKey(cwd))
  }

  /**
   * Settles once any teardown in flight for this root has. A reopen waits on it:
   * the entry leaves {@link get} as its close starts, not as it ends.
   */
  whenClosed(cwd: string): Promise<void> {
    return this.closing.get(projectRootKey(cwd)) ?? Promise.resolve()
  }

  entries(): readonly ProjectEntry<P, W>[] {
    return [...this.entries_.values()]
  }

  /**
   * Which project owns a pane, by identity.
   *
   * A scan, for the reason `SessionWorkspace.paneForSession` scans: a derived
   * answer cannot go stale, and a shell has a handful of tabs. An index keyed by
   * session id would need re-keying on every `/clear`.
   */
  entryForPane(pane: PaneLike): ProjectEntry<P, W> | undefined {
    for (const entry of this.entries_.values()) {
      if (entry.workspace.list().includes(pane)) return entry
    }
    return undefined
  }

  /**
   * The one projection of panes onto the wire.
   *
   * Takes the panes to describe rather than reading them out of the workspaces,
   * because the shell's set is narrower: a pane is registered in its workspace
   * *before* its window exists, and a tab the user cannot focus must not be
   * listed. The caller passes what it has windows for, and this fills in the
   * project fields.
   *
   * Field by field, never a spread — `SessionPane` carries the controller and
   * the runtime slot (`WirePaneInfo`).
   */
  describe(panes: Iterable<PaneLike>): WirePaneInfo[] {
    const out: WirePaneInfo[] = []
    for (const pane of panes) {
      const entry = this.entryForPane(pane)
      if (!entry) continue
      const session = pane.getSession()
      const info: WirePaneInfo = {
        paneId: session.id,
        sessionId: session.id,
        projectRoot: entry.root,
        projectName: projectDisplayName(entry.cwd),
      }
      if (session.title !== undefined) info.sessionTitle = session.title
      if (pane.isTitlePending?.()) info.titlePending = true
      if (session.coordination !== undefined) info.coordinationRole = session.coordination.role
      out.push(info)
    }
    return out
  }

  /**
   * Closes every pane of one project, then shuts the project down.
   *
   * The order is load-bearing and the reverse is a resource leak: `closeAll()`
   * runs each pane's fixed four-step teardown (`interrupt('exit')` → controller
   * → slot → scope), and `shutdown()` is the only call that stops background
   * tasks and MCP clients. Shutting down first would tear the tools out from
   * under panes that are still draining.
   *
   * Idempotent, and re-entrant-safe: `before-quit` can arrive while the last
   * window's `'closed'` handler is already here — the second caller is handed
   * the first one's promise instead of a resolved one, so awaiting a close
   * somebody else started really does wait for it.
   */
  closeProject(entry: ProjectEntry<P, W>, reason: string): Promise<void> {
    const inFlight = this.closing.get(entry.root)
    if (inFlight) return inFlight
    if (this.entries_.get(entry.root) !== entry) return Promise.resolve()
    this.entries_.delete(entry.root)
    const run = this.runClose(entry, reason)
    // The tracked copy swallows: `ShellHost.settleAfterLastLane` calls this as
    // `void closeProject(...)`, and a rejected `shutdown()` sitting in the map
    // with nobody awaiting it is an unhandled rejection — which on node 22
    // takes the main process down on the way out. Callers that await get `run`
    // itself, so the failure still reaches them.
    this.closing.set(entry.root, run.catch(() => undefined))
    return run
  }

  private async runClose(entry: ProjectEntry<P, W>, reason: string): Promise<void> {
    try {
      entry.workspace.closeAll()
      await entry.project.shutdown(reason)
    } finally {
      this.closing.delete(entry.root)
    }
  }

  /**
   * Every project, in parallel: the ones still registered *and* the ones whose
   * teardown was already in flight. `allSettled` so one misbehaving MCP server
   * cannot keep the process alive on the way out.
   *
   * `timeoutMs` is the quit's watchdog and is the caller's to set — nothing here
   * knows how long a user will stare at a dead window. Hitting it does **not**
   * cancel anything (there is nothing to cancel: `shutdown()` is a promise, not
   * an operation with a handle); it only stops waiting, which is the difference
   * between an app that exits and one that does not.
   */
  async shutdownAll(
    reason: string,
    options: { timeoutMs?: number } = {},
  ): Promise<'drained' | 'timed-out'> {
    // Snapshot first: `closeProject` mutates `closing` as it settles.
    const inFlight = [...this.closing.values()]
    const closes = this.entries().map((entry) => this.closeProject(entry, reason))
    const drained = Promise.allSettled([...inFlight, ...closes])
    if (options.timeoutMs === undefined) {
      await drained
      return 'drained'
    }
    return withDeadline(drained, options.timeoutMs)
  }
}

/**
 * Resolve when `work` does, or when the deadline passes — whichever is first.
 *
 * The timer is cleared on the winning path so a drained shutdown does not hold
 * an event loop handle open for the rest of the deadline (which under `node
 * --test` is the difference between a suite that ends and one that hangs).
 */
async function withDeadline(work: Promise<unknown>, timeoutMs: number): Promise<'drained' | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs)
  })
  try {
    return await Promise.race([work.then(() => 'drained' as const), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
