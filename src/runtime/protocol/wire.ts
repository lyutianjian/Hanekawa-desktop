import type { EffortLevel } from '../../config/effort.js'
import type { CommandView } from '../../commands/types.js'
import type { DestructiveCommandWarning } from '../../harness/destructiveCommands.js'
import type {
  PermissionDecisionSource,
  PermissionMode,
  PermissionRule,
} from '../../harness/permissions.js'
import type { RiskLevel, SessionRecord } from '../../harness/types.js'
import type { MessageQueuePriority, PersistedQueuedMessage } from '../../harness/types.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { ImageAttachmentRef } from '../../media/types.js'
import type { ImageStoreErrorReason } from '../../services/imageAttachments/imageAttachmentService.js'
import type { BackgroundTaskSnapshot } from '../../services/backgroundTasks/registry.js'
import type { ModelPickerOption } from '../modelPicker.js'
import type { RewindSummaryDecision } from '../rewindSummary.js'
import type { ContextBreakdown } from '../../harness/contextBreakdown.js'
import type { CheckpointWithDiff } from '../../services/fileHistory/types.js'
import type { FileToolPreview } from '../../services/fileToolPreview.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { FileSuggestion } from '../suggestions/atToken.js'
import type { SessionControllerSnapshot, SessionEvent } from '../sessionController.js'
import type { StartupNotice } from '../startupNotices.js'
import type { RuntimeConfigurationIssue } from '../errors.js'

/**
 * The wire format between a runtime host and whatever renders it.
 *
 * Every payload here is structured-clone-safe. `SessionEvent` and
 * `SessionControllerSnapshot` already are and travel verbatim; the three types
 * below exist because their in-process counterparts are not:
 *
 * - `AgentRunOverrides.model` holds a live `ModelProvider`
 * - `RuntimeSlotSnapshot.session` holds the `AgentLoop` and the provider
 * - `PermissionRequest.tool` holds a zod schema and `execute`, and its
 *   `onAlwaysAllow` is a callback
 *
 * Anything added here must survive `structuredClone`. `test/protocolWire.test.ts`
 * enforces that for the event side.
 */

// --- host → client ----------------------------------------------------------

export type HostEvent =
  /**
   * The controller's ordered stream, forwarded untouched.
   *
   * `toolDisplays` rides beside the event rather than inside it, because
   * `SessionEvent` is the controller's own type and this is a host-side
   * projection; see `ToolDisplayDto`. Present only on the two variants that
   * carry records (`record`, `transcript-reset`) and only when at least one of
   * them is a `tool_use`.
   */
  | { type: 'session-event'; event: SessionEvent; toolDisplays?: ToolDisplays }
  /**
   * Pull state. `subagentProgress` rides along because the controller exposes
   * it as a live `Map` that a `Map` cannot cross the boundary as.
   *
   * The session cost rides inside `snapshot.usage.total`: each request is priced
   * as it lands (`priceUsage`), so there is nothing left for the host to derive.
   */
  | {
      type: 'snapshot'
      snapshot: SessionControllerSnapshot
      subagentProgress: Array<[string, string]>
    }
  | { type: 'runtime-snapshot'; snapshot: WireRuntimeSnapshot }
  /**
   * Push, because the registry is a `useSyncExternalStore` source. The host
   * coalesces these: `changed()` fires on every output chunk of every running
   * shell, which would otherwise be an IPC firehose.
   */
  | { type: 'background-tasks'; tasks: BackgroundTaskSnapshot[] }
  /**
   * The session the host is now bound to.
   *
   * Push rather than a reply field, because a switch is not always the client's
   * own doing: `/clear` arrives as a `run-command`, and only the host knows the
   * draft id it just minted. A client that missed this would keep its message
   * queue and history keyed to the session it left.
   */
  | { type: 'session-changed'; session: SessionMeta }
  /**
   * A renderer-side side effect a slash command asked for mid-run.
   *
   * These cannot be reply fields: a command pushes them while it is still
   * executing, and several commands push more than one. They arrive on this
   * channel in order and always before the `reply` for the `run-command` that
   * produced them.
   */
  | { type: 'command-effect'; effect: CommandEffect }
  /** A blocking question for the UI. The client must eventually answer it. */
  | { type: 'ui-request'; request: UiRequest }
  | { type: 'pane-list'; panes: WirePaneInfo[] }
  /**
   * The messages waiting behind the running turn.
   *
   * Pushed rather than polled, and for a reason the client cannot see: the host
   * owns both the queue and the pump, so the list moves on events a renderer
   * never sent — a turn ending, a permission prompt being answered, a `/clear`
   * migrating the queue to a new session.
   */
  | { type: 'queued-messages'; messages: PersistedQueuedMessage[] }
  | { type: 'reply'; id: string; result: unknown }
  | { type: 'fail'; id: string; message: string }

