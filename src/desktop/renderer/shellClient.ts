import type { RuntimeChannel } from '../../runtime/protocol/channel.js'
import { PendingRequests } from '../../runtime/protocol/pendingRequests.js'
import type {
  ShellCommand,
  ShellEvent,
  WireLaneInfo,
  WireShellDeleteSessionResult,
  WireShellSettingsResult,
  WireShellSettingsChangeResult,
  WireShellRenameSessionResult,
  WireShellOpenInEditorResult,
  WireShellReadSkillResult,
  WireShellRevealSkillResult,
  WireMenuAction,
  WireShellSetWindowThemeResult,
  WireShellProbeEndpointResult,
  WireShellPickImagesResult,
  SettingsChange,
  WireShellOpenProjectResult,
  WireShellRemoveProjectResult,
  WireShellOpenSessionResult,
  WireShellPanesResult,
  WireShellSessionsResult,
  WireShellUsageStatsResult,
  WireShellModelNamesResult,
  WireEditorTarget,
  WireBrowserRect,
  WireBrowserTabInfo,
  WireShellBrowserCreateTabResult,
  WireShellBrowserOkResult,
  WireShellCoordinationOkResult,
  WireShellNewCoordinatorProjectResult,
  WireShellOpenCoordinatorResult,
  WireShellThreadMergeResult,
  WireShellThreadMergesResult,
  WireShellThreadTranscriptResult,
  WireCoordinationThreads,
} from '../shellProtocol.js'

/**
 * The renderer's client for the `__shell` lane.
 *
 * A deliberate miniature of `SessionClient`: same reply/fail envelopes, same
 * `PendingRequests` ledger, same fail-on-channel-death. What it does not have
 * is a protocol of its own — three commands, two events, and the lane list
 * kept identity-stable across `lanes` events that re-announce the same set,
 * because the tab bar re-renders on every one of them.
 *
 * Lives in the renderer tree so the test drives the shipping implementation,
 * the same rule `bridgeChannel.ts` follows. Browser-safe by construction: the
 * only value imports are the pending-request ledger and the protocol types'
 * module, and ids come from the global `crypto`, never `node:crypto`.
 */
export class ShellClient {
  private readonly channel: RuntimeChannel
  private readonly replies = new PendingRequests<
    { ok: true; result: unknown } | { ok: false; message: string }
  >()
  private readonly laneListeners = new Set<(lanes: readonly WireLaneInfo[]) => void>()
  private readonly activateListeners = new Set<(lane: string) => void>()
  private readonly browserListeners = new Set<(tabs: readonly WireBrowserTabInfo[]) => void>()
  private readonly coordinationListeners = new Set<(state: WireCoordinationThreads) => void>()
  private readonly menuListeners = new Set<(action: WireMenuAction) => void>()
  private readonly focusListeners = new Set<(focused: boolean) => void>()
  /** Project root -> its latest thread table, from pull replies and pushes alike. */
  private readonly coordinationThreadsByRoot = new Map<string, WireCoordinationThreads>()
  private lanes: readonly WireLaneInfo[] = Object.freeze([])
  private browserTabs: readonly WireBrowserTabInfo[] = Object.freeze([])
  private readonly teardown: Array<() => void> = []
  private disposed = false

  constructor(channel: RuntimeChannel) {
    this.channel = channel
    this.teardown.push(channel.onMessage(this.handleMessage))
    this.teardown.push(channel.onClose(this.handleClose))
  }

  /** The most recent topology the host announced. Empty until the first event or `panes()`. */
  getLanes = (): readonly WireLaneInfo[] => this.lanes

  onLanes(listener: (lanes: readonly WireLaneInfo[]) => void): () => void {
    this.laneListeners.add(listener)
    return () => {
      this.laneListeners.delete(listener)
    }
  }

  onActivate(listener: (lane: string) => void): () => void {
    this.activateListeners.add(listener)
    return () => {
      this.activateListeners.delete(listener)
    }
  }

  /** A native application-menu item was clicked (the macOS menu bar). */
  onMenuAction(listener: (action: WireMenuAction) => void): () => void {
    this.menuListeners.add(listener)
    return () => {
      this.menuListeners.delete(listener)
    }
  }

  /** The window gained (`true`) or lost (`false`) focus. */
  onWindowFocus(listener: (focused: boolean) => void): () => void {
    this.focusListeners.add(listener)
    return () => {
      this.focusListeners.delete(listener)
    }
  }

