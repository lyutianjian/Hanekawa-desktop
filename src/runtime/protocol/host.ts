import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CommandContext, CommandDefinition } from '../../commands/types.js'
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/effort.js'
import { saveEffortLevel } from '../../config/settings.js'
import { resolveImageCapability } from '../../config/providers.js'
import type { PermissionRequest } from '../../harness/permissions.js'
import type { RuntimeDiagnostic } from '../../harness/diagnostics.js'
import type { SessionRecord } from '../../harness/types.js'
import { getSubagentTranscriptPath, SidechainRecordStream } from '../../harness/sidechainRecordStream.js'
import { resolveUsageWithCost } from '../../harness/usage.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { ImageAttachmentRef } from '../../media/types.js'
import { describeImageBlockError } from '../../media/imageErrors.js'
import type {
  ImageAttachmentService,
  ImageStoreResult,
  StoredAttachment,
} from '../../services/imageAttachments/imageAttachmentService.js'
import { createQueueImageRebinder } from '../attachmentHandoff.js'
import { MessageQueue, type RebindQueuedImages } from '../messageQueue.js'
import { readGitBranch } from '../gitBranch.js'
import { listGitBranches, switchGitBranch } from '../gitBranches.js'
import { applyPermissionModeTransition } from '../permissionMode.js'
import { buildModelPickerOptions } from '../modelPicker.js'
import { refreshRuntimeSlot, resolveRuntimeModelKeyAfterConfigChange, type ProviderConfigChangeScope } from '../providerRuntime.js'
import { MISSING_MODEL_ISSUE } from '../errors.js'
import { canPumpQueue, canWakeForNotifications, handOffQueuedMessage, notificationInput } from '../queuePump.js'
import { projectDisplayName, projectRootKey } from '../projectDirectory.js'
import { isGlobalWorkspaceRoot } from '../../utils/paths.js'
import { SessionRecordLedger } from '../recordLedger.js'
import { buildRewindSummaryRewrite } from '../rewindSummary.js'
import { generateFileSuggestions } from '../suggestions/fileSuggestions.js'
import { getToolActivityDescription, getToolDisplay } from '../../tools/display.js'
import type { RuntimeSlot } from '../runtimeSlot.js'
import type { SessionController, SessionEvent } from '../sessionController.js'
import {
  switchToExistingSession,
  switchToNewSession,
  type SessionSwitchDeps,
  type SessionSwitchResult,
} from '../sessionSwitch.js'
import { buildStartupNotices, resolveInitialQueuedPrompt, type StartupNotice } from '../startupNotices.js'
import type { AgentSession, ProjectRuntime, SessionScope } from '../types.js'
import type { SessionPane } from '../sessionWorkspace.js'
import type { RuntimeChannel } from './channel.js'
import type { CoordinationLaneControl } from './coordinationHost.js'
import { sessionSwitchBlocked } from '../sessionRole.js'
import { createHostCommandContext } from './commandContext.js'
import { parseHostCommand, type HostCommandParseFailure } from './commandSchema.js'
import { PendingRequests } from './pendingRequests.js'
import { toPermissionDto } from './permissionDto.js'
import {
  UI_REQUEST_FALLBACKS,
  type CommandEffect,
  type HostCommand,
  type HostEvent,
  type UiRequest,
  type UiResponse,
  type WireBackgroundTasksResult,
  type WireBranchesResult,
  type WireCommandInfo,
  type WireCommandsResult,
  type WireClosePaneResult,
  type WireEffortResult,
  type WireEnqueueResult,
  type WireFileSuggestionsResult,
  type WireFocusPaneResult,
  type WireHelloResult,
  type WireImportAttachmentResult,
  type WireAttachmentPreviewResult,
  type WireAttachmentViewResult,
  type WireSubagentTranscriptResult,
  type WireOpenAttachmentResult,
  type WireListPanesResult,
  type WireModelInfo,
  type WireModelsResult,
  type WireOpenPaneResult,
  type WireOpenProjectResult,
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
  type ToolDisplays,
} from './wire.js'