// --- client → host ----------------------------------------------------------

export type HostCommand =
  /** Client attached. The host replays both snapshots so the UI can paint. */
  | { type: 'hello'; id: string }
  /**
   * Image attachments join the submission as *ids only*. The host resolves
   * every id against the current session's attachment store and builds the
   * `ImageAttachmentRef`s itself — a renderer-supplied path, MIME type, or
   * dimension is never trusted, so the wire cannot smuggle a `file://` read or
   * a mismatched ref into a turn. Ids that do not resolve to this session
   * reject the whole submit.
   */
  | { type: 'submit'; id: string; input: string; imageIds?: string[]; overrides?: WireRunOverrides }
  /**
   * No signal crosses the boundary — the host owns the `AbortController`. The
   * reason is a sentinel the loop reads: `'user-cancel'` writes a
   * `turn_interruption` record, `'exit'` deliberately does not.
   */
  | { type: 'interrupt'; id: string; reason: InterruptReason }
  /** Runs the newest failed turn again on its own message; see `SessionController.retryTurn`. */
  | { type: 'retry-turn'; id: string; failureId: string }
  /** Reloads *records*, unlike the `reload-*` commands below. */
  | { type: 'reload'; id: string }
  | { type: 'retarget'; id: string; sessionId: string }
  | { type: 'run-tool'; id: string; name: string; input: unknown }
  /**
   * Runs a slash command. The registry lives host-side (`bootstrap()` calls
   * `registerBuiltinCommands` and `registerSkillCommands`), so the client sends
   * the raw line and reads the effects that come back.
   */
  | { type: 'run-command'; id: string; input: string }
  /**
   * The command *metadata* a completion dropdown needs.
   *
   * A renderer cannot import `commands/` (that drags the registry and, through
   * `skills.ts`, the filesystem into its bundle), and the set is per-project and
   * changes on `/skills reload`, so a baked-in list would go stale. `/help`
   * arrives as a `write-line` string and cannot drive a listbox.
   */
  | { type: 'list-commands'; id: string }
  /**
   * Candidates for an `@` file mention, ranked host-side.
   *
   * Unlike `list-commands` this cannot be fetched once and cached: the answer
   * depends on the whole composer text and the caret, and it reads the
   * filesystem — `generateFileSuggestions` walks a directory, consults
   * `.gitignore` and ranks with Fuse. None of that can cross into a renderer
   * bundle, so the round trip happens per keystroke and the client is
   * responsible for discarding answers that arrive out of order.
   */
  | { type: 'file-suggestions'; id: string; input: string; cursorPos: number }
  // --- git branches ---------------------------------------------------------
  /**
   * The local branches of this pane's project, for the empty state's branch
   * popover.
   *
   * A command rather than a field on `hello` — which is what `gitBranch` is —
   * because listing costs a `git` subprocess and the popover is the only thing
   * that ever wants it. Re-read on every open: a branch created in a terminal
   * beside the app must show up without restarting the pane.
   */
  | { type: 'list-branches'; id: string }
  /**
   * `git switch`. Refusals (a dirty worktree, a vanished branch) come back as
   * `ok: false` with git's own words rather than as a `fail` — the client draws
   * them as a notice, and a rejected checkout is an answer, not a protocol error.
   */
  | { type: 'switch-branch'; id: string; branch: string }
  | { type: 'checkpoints'; id: string }
  /** The context indicator's popover: computed on open, never pushed. */
  | { type: 'context-breakdown'; id: string }
  | { type: 'restore-code'; id: string; messageId: string }
  /**
   * The write half of `/rewind`. `restore-code-and-conversation` deliberately
   * has no command of its own: it is `restore-code` followed by
   * `truncate-session`, which the caller composes.
   */
  | { type: 'truncate-session'; id: string; messageId: string }
  | { type: 'summarize-rewind'; id: string; messageId: string; decision: RewindSummaryDecision }
  | { type: 'set-model'; id: string; modelKey: string }
  | { type: 'set-effort'; id: string; level: string; persist?: boolean }
  | { type: 'set-permission-mode'; id: string; mode: PermissionMode }
  | { type: 'ui-response'; requestId: string; response: UiResponse }
  // --- models ---------------------------------------------------------------
  | { type: 'list-models'; id: string }
  | { type: 'resolve-model'; id: string; input: string }
  | { type: 'set-default-model'; id: string; reference: string }
  // --- sessions -------------------------------------------------------------
  | { type: 'list-sessions'; id: string }
  | { type: 'create-session'; id: string; title?: string }
  // --- host-side reloads ----------------------------------------------------
  | { type: 'reload-agents'; id: string }
  | { type: 'reload-skills'; id: string }
  | { type: 'reload-settings'; id: string }
  // --- background tasks -----------------------------------------------------
  | { type: 'list-background-tasks'; id: string }
  | { type: 'peek-task-output'; id: string; taskId: string; maxBytes?: number }
  | { type: 'kill-task'; id: string; taskId: string; reason?: string }
  // --- lifecycle ------------------------------------------------------------
  // --- panes (multi-tab) ---------------------------------------------------
  /**
   * Open a new tab. If `sessionId` is given, the new pane takes that session
   * (returning the existing pane if it is already open — one pane per session).
   * Otherwise a fresh draft session is adopted.
   */
  | { type: 'open-pane'; id: string; sessionId?: string; title?: string }
  | { type: 'close-pane'; id: string; paneId: string; onlyIfIdle?: boolean }
  | { type: 'list-panes'; id: string }
  /**
   * Bring an already-open pane's window to the front.
   *
   * Side-mounted rather than folded into `open-pane`, because a host only knows
   * its *own* project: it can create a pane in that project, but a shell holding
   * several projects is the only thing that can find an arbitrary pane's window.
   * So this command carries no session and touches no workspace — the host hands
   * it straight to the shell. `ok: false` means the shell has no window for that
   * pane any more, which is a client's cue to re-list rather than an error.
   */
  | { type: 'focus-pane'; id: string; paneId: string }
  /**
   * Open another project in the same process. The shell owns the picker: it
   * puts up its native directory dialog, and cancelling is a no-op.
   */
  | { type: 'open-project'; id: string }
  // --- message queue --------------------------------------------------------
  /**
   * Hold a message until the running turn is over.
   *
   * The queue lives host-side because it is persisted (`message_queue` records,
   * so it survives a restart) and because the pump's gate reads state only the
   * host has — whether a turn is in flight, and whether a blocking UI request is
   * outstanding. There is deliberately no `dequeue`: a client asking for the
   * next message would race the host's own pump.
   *
   * `imageIds` name attachments imported through `import-attachment`, exactly
   * as `submit` does: the queue persists text *and* attachment references, so a
   * message queued with images is still the same message after a restart. The
   * ids resolve host-side against the current session's store.
   */
  | {
    type: 'enqueue-message'
    id: string
    content: string
    imageIds?: string[]
    priority?: MessageQueuePriority
  }
  | { type: 'clear-queue'; id: string }
  // --- image attachments ----------------------------------------------------
  /**
   * Imports one image into the current session's attachment store.
   *
   * Two sources, for the two ways an image arrives: pasted bytes (the
   * renderer's `ClipboardEvent`/`DataTransferItem`, reduced to bytes before it
   * crosses), or a local file path (the host reads the file itself — a native
   * picker's answer, or a drag that resolved to a path). Neither accepts a DOM
   * object; `bytes` is a plain `Uint8Array`, size-capped at the schema.
   */
  | { type: 'import-attachment'; id: string; source: WireAttachmentSource }
  /**
   * Drops a draft's hold on an attachment. The files stay on disk under the
   * retention window (they may still be referenced by a message or the queue);
   * nothing here can touch an attachment another holder still names.
   */
  | { type: 'remove-attachment'; id: string; imageId: string }
  /**
   * A size-capped `data:image/png;base64,…` thumbnail for one attachment.
   * Fetched on demand — previews never ride the snapshot, so a streaming turn
   * does not re-send them per frame.
   */
  | { type: 'get-attachment-preview'; id: string; imageId: string }
  /**
   * The same thing one tier up: a screen-sized `data:image/png;base64,…` for a
   * fullscreen viewer, where the 256px thumbnail above would be a blur. Also
   * on demand, and rendered rather than cached — one of these is worth a dozen
   * thumbnails, and it is only wanted while a viewer is open.
   */
  | { type: 'get-attachment-view'; id: string; imageId: string }
  /**
   * One sub-agent run's own records, read from this session's transcript file
   * for it. The id is the run's `agentId`; the host builds the path itself.
   */
  | { type: 'get-subagent-transcript'; id: string; agentId: string }
  /**
   * Opens an attachment's cached original. The host resolves the file from the
   * registered `(session, imageId)` pair and hands the path to the shell — no
   * arbitrary `file://` path crosses this wire, and an unregistered or
   * cross-session id is rejected rather than guessed at.
   */
  | { type: 'open-attachment'; id: string; imageId: string }
  | { type: 'shutdown'; id: string; reason: string }

