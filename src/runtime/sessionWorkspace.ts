import type { SessionMeta } from '../sessions/service.js'
import { RuntimeSlot } from './runtimeSlot.js'
import { refreshRuntimeSlot } from './providerRuntime.js'
import { resolveSessionModelSelection, logSessionSelection } from './sessionSelection.js'
import { SessionController, type SessionControllerDeps } from './sessionController.js'
import {
  switchToExistingSession,
  switchToNewSession,
  type SessionSwitchDeps,
  type SessionSwitchResult,
} from './sessionSwitch.js'
import type { ProjectRuntime, SessionScope } from './types.js'

/** The one seam a test needs: real backups write outside the project. */
type CreateFileHistoryService = NonNullable<SessionControllerDeps['createFileHistoryService']>

export interface CreateSessionPaneOptions {
  /** Defaults to the project's startup model. */
  modelKey?: string
  createFileHistoryService?: CreateFileHistoryService
  /**
   * Runs at the end of `close()`, however it was reached.
   *
   * {@link SessionWorkspace} uses it to drop the pane from its own set, so a
   * pane closed directly does not leave a corpse behind in the workspace.
   */
  onClose?: () => void
}

/**
 * One conversation, fully assembled: a {@link SessionScope} plus the
 * {@link RuntimeSlot} and {@link SessionController} that drive it.
 *
 * This is the unit a desktop tab owns, and it is the same three objects
 * `tui.tsx` has always built by hand — a pane is only ever *one* of them for a
 * single-session shell. Anything shared by every pane in the project is on
 * `ProjectRuntime` instead.
 */
export class SessionPane {
  readonly scope: SessionScope
  readonly runtimeSlot: RuntimeSlot
  readonly controller: SessionController

  private readonly onClose: (() => void) | undefined
  private closed = false

  /** Use {@link createSessionPane}; the constructor takes what it already built. */
  constructor(parts: {
    scope: SessionScope
    runtimeSlot: RuntimeSlot
    controller: SessionController
    onClose?: () => void
  }) {
    this.scope = parts.scope
    this.runtimeSlot = parts.runtimeSlot
    this.controller = parts.controller
    this.onClose = parts.onClose
  }

  /**
   * The session currently shown, read from the controller rather than stored.
   *
   * `scope.session` is the session this pane *opened* with and does not move;
   * a `/resume` or `/clear` retargets the controller, and deriving from it is
   * what stops a pane from reporting a session it left.
   */
  getSession(): SessionMeta {
    return this.controller.getSessionMeta()
  }

  isTitlePending(): boolean {
    return this.controller.isTitlePending()
  }

  /**
   * Tears the pane down. Idempotent, because `ProjectRuntime.shutdown()`
   * disposes every open scope as a backstop and may arrive either side of this.
   *
   * The order is load-bearing:
   *
   * 1. `interrupt('exit')` first — `ToolRunner.run` does not pass its abort
   *    signal into `PermissionGate.approve`, so a turn parked on a permission
   *    prompt only unblocks once step 4 drains the bridge. `'exit'` rather than
   *    `'user-cancel'` because closing is not an interruption the session should
   *    resume from: `isUserCancelAbort` is what decides whether a
   *    `turn_interruption` record gets written.
   * 2. The controller next, so nothing that arrives later is republished to a UI
   *    that is going away.
   * 3. The slot, which unregisters the runtime's tool array and its plan-slug
   *    provider.
   * 4. The scope last, which puts the four bridges back to their pre-mount
   *    fallbacks and settles whatever was still parked.
   *
   * Background tasks deliberately keep running. `/clear` stops them because it
   * discards the session; closing a pane is closer to `/resume` switching away
   * — the session is still on disk and can be reopened, `restoreSession`'s
   * already-registered guard makes reopening correct, and a killed shell cannot
   * be brought back. `ProjectRuntime.shutdown()` is the one place that stops
   * everything.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.controller.interrupt('exit')
    this.controller.dispose()
    this.runtimeSlot.dispose()
    this.scope.dispose()
    this.onClose?.()
  }
}

/**
 * Assembles a pane over an already-open scope.
 *
 * Verbatim what `tui.tsx` used to do inline; it lives here so every shell —
 * terminal, desktop main process, a second tab — builds the runtime slot and
 * controller from exactly the same arguments.
 */
export function createSessionPane(
  project: ProjectRuntime,
  scope: SessionScope,
  options: CreateSessionPaneOptions = {},
): SessionPane {
  // One answer for every way a session arrives: new, reopened, restored after a
  // restart, or rebuilt after a settings refresh. A shell-supplied key still
  // wins for the pane it is adopting.
  const selection = resolveSessionModelSelection(project.config, scope.session, {
    defaultEffort: project.initialEffort ?? project.configuredEffortLevel,
  })
  logSessionSelection(scope.session, selection)
  const runtimeSlot = new RuntimeSlot(undefined, selection.effort)
  refreshRuntimeSlot({
    config: project.config,
    runtimeSlot,
    createRuntime: scope.createRuntime,
    modelKey: options.modelKey ?? selection.modelKey,
    ...(selection.issue ? { issue: selection.issue } : {}),
    session: scope.session,
    records: scope.existingRecords,
  })
  const controller = new SessionController({
    cwd: project.cwd,
    store: project.store,
    session: scope.session,
    existingRecords: scope.existingRecords,
    recordProxy: scope.bridges.record,
    // Read per turn, so a model switch mid-session cannot retarget a run
    // already in flight.
    getSession: () => runtimeSlot.requireCurrent(),
    ...(options.createFileHistoryService
      ? { createFileHistoryService: options.createFileHistoryService }
      : {}),
  })

  // Only now does the scope have somewhere to send the paths its write tools
  // are about to change; the controller owns the history and moves it on
  // `retarget`, so the hook goes through the controller rather than the service.
  scope.setFileEditTracker(controller.trackFileEdit)

  return new SessionPane({
    scope,
    runtimeSlot,
    controller,
    ...(options.onClose ? { onClose: options.onClose } : {}),
  })
}

export interface SessionWorkspaceOptions {
  createFileHistoryService?: CreateFileHistoryService
}

/**
 * Every pane open on one {@link ProjectRuntime}.
 *
 * The project half is shared — tools, MCP connections, background tasks, the
 * config and the store — and each pane gets its own scope on top of it. A
 * single-session shell needs none of this and calls {@link createSessionPane}
 * directly; the workspace exists for the shell that opens a second tab.
 *
 * There is no session index to keep in sync: `paneForSession` scans, because a
 * derived answer cannot go stale and a shell has a handful of tabs, not
 * thousands. That is deliberate — a map keyed by session id would need
 * re-keying on every `/clear` and `/resume`, and the one caller who forgot
 * would silently disable the one-pane-per-session guarantee below.
 */
export class SessionWorkspace {
  private readonly project: ProjectRuntime
  private readonly createFileHistoryService: CreateFileHistoryService | undefined
  private readonly panes = new Set<SessionPane>()

