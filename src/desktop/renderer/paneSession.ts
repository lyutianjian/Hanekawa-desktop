/**
 * One lane's worth of renderer state.
 *
 * The single-window shell keeps N panes alive at once, and everything that
 * belongs to exactly one conversation lives here: the session client, the
 * transcript state *and its own DOM subtree* (visibility-toggled, so a switch
 * repaints nothing and scroll positions survive), the four blocking-request
 * dialogs, completions, the queue strip's mirror, the surface picker state,
 * the rewind panel, and the composer draft while the pane is in the
 * background.
 *
 * Everything else — the status bar, the composer, the tab bar, the overlay
 * panels — is a singleton the *active* pane drives. A background pane still
 * folds every event into its state (a permission request parks; a turn keeps
 * streaming), it just does not paint. `activate()` replays the whole surface
 * once, which is the entire cost of switching.
 *
 * Same rules as the old `app.ts`: decisions live in `model/`, this file only
 * wires them; a blocking request must always be answered; the draft is only
 * authoritative in the composer while active and is banked on `deactivate()`.
 */

import { SessionClient } from '../../runtime/protocol/client.js'
import type { RuntimeChannel } from '../../runtime/protocol/channel.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
  PersistedQueuedMessage,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { PermissionMode } from '../../harness/permissions.js'
import type {
  PermissionRequestDto,
  UiRequest,
  WireCommandInfo,
  WireModelsResult,
  WirePaneInfo,
} from '../../runtime/protocol/wire.js'
import type { ComposerView } from './dom/composerView.js'
import type { StatusView } from './dom/statusView.js'
import type { SuggestionsView } from './dom/suggestionsView.js'
import type { OverlayView } from './dom/overlayView.js'
import type { PermissionRequestView } from './dom/permissionRequestView.js'
import type { QuestionCardView } from './dom/questionCardView.js'
import type { RewindPanel } from './dom/rewindView.js'
import type { SurfacePanel } from './dom/surfaceView.js'
import type { ProcessStripView } from './dom/processStripView.js'
import type { TaskPanelDom } from './dom/taskPanelView.js'
import { append, el, show } from './dom/dom.js'
import { finishPresenceWithin } from './dom/presence.js'
import { createRepaint } from './frame.js'
import { createTranscriptView, type TranscriptView } from './dom/transcriptView.js'
import { createCoordinatorWelcome, createWelcomeView } from './dom/welcomeView.js'
import { threadChip } from './dom/processStripView.js'
import type { ThreadStripView } from './model/sidePanel.js'
import { isTranscriptEmpty, welcomeView } from './model/welcome.js'
import {
  branchPickerKeyToIntent,
  branchPickerView,
  createBranchPickerState,
  moveBranchSelection,
  type BranchPickerIntent,
  type BranchPickerState,
} from './model/branchPicker.js'
import {
  createProjectPickerState,
  moveProjectSelection,
  projectPickerKeyToIntent,
  projectPickerView,
  type ProjectPickerEntry,
  type ProjectPickerIntent,
  type ProjectPickerState,
} from './model/projectPicker.js'
import {
  classifyInput,
  commandEffectToIntent,
  type CommandViewRow,
} from './model/commandRouting.js'
import {
  acceptCompletion as applyCompletion,
  applyFileResponse,
  beginFileRequest,
  closeCompletions as clearCompletions,
  commandCompletions,
  fileCompletionQuery,
  moveCompletion as moveCompletionState,
  NO_COMPLETIONS,
  selectCompletion,
  type CompletionState,
} from './model/completion.js'
import { completionAcceptMode, type ShellState } from './model/keymap.js'
import { NO_DISCLOSURE, pruneDisclosure, toggleDisclosure, type DisclosureState } from './model/thinking.js'
import { subagentEntries, type SubagentEntry } from './model/subagentPanel.js'
import {
  applySessionEvent,
  createTranscriptState,
  groupTranscript,
  presentationTranscript,
  withQueuedMessages,
  type ToolDisplayLookup,
  type TranscriptState,
} from './model/transcript.js'
import {
  activeIndex,
  activeRequest,
  addUiRequest,
  createUiQueue,
  cycleActive,
  permissionRequests,
  removeUiRequest,
  type UiQueueState,
} from './model/uiQueue.js'
import type { OverlayAction } from './model/dialogActions.js'
import {
  initialPermissionIndex,
  permissionIndexToIntent,
  permissionKeyToIntent,
  permissionResponseFor,
  permissionViewModel,
  type PermissionIntent,
} from './model/permissionDialog.js'
import {
  applyAskIntent,
  askKeyToIntent,
  askViewModel,
  createAskState,
  type AskIntent,
  type AskState,
} from './model/askUserQuestion.js'
import {
  applyExitPlanIntent,
  createExitPlanState,
  enterPlanIndexToIntent,
  enterPlanKeyToIntent,
  enterPlanViewModel,
  exitPlanIndexToIntent,
  exitPlanKeyToIntent,
  exitPlanViewModel,
  type EnterPlanIntent,
  type ExitPlanIntent,
  type ExitPlanState,
} from './model/planDialogs.js'
import {
  activateSurfaceRow as chooseSurfaceRow,
  backgroundTasksView,
  effortPickerView,
  initialSurfaceSelection,
  isSupportedSurface,
  modelPickerView,
  moveSurfaceSelection as stepSurfaceSelection,
  resumePickerView,
  runningProcessCount,
  type SupportedSurface,
  type SurfaceAction,
  type SurfaceView,
} from './model/surfaces.js'
import { runtimeMenuView } from './model/runtimeMenu.js'
import { contextGaugeView } from './model/usage.js'
import {
  applyRewindIntent,
  beginRewindRun,
  createRewindState,
  failRewindRun,
  rewindViewModel,
  runRewind,
  type RewindIntent,
  type RewindState,
} from './model/rewindPanel.js'
import {
  attachmentDraftsFull,
  attachmentStripView,
  beginAttachmentImport,
  imageDimensions,
  readyAttachmentRefs,
  readyDraftRef,
  removeAttachmentDraft,
  restoredAttachmentDrafts,
  retryAttachmentImport,
  settleAttachmentImport,
  type AttachmentDraft,
  type AttachmentDrafts,
  type AttachmentImportSource,
} from './model/composerAttachments.js'
import { formatImageFailure } from '../../media/imageErrors.js'
import {
  beginPreviewLoad,
  failPreviewLoad,
  previewDataUrl,
  settlePreviewLoad,
  type AttachmentPreviewCache,
} from './model/attachmentPreviews.js'
import {
  failImageViewer,
  fitZoom,
  openImageViewer,
  settleImageViewer,
  withZoom,
  type ImageViewerState,
} from './model/imageViewer.js'
import type { ImageViewerView } from './dom/imageViewerView.js'
import type { ImageAttachmentRef } from '../../media/types.js'
import { localizeCommands } from './model/builtinLabels.js'
import {
  advanceTaskPanel,
  retireCompletedTaskPanel,
  taskPanelState,
  type TaskPanelState,
} from './model/tasks.js'

export interface PaneSessionDeps {
  /** Whether this lane is a project coordinator (its permission pill is hidden). */
  isCoordinator?: () => boolean
  /** The coordinator welcome's 「概览」 link: raises the overview panel. */
  onOpenOverview?: () => void
  /** Whether this coordinator's project opened with a survey thread; the welcome says it went to look. */
  coordinationOpening?: () => boolean
  /** The thread chip drawn under the messages of a coordination session; `undefined` draws none. */
  threadStrip?: () => ThreadStripView | undefined
  onOpenThreads?: (target: ThreadStripView['target']) => void
  /** The lane key. Stable across `/clear` and `/resume`; identifies this pane. */
  lane: string
  channel: RuntimeChannel
  /** `#transcript-area`; this pane's subtree is appended here. */
  mount: HTMLElement
  overlay: OverlayView
  /**
   * The permission request's home: the composer, not the modal layer. Held
   * separately from `overlay` because the two are painted on different nodes and
   * a request must never leave one of them behind — see `renderOverlay`.
   */
  permissionRequest: PermissionRequestView
  /** The AskUserQuestion card; shares the composer dock with `permissionRequest`. */
  questionCard: QuestionCardView
  rewindPanel: RewindPanel
  surface: SurfacePanel
  suggestions: SuggestionsView
  /** The resident strip above the composer; a singleton, like the composer itself. */
  taskPanel: TaskPanelDom
  processStrip: ProcessStripView
  status: StatusView
  composer: ComposerView
  /**
   * The window's fullscreen image viewer. A singleton like the composer, and
   * driven only by the active pane — a viewer left open over the *next* pane's
   * conversation would be showing a picture from a different one.
   */
  imageViewer: ImageViewerView
  /** Shell chrome (the tab bar) re-renders from the active session. */
  onShellChanged?: () => void
  /**
   * This pane's transcript just went from nothing to something — its first
   * input or output. The sidebar's row for a lane-only session appears on this
   * edge, and the history pull it triggers is what replaces the「未命名会话」
   * fallback with the session's real title.
   */
  onFirstContent?: () => void
  /**
   * A path in a search result was clicked (§6.2 检索): open it in the user's
   * editor, at the line the hit named. Window-level — `open-in-editor` is a
   * shell command, and this pane owns only the click.
   */
  onOpenFile?: (path: string, line: number | undefined) => void
  /** `/exit` was accepted by the host — close whatever this shell calls "this pane". */
  onExit: () => void
  /** The lane died from the host side (pane closed, window closing). */
  onClosed?: () => void
  /**
   * 「选择图片」: puts up the OS picker and returns its paths. The Electron
   * boundary owns the native dialog; this pane only turns each answer into an
   * import. `undefined` is a cancelled dialog, not an error.
   */
  onPickImages?: () => Promise<readonly string[] | undefined>
  /**
   * The added projects, for the empty state's project switcher.
   *
   * A getter rather than a value: the list is `app.ts`'s, it moves whenever a
   * project is added or removed, and a pane that captured it once would offer a
   * project the sidebar had already forgotten. Read at every paint — the same
   * discipline `onOpenFile` follows for the lane's own root.
   */
  listProjects?: () => readonly ProjectPickerEntry[]
  /**
   * A project was chosen from the empty state: put the window in a session
   * there. Window-level, like「新会话」— this pane owns only the click.
   */
  onSwitchProject?: (projectRoot: string) => void
  /**
   * `/provider`. The endpoints/models/routing editor is the settings screen's
   * `provider` page, and that screen is window-level — one per window, pointable
   * at a project no open lane belongs to — so the pane only forwards the request.
   */
  onOpenProviderSettings?: () => void
  /**
   * A prompt went to the host — not a slash command, which is not a message to
   * the agent. The browser panel hangs a hand-back off this: asking the agent
   * for something is asking it to drive again.
   */
  onUserMessage?: () => void
  /** An `Agent` row was clicked: show that run in the window's side panel. */
  onOpenSubagent?: (id: string) => void
  /** A thread note card's 查看: open that thread's session. */
  onOpenThread?: (threadId: string) => void
  /** The active pane repainted its transcript, so the side panel's list may have moved. */
  onSubagentsChanged?: () => void
}