export type InterruptReason = 'user-cancel' | 'exit'

// --- payload replacements ---------------------------------------------------

/**
 * `AgentRunOverrides` minus everything that cannot be cloned.
 *
 * `model` becomes a key the host resolves through `createActiveModelRuntime`;
 * `hooks` is deliberately absent, because hooks come from host-side settings
 * and a client must never be able to inject them.
 */
export interface WireRunOverrides {
  allowedTools?: string[]
  modelKey?: string
  effort?: EffortLevel
  skillName?: string
  skillArgs?: string
  displayInput?: string
}

/** `RuntimeSlotSnapshot` projected to metadata. Never carries `apiKey`. */
export interface WireReadyRuntimeSnapshot {
  status: 'ready'
  modelKey: string
  model: string
  providerName?: string
  contextWindow?: number
  /**
   * The window minus what autocompact reserves — the loop's own
   * `getContextBudget().usableContextWindow`, and the only honest denominator
   * for an occupancy display: a turn that crosses it is compacted, so the raw
   * `contextWindow` above is a number the conversation never reaches.
   */
  usableContextWindow?: number
  /** The levels this model accepts; absent means every level. */
  supportedEfforts?: EffortLevel[]
  /**
   * Whether the model this snapshot names accepts image input — the resolved
   * capability (`resolveImageCapability`), not the raw config switch, so a
   * renderer never needs the provider registry to answer it. Absent means no.
   */
  supportsImageInput?: boolean
  effort: string
  permissionMode: PermissionMode
}