  /** Pulls the topology. Startup uses this rather than trusting early pushes: a renderer that attaches mid-session would otherwise wait for the next change to learn what already exists. */
  async panes(): Promise<readonly WireLaneInfo[]> {
    const result = (await this.send({ type: 'panes', id: crypto.randomUUID() })) as WireShellPanesResult
    this.applyLanes(result.lanes)
    return this.lanes
  }

  async openSession(options: { sessionId?: string; title?: string; projectRoot?: string; activate?: boolean } = {}): Promise<WireShellOpenSessionResult> {
    return this.send({
      type: 'open-session',
      id: crypto.randomUUID(),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
      ...(options.activate !== undefined ? { activate: options.activate } : {}),
    }) as Promise<WireShellOpenSessionResult>
  }

  async openProject(): Promise<WireShellOpenProjectResult> {
    return this.send({ type: 'open-project', id: crypto.randomUUID() }) as Promise<WireShellOpenProjectResult>
  }

  /**
   * Forgets a project: unregisters it and releases its lanes. Deletes nothing —
   * re-opening the directory brings the group and its sessions back.
   */
  async removeProject(projectRoot: string): Promise<WireShellRemoveProjectResult> {
    return this.send({
      type: 'remove-project',
      id: crypto.randomUUID(),
      projectRoot,
    }) as Promise<WireShellRemoveProjectResult>
  }

  /**
   * The sidebar's history. Deliberately not cached here: the caller decides
   * *when* to pull (topology change, turn end, after a delete) and owns the
   * coalescing, because this one reaches the filesystem on the host side.
   */
  async listSessions(): Promise<WireShellSessionsResult> {
    return this.send({
      type: 'list-sessions',
      id: crypto.randomUUID(),
    }) as Promise<WireShellSessionsResult>
  }

  async usageStats(): Promise<WireShellUsageStatsResult> {
    return this.send({
      type: 'usage-stats',
      id: crypto.randomUUID(),
    }) as Promise<WireShellUsageStatsResult>
  }

  async modelNames(): Promise<WireShellModelNamesResult> {
    return this.send({ type: 'model-names', id: crypto.randomUUID() }) as Promise<WireShellModelNamesResult>
  }

  async deleteSession(projectRoot: string, sessionId: string): Promise<WireShellDeleteSessionResult> {
    return this.send({
      type: 'delete-session',
      id: crypto.randomUUID(),
      projectRoot,
      sessionId,
    }) as Promise<WireShellDeleteSessionResult>
  }

  /** The settings screen's whole read model. Like `listSessions`, never cached here. */
  async getSettings(projectRoot?: string, skillsScope?: 'personal'): Promise<WireShellSettingsResult> {
    return this.send({
      type: 'get-settings',
      id: crypto.randomUUID(),
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(skillsScope ? { skillsScope } : {}),
    }) as Promise<WireShellSettingsResult>
  }

  /**
   * One settings edit. The reply carries a fresh snapshot — the renderer never
   * re-derives one by applying the change to the copy it is holding.
   */
  async changeSettings(
    projectRoot: string,
    change: SettingsChange,
    skillsScope?: 'personal',
  ): Promise<WireShellSettingsChangeResult> {
    return this.send({
      type: 'settings-change',
      id: crypto.randomUUID(),
      projectRoot,
      change,
      ...(skillsScope ? { skillsScope } : {}),
    }) as Promise<WireShellSettingsChangeResult>
  }

  async renameSession(
    projectRoot: string,
    sessionId: string,
    title: string,
  ): Promise<WireShellRenameSessionResult> {
    return this.send({
      type: 'rename-session',
      id: crypto.randomUUID(),
      projectRoot,
      sessionId,
      title,
    }) as Promise<WireShellRenameSessionResult>
  }

  /**
   * The canvas header's "open location" — or, with `target`, one file inside
   * the project at one line (a search result's path, clicked). `projectRoot` is
   * the lane list's key; the host resolves it and bounds `target.path` to the
   * project's real cwd. Rejects when the editor cannot start, which is the
   * common case (no `code` on PATH) — the caller writes it into the transcript
   * rather than losing it.
   */
  async openInEditor(
    projectRoot: string,
    target?: WireEditorTarget,
  ): Promise<WireShellOpenInEditorResult> {
    return this.send({
      type: 'open-in-editor',
      id: crypto.randomUUID(),
      projectRoot,
      ...(target === undefined ? {} : { target }),
    }) as Promise<WireShellOpenInEditorResult>
  }