export interface PaneSession {
  readonly lane: string
  readonly client: SessionClient
  readonly paneEl: HTMLElement
  /** The pane topology this pane's client last heard about. */
  readonly panes: readonly WirePaneInfo[]
  readonly ownProjectRoot: string | undefined
  readonly rewind: RewindState | undefined
  isActive(): boolean
  activate(): void
  deactivate(): void
  beginLayoutChange(): void
  syncMotion(): void
  dispose(): void
  /** The `hello()` startup sequence: records, notices, queue, commands, panes. */
  start(): Promise<void>
  shellState(): ShellState
  note(text: string, level?: 'system' | 'error'): void
  /** Whether this pane's session has had any input or output yet. */
  hasConversation(): boolean
  /**
   * Repaint the empty state. `app.ts` calls it when the project list moves — an
   * idle pane's Hero names a project the sidebar just renamed or removed, and
   * nothing else would repaint it.
   */
  refreshWelcome(): void
  /**
   * Re-read the slash-command list. `app.ts` calls it after a settings change
   * that adds or removes skill commands — the composer's completion list is
   * cached per pane, and nothing else would notice a skill being switched off.
   */
  refreshCommands(): void
  /** Every `Agent` call in this pane's transcript, for the side panel. */
  subagents(): readonly SubagentEntry[]
  /** The run the side panel is showing, highlighted on its row; `undefined` for none. */
  setSelectedSubagent(id: string | undefined): void
  // --- keyboard entry points (routed here by the app's global handler) ---
  handleOverlayKey(event: KeyboardEvent): void
  /** What a click in the question card means; the keyboard's twin is `handleOverlayKey`. */
  handleAskIntent(intent: AskIntent): void
  handleRewindIntent(intent: RewindIntent): void
  acceptCompletion(mode: 'accept' | 'submit'): Promise<void>
  moveCompletion(direction: 'up' | 'down'): void
  // --- mouse entry points (routed here by the two views' own listeners) ---
  /** An option row in the blocking dialog was clicked, by slot. */
  handleOverlayAction(action: OverlayAction): void
  /** A completion row was clicked, by slot. Accepts, and submits when Enter would. */
  acceptCompletionAt(index: number): Promise<void>
  closeCompletions(): void
  hideSurface(): void
  moveSurfaceSelection(direction: 'up' | 'down'): void
  activateSurfaceRow(): void
  interrupt(): Promise<void>
  /** The composer's permission pill; applies to the live gate, not to config. */
  setPermissionMode(mode: PermissionMode): Promise<void>
  send(): Promise<void>
  queueMessage(): Promise<void>
  /** The form/button path: the same send-or-queue verdict as the keymap. */
  submitFromForm(): Promise<void>
  onComposerInput(): void
  // --- image attachments (S11) ---
  /** 「选择图片」: the OS picker, then one import per chosen path. */
  pickImages(): Promise<void>
  /** Paste and drop funnel into the same import state machine. */
  importImagesFromFiles(files: readonly File[]): Promise<void>
  importImagesFromPaths(paths: readonly string[]): Promise<void>
  /** Removes one draft; a ready draft also releases its host-side hold. */
  removeDraftImage(draftId: string): Promise<void>
  /** Re-runs a failed import. A draft without a source (restored) cannot retry. */
  retryDraftImage(draftId: string): void
  /** Opens a ready draft's original (fire-and-forget, host-resolved). */
  openDraftImage(draftId: string): Promise<void>
  /** Opens a ready draft's tile in the window's fullscreen viewer (S12). */
  previewDraftImage(draftId: string): Promise<void>
  /** The viewer's zoom capsule and its wheel, routed back from the singleton view. */
  setViewerZoom(zoom: number): void
  /** The viewer reporting one of its own three dismissals. */
  onViewerClosed(): void
  // --- panel entry points ---
  openRewindPanel(): Promise<void>
  /**
   * `/model` and `/effort`'s own `#surface` cards. Still reached by the slash
   * commands; the composer chip goes through `openRuntimeMenu` instead.
   */
  openModelPicker(): Promise<void>
  openEffortPicker(): Promise<void>
  /**
   * The composer chip's popover. Fetches the model list, folds it together with
   * the runtime snapshot, and hands the rows to the composer — which is a
   * singleton, so only the active pane may fill it.
   *
   * The rows are the *same* ones the two pickers above draw, and choosing one
   * runs the same `run-command`, so the chip cannot drift from the slash
   * commands and the choice still persists.
   */
  openRuntimeMenu(): Promise<void>
  runSurfaceAction(action: SurfaceAction): Promise<void>
  /** The process tag above the composer: opens `/tasks`, or closes it when open. */
  toggleBackgroundTasks(): void
  refreshPanes(): Promise<void>
}