export interface WireUnconfiguredRuntimeSnapshot {
  status: 'needs_configuration'
  configurationIssue: RuntimeConfigurationIssue
  effort: string
  permissionMode: PermissionMode
}

export type WireRuntimeSnapshot = WireReadyRuntimeSnapshot | WireUnconfiguredRuntimeSnapshot

/**
 * `PermissionRequest` with the `Tool` reduced to the two fields a dialog reads
 * and `onAlwaysAllow` reduced to a flag. The host keeps the real request and
 * invokes the callback when the answer comes back.
 *
 * `preview` and `destructiveWarnings` are derived here rather than by the
 * viewer: both need host-side code (the filesystem, and the shell analyzer in
 * `harness/`), and a renderer must be able to draw this dialog without
 * importing either.
 */
export interface PermissionRequestDto {
  toolName: string
  /** The exact call awaiting a human answer, rather than every unapproved record. */
  toolUseId?: string
  riskLevel: RiskLevel
  input: unknown
  reason: string
  source: PermissionDecisionSource
  matchedRule?: PermissionRule
  alwaysAllowRule?: PermissionRule
  denialStreak: number
  /** The gate's own assessment; the dialog's tone follows it. */
  riskTier?: 'readonly' | 'normal' | 'risky' | 'critical'
  /** False when the gate offered no "always allow" affordance for this call. */
  canAlwaysAllow: boolean
  /** Already bounded by `capFileToolPreview`; absent for non-file tools. */
  preview?: FileToolPreview
  destructiveWarnings: DestructiveCommandWarning[]
  /** The sub-agent asking, so a background agent's prompt says whose it is. */
  agent?: { id: string; type: string; description: string }
}