  async probeEndpoint(
    request: Omit<Extract<ShellCommand, { type: 'probe-endpoint' }>, 'type' | 'id'>,
  ): Promise<WireShellProbeEndpointResult> {
    return this.send({ type: 'probe-endpoint', id: crypto.randomUUID(), ...request }) as Promise<WireShellProbeEndpointResult>
  }

  /** One skill's `SKILL.md`, verbatim: 复制 Markdown uses it because the snapshot holds a preview. */
  async readSkill(projectRoot: string, name: string, skillsScope?: 'personal'): Promise<WireShellReadSkillResult> {
    return this.send({ type: 'read-skill', id: crypto.randomUUID(), projectRoot, name, ...(skillsScope ? { skillsScope } : {}) }) as Promise<WireShellReadSkillResult>
  }

  /** Shows the skill's folder in the OS file manager. */
  async revealSkill(projectRoot: string, name: string, skillsScope?: 'personal'): Promise<WireShellRevealSkillResult> {
    return this.send({ type: 'reveal-skill', id: crypto.randomUUID(), projectRoot, name, ...(skillsScope ? { skillsScope } : {}) }) as Promise<WireShellRevealSkillResult>
  }

  /** Opens the skill's `SKILL.md` in the editor; rejects when the editor cannot start. */
  async openSkill(projectRoot: string, name: string, skillsScope?: 'personal'): Promise<WireShellOpenInEditorResult> {
    return this.send({ type: 'open-skill', id: crypto.randomUUID(), projectRoot, name, ...(skillsScope ? { skillsScope } : {}) }) as Promise<WireShellOpenInEditorResult>
  }

  /**
   * Repaints the native title-bar overlay after a theme change (5g).
   *
   * Fire-and-forget at the call site: the overlay is chrome, and a shell without
   * one answers `ok` anyway — there is nothing here for the user to act on.
   */
  async setWindowTheme(
    theme: 'dark' | 'light',
    preference: 'system' | 'dark' | 'light',
  ): Promise<WireShellSetWindowThemeResult> {
    return this.send({
      type: 'set-window-theme',
      id: crypto.randomUUID(),
      theme,
      preference,
    }) as Promise<WireShellSetWindowThemeResult>
  }

  /**
   * Asks the shell to flash the taskbar button or bounce the Dock icon; the
   * shell does nothing while the window has focus. Posted like
   * `browserSetBounds`, for the same reason: nobody awaits a cue.
   */
  requestAttention(): void {
    if (this.disposed) return
    this.channel.post({ type: 'request-attention', id: crypto.randomUUID() })
  }

  /**
   * 「选择图片」 (S11): the OS picker. `projectRoot` anchors where the dialog
   * opens; the answer is paths, which the pane imports host-side. An empty
   * list means the dialog was cancelled.
   */
  async pickImages(projectRoot?: string): Promise<WireShellPickImagesResult> {
    return this.send({
      type: 'pick-images',
      id: crypto.randomUUID(),
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    }) as Promise<WireShellPickImagesResult>
  }

  // --- coordination ----------------------------------------------------------

  /** Opens the project's coordinator session as the active lane, creating it the first time. */
  async openCoordinator(projectRoot: string): Promise<WireShellOpenCoordinatorResult> {
    return this.send({
      type: 'open-coordinator',
      id: crypto.randomUUID(),
      projectRoot,
    }) as Promise<WireShellOpenCoordinatorResult>
  }

  /** Picks a folder, adds it as a project and opens its coordinator; `cancelled` when the picker is dismissed. */
  async newCoordinatorProject(): Promise<WireShellNewCoordinatorProjectResult> {
    return this.send({ type: 'new-coordinator-project', id: crypto.randomUUID() }) as Promise<WireShellNewCoordinatorProjectResult>
  }

  /** The coordinator welcome's 「读取项目」. */
  async startSurvey(projectRoot: string): Promise<WireShellCoordinationOkResult> {
    return this.send({
      type: 'coordination-survey',
      id: crypto.randomUUID(),
      projectRoot,
    }) as Promise<WireShellCoordinationOkResult>
  }

  /** Stops the coordinator and every running thread of the project. */
  async stopAllCoordination(projectRoot: string): Promise<WireShellCoordinationOkResult> {
    return this.send({
      type: 'coordination-stop-all',
      id: crypto.randomUUID(),
      projectRoot,
    }) as Promise<WireShellCoordinationOkResult>
  }

  async threadMerges(projectRoot: string): Promise<WireShellThreadMergesResult> {
    return this.send({
      type: 'thread-merges',
      id: crypto.randomUUID(),
      projectRoot,
    }) as Promise<WireShellThreadMergesResult>
  }