  constructor(project: ProjectRuntime, options: SessionWorkspaceOptions = {}) {
    this.project = project
    this.createFileHistoryService = options.createFileHistoryService
  }

  list(): readonly SessionPane[] {
    return [...this.panes]
  }

  paneForSession(sessionId: string): SessionPane | undefined {
    return [...this.panes].find((pane) => pane.getSession().id === sessionId)
  }

  /**
   * Registers the scope `bootstrap()` already opened as this workspace's first
   * pane.
   *
   * Without this a shell would have to build the pane itself and then add it to
   * a set it does not own — or throw the initial scope away and open a second
   * one onto the same session, which is exactly what {@link open} refuses.
   */
  adopt(scope: SessionScope, options: { modelKey?: string } = {}): SessionPane {
    const existing = this.paneForSession(scope.session.id)
    if (existing) return existing
    return this.register(scope, options)
  }

  /**
   * Opens a pane for `session`, or hands back the one that already shows it.
   *
   * Returning the existing pane rather than opening a second one is the whole
   * point: two panes on one session id means two `AgentLoop`s appending to one
   * JSONL and two `FileHistoryService`s snapshotting one worktree. The pane
   * asked for *is* that pane.
   */
  async open(session: SessionMeta): Promise<SessionPane> {
    const existing = this.paneForSession(session.id)
    if (existing) return existing

    const scope = await this.project.openScope(session)
    return this.register(scope, {})
  }

  /** Closes one pane. A pane not open here is left alone. */
  close(pane: SessionPane): void {
    if (!this.panes.has(pane)) return
    pane.close()
  }

  closeAll(): void {
    for (const pane of [...this.panes]) pane.close()
  }

  /**
   * Points `pane` at an existing session, through the one copy of the switch
   * choreography in `sessionSwitch.ts`.
   *
   * The guard is what a single-pane shell has no need for: another pane already
   * showing that session would end up sharing it, so this refuses before
   * anything is swapped. Records come back raw for the caller to rebase
   * whatever record view it holds — a pane deliberately owns no ledger, since
   * `SessionHost` and `App.tsx` each keep their own.
   */
  async switchPane(
    pane: SessionPane,
    sessionId: string,
    options: { beforeApply?: SessionSwitchDeps['beforeApply'] } = {},
  ): Promise<SessionSwitchResult> {
    this.assertOpen(pane)
    const holder = this.paneForSession(sessionId)
    if (holder && holder !== pane) {
      throw new Error(`Session is already open in another pane: ${sessionId}`)
    }
    return switchToExistingSession(this.switchDeps(pane, options.beforeApply), sessionId)
  }

  /** The `/clear` equivalent: a fresh draft in this pane. */
  async clearPane(
    pane: SessionPane,
    options: { title?: string; beforeApply?: SessionSwitchDeps['beforeApply'] } = {},
  ): Promise<SessionSwitchResult> {
    this.assertOpen(pane)
    return switchToNewSession(this.switchDeps(pane, options.beforeApply), {
      previousSessionId: pane.getSession().id,
      ...(options.title ? { title: options.title } : {}),
    })
  }

  private register(scope: SessionScope, options: { modelKey?: string }): SessionPane {
    // Assigned after construction so the close hook can name the pane it
    // removes; the hook cannot run before `createSessionPane` returns.
    let pane: SessionPane
    pane = createSessionPane(this.project, scope, {
      ...(options.modelKey ? { modelKey: options.modelKey } : {}),
      ...(this.createFileHistoryService
        ? { createFileHistoryService: this.createFileHistoryService }
        : {}),
      onClose: () => {
        this.panes.delete(pane)
      },
    })
    this.panes.add(pane)
    return pane
  }

  private switchDeps(
    pane: SessionPane,
    beforeApply: SessionSwitchDeps['beforeApply'],
  ): SessionSwitchDeps {
    return {
      // One member from each half: the switch needs the project's store and
      // *this* pane's runtime factory.
      host: { store: this.project.store, createRuntime: pane.scope.createRuntime },
      runtimeSlot: pane.runtimeSlot,
      controller: pane.controller,
      backgroundTasks: this.project.backgroundTasks,
      ...(beforeApply ? { beforeApply } : {}),
    }
  }

  private assertOpen(pane: SessionPane): void {
    if (!this.panes.has(pane)) throw new Error('Pane is not open in this workspace')
  }
}