// --- tool display projection ------------------------------------------------

/**
 * How a `tool_use` record should be labelled, resolved host-side.
 *
 * `src/tools/display.ts` stays the single source of truth: it reaches the tool
 * registry for `userFacingName` / `getToolUseSummary` / `getActivityDescription`,
 * which are functions on live `Tool` objects and can never cross the boundary.
 * Without this a renderer is left guessing which key of `input` to show, which is
 * how the transcript ended up captioning half the tools with raw JSON.
 *
 * Plain strings and a flag, so the whole thing is `structuredClone`-safe by construction.
 * Nothing here is persisted — the projection runs over records on their way out,
 * so an old JSONL gets the same captions a new one does.
 */
export interface ToolDisplayDto {
  /** `Tool.userFacingName(input)`, falling back to the raw tool name. */
  displayName: string
  /** `Tool.getToolUseSummary(input)`; `''` when the tool offers none. */
  useSummary: string
  /** Present-tense spinner text, absent when the tool defines none. */
  activityDescription?: string
  /** The call reads or changes a file in the project's memory directory, or searches it. */
  memory?: true
}

/** Keyed by `ToolUseRecord.id` — not `toolUseId`, which is the *result*'s pointer. */
export type ToolDisplays = Record<string, ToolDisplayDto>

// --- slash command effects --------------------------------------------------

/**
 * The seven `CommandContext` members a host cannot satisfy, reduced to data.
 *
 * Everything else on `CommandContext` runs host-side — the store, the config,
 * the loop, the permission gate. What is left are calls that return nothing and
 * only mean something to whatever is drawing: write a line into the transcript,
 * open a panel. They are the reason `run-command` needs an event channel rather
 * than a richer reply.
 *
 * The panel openers collapse into one `open-surface` rather than one variant
 * each: a shell that has no provider panel can ignore that surface by name, and
 * adding a seventh panel does not widen the union.
 */
export type CommandEffect =
  | { kind: 'write-line'; text: string; tone?: 'error' }
  | { kind: 'open-command-view'; view: CommandView }
  | { kind: 'open-surface'; surface: CommandSurface }

export type CommandSurface =
  | 'model-picker'
  | 'effort-picker'
  | 'provider-panel'
  | 'background-tasks'
  | 'resume-picker'
  | 'rewind-panel'

/**
 * Mirrors what the TUI's `dispatch` returns, deliberately including its
 * tolerance: an unknown command or a command that threw is still `handled`, with
 * the explanation delivered as a `write-line` effect. Only input that is not a
 * slash command at all comes back unhandled.
 *
 * `exit` replaces the Ink `exit()` that `/exit` calls in the TUI. The host does
 * not shut itself down on a renderer's say-so — the shell has its own teardown
 * and calls `shutdown` when it is ready.
 */
export interface WireRunCommandResult {
  handled: boolean
  exit?: boolean
}

// --- the four blocking UI requests -----------------------------------------

export type UiRequest =
  | { kind: 'permission'; requestId: string; payload: PermissionRequestDto }
  | { kind: 'ask-user-question'; requestId: string; payload: AskUserQuestionRequest }
  | { kind: 'enter-plan'; requestId: string }
  | { kind: 'exit-plan'; requestId: string; payload: ExitDialogInput }

export type UiResponse =
  /** `alwaysAllow` must be honored before the approval resolves; see host.ts. */
  | { kind: 'permission'; approved: boolean; alwaysAllow?: boolean }
  | { kind: 'ask-user-question'; result: AskUserQuestionResult }
  | { kind: 'enter-plan'; approved: boolean }
  | { kind: 'exit-plan'; decision: ExitPlanDecision }