function isEffortLevel(value: string): value is EffortLevel {
  return (VALID_EFFORT_LEVELS as readonly string[]).includes(value)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled host command: ${JSON.stringify(value)}`)
}

/**
 * Four fields, copied one at a time. A spread would put `run` and `isEnabled` on
 * the wire; see `WireCommandInfo`.
 */
function toWireCommandInfo(command: CommandDefinition): WireCommandInfo {
  const info: WireCommandInfo = { name: command.name, description: command.description }
  if (command.aliases !== undefined) info.aliases = [...command.aliases]
  if (command.argumentHint !== undefined) info.argumentHint = command.argumentHint
  return info
}

/**
 * Captions for whichever of `records` are `tool_use`, or `undefined` when none
 * are.
 *
 * Exported so every record-carrying exit can call the same function: an
 * inconsistency here shows up as a transcript whose captions appear on a live
 * turn and vanish on `/resume`. `undefined` rather than `{}` keeps the key off
 * the wire entirely for the common case, and gives a consumer one shape to test.
 */
export function projectToolDisplays(records: Iterable<SessionRecord>): ToolDisplays | undefined {
  let displays: ToolDisplays | undefined
  for (const record of records) {
    if (record.type !== 'tool_use') continue
    const { name, summary } = getToolDisplay(record.tool, record.input)
    const activity = getToolActivityDescription(record.tool, record.input)
    displays ??= {}
    displays[record.id] = {
      displayName: name,
      useSummary: summary,
      ...(activity ? { activityDescription: activity } : {}),
    }
  }
  return displays
}

/** The reply-side shorthand: same payload, plus the projection when it is non-empty. */
function withToolDisplays<T extends { records: readonly SessionRecord[] }>(
  payload: T,
): T & { toolDisplays?: ToolDisplays } {
  const toolDisplays = projectToolDisplays(payload.records)
  return toolDisplays ? { ...payload, toolDisplays } : payload
}

export interface SessionHostDeps {
  channel: RuntimeChannel
  controller: SessionController
  runtimeSlot: RuntimeSlot
  /**
   * Split rather than one `RuntimeHost` because `SessionHost` is the only
   * consumer that ever gets a second instance. Keeping the halves apart here is
   * what stops session-scoped state being reached for on the project — and
   * project state being duplicated per tab.
   */
  project: ProjectRuntime
  scope: SessionScope
  /**
   * The registry of open panes.
   *
   * A pane is identified by the session it is bound to (one pane per session),
   * so `close-pane` / `list-panes` use the session id as the pane id. The host
   * is the only consumer that ever needs to reach for the workspace, and the
   * surface it relies on is documented by the `PaneRegistry` interface below.
   */
  workspace: PaneRegistry
  /**
   * Called when an `open-pane` command resolves to a fresh `SessionPane` that
   * needs a window, channel and host wired up by the shell.
   *
   * Hosts do not create `BrowserWindow`s themselves — they have no handle on
   * the Electron module — so the shell owns that step. The host still
   * resolves the pane (so the wire reply is the same shape regardless of pane
   * owner) and registers it in the workspace, then hands the constructed
   * pane off to the callback for window creation.
   */
  onPaneOpened: (pane: SessionPane, sessionId: string | undefined) => void
  /**
   * Called when a `close-pane` resolves to a real teardown. The shell detaches
   * the window, but the host is the one that ran `pane.close()` (which is
   * fixed-order: `interrupt('exit')` → controller → slot → scope), so the host
   * drives the command and the shell catches the side effect.
   */
  onPaneClosed: (paneId: string) => void
  /**
   * Brings an arbitrary pane's window forward. Returns false when the shell has
   * no window for it.
   *
   * The three members below are optional, and not because a missing one is
   * harmless — a `focus-pane` without this rejects. They are optional because
   * `SessionHostDeps` has one construction site the compiler cannot see:
   * `test/protocolChildProcess.test.ts` builds the host inside a *string* script
   * written to a temp `.mjs`. A required member there fails at runtime only, and
   * that trap has already been sprung twice (3a, 3b). A shell that owns one
   * project needs none of them.
   */
  onFocusPane?: (paneId: string) => boolean
  /**
   * Asks the shell to open another project. With no path the shell puts up its
   * own directory picker; the host neither waits for it nor learns the outcome.
   */
  onOpenProject?: (path?: string) => void
  /**
   * Opens a registered attachment's cached original (an `open-attachment`
   * resolved to its on-disk path). The shell owns the OS surface —
   * `shell.openPath` on Electron — because this module is Electron-free by
   * rule. The path arrives host-resolved; the renderer never sees it.
   */
  onOpenAttachment?: (filePath: string) => void
  /**
   * The whole pane topology, when the shell knows more panes than this host's
   * project does.
   *
   * With several projects open the host is no longer the authority on the tab
   * list: it can only see its own `SessionWorkspace`. The shell projects from its
   * *windows*, which also makes "listed ⇒ focusable" true — a pane is registered
   * in its workspace before its window exists.
   */
  describePanes?: () => WirePaneInfo[]
  /**
   * Fired after this host has announced a new pane topology on its own channel.
   *
   * The shell's cue to fan the same list out to its other windows — the host can
   * only reach the renderer it is paired with. Every announcement goes through
   * here, including the one a `/clear` or `/resume` triggers: a pane's id *is*
   * its session id, so a switch changes the topology without opening or closing
   * anything.
   */
  onPaneListChanged?: () => void
}

/**
 * The slice of `SessionWorkspace` the host reaches for.
 *
 * Declared structurally here so this file does not have to know that the
 * registry is a class; it also documents, by type, exactly which surface area
 * the host relies on.
 */
export interface PaneRegistry {
  list(): readonly SessionPane[]
  paneForSession(sessionId: string): SessionPane | undefined
  open(session: SessionMeta): Promise<SessionPane>
  adopt(scope: SessionScope, options: { modelKey?: string }): SessionPane
  close(pane: SessionPane): void
}

/**
 * The host half of the protocol: everything that must stay in the process that
 * owns the filesystem, the provider and the tools.
 *
 * It forwards the controller's event stream and both snapshots outward, turns
 * the four blocking UI bridges into request/response round trips, and executes
 * commands coming back. A client is a renderer; it never sees a `Tool`, a
 * `ModelProvider`, an `AbortSignal` or an `AgentLoop`.
 *
 * The load-bearing responsibility is what happens when the client dies: every
 * UI request still outstanding is settled with its own fallback. Nothing else
 * unblocks them — `ToolRunner.run` does not pass its abort signal into
 * `PermissionGate.approve`, so cancelling a turn leaves a pending prompt
 * pending, and the agent loop waits forever.
 */
export class SessionHost implements CoordinationLaneControl {
  private readonly channel: RuntimeChannel
  private readonly controller: SessionController
  private readonly runtimeSlot: RuntimeSlot
  private readonly project: ProjectRuntime
  private readonly scope: SessionScope
  private readonly workspace: PaneRegistry
  private readonly onPaneOpened: (pane: SessionPane, sessionId: string | undefined) => void
  private readonly onPaneClosed: (paneId: string) => void
  private readonly onFocusPane: ((paneId: string) => boolean) | undefined
  private readonly onOpenProject: ((path?: string) => void) | undefined
  private readonly onOpenAttachment: ((filePath: string) => void) | undefined
  private readonly describePanes: (() => WirePaneInfo[]) | undefined
  private readonly onPaneListChanged: (() => void) | undefined

  private readonly pendingUi = new PendingRequests<UiResponse>()
  /** Request kind per outstanding id, so each settles with its own fallback. */
  private readonly pendingKinds = new Map<string, UiRequest['kind']>()
  /** Kept host-side so `onAlwaysAllow` survives the round trip. */
  private readonly livePermissionRequests = new Map<string, PermissionRequest>()
  private readonly ledger: SessionRecordLedger
  /**
   * Messages the user submitted while a turn was running.
   *
   * Host-side rather than shell-side, unlike the terminal's — where `App.tsx`
   * owns the instance — because it is persisted through `store.appendRecord` and
   * because the pump's gate reads two things only this process knows: whether a
   * turn is in flight, and whether a blocking UI request is outstanding. Letting
   * a renderer own it would mean an `append-record` command, i.e. handing the
   * less-trusted end of this protocol the whole `SessionRecord` union.
   */
  private readonly messages: MessageQueue
  /** A pump run has taken a message but not finished handing it off. See `canPumpQueue`. */
  private pumping = false
  /**
   * The queued message the runtime refused, and the runtime that refused it.
   *
   * Paired with the `AgentSession` rather than the model key so *any* runtime
   * swap releases the block — a model switch, but equally a settings edit that
   * turned image input on for the same model. `RuntimeSlot` mints a new session
   * object for both.
   */
  private queueBlock: { messageId: string; session: AgentSession | undefined } | undefined
  private pendingConfigScope: ProviderConfigChangeScope | undefined
  /** A wake turn's text, waiting for the pump to let it through. See `requestWake`. */
  private pendingWake: string | undefined
  private readonly stateListeners = new Set<() => void>()
  /** The last lane state announced, so listeners fire on change only. */
  private lastStateKey = ''
  private readonly teardown: Array<() => void> = []
  private session: SessionMeta
  private disposed = false
  private taskPostTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: SessionHostDeps) {
    this.channel = deps.channel
    this.controller = deps.controller
    this.runtimeSlot = deps.runtimeSlot
    this.project = deps.project
    this.scope = deps.scope
    this.workspace = deps.workspace
    this.onPaneOpened = deps.onPaneOpened
    this.onPaneClosed = deps.onPaneClosed
    this.onFocusPane = deps.onFocusPane
    this.onOpenProject = deps.onOpenProject
    this.onOpenAttachment = deps.onOpenAttachment
    this.describePanes = deps.describePanes
    this.onPaneListChanged = deps.onPaneListChanged
    this.session = deps.scope.session
    this.ledger = new SessionRecordLedger(deps.scope.existingRecords)
    // Same four arguments the terminal passes (`App.tsx`), so a session's queue
    // replays identically whichever shell reopens it — and refuses the same
    // inputs at the same point.
    this.messages = new MessageQueue(
      deps.scope.session.id,
      deps.scope.existingRecords,
      (sessionId, record) => this.project.store.appendRecord(sessionId, record),
      (input) => this.controller.assertInputAcceptable(input),
    )

    this.teardown.push(this.controller.onEvent(this.forwardSessionEvent))
    this.teardown.push(this.controller.subscribe(this.postSnapshot))
    this.teardown.push(this.runtimeSlot.subscribe(this.postRuntimeSnapshot))
    // Plan-mode tools change the mode through PermissionGate without ever
    // touching RuntimeSlot, so without this the client's mode goes stale.
    this.teardown.push(this.scope.permissionGate.onModeChange(this.postRuntimeSnapshot))
    this.teardown.push(this.project.backgroundTasks.subscribe(this.scheduleBackgroundTaskPost))
    this.teardown.push(this.messages.subscribe(this.postQueuedMessages))
    this.teardown.push(this.channel.onMessage(this.handleMessage))
    this.teardown.push(this.channel.onClose(this.handleClose))

    this.attachBridges()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.taskPostTimer !== undefined) {
      clearTimeout(this.taskPostTimer)
      this.taskPostTimer = undefined
    }
    for (const off of this.teardown.splice(0)) off()
    this.detachBridges()
    this.settleAllUiRequests()
    this.stateListeners.clear()
  }

  // --- outbound ---------------------------------------------------------

  private post(event: HostEvent): void {
    if (this.disposed) return
    this.channel.post(event)
  }

  private forwardSessionEvent = (event: SessionEvent): void => {
    if (event.type === 'record') {
      this.ledger.track(event.record)
    } else if (event.type === 'transcript-reset') {
      this.ledger.rebase(event.records)
    } else if (event.type === 'session-meta') {
      // The controller named a session from its first message. Both halves of
      // `refreshSessionMeta`'s announcement, minus the write back into the
      // controller — this came *from* it. `pane-list` is the load-bearing one:
      // `sessionTitle` is a `WirePaneInfo` field, so without it the shell's
      // lanes keep the title they were opened with, which is none.
      this.session = event.session
      this.post({ type: 'session-changed', session: event.session })
      this.broadcastPaneList()
    }
    this.postSessionEvent(event)
  }

  /**
   * The one exit for `session-event`, so the tool-display projection cannot be
   * forgotten on the path `applySessionSwitch` takes — it posts its own
   * `transcript-reset` rather than going through the controller.
   */
  private postSessionEvent(event: SessionEvent): void {
    const displays = event.type === 'record'
      ? projectToolDisplays([event.record])
      : event.type === 'transcript-reset'
        ? projectToolDisplays(event.records)
        : undefined
    this.post({ type: 'session-event', event, ...(displays ? { toolDisplays: displays } : {}) })
  }

  private postSnapshot = (): void => {
    if (this.pendingConfigScope && !this.controller.getSnapshot().isStreaming) {
      const scope = this.pendingConfigScope
      this.pendingConfigScope = undefined
      this.refreshAfterConfigChange({ rebuild: true, scope })
    }
    // Also the pump's main trigger: this fires when `streaming` flips back to
    // false, which is the moment a queued message becomes sendable.
    const cost = this.currentCost()
    this.post({
      type: 'snapshot',
      snapshot: this.controller.getSnapshot(),
      subagentProgress: [...this.controller.getSubagentProgress()],
      ...(cost ? { cost } : {}),
    })
    this.notifyStateChange()
    this.pumpQueue()
  }

  /**
   * Session cost, through the same projection `/cost` reads.
   *
   * Derived here because a renderer may not import `harness/` — the bargain
   * `PermissionRequestDto` already makes with its preview.
   */
  private currentCost(): WireUsageCost | undefined {
    const usage = resolveUsageWithCost(
      this.controller.getSnapshot().usage.total,
      this.runtimeSlot.current?.modelConfig.pricing,
    )
    if (usage.cost === undefined) return undefined
    return { amount: usage.cost, currency: usage.currency ?? 'USD' }
  }

  /**
   * Announces the queue, and takes it as a cue to try the pump.
   *
   * Wired here rather than at each mutation so every path that can grow the queue
   * is covered by one edge: `enqueue-message`, the `hydrate` after a rewind, and
   * the `migrateTo` a `/clear` runs. Re-entrancy is safe — a pump in progress
   * dequeues, which notifies, which lands back here, where `canPumpQueue`'s
   * `running` guard turns it away.
   */
  private postQueuedMessages = (): void => {
    this.post({ type: 'queued-messages', messages: [...this.messages.getSnapshot()] })
    this.pumpQueue()
  }

  private postRuntimeSnapshot = (): void => {
    this.post({ type: 'runtime-snapshot', snapshot: this.buildRuntimeSnapshot() })
    // The single edge for "the runtime changed", subscribed to the slot as well
    // as called directly: a message held because the old model could not take
    // its images gets its retry here, and nowhere else notices.
    this.pumpQueue()
  }

  /**
   * `BackgroundTaskRegistry.changed()` fires on every output chunk of every
   * running shell. Posting each one would drown the channel, so collapse to at
   * most one message per macrotask and read the snapshot at flush time.
   */
  private scheduleBackgroundTaskPost = (): void => {
    if (this.disposed || this.taskPostTimer !== undefined) return
    this.taskPostTimer = setTimeout(() => {
      this.taskPostTimer = undefined
      this.postBackgroundTasks()
      // A background agent's note for this idle session starts a turn. Here,
      // off the registry's own call stack, so the agent's completion lands first.
      this.pumpQueue()
    }, 0)
    this.taskPostTimer.unref?.()
  }

  private postBackgroundTasks(): void {
    this.post({
      type: 'background-tasks',
      tasks: [...this.project.backgroundTasks.getSnapshot(this.session.id)],
    })
  }

  /** Metadata only — the live `AgentSession` and the endpoint's apiKey stay here. */
  private buildRuntimeSnapshot(): WireRuntimeSnapshot {
    const session = this.runtimeSlot.current
    if (!session) {
      return {
        status: 'needs_configuration',
        configurationIssue: this.runtimeSlot.getSnapshot().configurationIssue ?? MISSING_MODEL_ISSUE,
        effort: this.runtimeSlot.getEffort(),
        permissionMode: this.scope.permissionGate.getMode(),
      }
    }
    // Both window numbers come off the loop rather than off `modelConfig`: the
    // loop folds in whichever model is *active*, so a fallback activation or a
    // plan-model switch is reflected here without a runtime rebuild.
    const budget = session.loop.getContextBudget()
    // Capability likewise: `getActiveModel().supportsImageInput` is read off the
    // model actually serving requests — it deliberately opts out of the loop's
    // plan-model *display* policy — not off whatever the session started on.
    const activeModel = session.loop.getActiveModel()
    return {
      status: 'ready',
      modelKey: session.modelKey,
      model: session.modelConfig.model,
      providerName: session.providerName,
      contextWindow: budget.contextWindow,
      usableContextWindow: budget.usableContextWindow,
      ...(session.modelConfig.supportedEfforts !== undefined
        ? { supportedEfforts: [...session.modelConfig.supportedEfforts] }
        : {}),
      ...(activeModel.supportsImageInput ? { supportsImageInput: true } : {}),
      effort: this.runtimeSlot.getEffort(),
      permissionMode: this.scope.permissionGate.getMode(),
    }
  }

  // --- the four blocking bridges ---------------------------------------

  private attachBridges(): void {
    const { bridges } = this.scope
    bridges.steer.setSource(this.messages)

    bridges.prompt.setPrompt(async (request) => {
      const requestId = randomUUID()
      this.livePermissionRequests.set(requestId, request)
      try {
        const response = await this.askUi({
          kind: 'permission',
          requestId,
          payload: toPermissionDto(request, { cwd: this.scope.workingDir }),
        })
        if (response.kind !== 'permission') return false
        // Must run before we resolve: PermissionGate reads the captured
        // "always allow" flag on the statement right after this await returns.
        if (response.alwaysAllow) request.onAlwaysAllow?.()
        return response.approved
      } finally {
        this.livePermissionRequests.delete(requestId)
      }
    })

    bridges.askUserQuestion.setOpen(async (payload) => {
      const response = await this.askUi({
        kind: 'ask-user-question',
        requestId: randomUUID(),
        payload,
      })
      return response.kind === 'ask-user-question'
        ? response.result
        : { kind: 'rejected', feedback: 'The UI disconnected before answering.' }
    })

    bridges.enterPlan.setOpen(async () => {
      const response = await this.askUi({ kind: 'enter-plan', requestId: randomUUID() })
      // Entering plan mode only restricts the agent, so a lost client approves.
      return response.kind === 'enter-plan' ? response.approved : true
    })

    bridges.exitPlan.setOpen(async (payload) => {
      const response = await this.askUi({
        kind: 'exit-plan',
        requestId: randomUUID(),
        payload,
      })
      return response.kind === 'exit-plan'
        ? response.decision
        : { kind: 'reject', feedback: '' }
    })
  }

  private detachBridges(): void {
    const { bridges } = this.scope
    bridges.steer.setSource(undefined)
    bridges.prompt.clearPrompt()
    bridges.askUserQuestion.setOpen(async () => ({
      kind: 'rejected',
      feedback: 'AskUserQuestion UI is not mounted.',
    }))
    bridges.enterPlan.setOpen(async () => true)
    bridges.exitPlan.setOpen(async () => ({ kind: 'reject', feedback: '' }))
  }

  private askUi(request: UiRequest): Promise<UiResponse> {
    if (this.disposed) return Promise.resolve(UI_REQUEST_FALLBACKS[request.kind]())
    const pending = this.pendingUi.create(request.requestId)
    this.pendingKinds.set(request.requestId, request.kind)
    this.notifyStateChange()
    this.post({ type: 'ui-request', request })
    return pending.finally(() => {
      this.pendingKinds.delete(request.requestId)
      this.notifyStateChange()
      // A dialog closing can unblock the pump; nothing else notices that.
      this.pumpQueue()
    })
  }

  // --- the message queue ------------------------------------------------

  /**
   * Sends the next queued message, if the gate lets it through.
   *
   * The policy is `canPumpQueue`, shared with the terminal so the domain rule —
   * one at a time, never during a turn — cannot fork. Only `uiBlocked` differs
   * between the shells, and this is where the desktop's answer lives: a pending
   * *blocking* request, not any open panel. The `/rewind` panel and the pickers
   * hold the user, not the agent loop, so they do not stop the queue.
   *
   * Fire-and-forget by design. Every trigger (an enqueue, a turn ending, a
   * dialog being answered) is a place that must not wait for a whole turn, so
   * the work is detached and the tail re-checks rather than looping: after an
   * await this is a fresh microtask, not recursion.
   *
   * Because it is detached, both `disposed` checks below are defence in depth
   * rather than load-bearing, and it is worth knowing which is which. What
   * actually stops a closed pane from pumping is `dispose()` draining
   * `this.teardown`, which unsubscribes the snapshot and queue listeners — remove
   * either check by mutation and the suite stays green, because nothing calls this
   * afterwards. They are kept for the same reason `post()` carries one: the cost
   * is a branch, and the failure they guard against is a real turn starting on a
   * host nobody is listening to, with the bridges already detached so every
   * permission prompt inside it auto-denies. The second one, after the await,
   * covers a race the suite cannot hit deterministically — `dequeue()` writes to
   * disk, and a `dispose()` landing inside that await is past the first check.
   * Losing the dequeued message when the window closes is the lesser evil, and
   * matches what a Ctrl+C mid-pump does in the terminal.
   */
  private pumpQueue(): void {
    if (this.disposed) return
    const state = {
      pending: this.messages.getSnapshot().length,
      running: this.pumping,
      turnActive: this.controller.getSnapshot().isStreaming,
      uiBlocked: this.pendingKinds.size > 0 || !this.runtimeSlot.current,
      headMessageId: this.messages.peek()?.id,
      ...(this.queueBlock && this.queueBlock.session === this.runtimeSlot.current
        ? { blockedMessageId: this.queueBlock.messageId }
        : {}),
    }
    const tasks = this.project.backgroundTasks
    // Queued messages go first (`canWakeForNotifications` needs an empty queue);
    // a coordinator wake goes before background notes and takes any that are
    // waiting, so the two never start back-to-back turns.
    if (this.pendingWake !== undefined && canWakeForNotifications(state, true)) {
      const notes = tasks.hasParentNotifications(this.session.id)
        ? tasks.consumeParentNotifications(this.session.id)
        : []
      const text = [this.pendingWake, ...notes].join('\n\n')
      this.pendingWake = undefined
      this.pumping = true
      void this.controller.submit({ text }, { origin: 'wake' })
        .catch((error: unknown) => this.postQueueNotice(`Failed to start a wake turn: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.pumping = false
          this.pumpQueue()
        })
      return
    }
    if (canWakeForNotifications(state, tasks.hasParentNotifications(this.session.id))) {
      this.pumping = true
      void this.controller.submit(notificationInput(tasks.consumeParentNotifications(this.session.id)))
        .catch((error: unknown) => this.postQueueNotice(`Failed to deliver a background notification: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.pumping = false
          this.pumpQueue()
        })
      return
    }
    if (!canPumpQueue(state)) return

    this.pumping = true
    void (async () => {
      try {
        const outcome = await handOffQueuedMessage({
          peek: () => this.messages.peek(),
          consume: (messageId) => this.messages.consume(messageId),
          deliver: (input, context) => {
            // The race the old comment called the lesser evil: `dispose()` can
            // land inside the disk write above. Peeking first means the message
            // is still queued here, so it survives the window closing instead
            // of being lost.
            if (this.disposed) throw new Error('the window closed before the message was sent')
            return this.controller.submit(input, context.origin ? { origin: context.origin } : undefined, context)
          },
        })
        if (outcome.kind === 'blocked') {
          // Held rather than retried (design §12.2, work item 7): the runtime
          // refused this message *before* taking it, so trying again with the
          // same model and the same attachments would only refuse again. The
          // block is keyed to the runtime, so switching models releases it, and
          // `canPumpQueue` releases it on its own once the head changes.
          this.queueBlock = { messageId: outcome.message.id, session: this.runtimeSlot.current }
          this.postQueueNotice(`Queued message paused: ${outcome.reason}`)
        } else if (outcome.kind === 'failed') {
          this.postQueueNotice(`Failed to send queued message: ${outcome.reason}`)
        }
      } catch (error) {
        // Synthesized rather than routed through the controller: the message
        // never became a turn, so there is no turn to attach a notice to. Same
        // shape `applySessionSwitch` posts for its startup notices.
        this.postQueueNotice(`Failed to send queued message: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.pumping = false
        // More may be waiting, and the turn that just ended already fired its
        // own `postSnapshot` while this flag was still set.
        this.pumpQueue()
      }
    })()
  }

  private postQueueNotice(content: string): void {
    this.post({ type: 'session-event', event: { type: 'notice', level: 'error', content } })
  }

  /**
   * Every kind gets its own fallback, so this cannot be one blanket
   * `settleAll`. The asymmetry is deliberate; see `UI_REQUEST_FALLBACKS`.
   */
  private settleAllUiRequests(): void {
    for (const [requestId, kind] of [...this.pendingKinds]) {
      this.pendingUi.settle(requestId, UI_REQUEST_FALLBACKS[kind]())
    }
    this.pendingKinds.clear()
  }

  private handleClose = (): void => {
    this.dispose()
  }

  // --- inbound ----------------------------------------------------------

  private handleMessage = (message: unknown): void => {
    const parsed = parseHostCommand(message)
    if (!parsed.ok) {
      this.rejectMalformed(parsed)
      return
    }

    const command = parsed.command
    if (command.type === 'ui-response') {
      this.pendingUi.settle(command.requestId, command.response)
      return
    }

    void this.runCommand(command)
  }

  /**
   * A malformed message must not simply vanish. Both halves of this protocol
   * park a promise waiting for an answer, so silence is the one outcome that
   * hangs something: a command's `send()` never settles until the channel dies,
   * and an unanswered permission prompt blocks the agent loop outright --
   * `ToolRunner.run` does not pass its abort signal into
   * `PermissionGate.approve`, so interrupting the turn will not release it
   * either.
   *
   * A message too broken to carry an id is still dropped, as before: there is
   * nowhere to send the answer.
   */
  private rejectMalformed(failure: HostCommandParseFailure): void {
    if (failure.requestId !== undefined) {
      const kind = this.pendingKinds.get(failure.requestId)
      // Its own fallback rather than a blanket denial: `UI_REQUEST_FALLBACKS`
      // is asymmetric on purpose, and a renderer that answers garbage is not
      // distinguishable from one that has gone away.
      if (kind) this.pendingUi.settle(failure.requestId, UI_REQUEST_FALLBACKS[kind]())
      return
    }
    if (failure.id !== undefined) {
      this.post({ type: 'fail', id: failure.id, message: failure.message })
    }
  }

  private async runCommand(command: Exclude<HostCommand, { type: 'ui-response' }>): Promise<void> {
    try {
      const result = await this.execute(command)
      this.post({ type: 'reply', id: command.id, result })
    } catch (error) {
      // An image block crosses as a string and nothing else, so the exit is
      // appended here (design §13, S24): the renderer shows a `fail`'s message
      // verbatim, and "this model cannot see images" without "switch model or
      // remove the image" leaves the user with a dead end. Every other failure
      // — HTTP, config, provider outage — keeps its own words untouched.
      this.post({
        type: 'fail',
        id: command.id,
        message: describeImageBlockError(error),
      })
    }
  }

  private async execute(command: Exclude<HostCommand, { type: 'ui-response' }>): Promise<unknown> {
    switch (command.type) {
      case 'hello': {
        const records = [...this.ledger.list()]
        const toolDisplays = projectToolDisplays(records)
        this.postSnapshot()
        this.postRuntimeSnapshot()
        this.postBackgroundTasks()
        this.postQueuedMessages()
        const queued = resolveInitialQueuedPrompt(this.scope.hasRecoverableInterruption)
        const gitBranch = await readGitBranch(this.project.cwd)
        return {
          sessionId: this.session.id,
          session: this.session,
          cwd: this.project.cwd,
          projectRoot: projectRootKey(this.project.cwd),
          projectName: projectDisplayName(this.project.cwd),
          projectIsGlobal: isGlobalWorkspaceRoot(this.project.cwd),
          ...(gitBranch ? { gitBranch } : {}),
          records,
          ...(toolDisplays ? { toolDisplays } : {}),
          notices: this.startupNotices(this.scope.diagnostics),
          hasRecoverableInterruption: this.scope.hasRecoverableInterruption,
          ...(queued ? { initialQueuedPrompt: queued } : {}),
          queuedMessages: [...this.messages.getSnapshot()],
          configuredEffortLevel: this.project.configuredEffortLevel,
        } satisfies WireHelloResult
      }

      case 'submit': {
        // Attachment ids resolve *here*: the host reads them out of the
        // current session's store, so what reaches the controller is a ref the
        // storage layer vouches for — never a path or a dimension the renderer
        // typed. An id that does not belong to this session rejects the submit
        // before any turn starts.
        const images = command.imageIds === undefined
          ? []
          : await this.resolveAttachmentRefs(command.imageIds)
        await this.controller.submit(
          images.length > 0 ? { text: command.input, images } : { text: command.input },
          this.resolveOverrides(command.overrides),
        )
        return null
      }

      case 'interrupt':
        this.controller.interrupt(command.reason)
        return null

      case 'reload': {
        const records = await this.controller.reload()
        this.ledger.rebase(records)
        return withToolDisplays({ records }) satisfies WireReloadResult
      }

      case 'retarget':
        this.assertSessionSwitchAllowed()
        return this.applySessionSwitch(await switchToExistingSession(
          // `reset`, not `migrateTo`: `/resume` goes *to* an existing session,
          // which has a queue of its own replayed from its own log. Carrying this
          // session's pending messages over would put them in a conversation the
          // user did not write them for.
          this.switchDeps((next, records) => this.messages.reset(next.id, records)),
          command.sessionId,
        ))

      case 'create-session':
        this.assertSessionSwitchAllowed()
        return this.applySessionSwitch(await switchToNewSession(
          // `migrateTo`, because `/clear` is the same conversation continuing in a
          // fresh log: anything queued but unsent still means what it meant, and
          // the compensating `clear` goes to the *old* session's log so a later
          // replay cannot resurrect it. Attached images are copied into the new
          // session first (design §12.3), so nothing carried over depends on a
          // session the user may delete next.
          this.switchDeps((next) => this.messages.migrateTo(next.id, [], this.queueImageRebinder())),
          {
            previousSessionId: this.session.id,
            ...(command.title ? { title: command.title } : {}),
          },
        ))

      case 'run-tool': {
        const result = await this.runtimeSlot.requireCurrent().loop.runTool({
          id: randomUUID(),
          name: command.name,
          input: command.input,
        })
        return {
          ok: result.ok,
          content: result.content,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        }
      }

      case 'run-command':
        return this.runSlashCommand(command.input)

      case 'list-commands':
        // Already filtered for `isHidden`/`isEnabled` by the registry.
        return { commands: this.project.commands.list().map(toWireCommandInfo) } satisfies WireCommandsResult

      case 'file-suggestions': {
        // Built field by field rather than forwarded: `createFileSuggestion` is
        // free to grow a field, and a spread would put it on the wire without
        // anyone deciding to. `metadata` is rebuilt for the same reason.
        const suggestions = await generateFileSuggestions(
          command.input,
          command.cursorPos,
          this.project.cwd,
        )
        return {
          suggestions: suggestions.map((suggestion) => ({
            id: suggestion.id,
            displayText: suggestion.displayText,
            ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
            metadata: {
              replacementText: suggestion.metadata.replacementText,
              path: suggestion.metadata.path,
              kind: suggestion.metadata.kind,
            },
          })),
        } satisfies WireFileSuggestionsResult
      }

      case 'list-branches': {
        const listing = await listGitBranches(this.project.cwd)
        return {
          branches: [...listing.branches],
          ...(listing.current ? { current: listing.current } : {}),
        } satisfies WireBranchesResult
      }

      case 'switch-branch': {
        const result = await switchGitBranch(this.project.cwd, command.branch)
        return {
          ok: result.ok,
          ...(result.current ? { current: result.current } : {}),
          ...(result.message ? { message: result.message } : {}),
        } satisfies WireSwitchBranchResult
      }

      case 'checkpoints':
        return { checkpoints: await this.controller.getFileHistoryService().getCheckpointsWithDiffs() }

      case 'restore-code':
        return this.controller.getFileHistoryService().rewindTo(command.messageId)

      case 'truncate-session': {
        const result = await this.project.store.truncateBeforeMessage(this.session.id, command.messageId)
        // Thrown rather than reported: a rewind that silently did nothing would
        // leave the caller showing a transcript the file no longer matches.
        if (!result.success) throw new Error(result.error ?? 'Failed to truncate session')
        return withToolDisplays({ records: await this.afterRewind() }) satisfies WireRewindResult
      }

      case 'summarize-rewind': {
        const loaded = await this.project.store.loadRecordsWithDiagnostics(this.session.id)
        const rewrite = await buildRewindSummaryRewrite({
          records: loaded.records,
          targetMessageId: command.messageId,
          decision: command.decision,
          // Goes through `AgentLoop.enqueue`, the same single in-flight slot as
          // `run()`. Sent mid-turn it waits for that turn to finish, so this
          // reply can be arbitrarily slow; nothing about it is a fast path.
          summarize: (records) => this.runtimeSlot.requireCurrent().loop.summarizeRecordsForRewind(records),
        })
        await this.project.store.replaceRecords(this.session.id, rewrite.nextRecords)
        return withToolDisplays({ records: await this.afterRewind() }) satisfies WireRewindResult
      }

      case 'set-model':
        return { modelKey: command.modelKey, effort: this.applyModel(command.modelKey) }

      case 'set-effort': {
        const applied = this.runtimeSlot.setEffort(command.level)
        let persisted = false
        if (command.persist && isEffortLevel(applied)) {
          try {
            await saveEffortLevel(applied)
            persisted = true
          } catch {
            // Non-critical, and the live slot already took the change.
          }
        }
        this.postRuntimeSnapshot()
        return { effort: applied, persisted } satisfies WireEffortResult
      }

      case 'set-permission-mode': {
        const applied = applyPermissionModeTransition(
          this.scope.permissionGate,
          this.runtimeSlot.current?.planModeManager,
          command.mode,
        )
        this.postRuntimeSnapshot()
        return { mode: applied }
      }

      case 'list-models':
        return this.buildModelsResult()

      case 'resolve-model': {
        const modelKey = this.project.config.resolveModelInput(command.input)
        return { ...(modelKey ? { modelKey } : {}) } satisfies WireResolveModelResult
      }

      case 'set-default-model': {
        this.project.config.setDefaultModel(command.reference)
        await this.project.config.save()
        return this.buildModelsResult()
      }

      case 'list-sessions':
        return { sessions: await this.project.store.list() } satisfies WireSessionsResult

      case 'reload-agents':
        return { count: await this.project.reloadAgentDefinitions() } satisfies WireReloadCountResult

      case 'reload-skills':
        return { count: await this.project.reloadSkills() } satisfies WireReloadCountResult

      case 'reload-settings': {
        const { needsRuntimeRebuild } = await this.project.reloadSettings()
        return {
          needsRuntimeRebuild,
          ...this.refreshAfterConfigChange({ rebuild: needsRuntimeRebuild || !this.runtimeSlot.current, scope: 'models' }),
        } satisfies WireReloadSettingsResult
      }

      case 'list-background-tasks':
        return {
          tasks: [...this.project.backgroundTasks.getSnapshot(this.session.id)],
        } satisfies WireBackgroundTasksResult

      case 'peek-task-output':
        return {
          output: this.project.backgroundTasks.peekOutput(
            this.session.id,
            command.taskId,
            command.maxBytes,
          ),
        } satisfies WireTaskOutputResult

      case 'kill-task': {
        const task = await this.project.backgroundTasks.killTask(
          this.session.id,
          command.taskId,
          command.reason,
        )
        return { ...(task ? { task } : {}) } satisfies WireTaskResult
      }

      case 'shutdown':
        await this.project.shutdown(command.reason)
        return { ok: true }

      case 'open-pane':
        return this.handleOpenPane(command)

      case 'close-pane':
        return this.handleClosePane(command)

      case 'list-panes':
        return this.handleListPanes() satisfies WireListPanesResult

      case 'focus-pane':
        return this.handleFocusPane(command) satisfies WireFocusPaneResult

      case 'open-project':
        return this.handleOpenProject(command) satisfies WireOpenProjectResult

      case 'enqueue-message': {
        // `MessageQueue` notifies its subscribers, and `postQueuedMessages` both
        // announces the new list and asks the pump — so an idle host has already
        // started sending this by the time the reply goes out.
        // Ids resolve through the same trusted lookup `submit` uses: what is
        // persisted on the queued message is a ref the store vouches for, never
        // a renderer-supplied path. An id this session does not own, or an
        // input the model cannot take, rejects the enqueue — the composer still
        // holds the draft at that point, which is the whole reason the check
        // happens on the accept path.
        const images = command.imageIds === undefined
          ? []
          : await this.resolveAttachmentRefs(command.imageIds)
        const message = await this.messages.enqueue(
          images.length > 0 ? { text: command.content, images } : { text: command.content },
          command.priority,
        )
        return { message } satisfies WireEnqueueResult
      }

      case 'clear-queue':
        await this.messages.clear()
        return { ok: true }

      case 'import-attachment': {
        const attachments = this.requireAttachments()
        let bytes: Buffer
        let name: string
        if (command.source.kind === 'bytes') {
          // A copy, so the stored original owns its bytes outright; the wire
          // buffer was already structured-cloned at the boundary.
          bytes = Buffer.from(command.source.bytes)
          name = command.source.name
        } else {
          // The host reads the file itself — a picker's answer or a drag that
          // resolved to a path. Nothing but the processed result crosses back.
          try {
            bytes = await readFile(command.source.path)
          } catch (error) {
            return {
              ok: false,
              reason: 'file-missing',
              message: `Reading ${command.source.path} failed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
          name = command.source.name ?? path.basename(command.source.path)
        }
        const stored = await attachments.importImage(this.session.id, bytes, name)
        return this.toAttachmentResult(stored)
      }

      case 'remove-attachment':
        // Idempotent by design: the draft list lives renderer-side, so a remove
        // arriving for an id nobody holds any more is still an answer. The
        // files themselves stay for the retention window — a message or queue
        // entry may still reference them.
        this.requireAttachments().release({ ownerSessionId: this.session.id, id: command.imageId })
        return { ok: true }

      case 'get-attachment-preview': {
        const preview = await this.requireAttachments().previewDataUrl(
          this.attachmentLookup(command.imageId),
        )
        if (!preview.ok) return { ok: false, reason: preview.reason, message: preview.message }
        return { ok: true, dataUrl: preview.value } satisfies WireAttachmentPreviewResult
      }

      case 'get-attachment-view': {
        const view = await this.requireAttachments().viewDataUrl(
          this.attachmentLookup(command.imageId),
        )
        if (!view.ok) return { ok: false, reason: view.reason, message: view.message }
        return { ok: true, dataUrl: view.value } satisfies WireAttachmentViewResult
      }

      case 'get-subagent-transcript': {
        const path = getSubagentTranscriptPath(this.project.cwd, this.session.id, command.agentId)
        return { ok: true, records: await new SidechainRecordStream(path).load() } satisfies WireSubagentTranscriptResult
      }

      case 'open-attachment': {
        const stored = await this.requireAttachments().resolveRef(this.attachmentLookup(command.imageId))
        if (!stored.ok) return { ok: false, reason: stored.reason, message: stored.message }
        // Same pattern as `open-project`: this module is Electron-free, so the
        // shell owns `shell.openPath`, and the open itself is fire-and-forget —
        // the reply says the shell took it, not that an image viewer appeared.
        if (!this.onOpenAttachment) throw new Error('This shell cannot open attachments')
        this.onOpenAttachment(stored.value.metadata.localPath)
        return { ok: true } satisfies WireOpenAttachmentResult
      }
    }

    // Not a `default` branch, and it must not become one. The switch above has
    // to stay exhaustive so a new HostCommand variant is a compile error rather
    // than a silent reply; this line is what makes that true, because the
    // declared return type `Promise<unknown>` already admits the `undefined`
    // that falling out of the switch produces. Unreachable at runtime --
    // `parseHostCommand` rejects anything outside the union -- and if it ever
    // is reached, `runCommand`'s catch turns it into a `fail`.
    return assertNever(command)
  }

  /**
   * `useCommands.dispatch`, minus React.
   *
   * The tolerance is copied deliberately: an unknown command and a command that
   * threw both come back as `handled` with a `write-line` explaining why, because
   * that is what the TUI does and a slash command failing is not a protocol
   * failure. Only input that is not a slash command at all is unhandled.
   */
  private async runSlashCommand(input: string): Promise<WireRunCommandResult> {
    if (!input.startsWith('/')) return { handled: false }

    const spaceIndex = input.indexOf(' ')
    const name = spaceIndex >= 0 ? input.slice(1, spaceIndex) : input.slice(1)
    const args = spaceIndex >= 0 ? input.slice(spaceIndex + 1).trim() : ''

    // The shell owns its own teardown; it calls `shutdown` when it is ready.
    if (name === 'exit') return { handled: true, exit: true }

    const command = this.project.commands.get(name)
    if (command && (command.name === 'clear' || command.name === 'resume') && sessionSwitchBlocked(this.scope.role)) {
      this.emitCommandEffect({
        kind: 'write-line',
        text: `/${command.name} is not available in a ${this.scope.role} session.`,
      })
      return { handled: true }
    }
    if (!command) {
      this.emitCommandEffect({
        kind: 'write-line',
        text: `Unknown command: /${name}. Type /help for available commands.`,
      })
      return { handled: true }
    }

    try {
      await command.run(args, this.commandContext())
    } catch (error) {
      this.emitCommandEffect({
        kind: 'write-line',
        text: `Command error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return { handled: true }
  }

  private assertSessionSwitchAllowed(): void {
    if (sessionSwitchBlocked(this.scope.role)) {
      throw new Error(`A ${this.scope.role} session cannot switch to another session`)
    }
  }

  /** The `set-model` body, shared with `CoordinationLaneControl.setModel`. Returns the effort reapplied. */
  private applyModel(modelKey: string): string {
    const next = this.scope.createRuntime(modelKey, this.session, this.ledger.list())
    // Clearing before the swap: the cached Environment section embeds the
    // model name, so a stale prefix would survive into the next request.
    this.runtimeSlot.current?.loop.clearCachedSections()
    this.runtimeSlot.replace(next)
    const effort = this.runtimeSlot.reapplyEffort()
    this.postRuntimeSnapshot()
    return effort
  }

  // --- CoordinationLaneControl ------------------------------------------

  async enqueueFromCoordinator(text: string): Promise<void> {
    // The queue subscription announces it and asks the pump; an idle lane sends it now.
    await this.messages.enqueue({ text }, 'next', { origin: 'coordinator' })
  }

  /** Not gated on `hello`: a lane opened without a window still wakes. */
  requestWake(text: string): void {
    this.pendingWake = this.pendingWake === undefined ? text : `${this.pendingWake}\n\n${text}`
    this.pumpQueue()
  }

  /**
   * "Stop generation": drops what was queued before the stop, then interrupts.
   * Discarding first, or the pump would resend them at `turn-end`.
   */
  async stop(): Promise<void> {
    const ids = this.messages.getSnapshot().map((message) => message.id)
    this.pendingWake = undefined
    await this.messages.discard(ids)
    this.controller.interrupt('coordinator-stop')
  }

  setModel(key: string): void {
    this.applyModel(key)
  }

  setEffort(level: EffortLevel): void {
    this.runtimeSlot.setEffort(level)
  }

  state(): { streaming: boolean; pendingApproval: boolean; pendingDialog: boolean } {
    let pendingApproval = false
    let pendingDialog = false
    for (const kind of this.pendingKinds.values()) {
      if (kind === 'permission') pendingApproval = true
      else pendingDialog = true
    }
    return { streaming: this.controller.getSnapshot().isStreaming, pendingApproval, pendingDialog }
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  private notifyStateChange(): void {
    const { streaming, pendingApproval, pendingDialog } = this.state()
    const key = `${streaming}|${pendingApproval}|${pendingDialog}`
    if (key === this.lastStateKey) return
    this.lastStateKey = key
    for (const listener of [...this.stateListeners]) listener()
  }

  private emitCommandEffect = (effect: CommandEffect): void => {
    this.post({ type: 'command-effect', effect })
  }

  /**
   * Rebuilt per command rather than cached: `getSession` and `getRecords` close
   * over `this`, so a command that switches sessions mid-run still reads the new
   * one back.
   */
  private commandContext(): CommandContext {
    return createHostCommandContext({
      project: this.project,
      scope: this.scope,
      runtimeSlot: this.runtimeSlot,
      controller: this.controller,
      getSession: () => this.session,
      getRecords: () => this.ledger.list(),
      startNewSession: async () => {
        // Same `migrateTo` as the `create-session` command: `/clear` arrives
        // through here, and a queue left keyed to the old session would pump into
        // the new one.
        this.applySessionSwitch(await switchToNewSession(
          this.switchDeps((next) => this.messages.migrateTo(next.id, [], this.queueImageRebinder())),
          { previousSessionId: this.session.id },
        ))
      },
      emit: this.emitCommandEffect,
    })
  }

  /**
   * The tail both rewind commands share once the file on disk has changed.
   *
   * `invalidateRecordsCache` first, or the loop keeps serving the pre-rewind
   * records it already read. `reload()` re-reads and emits the
   * `transcript-reset` that repaints the view, and the ledger has to be rebased
   * off the same list -- a stale ledger would fold the discarded records back
   * into the next runtime `set-model` or `reload-settings` builds.
   */
  private async afterRewind(): Promise<SessionRecord[]> {
    this.runtimeSlot.current?.loop.invalidateRecordsCache()
    const records = await this.controller.reload()
    this.ledger.rebase(records)
    // The rewind may have cut away the `message_queue` records the live queue was
    // built from, so it is replayed off the new list rather than trusted.
    await this.messages.hydrate(records)
    return records
  }

  private switchDeps(
    beforeApply?: (session: SessionMeta, records: readonly SessionRecord[]) => Promise<void>,
  ): SessionSwitchDeps {
    return {
      // One field from each half rather than the merged host: switching a
      // session needs the project's store and *this* scope's runtime factory.
      host: { store: this.project.store, createRuntime: this.scope.createRuntime },
      runtimeSlot: this.runtimeSlot,
      controller: this.controller,
      backgroundTasks: this.project.backgroundTasks,
      // Rebinding the message queue has to happen here rather than after the
      // switch returns: past `RuntimeSlot.replace` there is an await boundary on
      // which a queue still keyed to the old session could pump into the new one.
      ...(beforeApply ? { beforeApply } : {}),
    }
  }

  private applySessionSwitch(result: SessionSwitchResult): WireSessionSwitchResult {
    this.session = result.session
    this.ledger.rebase(result.records)
    const notices = this.startupNotices(result.diagnostics)
    // Pushed rather than left to the reply: a `/clear` arriving as a
    // `run-command` switches the session too, and only the host knows the draft
    // id it just minted.
    this.post({ type: 'session-changed', session: result.session })
    // The event stream stays the single source of transcript truth; the reply
    // carries the same records only for convenience.
    this.postSessionEvent({
      type: 'transcript-reset',
      records: result.records,
      systemMessages: notices.map((notice) => notice.content),
      bumpGeneration: true,
    })
    this.postBackgroundTasks()
    this.postRuntimeSnapshot()
    // Unconditional rather than left to `MessageQueue`'s own subscription: a
    // switch between two empty queues changes nothing it would notify about, and
    // the client still needs to hear that the list it is showing now belongs to a
    // different session.
    this.postQueuedMessages()
    // A pane *is* its session id (`WirePaneInfo.paneId`), so a switch is a
    // topology change even though no pane opened or closed. Without this every
    // tab bar keeps the pre-switch id: the row still draws, but closing it fails
    // with "Pane not found" and focusing it has to self-heal through a re-list.
    this.broadcastPaneList()
    return withToolDisplays({
      session: result.session,
      records: result.records,
      notices,
    }) satisfies WireSessionSwitchResult
  }

  /**
   * Diagnostics folded together with the project's MCP status.
   *
   * Kept here rather than inside `switchToExistingSession`: only a host has the
   * MCP status, and a terminal shell shows the diagnostics without it.
   */
  private startupNotices(diagnostics: RuntimeDiagnostic[]): StartupNotice[] {
    return buildStartupNotices({ diagnostics, mcp: this.project.mcp })
  }

  private buildModelsResult(): WireModelsResult {
    const configured = this.project.config.get().models
    const models: WireModelInfo[] = Object.keys(configured).map((key) => {
      // Field by field, never a spread: resolveModel folds the endpoint's
      // apiKey and baseUrl into what it returns.
      const resolved = this.project.config.getModel(key)
      const info: WireModelInfo = { key }
      if (resolved?.model !== undefined) info.model = resolved.model
      if (resolved?.provider !== undefined) info.provider = resolved.provider
      if (resolved?.contextWindow !== undefined) info.contextWindow = resolved.contextWindow
      if (resolved?.supportedEfforts !== undefined) info.supportedEfforts = [...resolved.supportedEfforts]
      if (resolveImageCapability(resolved)) info.supportsImageInput = true
      return info
    })
    const defaultModelKey = this.project.config.resolveModelReference(this.project.config.get().defaultModel)
    const pickerOptions = buildModelPickerOptions(
      this.project.config,
      this.runtimeSlot.current?.modelKey,
      Object.keys(configured),
    )
    return { models, pickerOptions, ...(defaultModelKey ? { defaultModelKey } : {}) }
  }

  /** Turns wire overrides back into the live objects the loop expects. */
  private resolveOverrides(overrides: WireRunOverrides | undefined) {
    if (!overrides) return undefined
    const { modelKey, ...rest } = overrides
    return {
      ...rest,
      ...(modelKey ? { model: this.project.createActiveModelRuntime(modelKey) } : {}),
    }
  }

  // --- image attachments ---------------------------------------------------

  /**
   * The project's attachment store. Guarded rather than assumed: the suite's
   * cast fixtures build `ProjectRuntime` fakes that predate this member, and a
   * host without a store answers attachment commands with a `fail` rather than
   * a TypeError the client cannot read.
   */
  private requireAttachments(): ImageAttachmentService {
    const attachments = this.project.attachments
    if (!attachments) throw new Error('This host has no image attachment store.')
    return attachments
  }

  /**
   * Every attachment command addresses the store through the *current*
   * session's id, which is the whole of the ownership check: an id registered
   * under any other session simply does not resolve, and no renderer-supplied
   * path is ever consulted.
   */
  private attachmentLookup(imageId: string): { ownerSessionId: string; id: string } {
    return { ownerSessionId: this.session.id, id: imageId }
  }

  /**
   * The `/clear` attachment hand-off, or nothing when this host has no store
   * (the same fixtures `requireAttachments` guards against). A queue with no
   * images migrates identically either way.
   */
  private queueImageRebinder(): RebindQueuedImages | undefined {
    const attachments = this.project.attachments
    return attachments ? createQueueImageRebinder(attachments) : undefined
  }

  /**
   * Turns submit's attachment ids into the refs the controller speaks. Thrown
   * rather than returned: a submit that cannot reference its images must not
   * become a turn, and the client's promise rejecting is the shape S11 builds
   * its "remove this image / switch model" affordances on.
   */
  private async resolveAttachmentRefs(imageIds: readonly string[]): Promise<ImageAttachmentRef[]> {
    const attachments = this.requireAttachments()
    const seen = new Set<string>()
    const refs: ImageAttachmentRef[] = []
    for (const imageId of imageIds) {
      if (seen.has(imageId)) continue
      seen.add(imageId)
      const stored = await attachments.resolveRef(this.attachmentLookup(imageId))
      if (!stored.ok) throw new Error(`Attachment ${imageId} is not available: ${stored.message}`)
      refs.push(stored.value.ref)
    }
    return refs
  }

  /** The reply half an `import-attachment` shares with nothing else (yet). */
  private toAttachmentResult(stored: ImageStoreResult<StoredAttachment>): WireImportAttachmentResult {
    if (!stored.ok) return { ok: false, reason: stored.reason, message: stored.message }
    return { ok: true, attachment: { ref: stored.value.ref, animated: stored.value.animated } }
  }

  /** Exposed for hosts that need the ledger (model switches fold it into task state). */
  getRecords(): readonly SessionRecord[] {
    return this.ledger.list()
  }

  // --- pane (multi-tab) handlers ----------------------------------------

  /**
   * Resolves the requested pane and asks the shell to open a window for it.
   *
   * The split is the same as everywhere else in this file: the host owns
   * runtime and persistence, the shell owns the `BrowserWindow`. The host
   * resolves the pane and registers it in the workspace **before** handing
   * off, so the shell sees a pane by the time it iterates `workspace.list()`
   * (notably during its own initial setup).
   *
   * `paneId` is the session id: a pane is identified by the session it is
   * bound to (one pane per session), and a renderer's `close-pane` carries
   * the same value the renderer sees in `WirePaneInfo.paneId`.
   */
  private async handleOpenPane(
    command: Extract<HostCommand, { type: 'open-pane' }>,
  ): Promise<WireOpenPaneResult> {
    let pane: SessionPane
    if (command.sessionId) {
      // `paneForSession` is the one-pane-per-session invariant: returning the
      // existing pane is the whole point, since two panes on one session id
      // means two `AgentLoop`s appending to one JSONL.
      const existing = this.workspace.paneForSession(command.sessionId)
      if (existing) {
        pane = existing
      } else {
        const session = await this.project.store.resolve(command.sessionId)
        if (!session) throw new Error(`Session not found: ${command.sessionId}`)
        pane = await this.workspace.open(session)
      }
    } else {
      const scope = await this.project.openScope(this.project.store.createDraft(command.title))
      pane = this.workspace.adopt(scope, {})
    }

    const session = pane.getSession()
    const records = await this.project.store.loadRecordsWithDiagnostics(session.id)

    // The callback is what wires the new pane's `BrowserWindow` and builds
    // its `SessionHost`. We post the topology update **after** the shell has
    // finished construction so the listing is never ahead of reality.
    this.onPaneOpened(pane, command.sessionId)
    this.broadcastPaneList()

    return withToolDisplays({
      paneId: session.id,
      session,
      records: records.records,
      notices: this.startupNotices(records.diagnostics),
    }) satisfies WireOpenPaneResult
  }

  /**
   * Looks the pane up by id, then runs the fixed teardown order. The shell
   * detaches the window in response to the callback — the host does not
   * touch `BrowserWindow`s.
   *
   * Throwing on an unknown pane keeps the symmetry with `retarget`: a
   * renderer that has gone stale is better off getting a fail than a silent
   * no-op.
   */
  private handleClosePane(command: Extract<HostCommand, { type: 'close-pane' }>): WireClosePaneResult {
    const pane = this.workspace.list().find((candidate) => candidate.getSession().id === command.paneId)
    if (!pane) throw new Error(`Pane not found: ${command.paneId}`)
    this.workspace.close(pane)
    this.onPaneClosed(command.paneId)
    this.broadcastPaneList()
    return { ok: true }
  }

  /** Pane topology snapshot. The shape mirrors the `pane-list` event intentionally. */
  private handleListPanes(): WireListPanesResult {
    return { panes: this.collectPanes() }
  }

  /**
   * Pure hand-off: no workspace lookup, no session resolution.
   *
   * A host cannot answer this on its own — with several projects open, the pane
   * asked for may live in a workspace this host has never seen. Throwing when the
   * shell has no callback is deliberate (the client's promise rejects and the
   * renderer can say so); answering `{ ok: true }` would look like a focus that
   * silently did nothing.
   */
  private handleFocusPane(
    command: Extract<HostCommand, { type: 'focus-pane' }>,
  ): WireFocusPaneResult {
    if (!this.onFocusPane) throw new Error('This shell cannot focus panes')
    return { ok: this.onFocusPane(command.paneId) }
  }

  /**
   * Also a pure hand-off, and asynchronous on the shell's side: the reply says
   * the shell accepted the request, not that a project is open. Bootstrapping a
   * project takes MCP connections and a store, and the user may still have a
   * directory dialog in front of them.
   */
  private handleOpenProject(
    command: Extract<HostCommand, { type: 'open-project' }>,
  ): WireOpenProjectResult {
    if (!this.onOpenProject) throw new Error('This shell cannot open projects')
    this.onOpenProject(command.path)
    return { ok: true }
  }

  /**
   * Rebuilds this session's runtime after its *project's* config changed.
   *
   * Public because two callers need it: the `reload-settings` command, and the
   * desktop shell fanning a settings edit out over every lane of one project
   * (`LaneOccupant.refreshAfterConfigChange`). The reload itself is deliberately
   * *not* in here — it is a project-level call, and doing it per lane would
   * re-read and re-validate the settings files once per open session.
   *
   * `rebuild` is the caller's decision rather than something read off
   * `reloadSettings()`. That call's `needsRuntimeRebuild` is only
   * `hooksChanged`, so a provider or routing edit reports `false`; a settings
   * screen trusting it would persist the change and keep running the old
   * runtime until the next launch.
   *
   * The order inside is the usual one: clear the cached sections first
   * (`# Environment` embeds the model name), then install the new runtime
   * before disposing the old, then re-apply the effort the slot owns.
   */
  refreshAfterConfigChange(options: {
    rebuild: boolean
    scope: ProviderConfigChangeScope
  }): { rebuilt: boolean; modelKey: string | undefined } {
    const currentKey = this.runtimeSlot.current?.modelKey
    if (!options.rebuild) return { rebuilt: false, modelKey: currentKey }
    if (this.controller.getSnapshot().isStreaming) {
      // A routing change must still take precedence if another edit follows it
      // during the same turn. Other edits retain the lane's selected model.
      if (this.pendingConfigScope !== 'routing') this.pendingConfigScope = options.scope
      return { rebuilt: false, modelKey: currentKey }
    }
    // Rebuilt here rather than asked of the client: that hooks are captured
    // at runtime-construction time is host trivia a renderer should not know.
    const nextKey = resolveRuntimeModelKeyAfterConfigChange(this.project.config, currentKey, options.scope)
    refreshRuntimeSlot({
      config: this.project.config,
      runtimeSlot: this.runtimeSlot,
      createRuntime: this.scope.createRuntime,
      modelKey: nextKey,
      session: this.session,
      records: this.ledger.list(),
    })
    this.postRuntimeSnapshot()
    return { rebuilt: true, modelKey: this.runtimeSlot.current?.modelKey }
  }

  /**
   * The model key this lane is running on **right now**, or `undefined` when it
   * is idle.
   *
   * The one thing that still blocks deleting a model: config references repair
   * themselves (`ConfigService.removeModel`), but a turn already in flight holds
   * a provider built from that model and would fail mid-stream. Read off the two
   * places that already own the facts — the slot's key and the controller's
   * snapshot — rather than tracking a third copy that can drift.
   */
  activeModelKey(): string | undefined {
    return this.controller.getSnapshot().isStreaming ? this.runtimeSlot.current?.modelKey : undefined
  }

  /**
   * The session's meta moved without the session moving — today, a rename from
   * the shell's sidebar.
   *
   * Deliberately not `retarget`: that is the session-*switch* path, and it
   * interrupts the turn, resets usage and rebuilds the checkpoint service. For a
   * title, the controller only needs its copy refreshed and the renderer told.
   * `broadcastPaneList` because `sessionTitle` is a `WirePaneInfo` field.
   */
  refreshSessionMeta(session: SessionMeta): void {
    this.session = session
    this.controller.refreshSessionMeta(session)
    this.post({ type: 'session-changed', session })
    this.broadcastPaneList()
  }

  /**
   * Pushes the current pane topology to every connected renderer.
   *
   * Only this host's channel is reachable here, so a true multi-pane broadcast
   * is the shell's job: `onPaneListChanged` is the hook it hangs its fan-out on,
   * and it fires for *every* announcement — a pane opening, a pane closing, and a
   * session switch that moves a pane's id under it.
   */
  private broadcastPaneList(): void {
    this.post({ type: 'pane-list', panes: this.collectPanes() })
    this.onPaneListChanged?.()
  }

  /**
   * Field-by-field projection. Never spread `SessionPane` — see `WirePaneInfo`.
   *
   * The shell's `describePanes` wins when it exists: with more than one project
   * open, this host's workspace is a *subset* of the tabs the user sees, and a
   * partial list posted over a full one makes tabs blink out of existence. The
   * own-project projection below stays as the single-project answer, which is
   * what the terminal shell and every fake registry in the tests use.
   */
  private collectPanes(): WirePaneInfo[] {
    const described = this.describePanes?.()
    if (described) return described
    const projectName = projectDisplayName(this.project.cwd)
    return this.workspace.list().map((pane) => {
      const session = pane.getSession()
      const info: WirePaneInfo = {
        paneId: session.id,
        sessionId: session.id,
        projectRoot: projectRootKey(this.project.cwd),
        projectName,
      }
      if (session.title !== undefined) info.sessionTitle = session.title
      return info
    })
  }
}