  async mergeThread(projectRoot: string, threadId: string): Promise<WireShellThreadMergeResult> {
    return this.send({
      type: 'thread-merge',
      id: crypto.randomUUID(),
      projectRoot,
      threadId,
    }) as Promise<WireShellThreadMergeResult>
  }

  async dismissThreadMerge(projectRoot: string, threadId: string): Promise<WireShellCoordinationOkResult> {
    return this.send({
      type: 'thread-merge-dismiss',
      id: crypto.randomUUID(),
      projectRoot,
      threadId,
    }) as Promise<WireShellCoordinationOkResult>
  }

  /** Hands a conflicting merge back to the thread to resolve on its branch. */
  async resolveThreadMerge(projectRoot: string, threadId: string): Promise<WireShellCoordinationOkResult> {
    return this.send({
      type: 'thread-merge-resolve',
      id: crypto.randomUUID(),
      projectRoot,
      threadId,
    }) as Promise<WireShellCoordinationOkResult>
  }

  /** A thread's records; `since` is the token of the last copy, and an `unchanged` reply carries none. */
  async threadTranscript(projectRoot: string, threadId: string, since?: string): Promise<WireShellThreadTranscriptResult> {
    return this.send({
      type: 'thread-transcript',
      id: crypto.randomUUID(),
      projectRoot,
      threadId,
      ...(since !== undefined ? { since } : {}),
    }) as Promise<WireShellThreadTranscriptResult>
  }

  /** Pulls a project's thread table; the reply also lands in the cache and wakes the listeners. */
  async coordinationThreads(projectRoot: string): Promise<WireCoordinationThreads> {
    const state = (await this.send({
      type: 'coordination-threads',
      id: crypto.randomUUID(),
      projectRoot,
    })) as WireCoordinationThreads
    this.applyCoordinationThreads(state)
    return state
  }

  /** The user's stop of one thread. */
  async threadStop(projectRoot: string, threadId: string): Promise<WireShellCoordinationOkResult> {
    return this.send({
      type: 'thread-stop',
      id: crypto.randomUUID(),
      projectRoot,
      threadId,
    }) as Promise<WireShellCoordinationOkResult>
  }

  /** The user's 结案 of one thread. */
  async threadResolve(projectRoot: string, threadId: string): Promise<WireShellCoordinationOkResult> {
    return this.send({
      type: 'thread-resolve',
      id: crypto.randomUUID(),
      projectRoot,
      threadId,
    }) as Promise<WireShellCoordinationOkResult>
  }

  /** The latest thread table for a project root, or `undefined` before the first pull or push. */
  getCoordinationThreads = (projectRoot: string): WireCoordinationThreads | undefined =>
    this.coordinationThreadsByRoot.get(projectRoot)

  onCoordinationThreads(listener: (state: WireCoordinationThreads) => void): () => void {
    this.coordinationListeners.add(listener)
    return () => {
      this.coordinationListeners.delete(listener)
    }
  }

  // --- browser ---------------------------------------------------------------

  /** The most recent tab list the host announced, across every lane. */
  getBrowserTabs = (): readonly WireBrowserTabInfo[] => this.browserTabs

  onBrowserState(listener: (tabs: readonly WireBrowserTabInfo[]) => void): () => void {
    this.browserListeners.add(listener)
    return () => {
      this.browserListeners.delete(listener)
    }
  }

  async browserCreateTab(lane: string, url?: string): Promise<WireShellBrowserCreateTabResult> {
    return this.send({
      type: 'browser-create-tab',
      id: crypto.randomUUID(),
      lane,
      ...(url !== undefined ? { url } : {}),
    }) as Promise<WireShellBrowserCreateTabResult>
  }

  async browserCloseTab(tabId: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-close-tab', id: crypto.randomUUID(), tabId }) as Promise<WireShellBrowserOkResult>
  }

  async browserNavigate(tabId: string, url: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-navigate', id: crypto.randomUUID(), tabId, url }) as Promise<WireShellBrowserOkResult>
  }

  async browserGoBack(tabId: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-go-back', id: crypto.randomUUID(), tabId }) as Promise<WireShellBrowserOkResult>
  }

  async browserGoForward(tabId: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-go-forward', id: crypto.randomUUID(), tabId }) as Promise<WireShellBrowserOkResult>
  }

  async browserReload(tabId: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-reload', id: crypto.randomUUID(), tabId }) as Promise<WireShellBrowserOkResult>
  }