/**
 * What each request kind resolves to when the client is gone.
 *
 * These mirror the bridges' own fallbacks and are asymmetric on purpose:
 * denying a tool is safe, rejecting a plan exit is safe, but *entering* plan
 * mode only ever restricts the agent, so it approves. Do not unify them.
 */
export const UI_REQUEST_FALLBACKS = {
  permission: (): UiResponse => ({ kind: 'permission', approved: false }),
  'ask-user-question': (): UiResponse => ({
    kind: 'ask-user-question',
    result: { kind: 'rejected', feedback: 'The UI disconnected before answering.' },
  }),
  'enter-plan': (): UiResponse => ({ kind: 'enter-plan', approved: true }),
  'exit-plan': (): UiResponse => ({
    kind: 'exit-plan',
    decision: { kind: 'reject', feedback: '' },
  }),
} as const satisfies Record<UiRequest['kind'], () => UiResponse>

// --- command result payloads ------------------------------------------------

/** Absent while the session has no context figure yet. */
export interface WireContextBreakdownResult {
  breakdown?: ContextBreakdown
}

export interface WireCheckpointsResult {
  checkpoints: CheckpointWithDiff[]
}

/** Local branches, most recent first, plus wherever HEAD is now. */
export interface WireBranchesResult {
  branches: string[]
  current?: string
}

/**
 * The outcome of a `switch-branch`.
 *
 * `current` is read back off HEAD in both directions, so a refused switch still
 * tells the client where it is — and a client that assumed the branch it asked
 * for would draw a badge for a branch it is not on.
 */
export interface WireSwitchBranchResult {
  ok: boolean
  current?: string
  /** git's own stderr, for the note the client posts. Absent when `ok`. */
  message?: string
}

export interface WireReloadResult {
  records: SessionRecord[]
  toolDisplays?: ToolDisplays
}

export interface WireRestoreCodeResult {
  success: boolean
  error?: string
}

/**
 * The records as they stand after a rewind wrote to disk.
 *
 * The event stream is still the source of transcript truth -- both rewind
 * commands go through `SessionController.reload()`, which emits a
 * `transcript-reset` -- so this is the same list arriving a second time, for a
 * caller that wants it in hand rather than in a listener.
 */
export interface WireRewindResult {
  records: SessionRecord[]
  toolDisplays?: ToolDisplays
}

export interface WireRunToolResult {
  ok: boolean
  content: string
  errorCode?: string
}

/**
 * What a shell needs before it can paint its first frame.
 *
 * Startup-shaped state rides here rather than becoming events or extra round
 * trips; anything that changes later gets a command instead. `records` is the
 * host's ledger at attach time — without it a fresh renderer has an empty
 * transcript until it asks for a reload.
 */
export interface WireHelloResult {
  sessionId: string
  session: SessionMeta
  /** This scope's working directory, where tools run. */
  cwd: string
  /**
   * The normalized project root (`projectRootKey`), which keys the session's
   * data and matches `WirePaneInfo.projectRoot`. Separate from the working
   * directory for global sessions and coordination threads.
   */
  projectRoot: string
  /** The project display name — the same value `WirePaneInfo.projectName` carries. */
  projectName: string
  /**
   * Whether this pane runs in the global (home-rooted) workspace rather than a
   * project — the desktop's fallback when nothing is opened, whose records are
   * keyed by the home directory under `~/.myagent/projects/`.
   *
   * A boolean on the wire rather than a name the renderer could match: display
   * names are localized and mutable, and the empty-state screen has to know the
   * difference structurally (it drops its "在 X 中" hero segment).
   */
  projectIsGlobal: boolean
  /**
   * The branch `<cwd>/.git/HEAD` names, absent when it is unreadable, the
   * directory is not a repository, or HEAD is detached.
   *
   * Read once, at attach, like everything else on this result. A mid-session
   * `git switch` therefore leaves it stale until the pane is rebuilt — accepted,
   * because the only thing that draws it is the empty-state screen, which exists
   * for the moment right after an attach or a `/clear`. Promote it to a shell
   * command if something ever needs it live.
   */
  gitBranch?: string
  records: SessionRecord[]
  /** Captions for the `tool_use` records above; see `ToolDisplayDto`. */
  toolDisplays?: ToolDisplays
  notices: StartupNotice[]
  hasRecoverableInterruption: boolean
  initialQueuedPrompt?: string
  /**
   * Messages already waiting when the client attached.
   *
   * Startup-shaped like `records`: the queue is replayed from the session log,
   * so a window reopened after a crash finds whatever the last one left behind.
   * Distinct from `initialQueuedPrompt`, which is an *interrupted* prompt handed
   * back to the composer rather than a message anyone queued.
   */
  queuedMessages: PersistedQueuedMessage[]
  /** Before clamping, for a picker that wants to show the configured value. */
  configuredEffortLevel: EffortLevel
}

