import { randomUUID } from 'node:crypto'
import type { SessionRecord, TaskDisplaySnapshot } from '../../harness/types.js'
import type { MessageQueuePriority, PersistedQueuedMessage } from '../../harness/types.js'
import type { PermissionMode } from '../../harness/permissions.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { BackgroundTaskSnapshot } from '../../services/backgroundTasks/registry.js'
import type { CheckpointWithDiff } from '../../services/fileHistory/types.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { FileSuggestion } from '../suggestions/atToken.js'
import { createEmptySessionUsage, type SessionUsage } from '../sessionUsage.js'
import type { RewindSummaryDecision } from '../rewindSummary.js'
import type { SessionControllerSnapshot, SessionEvent } from '../sessionController.js'
import type { RuntimeChannel } from './channel.js'
import { PendingRequests } from './pendingRequests.js'
import {
  UI_REQUEST_FALLBACKS,
  type CommandEffect,
  type HostCommand,
  type HostEvent,
  type InterruptReason,
  type PermissionRequestDto,
  type UiResponse,
  type WireBackgroundTasksResult,
  type WireBranchesResult,
  type WireClosePaneResult,
  type WireCommandInfo,
  type WireCommandsResult,
  type WireEffortResult,
  type WireEnqueueResult,
  type WireAttachmentPreviewResult,
  type WireAttachmentViewResult,
  type WireSubagentTranscriptResult,
  type WireAttachmentSource,
  type WireFileSuggestionsResult,
  type WireFocusPaneResult,
  type WireHelloResult,
  type WireImportAttachmentResult,
  type WireListPanesResult,
  type WireModelsResult,
  type WireOpenAttachmentResult,
  type WireOpenPaneResult,
  type WirePaneInfo,
  type WireReloadCountResult,
  type WireReloadResult,
  type WireReloadSettingsResult,
  type WireResolveModelResult,
  type WireRewindResult,
  type WireRunCommandResult,
  type WireRunOverrides,
  type WireRuntimeSnapshot,
  type WireSessionSwitchResult,
  type WireSessionsResult,
  type WireSwitchBranchResult,
  type WireTaskOutputResult,
  type WireTaskResult,
  type WireUsageCost,
  type ToolDisplayDto,
  type ToolDisplays,
} from './wire.js'

const EMPTY_TASKS: readonly BackgroundTaskSnapshot[] = Object.freeze([])
const EMPTY_QUEUE: readonly PersistedQueuedMessage[] = Object.freeze([])

/** Answers the four blocking questions a host can ask. */
export interface SessionClientHandlers {
  permission?: (request: PermissionRequestDto) => Promise<{ approved: boolean; alwaysAllow?: boolean }>
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>
  enterPlan?: () => Promise<boolean>
  exitPlan?: (input: ExitDialogInput) => Promise<ExitPlanDecision>
}

/**
 * The UI half of the protocol.
 *
 * Mirrors the shape `SessionController` exposes — `onEvent` for the ordered
 * stream, `subscribe`/`getSnapshot` for pull state — so a view written against
 * one works against the other.
 *
 * The subtle part is snapshot identity. `SessionController.publish` compares
 * `usage` and `taskSnapshot` *by reference*, which works in-process because
 * they are only reassigned when they truly change. Deserialized messages have
 * no such luck: every `snapshot` that arrives is a fresh object graph, so
 * rebuilding state from each one would hand `useSyncExternalStore` a new
 * identity on every tick and re-render forever. This client field-diffs before
 * swapping, restoring the invariant the React contract needs.
 */
export class SessionClient {
  private readonly channel: RuntimeChannel
  private readonly replies = new PendingRequests<{ ok: true; result: unknown } | { ok: false; message: string }>()
  private readonly eventListeners = new Set<(event: SessionEvent) => void>()
  private readonly effectListeners = new Set<(effect: CommandEffect) => void>()
  private readonly paneListeners = new Set<(panes: readonly WirePaneInfo[]) => void>()
  private readonly queueListeners = new Set<(messages: readonly PersistedQueuedMessage[]) => void>()
  private readonly listeners = new Set<() => void>()
  private handlers: SessionClientHandlers = {}