export function createPaneSession(deps: PaneSessionDeps): PaneSession {
  const { lane, channel } = deps
  const client = new SessionClient(channel)

  // One DOM subtree per pane. Visibility is the only thing that changes on a
  // switch: `show()` flips `hidden`, the scroll position stays where the user
  // left it, and no item is ever rebuilt because of a switch.
  const paneEl = el('div', 'pane')
  // Before the transcript, so the startup notices a fresh draft carries read as a
  // footnote under the Hero rather than pushing it off the top of the canvas.
  const welcomeEl = el('div', 'welcome')
  let coordinatorWelcomeEl: HTMLElement | undefined
  let coordinatorWelcomeKey = ''
  let threadChipEl: HTMLElement | undefined
  let threadChipKey = ''
  const transcriptEl = el('div', 'transcript')
  transcriptEl.setAttribute('aria-live', 'polite')
  append(paneEl, [welcomeEl, transcriptEl])
  deps.mount.appendChild(paneEl)
  // `paneEl` is the float host: `.pane` is the positioned ancestor, and a button
  // placed inside the scroller would both be wiped by every repaint and anchor to
  // the bottom of the content instead of the viewport.
  const transcriptView: TranscriptView = createTranscriptView(transcriptEl, paneEl, {
    onToggle: (id, expanded) => toggleDisclosureAt(id, expanded),
    onOpenSubagent: (id) => deps.onOpenSubagent?.(id),
    onOpenThread: (id) => deps.onOpenThread?.(id),
    // The panel is a singleton the active pane drives, so a background pane
    // cannot reach it — and cannot be clicked either, since it does not paint.
    onTaskStep: () => {
      if (active) deps.taskPanel.flash()
    },
    // A search hit's path, clicked: the pane hands over exactly what the tool
    // printed (a cwd-relative path, and the hit's line) — resolving it to a
    // project and bounding it there is the shell's half of the bargain.
    onOpenPath: (path, line) => deps.onOpenFile?.(path, line),
    // An image above a user bubble, clicked (S12): the window's fullscreen
    // viewer, seeded with the thumbnail already in hand.
    onViewImage: (image) => { void viewImage(image) },
    // The thumbnail the pane holds for that id, or nothing yet. The fetch is
    // `loadTranscriptThumbnails` below; this is only the lookup.
    imageThumbUrl: (imageId) => previewDataUrl(previewCache, imageId),
    // The clipboard lives here rather than in the view: `navigator` is a host
    // object, and `dom/transcriptView.ts` is the half of this that runs against a
    // hand-written DOM stub in tests. A rejected write is swallowed — the button
    // is a convenience beside text the user can still select.
    onCopy: (text) => { void navigator.clipboard?.writeText(text).catch(() => {}) },
    onRewind: (messageId) => { void openRewindPanel(messageId) },
  })
  const welcome = createWelcomeView(welcomeEl, {
    onBranchIntent: (intent) => runBranchPickerIntent(intent),
    onBranchKey: (chord) => {
      const intent = branchPickerKeyToIntent(chord, branchPickerView(branchPicker))
      if (intent.kind === 'none') return false
      runBranchPickerIntent(intent)
      return true
    },
    onProjectIntent: (intent) => runProjectPickerIntent(intent),
    onProjectKey: (chord) => {
      const intent = projectPickerKeyToIntent(chord, projectPickerView(projectPickerState()))
      if (intent.kind === 'none') return false
      runProjectPickerIntent(intent)
      return true
    },
  })

  // --- state -----------------------------------------------------------------

  /**
   * Tool captions, resolved host-side (T1) and asked for at the moment an item is
   * built — the client has already absorbed the map by the time it hands over the
   * event, and a caption outlives the payload that introduced it.
   */
  const toolDisplays: ToolDisplayLookup = (recordId) => client.getToolDisplay(recordId)

  let transcript: TranscriptState = createTranscriptState([], toolDisplays)
  /**
   * The activity groups and steps the user opened or closed by hand, as absolute
   * answers (§5.2). Per pane, like every other `let` here — a window-level map
   * would fold a step in a session the user never touched.
   */
  let disclosure: DisclosureState = NO_DISCLOSURE
  /**
   * The checklist above the composer, or `undefined` for no panel at all.
   *
   * Held here rather than derived from the transcript: the panel's source is the
   * newest `taskSnapshot`, which `TranscriptState` does not keep, and the pane
   * never keeps the record list either. `hello` and `transcript-reset` project it
   * from a whole list; every other record advances it one step (§7.3).
   */
  let taskPanel: TaskPanelState | undefined
  /**
   * When the running turn started, epoch ms — the live status's clock, and
   * nothing else reads it. Per pane, and cleared at `turn-end`: a background
   * pane's turn is still its own turn.
   */
  let turnStartedAt: number | undefined
  let queue: UiQueueState = createUiQueue()
  let completions: CompletionState = NO_COMPLETIONS
  let commands: WireCommandInfo[] = []
  let panes: readonly WirePaneInfo[] = Object.freeze([])
  let ownProjectRoot: string | undefined
  /** From `hello`, for the welcome screen's Hero and its context pills. */
  let projectName: string | undefined
  /** From `hello`: this pane runs in the global (home-rooted) workspace. */
  let projectGlobal = false
  let gitBranch: string | undefined
  /**
   * The welcome screen's branch switcher. Per pane like every other `let` here:
   * the popover belongs to the pill it hangs off, and the branch it lists is
   * this pane's project's.
   */
  let branchPicker: BranchPickerState = createBranchPickerState()
  /**
   * Discards the answer of a `list-branches` the user has already moved past —
   * closing and reopening the popover starts a second pull, and the first one
   * arriving late would repaint a list nobody asked for.
   */
  let branchListToken = 0
  /**
   * The empty state's project switcher, per pane like the branch one. Only
   * `open` and the cursor live here — the rows and the ticked project are read
   * fresh at every paint by {@link projectPickerState}, because both belong to
   * `app.ts` and to `hello` rather than to this popover.
   */
  let projectPickerOpen = false
  let projectSelectedIndex = -1
  /**
   * Messages the host holds for the running turn's next step — a mirror of
   * `client.getQueuedMessages()`, drawn from the last `queued-messages` event
   * as user bubbles at the transcript's tail.
   */
  let queued: readonly PersistedQueuedMessage[] = Object.freeze([])
  let surfaceView: SurfaceView | undefined
  let surfaceIndex = 0
  /** The task whose stop button awaits its second press, while `/tasks` is open. */
  let armedKillId: string | undefined
  /** Ticks the elapsed times while `/tasks` is painted. */
  let taskClock: ReturnType<typeof setInterval> | undefined
  /**
   * A slash command's information table, which shares the `#surface` node with
   * the pickers but is state of its own.
   *
   * Held rather than painted and forgotten: `hideSurface` and the Escape/press-
   * outside paths that call it both read the pane's state, so a panel the pane
   * does not remember is a panel nothing can close.
   */
  let commandView: { title: string; rows: readonly CommandViewRow[] } | undefined
  let rewind: RewindState | undefined
  let boundSessionId: string | undefined
  /** One resolver per outstanding request, keyed the way the queue is. */
  const resolvers = new Map<string, (response: unknown) => void>()
  let permissionIndex = 0
  let askState: AskState | undefined
  let askingHeader: string | undefined
  let enterPlanIndex = 0
  let exitPlan: ExitPlanState | undefined
  let preparedId: string | undefined
  /** The composer text while this pane is not active; the composer owns it while it is. */
  let draftText = ''
  /**
   * This pane's draft image attachments (S11). Per pane like the text draft:
   * the strip and the send gate below read the same list, so a background
   * pane's import can settle into its own state without touching the composer
   * the *active* pane is painting. Adding while text-only still works —
   * viewing and deleting are never gated on the model's capability.
   */
  let draftImages: AttachmentDrafts = Object.freeze([])
  /** Monotonic draft ids, so an import settling late can never collide with a newer draft. */
  let draftSeq = 0
  /**
   * This pane's thumbnail data URLs (S12): one on-demand
   * `get-attachment-preview` per image id, LRU-bounded in the model. The
   * snapshots a streaming turn posts carry refs only, so the host never
   * re-sends pixels with them; this map is the renderer's half of that —
   * a cached URL is painted straight from it, no request, per frame.
   */
  let previewCache: AttachmentPreviewCache = new Map()
  /** In-flight preview loads, so a repaint before the settle does not fire a second request. */
  const previewLoads = new Set<string>()
  /**
   * The fullscreen viewer's state, or `undefined` while it is shut. Per pane
   * like everything else here: a viewer opened in this conversation must not
   * survive a switch to another one, which `deactivate` enforces.
   */
  let viewerState: ImageViewerState | undefined
  let active = false

  // --- rendering (state always updates; paint only when active) --------------

  /** The project switcher's whole state: the rows are read, not stored. */
  function projectPickerState(): ProjectPickerState {
    return createProjectPickerState({
      open: projectPickerOpen,
      projects: deps.listProjects?.() ?? [],
      current: ownProjectRoot,
      selectedIndex: projectSelectedIndex,
    })
  }

  function runProjectPickerIntent(intent: ProjectPickerIntent): void {
    switch (intent.kind) {
      case 'open':
        if (projectPickerOpen) return
        // One popover at a time: the two pills sit side by side, and leaving the
        // branch list open under a project list is two dialogs over one screen.
        branchPicker = createBranchPickerState()
        projectPickerOpen = true
        projectSelectedIndex = -1
        renderTranscript()
        welcome.focusProjectPicker()
        return
      case 'close':
        if (!projectPickerOpen) return
        projectPickerOpen = false
        projectSelectedIndex = -1
        renderTranscript()
        // Focus has to land somewhere the user expects, and the composer is
        // where they were going anyway.
        deps.composer.focus()
        return
      case 'move':
        projectSelectedIndex = moveProjectSelection(
          projectPickerView(projectPickerState()),
          intent.direction,
        )
        renderTranscript()
        return
      case 'pick':
        // Closed before the switch rather than after it: opening a session is a
        // window-level act that ends with another pane on screen, and a popover
        // left open would be drawn again the next time this one is looked at.
        projectPickerOpen = false
        projectSelectedIndex = -1
        renderTranscript()
        deps.onSwitchProject?.(intent.root)
        return
      case 'none':
        return
      default:
        assertNever(intent)
    }
  }

  function runBranchPickerIntent(intent: BranchPickerIntent): void {
    switch (intent.kind) {
      case 'open':
        if (branchPicker.open) return
        // See `runProjectPickerIntent`: only one of the two pills' popovers is
        // ever on screen.
        projectPickerOpen = false
        projectSelectedIndex = -1
        // Opened empty and loading, then filled: branches are created and
        // deleted in a terminal beside this window, so a list cached from the
        // last open would be a lie by the second one.
        branchPicker = {
          ...createBranchPickerState(),
          open: true,
          loading: true,
          current: gitBranch,
        }
        renderTranscript()
        welcome.focusBranchPicker()
        void loadBranches()
        return
      case 'close':
        if (!branchPicker.open) return
        branchPicker = createBranchPickerState()
        renderTranscript()
        // Focus has to land somewhere the user expects, and the composer is
        // where they were going anyway.
        deps.composer.focus()
        return
      case 'move':
        branchPicker = {
          ...branchPicker,
          selectedIndex: moveBranchSelection(branchPickerView(branchPicker), intent.direction),
        }
        renderTranscript()
        return
      case 'pick':
        void switchBranch(intent.branch)
        return
      case 'none':
        return
      default:
        assertNever(intent)
    }
  }

  /** The list behind an open popover. Never throws: a failure is an empty list. */
  async function loadBranches(): Promise<void> {
    branchListToken += 1
    const token = branchListToken
    try {
      const result = await client.listBranches()
      if (token !== branchListToken || !branchPicker.open) return
      branchPicker = {
        ...branchPicker,
        loading: false,
        branches: result.branches,
        current: result.current,
      }
      // The pill draws from `gitBranch`, and this is a fresher read of HEAD than
      // `hello` left behind — a branch switched in a terminal lands here.
      gitBranch = result.current
    } catch (error) {
      if (token !== branchListToken || !branchPicker.open) return
      branchPicker = { ...branchPicker, loading: false, error: describe(error) }
    }
    renderTranscript()
  }

  /**
   * `git switch`, host-side. A refusal — a dirty worktree, most often — comes
   * back as a result rather than a throw, and it is drawn *in* the popover: the
   * user is looking at the list they just clicked, and a notice behind it is a
   * notice nobody reads. It is also posted to the transcript, which survives the
   * popover closing.
   */
  async function switchBranch(branch: string): Promise<void> {
    if (branchPicker.switching) return
    branchPicker = { ...branchPicker, switching: true, error: undefined }
    renderTranscript()
    try {
      const result = await client.switchBranch(branch)
      gitBranch = result.current
      if (result.ok) {
        branchPicker = createBranchPickerState()
        renderTranscript()
        deps.composer.focus()
        return
      }
      const message = result.message ?? `无法切换到 ${branch}`
      branchPicker = { ...branchPicker, switching: false, current: result.current, error: message }
      renderTranscript()
      note(message, 'error')
    } catch (error) {
      const message = describe(error)
      branchPicker = { ...branchPicker, switching: false, error: message }
      renderTranscript()
      note(message, 'error')
    }
  }

  function renderTranscript(): void {
    if (!active) return
    // Pruned every paint, not on reset: `transcript-reset` restarts the block
    // counter, so `thinking-0` can be minted again and would inherit the answer a
    // different block left behind — and an absolute answer would not even be
    // corrected by the default.
    const shown = withQueuedMessages(transcript, queued)
    const presented = presentationTranscript(shown)
    disclosure = pruneDisclosure(groupTranscript(presented.items), disclosure)
    const isStreaming = client.getSnapshot().isStreaming
    // A pane can find itself mid-turn without having seen `turn-start` — it was
    // resumed, or the turn began while this pane was in the background — and a
    // row counting from `undefined` would have no clock at all. Noticing the
    // turn is the honest floor for 「how long have I been waiting」.
    if (isStreaming && turnStartedAt === undefined) turnStartedAt = Date.now()
    const coordinator = deps.isCoordinator?.() ?? false
    if (coordinator) {
      const input = { projectName, opening: deps.coordinationOpening?.() ?? false }
      const key = JSON.stringify(input)
      if (key !== coordinatorWelcomeKey || !coordinatorWelcomeEl) {
        coordinatorWelcomeKey = key
        coordinatorWelcomeEl = createCoordinatorWelcome(input, () => deps.onOpenOverview?.())
      }
    }
    const strip = deps.threadStrip?.()
    const stripKey = strip ? JSON.stringify(strip) : ''
    if (stripKey !== threadChipKey) {
      threadChipKey = stripKey
      threadChipEl = strip ? threadChip(strip, (target) => deps.onOpenThreads?.(target)) : undefined
    }
    const asking = askState ? askViewModel(askState)?.header : undefined
    transcriptView.render(presented, disclosure, {
      isStreaming,
      startedAt: turnStartedAt,
      turnId: transcript.turnId,
      ...(asking === undefined ? {} : { asking }),
      ...(transcript.phase ? { phase: transcript.phase } : {}),
    }, selectedSubagent, coordinator ? coordinatorWelcomeEl : undefined, threadChipEl)
    subagentList = undefined
    // The one place that decides whether this pane has a conversation, so the
    // transcript and the welcome screen cannot disagree about it.
    welcome.render(welcomeView({
      coordinator,
      transcript: shown,
      projectName,
      global: projectGlobal,
      branch: gitBranch,
      // The global workspace is the home directory, which is not a checkout
      // anyone should be switching from a Hero screen; everywhere else the pill
      // is a control as soon as there is a branch to name.
      canSwitchBranch: !projectGlobal,
      branchPicker,
      projectPicker: projectPickerState(),
    }))
    paneEl.classList.toggle('empty', !coordinator && isTranscriptEmpty(shown))
    // Thumbnails arrive on demand, exactly as the composer's tiles do: the
    // paint draws the boxes, then each uncached id asks once. Streaming makes
    // this run per chunk; `beginPreviewLoad` is what keeps that one request.
    void loadTranscriptThumbnails(shown)
    deps.onSubagentsChanged?.()
  }

  /**
   * One `get-attachment-preview` per image id the transcript shows.
   *
   * Shares `previewCache` with the composer's tiles, so an image sent from this
   * pane keeps the thumbnail it already had — the submit moves it from the
   * draft list to a message, not from one cache to another.
   */
  async function loadTranscriptThumbnails(shown: TranscriptState): Promise<void> {
    const ids: string[] = []
    for (const item of shown.items) {
      if (item.kind !== 'user') continue
      for (const image of item.images ?? []) ids.push(image.id)
    }
    let arrived = false
    for (const id of ids) {
      const begun = beginPreviewLoad(previewCache, id)
      if (!begun.started || previewLoads.has(id)) continue
      previewCache = begun.cache
      previewLoads.add(id)
      try {
        const result = await client.getAttachmentPreview(id)
        previewCache = result.ok
          ? settlePreviewLoad(previewCache, id, result.dataUrl)
          : failPreviewLoad(previewCache, id, result.message)
        arrived = arrived || result.ok
      } catch (error) {
        previewCache = failPreviewLoad(previewCache, id, describe(error))
      } finally {
        previewLoads.delete(id)
      }
    }
    // One repaint for the batch, and only when pixels actually arrived: the
    // node signatures carry the URLs, so a failed load changes nothing to draw.
    if (arrived && active) renderTranscript()
  }

  /**
   * The conversation-presence edge the sidebar's visibility hangs on. Tracked
   * here rather than in `app.ts` so the "empty → content" moment is one
   * decision, made where the transcript is folded.
   */
  let hadConversation = false
  function noteConversationState(): void {
    const has = !isTranscriptEmpty(transcript)
    if (has && !hadConversation) deps.onFirstContent?.()
    hadConversation = has
  }

  /** Whether this pane's session has had any input or output. */
  function hasConversation(): boolean {
    return !isTranscriptEmpty(transcript)
  }

  /** `expanded` is what that row shows right now, so the click inverts what is seen. */
  let selectedSubagent: string | undefined
  /** Derived per paint, lazily: only the active pane with the panel open ever asks. */
  let subagentList: readonly SubagentEntry[] | undefined

  function setSelectedSubagent(id: string | undefined): void {
    if (id === selectedSubagent) return
    selectedSubagent = id
    renderTranscript()
  }

  function toggleDisclosureAt(id: string, expanded: boolean): void {
    disclosure = toggleDisclosure(disclosure, id, expanded)
    renderTranscript()
  }

  function renderTaskPanel(): void {
    if (!active) return
    deps.taskPanel.render(taskPanel)
  }

  /**
   * The one place `#surface` is painted. A picker wins over an information
   * table because opening either clears the other, so at most one is set.
   */
  function renderSurface(): void {
    syncTaskClock()
    if (!active) return
    if (surfaceView) deps.surface.showSurface(surfaceView, surfaceIndex)
    else if (commandView) deps.surface.showCommandView(commandView.title, commandView.rows)
  }

  function hideSurface(): void {
    surfaceView = undefined
    surfaceIndex = 0
    commandView = undefined
    armedKillId = undefined
    syncTaskClock()
    if (active) deps.surface.hide()
  }

  function syncTaskClock(): void {
    const wanted = active && surfaceView?.surface === 'background-tasks'
    if (wanted && !taskClock) taskClock = setInterval(refreshTasksSurface, 1000)
    else if (!wanted && taskClock) {
      clearInterval(taskClock)
      taskClock = undefined
    }
  }

  /**
   * Rebuilds an open `/tasks` from the client's live list, keeping the selection
   * on the same task. Skipped when nothing visible changed, so the per-chunk
   * snapshot ticks and the clock do not rebuild rows under the pointer.
   */
  function refreshTasksSurface(): void {
    if (surfaceView?.surface !== 'background-tasks') return
    const next = backgroundTasksView(client.getBackgroundTasks(), Date.now(), armedKillId)
    if (JSON.stringify(next.rows) === JSON.stringify(surfaceView.rows)) return
    const selectedId = surfaceView.rows[surfaceIndex]?.id
    const kept = next.rows.findIndex((row) => row.id === selectedId)
    surfaceView = next
    surfaceIndex = kept >= 0 ? kept : initialSurfaceSelection(next)
    renderSurface()
  }

  function toggleBackgroundTasks(): void {
    if (surfaceView?.surface === 'background-tasks') hideSurface()
    else void openSurface('background-tasks')
  }

  function renderRewind(): void {
    if (!active) return
    if (rewind) deps.rewindPanel.render(rewindViewModel(rewind))
  }

  function closeRewindPanel(): void {
    rewind = undefined
    if (active) {
      deps.rewindPanel.hide()
      deps.composer.focus()
    }
  }

  function renderStatus(): void {
    if (!active) return
    deps.status.render(client.getSnapshot(), client.getCost())
    deps.composer.setStreaming(client.getSnapshot().isStreaming)
    const runtime = client.getRuntimeSnapshot()
    // The runtime controls are repainted even when the snapshot is missing, so a
    // pane that has not finished starting shows the placeholder rather than the
    // previous pane's model.
    deps.composer.renderRuntime(
      runtime,
      contextGaugeView(client.getContextUsedTokens(), runtime),
      deps.isCoordinator?.() ?? false,
    )
    deps.processStrip.render(runningProcessCount(client.getBackgroundTasks()))
    // The strip's send-gate half follows the same snapshot: a model switch to
    // or away from image capability changes what the button should explain.
    renderAttachmentGate()
    const session = client.getSession()
    if (session) deps.status.renderSession(session)
  }

  function renderSuggestions(): void {
    if (!active) return
    deps.suggestions.render(completions)
  }

  // --- image attachments (S11) ----------------------------------------------------

  /** The strip's one view model, shared by the paint and the send gate. */
  function attachmentsView() {
    return attachmentStripView(draftImages, client.getRuntimeSnapshot(), (imageId) =>
      previewDataUrl(previewCache, imageId))
  }

  function renderAttachments(): void {
    if (!active) return
    deps.composer.renderAttachments(attachmentsView())
    // Thumbnails arrive on demand: after the paint shows the row, each ready
    // row without a cached URL asks once. A turn streaming in the meantime
    // repaints the strip per snapshot tick, and `beginPreviewLoad` keeps the
    // answer one request per id — the bounded half of S12's promise is here,
    // not in the paint.
    void loadMissingThumbnails()
  }

  /** One `get-attachment-preview` per image id per cache generation, settled into the LRU. */
  async function loadMissingThumbnails(): Promise<void> {
    const ready = readyAttachmentRefs(draftImages)
    for (const ref of ready) {
      const begun = beginPreviewLoad(previewCache, ref.id)
      if (!begun.started || previewLoads.has(ref.id)) continue
      previewCache = begun.cache
      previewLoads.add(ref.id)
      try {
        const result = await client.getAttachmentPreview(ref.id)
        previewCache = result.ok
          ? settlePreviewLoad(previewCache, ref.id, result.dataUrl)
          : failPreviewLoad(previewCache, ref.id, result.message)
      } catch (error) {
        previewCache = failPreviewLoad(previewCache, ref.id, describe(error))
      } finally {
        previewLoads.delete(ref.id)
      }
      // Only the strip's own repaint; the row gained a thumbUrl, which is a
      // signature change even though the drafts did not move.
      if (active) deps.composer.renderAttachments(attachmentsView())
    }
  }

  /** Retargets the strip after the runtime snapshot moved. */
  function renderAttachmentGate(): void {
    renderAttachments()
  }

  async function importSources(sources: readonly AttachmentImportSource[]): Promise<void> {
    if (sources.length === 0) return
    // Never skipped: an over-quota paste is turned into the reason the user
    // can act on, not a silent partial import.
    for (const source of sources) {
      if (attachmentDraftsFull(draftImages)) {
        note('已达到单次输入最多 10 张图片的上限；请先移除一些再继续。', 'error')
        return
      }
      await importOneSource(source)
    }
  }

  async function importOneSource(source: AttachmentImportSource): Promise<void> {
    const draftId = `draft-${lane}-${++draftSeq}`
    draftImages = beginAttachmentImport(draftImages, source, draftId)
    renderAttachments()
    // Bound to the session that owned the moment the import started: an id
    // settled after a `/clear`/`/resume` rebind belongs to the old session's
    // store, and landing it in the new draft list would hang a ref the new
    // session's submits cannot resolve.
    const sessionId = client.getSession()?.id
    const settled = await client.importAttachment(source)
    if (sessionId === undefined || sessionId !== client.getSession()?.id) return
    const outcome = settled.ok
      ? { ok: true as const, ref: settled.attachment.ref, ...(settled.attachment.animated ? { animated: true } : {}) }
      : { ok: false as const, reason: settled.reason, message: settled.message }
    const next = settleAttachmentImport(draftImages, draftId, outcome)
    if (next) {
      draftImages = next
      renderAttachments()
    }
  }

  async function importImagesFromFiles(files: readonly File[]): Promise<void> {
    const sources: AttachmentImportSource[] = []
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      sources.push({ kind: 'bytes', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
    }
    await importSources(sources)
  }

  async function importImagesFromPaths(paths: readonly string[]): Promise<void> {
    await importSources(paths.map((path) => ({ kind: 'path' as const, path })))
  }

  async function pickImages(): Promise<void> {
    if (!deps.onPickImages) return
    try {
      const paths = await deps.onPickImages()
      if (paths !== undefined) await importImagesFromPaths(paths)
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  async function removeDraftImage(draftId: string): Promise<void> {
    const { drafts, releasedImageId } = removeAttachmentDraft(draftImages, draftId)
    draftImages = drafts
    renderAttachments()
    if (releasedImageId === undefined) return
    try {
      await client.removeAttachment(releasedImageId)
    } catch (error) {
      // A released-but-unheld id is idempotent host-side; only a dead lane
      // reaches here, and the files still fall to the retention window.
      note(describe(error), 'error')
    }
  }

  function retryDraftImage(draftId: string): void {
    const retrying = retryAttachmentImport(draftImages, draftId)
    if (!retrying) return
    const entry = retrying.find((draft) => draft.draftId === draftId)
    draftImages = retrying
    renderAttachments()
    if (entry?.kind === 'importing') void importOneSource(entry.source)
  }

  async function openDraftImage(draftId: string): Promise<void> {
    const entry = draftImages.find((draft) => draft.draftId === draftId)
    if (entry?.kind !== 'ready') return
    try {
      const result = await client.openAttachment(entry.ref.id)
      if (!result.ok) note(formatImageFailure(result.reason, result.message), 'error')
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  /** A draft tile's click: the same viewer a sent message's thumbnail opens. */
  async function previewDraftImage(draftId: string): Promise<void> {
    const entry = readyDraftRef(draftImages, draftId)
    if (entry === undefined) return
    await viewImage(entry.ref, entry.animated)
  }

  /**
   * The fullscreen viewer (S12).
   *
   * Two tiers of pixels, in the order they can be had. The 256px thumbnail the
   * tile is already painting opens the viewer on the same frame as the click,
   * so a press never lands on an empty scrim; `get-attachment-view` then brings
   * a screen-sized copy, because the thumbnail blown up to the window is a
   * blur. The failure stays *in* the viewer rather than becoming a transcript
   * note — the user is looking at the picture, not at the conversation.
   */
  async function viewImage(ref: ImageAttachmentRef, animated = false): Promise<void> {
    if (!active) return
    const dimensions = imageDimensions(ref, animated)
    const thumbUrl = previewDataUrl(previewCache, ref.id)
    viewerState = openImageViewer({
      imageId: ref.id,
      name: ref.name,
      dimensions,
      ...(thumbUrl !== undefined ? { thumbUrl } : {}),
      zoom: openingZoom(ref),
    })
    deps.imageViewer.show(viewerState)

    try {
      const result = await client.getAttachmentView(ref.id)
      const next = result.ok
        ? settleImageViewer(viewerState, ref.id, result.dataUrl)
        : failImageViewer(viewerState, ref.id, formatImageFailure(result.reason, result.message))
      // `undefined` is the staleness guard: the viewer closed, or moved to
      // another image, while this round trip was out.
      if (next === undefined) return
      viewerState = next
    } catch (error) {
      const next = failImageViewer(viewerState, ref.id, describe(error))
      if (next === undefined) return
      viewerState = next
    }
    if (active) deps.imageViewer.show(viewerState)
  }

  /**
   * The zoom an image opens at: fitted to the stage, never enlarged. The stage
   * has no size before the first open, in which case 1 is the honest answer —
   * and the next paint measures it properly.
   */
  function openingZoom(ref: ImageAttachmentRef): number {
    const stage = deps.imageViewer.stageSize()
    return stage === undefined ? 1 : fitZoom({ width: ref.width, height: ref.height }, stage)
  }

  /** The zoom capsule and the wheel, which both hand back an already-clamped factor. */
  function setViewerZoom(zoom: number): void {
    if (viewerState === undefined) return
    viewerState = withZoom(viewerState, zoom)
    deps.imageViewer.show(viewerState)
  }

  /** The viewer reporting that it shut itself — ✕, Escape, or a press on the scrim. */
  function onViewerClosed(): void {
    viewerState = undefined
  }

  /** Shuts the viewer from this side: a pane switch, a session rebind, disposal. */
  function closeImageViewer(): void {
    if (viewerState === undefined) return
    viewerState = undefined
    deps.imageViewer.close()
  }

  /**
   * The two repaints a streaming turn drives, coalesced to one per frame each.
   *
   * Only the two host-event paths go through these — every other call site
   * (a click, `activate()`, the `hello` sequence) keeps calling the render
   * functions directly, because those paint once and then hand focus to a node
   * the paint had to have built. `createRepaint` is leading-edge, so a first
   * request out of an idle beat is synchronous anyway; what is deferred is the
   * second and later chunk of a burst.
   */
  const streamRepaint = createRepaint(() => {
    renderTranscript()
    renderTaskPanel()
  })
  /**
   * `snapshot` arrives per chunk too, and the sidebar's badges hang off it — but
   * only off the few fields in `shellKey`, so a chunk that moves none of them is
   * the status line's alone. (`hasOverlay` announces its own edges.)
   */
  let shellKey: string | undefined
  const statusRepaint = createRepaint(() => {
    renderStatus()
    const key = [
      client.getSnapshot().isStreaming,
      client.getBackgroundTasks().some((task) => task.status === 'running'),
      hasConversation(),
      client.getSession()?.id,
    ].join()
    if (key === shellKey) return
    shellKey = key
    deps.onShellChanged?.()
  })

  function note(text: string, level: 'system' | 'error' = 'system'): void {
    transcript = applySessionEvent(transcript, { type: 'notice', level, content: text }, toolDisplays).state
    renderTranscript()
  }

  // --- the four blocking requests --------------------------------------------

  /**
   * Parks a request until the user answers it. Every one of these *must* be
   * answered: `PermissionGate.approve` has no timeout, so a dropped request
   * parks the agent loop for the life of the pane. `SessionClient.answer`
   * catches a throw from the handler and falls back per kind — the second net
   * under the same rule.
   */
  function enqueue<T>(request: UiRequest): Promise<T> {
    return new Promise<T>((resolve) => {
      queue = addUiRequest(queue, request)
      resolvers.set(request.requestId, resolve as (response: unknown) => void)
      prepareActive()
      renderOverlay()
      // The sidebar's `awaiting-input` badge is derived from `shellState().hasOverlay`
      // (`app.ts:242`), and the sidebar only repaints when it is told to. Without
      // this the badge rides on whatever unrelated snapshot tick happens next:
      // it appeared only because tool activity follows a permission request, and
      // it stayed on a row whose prompt had been answered until something else
      // moved. Both `hasOverlay` transitions have to announce themselves.
      deps.onShellChanged?.()
    })
  }

  function settle(requestId: string, response: unknown): void {
    const resolve = resolvers.get(requestId)
    resolvers.delete(requestId)
    queue = removeUiRequest(queue, requestId)
    // Reply before visual exit work. hasOverlay reads this queue, never the
    // closing panel, so the shell is unblocked even while pixels remain.
    resolve?.(response)
    prepareActive()
    renderOverlay()
    deps.onShellChanged?.()
  }

  /** Resets the focused dialog's cursor state whenever the active request changes. */
  function prepareActive(): void {
    const activeRequestNow = activeRequest(queue)
    if (activeRequestNow?.requestId === preparedId) return
    preparedId = activeRequestNow?.requestId

    askState = undefined
    exitPlan = undefined
    enterPlanIndex = 0
    if (!activeRequestNow) return

    if (activeRequestNow.kind === 'permission') permissionIndex = initialPermissionIndex(activeRequestNow.payload)
    if (activeRequestNow.kind === 'ask-user-question') askState = createAskState(activeRequestNow.payload)
    if (activeRequestNow.kind === 'exit-plan') exitPlan = createExitPlanState(activeRequestNow.payload)
  }

  function renderOverlay(): void {
    const header = askState ? askViewModel(askState)?.header : undefined
    if (header !== askingHeader) {
      askingHeader = header
      renderTranscript()
    }
    const current = activeRequest(queue)
    if (!current) {
      if (active) {
        deps.overlay.hide()
        // The composer is only worth focusing once it is a composer again.
        deps.permissionRequest.hide()
        deps.composer.focus()
      }
      return
    }

    // An empty ask cannot be drawn — answer it rather than showing nothing,
    // even on a background pane: the loop is parked either way.
    if (current.kind === 'ask-user-question') {
      const view = askState ? askViewModel(askState) : undefined
      if (!view) {
        settle(current.requestId, { kind: 'rejected', feedback: 'No questions were asked.' })
        return
      }
      if (active) {
        deps.overlay.hide()
        deps.questionCard.show(view)
      }
      return
    }
    if (!active) return

    switch (current.kind) {
      case 'permission': {
        const others = permissionRequests(queue)
          .filter((entry) => entry.requestId !== current.requestId)
          .map((entry) => entry.payload)
        // The one request that is not modal: it transforms the composer instead.
        // The modal layer is closed first, because a permission request can
        // arrive on top of a plan decision that was drawn there.
        deps.overlay.hide()
        deps.permissionRequest.show(permissionViewModel({
          request: current.payload,
          selectedIndex: permissionIndex,
          activeIndex: activeIndex(queue),
          total: queue.entries.length,
          others,
        }))
        return
      }
      case 'enter-plan':
        deps.permissionRequest.hide()
        deps.overlay.enterPlan(enterPlanViewModel(enterPlanIndex))
        return
      case 'exit-plan':
        if (exitPlan) {
          deps.permissionRequest.hide()
          deps.overlay.exitPlan(exitPlanViewModel(exitPlan))
        }
        return
    }
  }

  /** Routes a keystroke to whichever dialog is on top. */
  function handleOverlayKey(event: KeyboardEvent): void {
    const current = activeRequest(queue)
    if (!current) return
    if (current.kind !== 'ask-user-question') event.preventDefault()
    const chord = {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    }

    switch (current.kind) {
      case 'permission': {
        const view = permissionViewModel({ request: current.payload, selectedIndex: permissionIndex })
        applyPermissionIntent(
          current.requestId,
          permissionKeyToIntent(chord, { selectedIndex: permissionIndex, options: view.options }),
        )
        return
      }

      case 'ask-user-question': {
        if (!askState) return
        const intent = askKeyToIntent(chord, askState)
        // Typing in the 「其他」 input is the browser's, not ours.
        if (intent.kind !== 'none' || !askState.otherMode) event.preventDefault()
        applyAsk(current.requestId, intent)
        return
      }

      case 'enter-plan':
        applyEnterPlanIntent(current.requestId, enterPlanKeyToIntent(chord, { selectedIndex: enterPlanIndex }))
        return

      case 'exit-plan': {
        if (!exitPlan) return
        applyExitPlan(current.requestId, exitPlanKeyToIntent(chord, exitPlanViewModel(exitPlan)))
        return
      }
    }
  }

  /**
   * Routes a click in the dialog: an option slot, or the button bar.
   *
   * A slot goes through the same `*IndexToIntent` its number key uses, and the
   * four `apply*` helpers below are shared with `handleOverlayKey` — so the mouse
   * cannot answer anything the keyboard would not, and a dialog that is drawn but
   * not focused (a background pane never paints) has nothing to click.
   *
   * `primary`/`secondary` exist only on the exit-plan dialog, where an option is
   * *not* an action. The permission and enter-plan bars are made of slots, so
   * those two cases cannot arrive there.
   */
  function handleOverlayAction(action: OverlayAction): void {
    const current = activeRequest(queue)
    if (!current) return

    switch (current.kind) {
      case 'permission': {
        if (action.kind !== 'slot') return
        const view = permissionViewModel({ request: current.payload, selectedIndex: permissionIndex })
        applyPermissionIntent(current.requestId, permissionIndexToIntent(action.index, view.options))
        return
      }

      case 'enter-plan':
        if (action.kind !== 'slot') return
        applyEnterPlanIntent(current.requestId, enterPlanIndexToIntent(action.index))
        return

      case 'exit-plan': {
        if (!exitPlan) return
        const view = exitPlanViewModel(exitPlan)
        applyExitPlan(
          current.requestId,
          action.kind === 'slot'
            ? exitPlanIndexToIntent(action.index, view)
            // 继续规划 is Escape: it rejects with no feedback, which is why the
            // model comments that it is the one button that can discard typing.
            : action.kind === 'primary'
              ? { kind: 'commit' }
              : { kind: 'reject' },
        )
        return
      }
    }
  }

  // The four intents, applied. Each one is reached from both the keyboard and the
  // mouse, so cursor state, `settle` and the repaint stay in one place per dialog.

  function applyPermissionIntent(requestId: string, intent: PermissionIntent): void {
    if (intent.kind === 'move') {
      permissionIndex = intent.selectedIndex
      renderOverlay()
      return
    }
    if (intent.kind === 'cycle') {
      queue = cycleActive(queue, intent.direction)
      prepareActive()
      renderOverlay()
      return
    }
    if (intent.kind === 'answer') settle(requestId, permissionResponseFor(intent.action))
  }

  function handleAskIntent(intent: AskIntent): void {
    const current = activeRequest(queue)
    if (current?.kind === 'ask-user-question') applyAsk(current.requestId, intent)
  }

  function applyAsk(requestId: string, intent: AskIntent): void {
    if (!askState) return
    const outcome = applyAskIntent(askState, intent)
    askState = outcome.state
    if ('result' in outcome) settle(requestId, outcome.result)
    else renderOverlay()
  }

  function applyEnterPlanIntent(requestId: string, intent: EnterPlanIntent): void {
    if (intent.kind === 'move') {
      enterPlanIndex = intent.selectedIndex
      renderOverlay()
      return
    }
    if (intent.kind === 'answer') settle(requestId, intent.approved)
  }

  function applyExitPlan(requestId: string, intent: ExitPlanIntent): void {
    if (!exitPlan) return
    const outcome = applyExitPlanIntent(exitPlan, intent)
    exitPlan = outcome.state
    if ('decision' in outcome) settle(requestId, outcome.decision)
    else renderOverlay()
  }

  // Installed before `hello()`: the host may post a `ui-request` at any time,
  // and with no handler the client answers the way a missing UI would.
  client.setHandlers({
    permission: (request: PermissionRequestDto) =>
      enqueue<{ approved: boolean; alwaysAllow?: boolean }>({
        kind: 'permission',
        requestId: crypto.randomUUID(),
        payload: request,
      }),
    askUserQuestion: (request: AskUserQuestionRequest) =>
      enqueue<AskUserQuestionResult>({
        kind: 'ask-user-question',
        requestId: crypto.randomUUID(),
        payload: request,
      }),
    enterPlan: () => enqueue<boolean>({ kind: 'enter-plan', requestId: crypto.randomUUID() }),
    exitPlan: (input: ExitDialogInput) =>
      enqueue<ExitPlanDecision>({
        kind: 'exit-plan',
        requestId: crypto.randomUUID(),
        payload: input,
      }),
  })

  // --- host events -------------------------------------------------------------

  client.onEvent((event) => {
    // The waiting row's clock, set before the paint that may draw it. The turn's
    // own boundaries rather than `isStreaming`'s edges: the snapshot flag is
    // polled, and 「已等待」 must start at the moment the user pressed Enter.
    if (event.type === 'turn-start') turnStartedAt = Date.now()
    if (event.type === 'turn-end') turnStartedAt = undefined
    const outcome = applySessionEvent(transcript, event, toolDisplays, Date.now())
    transcript = outcome.state
    noteConversationState()

    // Not a `default`-free switch, and deliberately so: the task panel cares
    // about three of a dozen event kinds, and `applySessionEvent` above is the
    // one that must stay exhaustive over `SessionEvent`.
    if (event.type === 'record') taskPanel = advanceTaskPanel(taskPanel, event.record)
    // `/clear`, `/resume` and a rewind all arrive here: the new record list is
    // the whole truth, and an empty one has no snapshot, so a cleared session
    // drops the panel without a case of its own.
    if (event.type === 'transcript-reset') taskPanel = taskPanelState(event.records)
    // The user starting something new, a beat before their record lands.
    if (event.type === 'turn-start') taskPanel = retireCompletedTaskPanel(taskPanel)

    // One paint for both, at most once a frame: `stream` deltas arrive per token
    // and each paint is linear in the conversation.
    streamRepaint.request()
    // The boundaries are flushed rather than left to the frame: a turn's last
    // state is what a reader is left looking at, and `transcript-reset` is a
    // different session's records — neither may land a frame late behind
    // whatever runs next.
    if (event.type === 'turn-end' || event.type === 'transcript-reset') streamRepaint.flush()

    // The controller rolled back an interrupted prompt; the record is already
    // gone from disk, so dropping this destroys the user's message.
    if (outcome.restoreInput !== undefined) {
      if (active) {
        deps.composer.setValue(outcome.restoreInput, outcome.restoreInput.length)
        deps.composer.focus()
      } else {
        draftText = outcome.restoreInput
      }
      // The images the interrupt rolled back come back as drafts. Restoring
      // never *overwrites* — the strip is appended to only when the restored
      // ids are not already in it, so a draft the user rebuilt while the turn
      // was failing is left alone (the same rule the text restore follows:
      // the event fires once, and the shell decides when to write).
      const restored = restoredAttachmentDrafts(outcome.restoreImages ?? [])
      const existing = new Set(readyAttachmentRefs(draftImages).map((ref) => ref.id))
      const missing = restored.filter((draft) => draft.kind === 'ready' && !existing.has(draft.ref.id))
      if (missing.length > 0) {
        draftImages = [...draftImages, ...missing]
        renderAttachments()
      }
    }
    // `outcome.activeModel` is deliberately not drawn: the controller emits
    // `active-model` at the end of *every* turn, so the notice it used to mint
    // said "Switched to X." after a turn that switched nothing — a row under
    // each answer, and one without a `turnId`, which split the turn's run and
    // left its elapsed time drawn twice. Each assistant message names its own
    // model on hover instead (`dom/transcriptView.ts`'s `modelLabel`).
  })

  client.onCommandEffect((effect) => {
    const intent = commandEffectToIntent(effect)
    switch (intent.kind) {
      case 'write-line':
        note(intent.text)
        return
      case 'show-view':
        surfaceView = undefined
        surfaceIndex = 0
        commandView = { title: intent.view.title, rows: intent.rows }
        renderSurface()
        deps.onShellChanged?.()
        return
      case 'open-surface':
        // Two surfaces are resolved by name before the four that build a
        // `SurfaceView`: the rewind panel is a modal of its own, and the
        // provider panel is the settings screen, which is window-level.
        if (intent.surface === 'rewind-panel') {
          void openRewindPanel()
          return
        }
        if (intent.surface === 'provider-panel') {
          if (deps.onOpenProviderSettings) deps.onOpenProviderSettings()
          else note('此界面无法打开服务商设置。', 'error')
          return
        }
        if (isSupportedSurface(intent.surface)) void openSurface(intent.surface)
        return
    }
  })

  client.onPanesChanged((next) => {
    panes = next
    deps.onShellChanged?.()
  })

  client.onQueueChanged((next) => {
    queued = next
    renderTranscript()
  })

  client.subscribe(() => {
    // Per streamed chunk, like the event above — the usage numbers, the context
    // ring and every sidebar badge ride on this one snapshot.
    statusRepaint.request()
    if (active) refreshTasksSurface()
    // A `/clear` or `/resume` rebinds the host to another session, and the
    // checkpoints on screen belong to the one it left: every option would
    // resolve to a message the new session has never heard of.
    const session = client.getSession()
    if (session && session.id !== boundSessionId) {
      boundSessionId = session.id
      // A rebind (`/clear`, `/resume`) moves the conversation: the old
      // session's drafts stay with the old session's files (S23 owns the
      // ownership rules; S11 only makes sure no ref dangles here).
      draftImages = Object.freeze([])
      if (rewind) closeRewindPanel()
      // A rebind is not a streaming tick: the header and the status line are
      // about a different session from this point, so they are drawn now.
      statusRepaint.flush()
      renderAttachments()
    }
  })

  channel.onClose(() => deps.onClosed?.())

  // --- surfaces -----------------------------------------------------------------

  async function openSurface(name: SupportedSurface): Promise<void> {
    try {
      const view = await buildSurfaceView(name)
      armedKillId = undefined
      surfaceView = view
      surfaceIndex = initialSurfaceSelection(view)
      renderSurface()
    } catch (error) {
      note(`Could not open ${name}: ${describe(error)}`, 'error')
    }
  }

  async function buildSurfaceView(name: SupportedSurface): Promise<SurfaceView> {
    switch (name) {
      case 'model-picker':
        return modelPickerView(await client.listModels())
      case 'effort-picker': {
        const runtime = client.getRuntimeSnapshot()
        return effortPickerView({
          current: runtime?.effort ?? '',
          ...(runtime?.status === 'ready' && runtime.supportedEfforts ? { supportedEfforts: runtime.supportedEfforts } : {}),
        })
      }
      case 'background-tasks':
        return backgroundTasksView(await client.listBackgroundTasks(), Date.now())
      case 'resume-picker':
        return resumePickerView({
          sessions: await client.listSessions(),
          ...(client.getSession() ? { currentSessionId: client.getSession()!.id } : {}),
        })
    }
  }

  /**
   * The composer chip's popover. A failed model list still opens it: the effort
   * half is answerable from the snapshot alone, and a chip that silently refuses
   * to open reads as the app having hung.
   */
  async function openRuntimeMenu(): Promise<void> {
    if (client.getRuntimeSnapshot()?.status === 'needs_configuration') {
      deps.onOpenProviderSettings?.()
      return
    }
    let models: WireModelsResult | undefined
    try {
      models = await client.listModels()
    } catch (error) {
      note(`Could not list models: ${describe(error)}`, 'error')
    }
    if (!active) return
    deps.composer.showRuntimeMenu(runtimeMenuView({ runtime: client.getRuntimeSnapshot(), models }))
  }

  /**
   * Runs whatever the chosen row asked for. The panel closes first: every one
   * of these changes what the panel was describing.
   */
  async function runSurfaceAction(action: SurfaceAction): Promise<void> {
    // Stopping stays in the list: the row turning 已结束 is the confirmation.
    if (action.kind === 'arm-kill' || action.kind === 'kill-task') {
      armedKillId = action.kind === 'arm-kill' ? action.taskId : undefined
      refreshTasksSurface()
      if (action.kind === 'kill-task') await client.killTask(action.taskId).catch((error: unknown) => note(describe(error), 'error'))
      return
    }
    hideSurface()
    try {
      switch (action.kind) {
        case 'run-command':
          await client.runCommand(action.line)
          void refreshCommands()
          return
        case 'open-pane':
          await client.openPane({ sessionId: action.sessionId })
          return
        case 'peek-task': {
          const output = await client.peekTaskOutput(action.taskId)
          note(output.trim().length > 0 ? output : 'No new output.')
          return
        }
        default:
          return assertNever(action)
      }
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  // --- the rewind panel ---------------------------------------------------------

  /**
   * Opens `/rewind`. The dismissible panel is closed first: a surface does not
   * block the composer, so a user can open `/model`, type `/rewind` and submit
   * it, which would otherwise leave two panels stacked. A failed checkpoint
   * read still opens the panel, empty — showing "No checkpoints available"
   * explains itself; a command that appears to do nothing does not.
   *
   * `messageId` is a user bubble's 回退 button: the panel opens on that
   * message's confirm screen, or on the list when it has no checkpoint.
   */
  async function openRewindPanel(messageId?: string): Promise<void> {
    if (messageId !== undefined && client.getSnapshot().isStreaming) {
      note('回合进行中，无法回退。', 'error')
      return
    }
    hideSurface()
    try {
      rewind = createRewindState(await client.getCheckpoints())
    } catch (error) {
      rewind = failRewindRun(createRewindState([]), describe(error))
    }
    if (messageId !== undefined) rewind = applyRewindIntent(rewind, { kind: 'select-row', id: messageId }).state
    renderRewind()
  }

  function handleRewindIntent(intent: RewindIntent): void {
    if (!rewind) return
    const outcome = applyRewindIntent(rewind, intent)
    rewind = outcome.state

    if ('close' in outcome) {
      closeRewindPanel()
      return
    }
    if ('run' in outcome) {
      rewind = beginRewindRun(rewind)
      renderRewind()
      void executeRewind(outcome.run.decision, outcome.run.checkpoint)
      return
    }
    renderRewind()
  }

  /**
   * Runs the chosen decision, then closes. The transcript is *not* rebuilt
   * here: the host's `afterRewind()` reloads the session and pushes a
   * `transcript-reset`, which the regular `onEvent` path already folds in.
   */
  async function executeRewind(
    decision: Parameters<typeof runRewind>[1],
    checkpoint: Parameters<typeof runRewind>[2],
  ): Promise<void> {
    try {
      const result = await runRewind(client, decision, checkpoint)
      closeRewindPanel()
      note(result.message, result.partial ? 'error' : 'system')
    } catch (error) {
      if (!rewind) return
      rewind = failRewindRun(rewind, describe(error))
      renderRewind()
    }
  }

  // --- completions --------------------------------------------------------------

  /**
   * Recomputes the dropdown after a keystroke. Commands are answered from the
   * list already in hand; a file mention asks the host, and the answer is
   * folded in later — and only if no newer request has been issued since,
   * which is what the echoed `seq` decides. Nothing here awaits.
   */
  function refreshCompletions(): void {
    const text = deps.composer.value()
    const query = fileCompletionQuery(text, deps.composer.cursorPos())
    if (!query) {
      completions = commandCompletions(completions, text, commands)
      renderSuggestions()
      return
    }

    const started = beginFileRequest(completions)
    completions = started.state
    void client.fileSuggestions(query.input, query.cursorPos)
      .then((found) => {
        completions = applyFileResponse(completions, started.seq, found)
        renderSuggestions()
      })
      .catch(() => {
        // Completion is a convenience; a failed lookup must not disturb the
        // composer or clobber whatever the user has typed since.
      })
  }

  function closeCompletions(): void {
    completions = clearCompletions(completions)
    renderSuggestions()
  }

  // --- input --------------------------------------------------------------------

  async function send(): Promise<void> {
    const text = deps.composer.value()
    const classified = classifyInput(text)
    if (classified.kind !== 'command' && client.getRuntimeSnapshot()?.status === 'needs_configuration') {
      note('请先配置可用模型，当前草稿已保留。', 'system')
      deps.onOpenProviderSettings?.()
      return
    }
    // An image-only input is a real message: the draft list is part of the
    // composer's content the way the textarea is, and `classifyInput`'s
    // emptiness is only about text.
    if (classified.kind === 'empty' && draftImages.length === 0) return
    if (classified.kind !== 'command' && attachmentsView().sendBlockNote !== undefined) {
      // Pending or failed attachments, or images against a text-only model:
      // the rest of the input is not sent as though it were complete, and
      // nothing is cleared.
      note(attachmentsView().sendBlockNote!, 'error')
      return
    }
    const imageIds = readyAttachmentRefs(draftImages).map((ref) => ref.id)
    // The whole input, held for the failure path: the composer was optimistically
    // cleared below, and a rejected submit must hand the user back exactly what
    // was in it — text and attachments both.
    const sentText = text
    const sentDrafts = draftImages
    deps.composer.clear()
    // Commands keep their drafts (see below); a prompt takes them with it, so
    // the strip empties with the textarea and the failure path below is what
    // puts both back.
    if (classified.kind !== 'command') clearDraftImages()
    closeCompletions()

    try {
      if (classified.kind === 'command') {
        // A slash command runs host-side; an unknown one still comes back
        // handled, with the explanation arriving as a `write-line` beforehand.
        // Commands keep the draft attachments, exactly as the TUI does:
        // `/model` mid-compose must not eat the images waiting beside it.
        const result = await client.runCommand(classified.line)
        if (result.exit) deps.onExit()
        // The command set can change under us (`/skills reload`), so re-read it.
        void refreshCommands()
        return
      }
      // Before the round trip, not after it: the message is on its way, and the
      // panel's「已接管」badge should clear as the composer does rather than a
      // network hop later.
      deps.onUserMessage?.()
      await client.submit(classified.kind === 'prompt' ? classified.text : '', imageIds.length > 0 ? { imageIds } : {})
    } catch (error) {
      // The failure restores the whole input — text and attachments. Only
      // when the composer is still exactly what was sent: a user who kept
      // typing while the submit round-tripped owns the newer draft, and the
      // attachment restore follows the same rule for the same reason.
      if (deps.composer.value() === '') deps.composer.setValue(sentText, sentText.length)
      note(`Failed: ${describe(error)}`, 'error')
      draftImages = restoreDraftImages(sentDrafts)
      renderAttachments()
    } finally {
      deps.composer.focus()
    }
  }

  /**
   * Hands the composer's text and draft attachments to the host's queue
   * instead of starting a turn. A slash command is *not* queued — commands are
   * not prompts. The composer is cleared optimistically, then restored on
   * failure, text and attachments together.
   *
   * The gate is `send()`'s: a queued message is a message, so pending or failed
   * imports and images in front of a text-only model stop it here rather than
   * being queued into a refusal the user cannot fix later.
   */
  async function queueMessage(): Promise<void> {
    const classified = classifyInput(deps.composer.value())
    if (classified.kind === 'empty' && draftImages.length === 0) return
    if (classified.kind === 'command') {
      await send()
      return
    }
    if (attachmentsView().sendBlockNote !== undefined) {
      note(attachmentsView().sendBlockNote!, 'error')
      return
    }

    const text = classified.kind === 'prompt' ? classified.text : ''
    const imageIds = readyAttachmentRefs(draftImages).map((ref) => ref.id)
    const queuedDrafts = draftImages
    deps.composer.clear()
    clearDraftImages()
    closeCompletions()
    try {
      // A queued message releases the taken-over tabs just as a sent one does:
      // mid-turn — the usual moment for a takeover — Enter queues, not sends.
      deps.onUserMessage?.()
      await client.enqueueMessage(text, imageIds.length > 0 ? { imageIds } : {})
    } catch (error) {
      if (deps.composer.value() === '') deps.composer.setValue(text, text.length)
      note(`Failed to queue: ${describe(error)}`, 'error')
      draftImages = restoreDraftImages(queuedDrafts)
      renderAttachments()
    } finally {
      deps.composer.focus()
    }
  }

  /** Empties the strip in the one step a send or a queue hand-off shares. */
  function clearDraftImages(): void {
    if (draftImages.length === 0) return
    draftImages = Object.freeze([])
    renderAttachments()
  }

  async function refreshCommands(): Promise<void> {
    try {
      commands = localizeCommands(await client.listCommands())
    } catch {
      // Completion is a convenience; losing it must not break the composer.
    }
  }

  async function refreshPanes(): Promise<void> {
    try {
      panes = await client.listPanes()
    } catch {
      return
    }
    deps.onShellChanged?.()
  }

  // --- activation -----------------------------------------------------------------

  function activate(): void {
    if (active) return
    active = true
    show(paneEl, true)
    // The draft was banked when this pane went to the background; the composer
    // is the source of truth again from here until the next deactivation.
    deps.composer.setValue(draftText, draftText.length)
    deps.composer.autosize()
    renderTranscript()
    renderAttachments()
    renderOverlay()
    renderRewind()
    if (surfaceView || commandView) renderSurface()
    else deps.surface.hide()
    renderSuggestions()
    renderTaskPanel()
    renderStatus()
    // Everything above is the whole surface, so a frame still owed from before
    // the switch has nothing left to draw.
    streamRepaint.cancel()
    statusRepaint.cancel()
    deps.composer.focus()
  }

  function deactivate(): void {
    if (!active) return
    draftText = deps.composer.value()
    active = false
    show(paneEl, false)
    // Clear the *paint* this pane left on the singleton panels, not the state:
    // a background pane's open dialogs must not leak onto whichever pane
    // becomes active, and `activate()` repaints from this pane's state when it
    // comes back. Keys never reach a background pane (the app routes to the
    // active one), so a painted-but-inert dialog would be a trap.
    deps.overlay.hide()
    // The composer is a singleton too, so a background pane's request would
    // otherwise sit in the next pane's capsule and answer *its* gate.
    deps.permissionRequest.hide(true)
    deps.rewindPanel.hide()
    deps.surface.hide()
    syncTaskClock()
    // Emptied, not remembered: the strip is a singleton on the composer's axis,
    // so a background pane's checklist would otherwise hang over the session the
    // user just switched to. `activate()` repaints it from `taskPanel`.
    deps.taskPanel.hide()
    deps.suggestions.render(NO_COMPLETIONS)
    // The composer is a singleton the active pane drives, so an open permission
    // menu would hang over the next pane and act on *its* runtime.
    deps.composer.closeMenus()
    // The viewer is a singleton too, and the picture in it belongs to *this*
    // conversation — a switch must not leave it hanging over another one. The
    // state goes with the paint: there is nothing worth restoring about "which
    // image was open" the way there is about a draft or a checklist.
    closeImageViewer()
    // Singleton surfaces must finish their exits before the next pane paints.
    finishPresenceWithin(document)
    // Ditto the attachment strip: this pane's drafts must not ride the next
    // pane's send. `activate()` repaints from this pane's own state.
    deps.composer.renderAttachments(
      attachmentStripView(Object.freeze([]), client.getRuntimeSnapshot(), (imageId) => previewDataUrl(previewCache, imageId)))
    // Nothing repaints a hidden pane, so the waiting row's clock would tick on
    // against a node nobody can see. `activate()`'s `renderTranscript()` starts
    // it again from the same `turnStartedAt`, so no time is lost.
    transcriptView.stopClock()
    // A frame owed to a pane nobody can see: the render functions would return
    // at their `if (!active)` guard anyway, but the sidebar half of
    // `statusRepaint` would not, and `activate()` repaints all of it.
    streamRepaint.cancel()
    statusRepaint.cancel()
  }

  function dispose(): void {
    if (active) closeImageViewer()
    if (taskClock) clearInterval(taskClock)
    transcriptView.dispose()
    streamRepaint.cancel()
    statusRepaint.cancel()
    client.dispose()
    paneEl.remove()
  }

  // --- the hello sequence ----------------------------------------------------------

  async function start(): Promise<void> {
    const hello = await client.hello()

    // Before the first paint, not with the other `hello` bookkeeping below: the
    // welcome screen names the project, and setting these after
    // `renderTranscript()` would show one frame of the「当前项目」fallback.
    projectName = hello.projectName
    projectGlobal = hello.projectIsGlobal
    gitBranch = hello.gitBranch

    transcript = createTranscriptState(hello.records, toolDisplays)
    for (const notice of hello.notices) {
      transcript = applySessionEvent(transcript, {
        type: 'notice',
        level: 'system',
        content: notice.content,
      }, toolDisplays).state
    }
    // Baseline, not an edge: a session opened *with* history already has its
    // content — only later transitions are "first content".
    hadConversation = !isTranscriptEmpty(transcript)
    // The reverse scan, once per pane: a session resumed mid-checklist gets its
    // panel back from the records alone (§7.3).
    taskPanel = taskPanelState(hello.records)
    renderTranscript()
    renderTaskPanel()
    renderStatus()

    boundSessionId = hello.session.id
    // Which project this pane belongs to, so the bar can tell its own tabs
    // from another project's. `projectRoot`, not `cwd`: the pane list carries
    // the normalized key, and on Windows the raw path may differ in case.
    ownProjectRoot = hello.projectRoot

    // Whatever the last window left waiting. The queue is replayed from the
    // session log, so this is not always empty even on a cold start.
    queued = hello.queuedMessages
    renderTranscript()

    await refreshCommands()

    // Best-effort initial load; a `pane-list` event will arrive shortly after.
    try {
      panes = await client.listPanes()
    } catch {
      panes = Object.freeze([])
    }

    if (hello.initialQueuedPrompt) {
      if (active) {
        deps.composer.setValue(hello.initialQueuedPrompt, hello.initialQueuedPrompt.length)
      } else {
        draftText = hello.initialQueuedPrompt
      }
    }
    if (active) deps.composer.focus()
    deps.onShellChanged?.()
  }

  function shellState(): ShellState {
    return {
      hasOverlay: activeRequest(queue) !== undefined,
      hasRewind: rewind !== undefined,
      hasSurface: surfaceView !== undefined,
      hasCommandView: commandView !== undefined,
      completions: completions.kind,
      isStreaming: client.getSnapshot().isStreaming,
      // The drafts count as composer content: an image-only draft must make
      // Enter mean "submit" rather than fall through to `newline`'s guard —
      // `keymap.ts`'s `inputEmpty` already carries exactly this meaning.
      inputEmpty: deps.composer.value().trim().length === 0 && readyAttachmentRefs(draftImages).length === 0,
    }
  }

  async function acceptCompletion(mode: 'accept' | 'submit'): Promise<void> {
    const applied = applyCompletion(completions, deps.composer.value(), deps.composer.cursorPos())
    if (mode === 'accept') {
      if (applied) deps.composer.setValue(applied.text, applied.cursorPos)
      closeCompletions()
      return
    }
    closeCompletions()
    if (!applied) return
    // Accept *and* run, the way the terminal does; Tab is accept-only. Only
    // command suggestions reach here — `keymap.ts` degrades a file mention to
    // accept-only, because it is a fragment of a sentence, not a line.
    deps.composer.setValue(applied.text.trim())
    await send()
  }

  function moveCompletion(direction: 'up' | 'down'): void {
    completions = moveCompletionState(completions, direction)
    renderSuggestions()
  }

  /**
   * A clicked completion row: focus it, then accept it exactly as Enter would.
   *
   * `completionAcceptMode` is the keymap's own rule, so a click on `/model` runs
   * it and a click on an `@` mention only fills it in — the difference is not
   * restated here.
   */
  async function acceptCompletionAt(index: number): Promise<void> {
    completions = selectCompletion(completions, index)
    renderSuggestions()
    await acceptCompletion(completionAcceptMode(shellState()))
  }

  function moveSurfaceSelection(direction: 'up' | 'down'): void {
    if (!surfaceView) return
    surfaceIndex = stepSurfaceSelection(surfaceView, surfaceIndex, direction)
    renderSurface()
  }

  function activateSurfaceRow(): void {
    if (!surfaceView) return
    const chosen = chooseSurfaceRow(surfaceView, surfaceIndex)
    if (chosen) void runSurfaceAction(chosen)
  }

  async function interrupt(): Promise<void> {
    try {
      await client.interrupt('user-cancel')
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  /**
   * The composer's permission pill.
   *
   * Straight to `set-permission-mode` rather than through a slash command,
   * unlike the model and effort chips: there is nothing to persist here (the
   * mode belongs to the live gate) and the host posts a fresh runtime snapshot
   * on the way out, so the pill repaints from the same path everything else does
   * instead of holding an optimistic guess.
   */
  async function setPermissionMode(mode: PermissionMode): Promise<void> {
    try {
      await client.setPermissionMode(mode)
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  async function submitFromForm(): Promise<void> {
    // The button path must reach the same verdict as the key map. The button
    // is not disabled mid-turn, so this branch is load-bearing.
    if (client.getSnapshot().isStreaming) {
      await queueMessage()
      return
    }
    await send()
  }

  return {
    lane,
    client,
    paneEl,
    get panes() {
      return panes
    },
    get ownProjectRoot() {
      return ownProjectRoot
    },
    get rewind() {
      return rewind
    },
    isActive: () => active,
    activate,
    deactivate,
    beginLayoutChange: () => transcriptView.beginLayoutChange(),
    syncMotion() {
      transcriptView.stopClock()
      if (!document.hidden) renderTranscript()
    },
    dispose,
    start,
    shellState,
    note,
    hasConversation,
    subagents: () => (subagentList ??= subagentEntries(presentationTranscript(transcript).items)),
    setSelectedSubagent,
    refreshWelcome: renderTranscript,
    refreshCommands: () => {
      void refreshCommands()
    },
    handleOverlayKey,
    handleAskIntent,
    handleRewindIntent,
    acceptCompletion,
    moveCompletion,
    handleOverlayAction,
    acceptCompletionAt,
    closeCompletions,
    hideSurface,
    moveSurfaceSelection,
    activateSurfaceRow,
    interrupt,
    setPermissionMode,
    send,
    queueMessage,
    submitFromForm,
    onComposerInput: () => {
      deps.composer.autosize()
      refreshCompletions()
    },
    pickImages,
    importImagesFromFiles,
    importImagesFromPaths,
    removeDraftImage,
    retryDraftImage,
    openDraftImage,
    previewDraftImage,
    setViewerZoom,
    onViewerClosed,
    openRewindPanel,
    openModelPicker: () => openSurface('model-picker'),
    openEffortPicker: () => openSurface('effort-picker'),
    openRuntimeMenu,
    runSurfaceAction,
    toggleBackgroundTasks,
    refreshPanes,
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The drafts a failed submit hands back: `ready` and `failed` entries return
 * as they were; an entry that was mid-import stays importing, because its
 * import is still running and will settle on its own — an id written here
 * would race the settlement for the same draftId.
 */
function restoreDraftImages(drafts: AttachmentDrafts): AttachmentDrafts {
  return drafts
}