  async browserTakeOver(tabId: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-take-over', id: crypto.randomUUID(), tabId }) as Promise<WireShellBrowserOkResult>
  }

  async browserRelease(tabId: string): Promise<WireShellBrowserOkResult> {
    return this.send({ type: 'browser-release', id: crypto.randomUUID(), tabId }) as Promise<WireShellBrowserOkResult>
  }

  /**
   * Where the panel's hole is, and whether the native view may paint.
   *
   * The one command posted straight onto the channel instead of through
   * `send`: it rides every resize frame, every sidebar drag and every
   * `ResizeObserver` callback, so registering a pending reply per push would
   * grow the ledger for answers nobody reads. The host replies anyway and
   * `PendingRequests.settle` drops the unknown id — that is the intended shape,
   * not a leak.
   */
  browserSetBounds(tabId: string, rect: WireBrowserRect, visible: boolean): void {
    if (this.disposed) return
    this.channel.post({
      type: 'browser-set-bounds',
      id: crypto.randomUUID(),
      tabId,
      rect,
      visible,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.teardown.splice(0)) off()
    this.failAllPending('The shell client was disposed.')
    this.lanes = Object.freeze([])
    this.browserTabs = Object.freeze([])
    this.laneListeners.clear()
    this.activateListeners.clear()
    this.browserListeners.clear()
    this.coordinationThreadsByRoot.clear()
    this.coordinationListeners.clear()
    this.menuListeners.clear()
    this.focusListeners.clear()
  }

  // --- internals -----------------------------------------------------------

  private handleMessage = (message: unknown): void => {
    const event = message as ShellEvent
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return

    switch (event.type) {
      case 'lanes':
        this.applyLanes(event.lanes)
        return
      case 'activate':
        for (const listener of [...this.activateListeners]) listener(event.lane)
        return
      case 'browser-state':
        this.browserTabs = Object.freeze([...event.tabs])
        for (const listener of [...this.browserListeners]) listener(this.browserTabs)
        return
      case 'coordination-threads':
        this.applyCoordinationThreads(event.state)
        return
      case 'menu-action':
        for (const listener of [...this.menuListeners]) listener(event.action)
        return
      case 'window-focus':
        for (const listener of [...this.focusListeners]) listener(event.focused)
        return
      case 'reply':
        this.replies.settle(event.id, { ok: true, result: event.result })
        return
      case 'fail':
        this.replies.settle(event.id, { ok: false, message: event.message })
        return
    }
  }

  /**
   * Swaps the list only when it actually differs, so `getLanes()` keeps its
   * identity across re-announcements and a tab bar diffing on it stays quiet.
   */
  private applyLanes(next: WireLaneInfo[]): void {
    if (sameLaneList(this.lanes, next)) return
    this.lanes = Object.freeze([...next])
    for (const listener of [...this.laneListeners]) listener(this.lanes)
  }

  private applyCoordinationThreads(state: WireCoordinationThreads): void {
    this.coordinationThreadsByRoot.set(state.projectRoot, state)
    for (const listener of [...this.coordinationListeners]) listener(state)
  }

  private async send(command: ShellCommand): Promise<unknown> {
    if (this.disposed) throw new Error('The shell client was disposed.')
    const pending = this.replies.create(command.id)
    this.channel.post(command)
    const settled = await pending
    if (!settled.ok) throw new Error(settled.message)
    return settled.result
  }

  private handleClose = (): void => {
    this.failAllPending('The shell host disconnected.')
  }

  private failAllPending(message: string): void {
    this.replies.settleAll(() => ({ ok: false, message }))
  }
}

/**
 * Compared field by field, in order: the fields a tab row renders are exactly
 * the ones that move (`sessionId` travels under `/clear`, titles arrive late),
 * and a lane whose nothing changed must not wake its listeners.
 */
function sameLaneList(current: readonly WireLaneInfo[], next: readonly WireLaneInfo[]): boolean {
  if (current.length !== next.length) return false
  for (let index = 0; index < current.length; index += 1) {
    const a = current[index]!
    const b = next[index]!
    if (
      a.lane !== b.lane ||
      a.paneId !== b.paneId ||
      a.sessionId !== b.sessionId ||
      a.projectRoot !== b.projectRoot ||
      a.projectName !== b.projectName ||
      a.sessionTitle !== b.sessionTitle ||
      a.titlePending !== b.titlePending ||
      a.coordinationRole !== b.coordinationRole
    ) {
      return false
    }
  }
  return true
}