/** Echoes the stored message so a client can paint the row it just created. */
export interface WireEnqueueResult {
  message: PersistedQueuedMessage
}

// --- image attachment payloads ----------------------------------------------

/** What an `import-attachment` imports: bytes the renderer pasted, or a path the host reads. */
export type WireAttachmentSource =
  | { kind: 'bytes'; name: string; bytes: Uint8Array }
  | { kind: 'path'; path: string; name?: string }

/**
 * One imported attachment, as the composer's draft list wants it.
 *
 * The `ref` crosses as itself — it is already the pure, clone-safe shape
 * records carry — while `animated` rides along so both UIs can flag a
 * first-frame send version without a second round trip.
 */
export interface WireAttachmentInfo {
  ref: ImageAttachmentRef
  /** True when the source was animated and the send version is its first frame. */
  animated: boolean
}

/**
 * The failure half every attachment command shares: a distinguishable reason
 * (never a bare HTTP 400) plus the sentence the UI shows next to it.
 */
export interface WireAttachmentFailure {
  ok: false
  reason: ImageStoreErrorReason
  message: string
}

export type WireImportAttachmentResult = WireAttachmentFailure | {
  ok: true
  attachment: WireAttachmentInfo
}

export type WireAttachmentPreviewResult = WireAttachmentFailure | {
  ok: true
  dataUrl: string
}

/** `records` is empty when the run has written nothing yet, or never wrote a file. */
export interface WireSubagentTranscriptResult {
  ok: true
  records: SessionRecord[]
}

/** Same shape as the preview's; the difference is which tier of bytes it carries. */
export type WireAttachmentViewResult = WireAttachmentFailure | {
  ok: true
  dataUrl: string
}

/**
 * `ok: false` is an unregistered or cross-session id, with its reason. The
 * success half says the shell *took* the open request — `shell.openPath` is
 * fire-and-forget host-side, like `open-project` before it.
 */
export type WireOpenAttachmentResult = WireAttachmentFailure | { ok: true }

/**
 * One entry of `config.models`, built field by field.
 *
 * Never spread a `ModelConfig` into this: `resolveModel` folds the endpoint's
 * `apiKey` and `baseUrl` into what it returns, so a spread would ship every
 * key the user has configured to the renderer. Fields are absent when the
 * entry does not resolve (missing or unknown endpoint).
 */
export interface WireModelInfo {
  key: string
  model?: string
  provider?: string
  contextWindow?: number
  supportedEfforts?: EffortLevel[]
  /** Effective image-input capability (`resolveImageCapability`); absent means no. */
  supportsImageInput?: boolean
}

export interface WireModelsResult {
  /** Every configured key, resolvable or not — parity with `availableModelKeys`. */
  models: WireModelInfo[]
  defaultModelKey?: string
  /**
   * Resolved host-side for the same reason `PermissionRequestDto` carries its
   * preview: building these needs `ConfigService.getModel`, which folds the
   * endpoint's `apiKey` and `baseUrl` into what it returns.
   */
  pickerOptions: ModelPickerOption[]
}

export interface WireResolveModelResult {
  modelKey?: string
}