  private snapshot: SessionControllerSnapshot = Object.freeze({
    isStreaming: false,
    usage: createEmptySessionUsage(),
    taskSnapshot: undefined,
    spinnerSubText: undefined,
    contextUsedTokens: undefined,
    turnOutputTokens: undefined,
  })
  private subagentProgress: ReadonlyMap<string, string> = new Map()
  /**
   * Session cost, as computed by the host.
   *
   * Folded into the same diff as the snapshot rather than kept as its own
   * signal: it is a function of the token totals, so it moves exactly when
   * `usage` does and would otherwise wake every subscriber on a turn where
   * nothing else changed.
   */
  private cost: WireUsageCost | undefined
  private runtimeSnapshot: WireRuntimeSnapshot | undefined
  private session: SessionMeta | undefined
  private backgroundTasks: readonly BackgroundTaskSnapshot[] = EMPTY_TASKS
  /** Pane list, kept identity-stable across `pane-list` events that re-announce the same set. */
  private panes: readonly WirePaneInfo[] = Object.freeze([])
  /** Queued messages, identity-stable the same way and for the same reason. */
  private queuedMessages: readonly PersistedQueuedMessage[] = EMPTY_QUEUE
  /**
   * Tool captions, accumulated from every record-carrying payload the host
   * sends.
   *
   * Kept here rather than handed to each `onEvent` listener, because a caption
   * outlives the event that introduced it: a `tool_result` arriving ten seconds
   * later is drawn under the same header, and a re-render has no event in hand
   * at all. Keys are `tool_use` record ids, so merging is safe; a
   * `transcript-reset` replaces the map instead, since the records it names are
   * the whole session.
   */
  private toolDisplays: ToolDisplays = {}
  private readonly teardown: Array<() => void> = []
  private disposed = false

  constructor(channel: RuntimeChannel) {
    this.channel = channel
    this.teardown.push(channel.onMessage(this.handleMessage))
    this.teardown.push(channel.onClose(this.handleClose))
  }

  setHandlers(handlers: SessionClientHandlers): void {
    this.handlers = handlers
  }

  // --- pull state -------------------------------------------------------

  getSnapshot = (): SessionControllerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSubagentProgress(): ReadonlyMap<string, string> {
    return this.subagentProgress
  }

  getRuntimeSnapshot(): WireRuntimeSnapshot | undefined {
    return this.runtimeSnapshot
  }

  getBackgroundTasks = (): readonly BackgroundTaskSnapshot[] => this.backgroundTasks

  /**
   * The session the host is bound to, once it has said so.
   *
   * `undefined` only before `hello()` resolves — that reply seeds it, so a shell
   * that has attached always has an answer. The desktop tab bar's active row is
   * derived from this, which is why `hello` records it rather than leaving the
   * first `session-changed` to.
   */
  getSession = (): SessionMeta | undefined => this.session