/**
 * One registered slash command, built field by field.
 *
 * Never spread a `CommandDefinition` into this: it carries `run` and may carry
 * `isEnabled`, both functions. `createMemoryChannelPair` clones on every post so
 * that fails loudly in tests, but `ipcRenderer.send` uses structured clone in
 * production and **silently drops functions** — the renderer would receive a
 * command whose metadata looked fine and whose behaviour was gone.
 *
 * `isHidden`/`isEnabled` are deliberately absent rather than projected: the host
 * already applied them (`listCommands()` filters both), and shipping a stale
 * boolean invites a client to re-filter on data that has since changed.
 */
export interface WireCommandInfo {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string
  /** Registered from a skill, rather than a built-in command. */
  isSkill?: boolean
}

export interface WireCommandsResult {
  commands: WireCommandInfo[]
}

/**
 * `@` file candidates.
 *
 * `FileSuggestion` crosses as itself, like `SessionMeta` and `CheckpointWithDiff`
 * do: it is plain data with no functions and nothing folded in from a
 * `ModelConfig`, and it comes from `suggestions/atToken.ts`, which the renderer
 * is allowed to import anyway — so the view hands what it receives straight back
 * to `applyFileSuggestion` with no adapter in between. The host still builds each
 * one field by field; see the note on `WireCommandInfo` for why that rule holds
 * even where a spread would currently be harmless.
 */
export interface WireFileSuggestionsResult {
  suggestions: FileSuggestion[]
}

/** `SessionMeta` crosses verbatim: it is already the JSON shape in index.json. */
export interface WireSessionsResult {
  sessions: SessionMeta[]
}

export interface WireSessionSwitchResult {
  session: SessionMeta
  records: SessionRecord[]
  toolDisplays?: ToolDisplays
  notices: StartupNotice[]
}

export interface WireReloadCountResult {
  count: number
}

export interface WireReloadSettingsResult {
  needsRuntimeRebuild: boolean
  /** True when the host already swapped the runtime on your behalf. */
  rebuilt: boolean
  modelKey: string | undefined
}

export interface WireEffortResult {
  effort: string
  persisted: boolean
}

export interface WireBackgroundTasksResult {
  tasks: BackgroundTaskSnapshot[]
}

export interface WireTaskOutputResult {
  output: string
}

export interface WireTaskResult {
  task?: BackgroundTaskSnapshot
}

// --- pane (multi-tab) payloads --------------------------------------------

/**
 * One open pane, projected to metadata.
 *
 * Built field by field, never spread from `SessionPane` — the host-side object
 * holds runtime state and the controller. A string `paneId` is the host's
 * token for the pane's IPC channel; it survives the renderer losing the
 * reference and is what `close-pane` carries.
 */
export interface WirePaneInfo {
  paneId: string
  sessionId: string
  /** May be absent for a fresh draft that has never received a title. */
  sessionTitle?: string
  /** `sessionTitle` is the first-message fallback and a model-written title is still being generated. */
  titlePending?: true
  /**
   * Which project this pane belongs to, normalized (`projectRootKey`).
   *
   * Required rather than optional so the compiler makes every projection site
   * fill it: a pane whose project is unknown cannot be grouped, and the tab bar
   * has to decide from this whether a row is its own window's project (closable)
   * or somebody else's (focus only).
   */
  projectRoot: string
  /** Display name for the group label — `basename`, or the root for a filesystem root. */
  projectName: string
  /** The session's coordination role, when it belongs to a project's coordination. */
  coordinationRole?: 'coordinator' | 'thread'
}

export interface WireOpenPaneResult {
  paneId: string
  session: SessionMeta
  records: SessionRecord[]
  toolDisplays?: ToolDisplays
  notices: StartupNotice[]
}

export interface WireClosePaneResult {
  ok: boolean
}

export interface WireListPanesResult {
  panes: WirePaneInfo[]
}

/** `false` when the shell has no window for that pane — the client should re-list. */
export interface WireFocusPaneResult {
  ok: boolean
}

/**
 * `ok` means the shell accepted the request, not that a project is open: with no
 * `path` the user still has a directory dialog to answer, and bootstrapping
 * happens after this reply. `false` is a shell that cannot open projects at all.
 */
export interface WireOpenProjectResult {
  ok: boolean
}