  /**
   * How a `tool_use` record should be captioned, or `undefined` for a record the
   * host never projected (an old host, or a record that is not a tool call).
   *
   * A renderer reads this instead of guessing at `input`'s keys; the resolution
   * itself needs the tool registry and stays host-side.
   */
  getToolDisplay(recordId: string): ToolDisplayDto | undefined {
    return this.toolDisplays[recordId]
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Renderer-side side effects pushed by a running slash command.
   *
   * Separate from `onEvent` because these are not session history: nothing here
   * is persisted, so a client that attaches later never sees the ones it missed —
   * exactly as the TUI behaves, where `writeLine` appends a display item rather
   * than a `SessionRecord`.
   */
  onCommandEffect(listener: (effect: CommandEffect) => void): () => void {
    this.effectListeners.add(listener)
    return () => {
      this.effectListeners.delete(listener)
    }
  }

  /**
   * The most recent pane topology the host has announced.
   *
   * Empty until the first `pane-list` event arrives; a shell that needs the
   * initial set to paint should call `listPanes()` instead of waiting.
   */
  getPanes = (): readonly WirePaneInfo[] => this.panes

  /**
   * Notified when the pane topology changes.
   *
   * The host pushes `pane-list` whenever a pane opens or closes; the client
   * field-diffs to keep the listener identity stable across re-announcements
   * of the same set.
   */
  onPanesChanged(listener: (panes: readonly WirePaneInfo[]) => void): () => void {
    this.paneListeners.add(listener)
    return () => {
      this.paneListeners.delete(listener)
    }
  }

  /**
   * Messages the host is holding until the running turn ends.
   *
   * Empty until the first `queued-messages` event; a shell that needs the
   * initial set to paint takes it from `hello()`'s result instead of waiting.
   */
  getQueuedMessages = (): readonly PersistedQueuedMessage[] => this.queuedMessages

  /** Notified when the queue changes, including when the host pumps one out of it. */
  onQueueChanged(listener: (messages: readonly PersistedQueuedMessage[]) => void): () => void {
    this.queueListeners.add(listener)
    return () => {
      this.queueListeners.delete(listener)
    }
  }

  /**
   * Session cost so far, or `undefined` when the active model has no complete
   * pricing. Derived host-side; see the `snapshot` event in `wire.ts`.
   */
  getCost(): WireUsageCost | undefined {
    return this.cost
  }

  /**
   * How many tokens the conversation currently occupies, or `undefined` before
   * there is anything to report. Computed by the `SessionController` and carried
   * on its snapshot, so this and the TUI status line read one number.
   */
  getContextUsedTokens(): number | undefined {
    return this.snapshot.contextUsedTokens
  }

  // --- commands ---------------------------------------------------------

  async hello(): Promise<WireHelloResult> {
    const result = await this.send({ type: 'hello', id: randomUUID() }) as WireHelloResult
    // `hello` *is* an announcement of the bound session, so record it rather than
    // waiting for the first `session-changed`. Without this `getSession()` stays
    // undefined through the whole first session, and anything deriving from it —
    // the tab bar's active row, for one — is wrong until a `/clear` or `/resume`
    // happens to fix it.
    this.session = result.session
    // The one reply that has to seed the map itself: everything else that
    // replaces the record list (`reload`, `/clear`, `/resume`, both rewinds)
    // emits a `transcript-reset` on the way, and the channel delivers that
    // before the reply.
    this.absorbToolDisplays(result.toolDisplays, true)
    return result
  }

  /**
   * Submits a turn. `imageIds` name attachments imported through
   * `importAttachment`; the host resolves them against the current session and
   * rejects the whole submit when one does not belong to it.
   */
  async submit(
    text: string,
    options: { imageIds?: string[]; overrides?: WireRunOverrides } = {},
  ): Promise<void> {
    await this.send({
      type: 'submit',
      id: randomUUID(),
      input: text,
      ...(options.imageIds !== undefined ? { imageIds: [...options.imageIds] } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    })
  }

  async interrupt(reason: InterruptReason = 'user-cancel'): Promise<void> {
    await this.send({ type: 'interrupt', id: randomUUID(), reason })
  }

  /** Reloads *records*. The `reload*` methods below reload host state. */
  async reload(): Promise<SessionRecord[]> {
    const result = await this.send({ type: 'reload', id: randomUUID() }) as WireReloadResult
    return result.records
  }

  async retarget(sessionId: string): Promise<WireSessionSwitchResult> {
    return this.send({ type: 'retarget', id: randomUUID(), sessionId }) as Promise<WireSessionSwitchResult>
  }

  async createSession(title?: string): Promise<WireSessionSwitchResult> {
    return this.send({
      type: 'create-session',
      id: randomUUID(),
      ...(title ? { title } : {}),
    }) as Promise<WireSessionSwitchResult>
  }

  async listSessions(): Promise<SessionMeta[]> {
    const result = await this.send({ type: 'list-sessions', id: randomUUID() }) as WireSessionsResult
    return result.sessions
  }

  async listModels(): Promise<WireModelsResult> {
    return this.send({ type: 'list-models', id: randomUUID() }) as Promise<WireModelsResult>
  }

  async resolveModel(input: string): Promise<string | undefined> {
    const result = await this.send({ type: 'resolve-model', id: randomUUID(), input }) as WireResolveModelResult
    return result.modelKey
  }

  async setDefaultModel(reference: string): Promise<WireModelsResult> {
    return this.send({
      type: 'set-default-model',
      id: randomUUID(),
      reference,
    }) as Promise<WireModelsResult>
  }

  async reloadAgents(): Promise<number> {
    const result = await this.send({ type: 'reload-agents', id: randomUUID() }) as WireReloadCountResult
    return result.count
  }

  async reloadSkills(): Promise<number> {
    const result = await this.send({ type: 'reload-skills', id: randomUUID() }) as WireReloadCountResult
    return result.count
  }

  async reloadSettings(): Promise<WireReloadSettingsResult> {
    return this.send({ type: 'reload-settings', id: randomUUID() }) as Promise<WireReloadSettingsResult>
  }

  async listBackgroundTasks(): Promise<BackgroundTaskSnapshot[]> {
    const result = await this.send({
      type: 'list-background-tasks',
      id: randomUUID(),
    }) as WireBackgroundTasksResult
    return result.tasks
  }

  async peekTaskOutput(taskId: string, maxBytes?: number): Promise<string> {
    const result = await this.send({
      type: 'peek-task-output',
      id: randomUUID(),
      taskId,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }) as WireTaskOutputResult
    return result.output
  }

  async killTask(taskId: string, reason?: string): Promise<BackgroundTaskSnapshot | undefined> {
    const result = await this.send({
      type: 'kill-task',
      id: randomUUID(),
      taskId,
      ...(reason ? { reason } : {}),
    }) as WireTaskResult
    return result.task
  }

  async runTool(name: string, input: unknown): Promise<{ ok: boolean; content: string; errorCode?: string }> {
    return this.send({ type: 'run-tool', id: randomUUID(), name, input }) as Promise<{
      ok: boolean
      content: string
      errorCode?: string
    }>
  }

  /**
   * Runs a slash command in the host.
   *
   * Anything the command wants drawn arrives beforehand on `onCommandEffect`,
   * not in this result — see `CommandEffect`. A rejected promise means the
   * command could not be *dispatched*; a command that failed on its own terms
   * resolves as handled and explains itself through a `write-line`.
   */
  async runCommand(input: string): Promise<WireRunCommandResult> {
    return this.send({ type: 'run-command', id: randomUUID(), input }) as Promise<WireRunCommandResult>
  }

  /**
   * Metadata for the registered slash commands, for a completion dropdown.
   *
   * Worth re-asking after `reloadSkills()`: skill commands come off disk and the
   * set changes without any event announcing it.
   */
  async listCommands(): Promise<WireCommandInfo[]> {
    const result = await this.send({ type: 'list-commands', id: randomUUID() }) as WireCommandsResult
    return result.commands
  }

  /**
   * `@` file candidates for the composer's current text and caret.
   *
   * Deliberately not cached and not debounced here: both are the caller's
   * decisions, and a caller that fires one of these per keystroke **must**
   * discard answers that arrive out of order — nothing about a `send()` promise
   * guarantees that the newest request settles last.
   */
  async fileSuggestions(input: string, cursorPos: number): Promise<FileSuggestion[]> {
    const result = await this.send({
      type: 'file-suggestions',
      id: randomUUID(),
      input,
      cursorPos,
    }) as WireFileSuggestionsResult
    return result.suggestions
  }

  /** The empty state's branch popover, asked once per open — never cached here. */
  async listBranches(): Promise<WireBranchesResult> {
    return this.send({ type: 'list-branches', id: randomUUID() }) as Promise<WireBranchesResult>
  }

  /**
   * A refused switch resolves rather than rejects: the host reports `ok: false`
   * with git's own sentence, and a dirty worktree is an answer the user has to
   * read, not a transport failure.
   */
  async switchBranch(branch: string): Promise<WireSwitchBranchResult> {
    return this.send({
      type: 'switch-branch',
      id: randomUUID(),
      branch,
    }) as Promise<WireSwitchBranchResult>
  }

  async getCheckpoints(): Promise<CheckpointWithDiff[]> {
    const result = await this.send({ type: 'checkpoints', id: randomUUID() }) as { checkpoints: CheckpointWithDiff[] }
    return result.checkpoints
  }

  async restoreCode(messageId: string): Promise<{ success: boolean; error?: string }> {
    return this.send({ type: 'restore-code', id: randomUUID(), messageId }) as Promise<{
      success: boolean
      error?: string
    }>
  }

  /**
   * Drops everything from `messageId` onward. Rejects when the message is not
   * in the session, so a stale checkpoint list cannot silently no-op.
   *
   * `restore-code-and-conversation` is this plus `restoreCode()`; there is no
   * combined command.
   */
  async truncateSession(messageId: string): Promise<SessionRecord[]> {
    const result = await this.send({
      type: 'truncate-session',
      id: randomUUID(),
      messageId,
    }) as WireRewindResult
    return result.records
  }

  /**
   * Replaces one half of the conversation with a summary of it.
   *
   * Slow by nature: the summary is a real provider call queued behind whatever
   * the loop is already doing.
   */
  async summarizeRewind(messageId: string, decision: RewindSummaryDecision): Promise<SessionRecord[]> {
    const result = await this.send({
      type: 'summarize-rewind',
      id: randomUUID(),
      messageId,
      decision,
    }) as WireRewindResult
    return result.records
  }

  async setModel(modelKey: string): Promise<{ modelKey: string; effort: string }> {
    return this.send({ type: 'set-model', id: randomUUID(), modelKey }) as Promise<{
      modelKey: string
      effort: string
    }>
  }

  async setEffort(level: string, options: { persist?: boolean } = {}): Promise<WireEffortResult> {
    return this.send({
      type: 'set-effort',
      id: randomUUID(),
      level,
      ...(options.persist ? { persist: true } : {}),
    }) as Promise<WireEffortResult>
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const result = await this.send({ type: 'set-permission-mode', id: randomUUID(), mode }) as { mode: PermissionMode }
    return result.mode
  }

  /**
   * The one command that tolerates the transport dying mid-flight: the host
   * going away is the success case, and a shell must not refuse to close its
   * window because the reply never arrived.
   */
  async shutdown(reason: string): Promise<void> {
    try {
      await this.send({ type: 'shutdown', id: randomUUID(), reason })
    } catch {
      // Already gone.
    }
  }

  // --- pane (multi-tab) commands ----------------------------------------

  /**
   * Opens a new tab. Without `sessionId` the host mints a fresh draft; with
   * one, the host resolves the existing session (returning the pane that
   * already shows it, if any — one pane per session).
   *
   * The reply is the same shape `hello` returns: the caller learns the
   * session id, the records that should be on screen, and the startup notices
   * for the new tab.
   */
  async openPane(options: { sessionId?: string; title?: string } = {}): Promise<WireOpenPaneResult> {
    return this.send({
      type: 'open-pane',
      id: randomUUID(),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.title ? { title: options.title } : {}),
    }) as Promise<WireOpenPaneResult>
  }

  /** Closes a tab by pane id. `paneId` is the same value `WirePaneInfo.paneId` carries. */
  async closePane(paneId: string): Promise<void> {
    await this.send({ type: 'close-pane', id: randomUUID(), paneId })
  }

  /** Lists every open tab. */
  async listPanes(): Promise<readonly WirePaneInfo[]> {
    const result = await this.send({ type: 'list-panes', id: randomUUID() }) as WireListPanesResult
    return result.panes
  }

  /**
   * Brings an already-open pane's window forward.
   *
   * This — not `openPane` — is what a tab click means: every row in the tab bar
   * is a pane that exists, and with several projects open the pane may belong to
   * a project this host knows nothing about. `false` means the shell no longer
   * has a window for it, so the caller should re-list rather than report an error.
   */
  async focusPane(paneId: string): Promise<boolean> {
    const result = await this.send({
      type: 'focus-pane',
      id: randomUUID(),
      paneId,
    }) as WireFocusPaneResult
    return result.ok
  }

  /**
   * Asks the shell to open another project in this process.
   *
   * Resolving means the shell accepted the request; the project is bootstrapped
   * afterwards, in its own window. `path` is for a smoke harness — a client
   * normally omits it and lets the shell put up its native directory picker.
   */
  async openProject(path?: string): Promise<void> {
    await this.send({
      type: 'open-project',
      id: randomUUID(),
      ...(path ? { path } : {}),
    })
  }

  /**
   * Holds a message until the running turn is over.
   *
   * There is no matching `dequeue`: the host pumps its own queue, and a client
   * that also popped from it would race that pump. The reply echoes the stored
   * message, but the authoritative list still arrives as a `queued-messages`
   * event — including the one that removes this message again when it is sent.
   *
   * `imageIds` behaves as it does on {@link submit}: the ids are resolved
   * host-side and stored on the queued message as refs, so a rejection here
   * means the message was *not* queued and the composer still owns the draft.
   */
  async enqueueMessage(
    content: string,
    options: { imageIds?: string[]; priority?: MessageQueuePriority } = {},
  ): Promise<PersistedQueuedMessage> {
    const result = await this.send({
      type: 'enqueue-message',
      id: randomUUID(),
      content,
      ...(options.imageIds !== undefined ? { imageIds: [...options.imageIds] } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    }) as WireEnqueueResult
    return result.message
  }

  /** Drops every waiting message. Does not touch the turn already running. */
  async clearQueue(): Promise<void> {
    await this.send({ type: 'clear-queue', id: randomUUID() })
  }

  // --- image attachments ---------------------------------------------------

  /**
   * Imports one image into the current session's attachment store.
   *
   * Bytes (a paste) are size-capped at the schema — an oversized payload
   * rejects here with the cap in the message. A path source is read by the
   * host, so this never ships a `File`/`Blob` across the wire.
   */
  async importAttachment(source: WireAttachmentSource): Promise<WireImportAttachmentResult> {
    return this.send({ type: 'import-attachment', id: randomUUID(), source }) as Promise<WireImportAttachmentResult>
  }

  /**
   * Drops a draft's hold on an attachment. Idempotent; the files stay on disk
   * under the retention window, and a message or queue entry still referencing
   * them is untouched.
   */
  async removeAttachment(imageId: string): Promise<void> {
    await this.send({ type: 'remove-attachment', id: randomUUID(), imageId })
  }

  /**
   * A size-capped thumbnail data URL for one attachment. Fetched on demand and
   * never part of a snapshot, so streaming turns do not re-send it per frame.
   */
  async getAttachmentPreview(imageId: string): Promise<WireAttachmentPreviewResult> {
    return this.send({
      type: 'get-attachment-preview',
      id: randomUUID(),
      imageId,
    }) as Promise<WireAttachmentPreviewResult>
  }

  /** One sub-agent run's own records, for the desktop's side panel. */
  async getSubagentTranscript(agentId: string): Promise<WireSubagentTranscriptResult> {
    return this.send({
      type: 'get-subagent-transcript',
      id: randomUUID(),
      agentId,
    }) as Promise<WireSubagentTranscriptResult>
  }

  /**
   * A screen-sized data URL for one attachment — the fullscreen viewer's tier,
   * where the thumbnail above would be a blur. Rendered per call rather than
   * cached on disk, so ask for it only when a viewer is actually opening.
   */
  async getAttachmentView(imageId: string): Promise<WireAttachmentViewResult> {
    return this.send({
      type: 'get-attachment-view',
      id: randomUUID(),
      imageId,
    }) as Promise<WireAttachmentViewResult>
  }

  /**
   * Asks the shell to open the attachment's cached original. `ok: false`
   * carries a reason (`file-missing` for an id this session never registered);
   * a rejection means this shell cannot open files at all.
   */
  async openAttachment(imageId: string): Promise<WireOpenAttachmentResult> {
    return this.send({ type: 'open-attachment', id: randomUUID(), imageId }) as Promise<WireOpenAttachmentResult>
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.teardown.splice(0)) off()
    this.failAllPending('The client was disposed.')
    this.backgroundTasks = EMPTY_TASKS
    this.panes = Object.freeze([])
    this.queuedMessages = EMPTY_QUEUE
    this.eventListeners.clear()
    this.effectListeners.clear()
    this.paneListeners.clear()
    this.queueListeners.clear()
    this.listeners.clear()
  }

  // --- plumbing ---------------------------------------------------------

  private async send(command: Exclude<HostCommand, { type: 'ui-response' }>): Promise<unknown> {
    if (this.disposed) throw new Error('The client was disposed.')
    const pending = this.replies.create(command.id)
    this.channel.post(command)
    const settled = await pending
    if (!settled.ok) throw new Error(settled.message)
    return settled.result
  }

  private handleMessage = (message: unknown): void => {
    const event = message as HostEvent
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return

    switch (event.type) {
      case 'session-event':
        // Before the listeners, not after: the first thing a listener does with a
        // `tool_use` record is ask for its caption.
        this.absorbToolDisplays(event.toolDisplays, event.event.type === 'transcript-reset')
        for (const listener of [...this.eventListeners]) listener(event.event)
        return
      case 'snapshot':
        this.subagentProgress = new Map(event.subagentProgress)
        this.applySnapshot(event.snapshot, event.cost)
        return
      case 'runtime-snapshot':
        this.runtimeSnapshot = event.snapshot
        this.notify()
        return
      case 'background-tasks':
        this.applyBackgroundTasks(event.tasks)
        return
      case 'session-changed':
        this.applySession(event.session)
        return
      case 'pane-list':
        this.applyPanes(event.panes)
        return
      case 'queued-messages':
        this.applyQueuedMessages(event.messages)
        return
      case 'command-effect':
        for (const listener of [...this.effectListeners]) listener(event.effect)
        return
      case 'ui-request':
        void this.answer(event.request)
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
   * `replace` for payloads that carry the session's whole record list, merge for
   * a single record. An absent map still replaces on a reset — that is a session
   * with no tool calls in it, not a host that said nothing.
   */
  private absorbToolDisplays(displays: ToolDisplays | undefined, replace: boolean): void {
    if (replace) {
      this.toolDisplays = { ...displays }
      return
    }
    if (displays) this.toolDisplays = { ...this.toolDisplays, ...displays }
  }

  /**
   * Swaps the snapshot only when a field actually differs, so `getSnapshot()`
   * keeps returning the same object while nothing has changed.
   *
   * `cost` participates in the same decision even though it lives outside the
   * snapshot object: it rides on this event, so treating it separately would
   * mean a second `notify()` per tick or a stale readout.
   */
  private applySnapshot(next: SessionControllerSnapshot, cost?: WireUsageCost): void {
    const previous = this.snapshot
    const usage = sameUsage(previous.usage, next.usage) ? previous.usage : next.usage
    const taskSnapshot = sameTaskSnapshot(previous.taskSnapshot, next.taskSnapshot)
      ? previous.taskSnapshot
      : next.taskSnapshot
    const costChanged = !sameCost(this.cost, cost)
    const contextChanged = previous.contextUsedTokens !== next.contextUsedTokens

    if (
      !costChanged
      && !contextChanged
      && previous.isStreaming === next.isStreaming
      && previous.spinnerSubText === next.spinnerSubText
      && previous.turnOutputTokens === next.turnOutputTokens
      && usage === previous.usage
      && taskSnapshot === previous.taskSnapshot
    ) return

    this.cost = cost
    this.snapshot = Object.freeze({
      isStreaming: next.isStreaming,
      usage,
      taskSnapshot,
      spinnerSubText: next.spinnerSubText,
      contextUsedTokens: next.contextUsedTokens,
      turnOutputTokens: next.turnOutputTokens,
    })
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Same identity discipline as the snapshot, and for the same reason: the
   * host re-sends the whole list on every change, so a fresh array would hand
   * `useSyncExternalStore` a new identity on every output chunk.
   */
  private applyBackgroundTasks(next: BackgroundTaskSnapshot[]): void {
    if (sameTaskList(this.backgroundTasks, next)) return
    this.backgroundTasks = next
    this.notify()
  }

  /**
   * Field-diffed like the rest. `updatedAt` and `messageCount` move on every
   * turn, so the host re-announcing the same session — which it does on any
   * switch, including one that landed back where it started — must not wake
   * every subscriber.
   */
  private applySession(next: SessionMeta): void {
    const previous = this.session
    if (
      previous
      && previous.id === next.id
      && previous.title === next.title
      && previous.messageCount === next.messageCount
      && previous.updatedAt === next.updatedAt
    ) return
    this.session = next
    this.notify()
  }

  /**
   * Pane topology is field-diffed by id-set comparison: a re-announcement of
   * the same pane ids in the same order does not swap the array, so a tab bar
   * built on this signal does not re-render on every event the host pushes.
   *
   * The internal array is frozen, so a consumer that destructures it sees a
   * stable object across calls — and so does `onPanesChanged`, who receives
   * the same reference until the topology actually changes.
   */
  private applyPanes(next: readonly WirePaneInfo[]): void {
    if (samePaneList(this.panes, next)) return
    this.panes = Object.freeze([...next])
    this.notify()
    for (const listener of [...this.paneListeners]) listener(this.panes)
  }

  /**
   * Same identity discipline as the pane list. The host re-announces the queue
   * on every mutation *and* on every session switch, so a fresh array each time
   * would repaint the strip while it says the same thing.
   */
  private applyQueuedMessages(next: readonly PersistedQueuedMessage[]): void {
    if (sameQueuedMessages(this.queuedMessages, next)) return
    this.queuedMessages = next.length === 0 ? EMPTY_QUEUE : Object.freeze([...next])
    this.notify()
    for (const listener of [...this.queueListeners]) listener(this.queuedMessages)
  }

  /**
   * Answers a host's blocking question, and *always* answers.
   *
   * The try/catch is load-bearing rather than defensive: `handleMessage` calls
   * this as `void this.answer(...)`, so a handler that throws would leave no
   * `ui-response` on the wire at all. Nothing else releases the host —
   * `PermissionGate.approve` has no timeout, and `ToolRunner.run` does not pass
   * its abort signal into it, so interrupting the turn will not free it either.
   * The agent loop would wait for the rest of the process's life.
   *
   * The fallback is the kind's own, so the asymmetry survives: deny a tool,
   * reject a question, but *approve* entering plan mode.
   */
  private async answer(request: Extract<HostEvent, { type: 'ui-request' }>['request']): Promise<void> {
    let response: UiResponse
    try {
      response = await this.resolveUiRequest(request)
    } catch {
      response = UI_REQUEST_FALLBACKS[request.kind]()
    }
    this.channel.post({ type: 'ui-response', requestId: request.requestId, response } satisfies HostCommand)
  }

  /**
   * With no handler installed the client answers the way the host would if it
   * had never been asked, so an unfinished UI degrades the same way a missing
   * one does rather than hanging the agent.
   */
  private async resolveUiRequest(
    request: Extract<HostEvent, { type: 'ui-request' }>['request'],
  ): Promise<UiResponse> {
    switch (request.kind) {
      case 'permission': {
        if (!this.handlers.permission) return { kind: 'permission', approved: false }
        const answer = await this.handlers.permission(request.payload)
        return { kind: 'permission', approved: answer.approved, ...(answer.alwaysAllow ? { alwaysAllow: true } : {}) }
      }
      case 'ask-user-question': {
        if (!this.handlers.askUserQuestion) {
          return {
            kind: 'ask-user-question',
            result: { kind: 'rejected', feedback: 'AskUserQuestion UI is not mounted.' },
          }
        }
        return { kind: 'ask-user-question', result: await this.handlers.askUserQuestion(request.payload) }
      }
      case 'enter-plan':
        return { kind: 'enter-plan', approved: this.handlers.enterPlan ? await this.handlers.enterPlan() : true }
      case 'exit-plan': {
        if (!this.handlers.exitPlan) return { kind: 'exit-plan', decision: { kind: 'reject', feedback: '' } }
        return { kind: 'exit-plan', decision: await this.handlers.exitPlan(request.payload) }
      }
    }
  }

  private handleClose = (): void => {
    this.failAllPending('The host disconnected.')
  }

  private failAllPending(message: string): void {
    this.replies.settleAll(() => ({ ok: false, message }))
  }
}

/**
 * Compared field by field rather than deeply: the fields that move are the
 * ones a task list renders, and `outputBytes`/`unreadBytes` change on every
 * chunk, which is exactly what the comparison needs to catch.
 */
function sameTaskList(
  a: readonly BackgroundTaskSnapshot[],
  b: readonly BackgroundTaskSnapshot[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((task, index) => {
    const other = b[index]
    if (!other) return false
    return task.id === other.id
      && task.status === other.status
      && task.outputBytes === other.outputBytes
      && task.unreadBytes === other.unreadBytes
      && task.finishedAt === other.finishedAt
  })
}

function sameUsage(a: SessionUsage, b: SessionUsage): boolean {
  return sameTokens(a.total, b.total) && sameTokens(a.lastRequest, b.lastRequest)
}

type TokenCounts = {
  inputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens: number
  outputTokens: number
}

function sameTokens(a: TokenCounts | null, b: TokenCounts | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.inputTokens === b.inputTokens
    && (a.cacheCreationInputTokens ?? 0) === (b.cacheCreationInputTokens ?? 0)
    && a.cacheReadInputTokens === b.cacheReadInputTokens
    && a.outputTokens === b.outputTokens
}

/**
 * Compared structurally rather than deeply: the snapshot is regenerated on the
 * host whenever a task changes, so a cheap shape+status check is enough to
 * decide whether the UI has anything new to show.
 */
function sameTaskSnapshot(a: TaskDisplaySnapshot | undefined, b: TaskDisplaySnapshot | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Two pane lists are the same when every pane id matches in the same order and
 * every title still matches. A re-announcement of the same topology — which the
 * host does on every open / close — must not wake the tab bar.
 *
 * The project fields count too: they decide which group a row is drawn under and
 * whether it gets a close button, so a list that only differs there is a list
 * the tab bar has to repaint.
 */
function samePaneList(a: readonly WirePaneInfo[], b: readonly WirePaneInfo[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.paneId !== right.paneId) return false
    if (left.sessionId !== right.sessionId) return false
    if (left.sessionTitle !== right.sessionTitle) return false
    if (left.projectRoot !== right.projectRoot) return false
    if (left.projectName !== right.projectName) return false
  }
  return true
}

/**
 * Order matters as much as membership — the queue *is* an order — so this is a
 * positional walk rather than a set comparison.
 *
 * Spelled out here rather than reusing `MessageQueue`'s own private comparison:
 * that module value-imports `node:crypto`, and this file is bundled for a
 * renderer.
 */
function sameQueuedMessages(
  a: readonly PersistedQueuedMessage[],
  b: readonly PersistedQueuedMessage[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.id !== right.id) return false
    if (left.content !== right.content) return false
    if (left.priority !== right.priority) return false
    if (left.createdAt !== right.createdAt) return false
  }
  return true
}

function sameCost(a: WireUsageCost | undefined, b: WireUsageCost | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.amount === b.amount && a.currency === b.currency
}
