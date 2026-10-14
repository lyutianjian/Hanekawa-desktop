/**
 * The renderer for the Electron desktop shell: wiring only.
 *
 * Everything this file knows about the host arrives through `window.hanekawa`,
 * which the preload exposes via `contextBridge`. Anything imported here is
 * bundled by esbuild into `dist/desktop/renderer/app.js`.
 *
 * Three architectural rules, each with a test behind it:
 *
 * 1. Deep-import `runtime/protocol/client.js`, not the protocol barrel — the
 *    barrel transitively pulls `host.ts`/`permissionDto.ts`, which pull
 *    `node:fs` (`test/protocolClientParity.test.ts`).
 * 2. No value import of `harness/`, `services/`, `sessions/`, `commands/` or
 *    `tui/`, and no Node global. `test/rendererImports.test.ts` is the guard,
 *    because neither typecheck pass can see either problem: the renderer program
 *    already contains ~130 host files through the wire types, which is also how
 *    `@types/node`'s globals get into scope despite `"types": []`.
 * 3. Decisions live in `model/`, which is DOM-free and unit-tested; this file,
 *    `dom/` and `paneSession.ts` only turn those decisions into nodes and
 *    events. That split is mandatory rather than tidy — a `model/` module
 *    imported by a test is compiled in the base tsconfig program, which has no
 *    DOM lib.
 *
 * This file owns the window, not any conversation: the lane mux over the
 * bridge, one `ShellClient` on the `__shell` lane, one `PaneSession` per pane
 * lane, and the singleton views the *active* pane drives. Switching panes is a
 * renderer-local act (the sidebar never asks the host to focus anything) —
 * which is the whole point of the single-window design: a background pane
 * keeps streaming and its prompts keep parking until the user comes back.
 *
 * It also owns the three pieces of bookkeeping that make the sidebar and the
 * resident-pane budget work, and that nothing else can hold: which lane was
 * activated when, each lane's last streaming state (the falling edge is the cue
 * to re-read the history), and the last pulled session list. The *decisions*
 * over that state live in `model/sidebar.ts` and `../paneBudget.ts`.
 */

import { createBridgeChannel } from './bridgeChannel.js'
import { createPaneSession, type PaneSession } from './paneSession.js'
import { ShellClient } from './shellClient.js'
import { SHELL_LANE } from '../shellProtocol.js'
import { DEFAULT_PANE_LIMIT, selectEvictions, type PaneBudgetEntry } from '../paneBudget.js'
import { createLaneMux } from '../../runtime/protocol/laneChannel.js'
import { resolveKey, type ShellState } from './model/keymap.js'
import {
  createSidebarState,
  moveSelection,
  newSessionIntent,
  nextCollapsePhase,
  toggleProject,
  sidebarChordToIntent,
  sidebarKeyToIntent,
  sidebarView as buildSidebarView,
  type SidebarCollapsePhase,
  type SidebarIntent,
  type SidebarLaneStatus,
  type SidebarProjectSessions,
  type SidebarState,
} from './model/sidebar.js'
import { rewindKeyToIntent } from './model/rewindPanel.js'
import {
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_VARIABLE,
  sidebarWidthVariable,
} from './model/sidebarWidth.js'
import {
  applySettingsIntent,
  createSettingsState,
  loadSettings,
  runSettingsChanges,
  settingsChordToIntent,
  settingsKeyToIntent,
  settingsView,
  type PendingMutation,
  type SettingsIntent,
} from './model/settings.js'
import type { SettingsChange } from '../shellProtocol.js'
import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  systemThemeFromMatches,
  type ThemePreference,
} from './model/theme.js'
import { canvasHeaderView, type CanvasHeaderMenuItem } from './model/canvasHeader.js'
import { el, replace, required, show } from './dom/dom.js'
import { icon } from './dom/icons.js'
import { button } from './dom/controls.js'
import { onPressOutside } from './dom/dismiss.js'
import { createCanvasHeaderView } from './dom/canvasHeaderView.js'
import { createSettingsView } from './dom/settingsView.js'
import { createProjectsPageView } from './dom/projectsPageView.js'
import { projectCards } from './model/projectsPage.js'
import { createDockedCard } from './dom/dockedCard.js'
import { createPermissionRequestView } from './dom/permissionRequestView.js'
import { createPlanCardView } from './dom/planCardView.js'
import { createPlanPanelView } from './dom/planPanelView.js'
import { createQuestionCardView } from './dom/questionCardView.js'
import { createRewindView } from './dom/rewindView.js'
import { createSurfacePanel } from './dom/surfaceView.js'
import { createTaskPanelView } from './dom/taskPanelView.js'
import { createProcessStripView } from './dom/processStripView.js'
import { createComposerView } from './dom/composerView.js'
import { createImageViewerView } from './dom/imageViewerView.js'
import { createStatusView } from './dom/statusView.js'
import { createSuggestionsView } from './dom/suggestionsView.js'
import { createSidebarView } from './dom/sidebarView.js'
import { createTitleBarView } from './dom/titleBarView.js'
import { titleBarMenus, type TitleBarAction } from './model/titleBar.js'
import { createBrowserPanelView, browserPanelNodes } from './dom/browserPanelView.js'
import { createSubagentPanelView } from './dom/subagentPanelView.js'
import {
  SIDE_WIDTH_STORAGE_KEYS,
  SIDE_WIDTH_VARIABLES,
  newTabsForLane,
  clampSideWidth,
  parseSideWidth,
  resolveActiveTab,
  tabsForLane,
} from './model/browserPanel.js'
import { bindWindowChrome, type WindowControlsOverlay } from './dom/windowChrome.js'
import { REDUCED_MOTION_QUERY } from './model/reducedMotion.js'
import { finishPresenceWithin } from './dom/presence.js'
import type { WireCoordinationThreads, WireThreadMerge, WireThreadStatus } from '../shellProtocol.js'
import { THREAD_STATUS_LABEL, coordinationCounts, threadBySession, threadFinished, threadTone } from './model/coordinationStatus.js'
import { threadPanelView, type ThreadFold, type ThreadPanelIntent } from './model/threadPanel.js'
import { mergeBarView, type MergeBarIntent } from './model/mergeBar.js'
import {
  OVERVIEW_CLOSED_STORAGE_KEY,
  SECTIONS_COLLAPSED_STORAGE_KEY,
  SIDE_SECTIONS,
  autoOpensOverview,
  isSectionCollapsed,
  parseOverviewClosed,
  parseSectionsCollapsed,
  serializeOverviewClosed,
  serializeSectionsCollapsed,
  keepSelectedSubagent,
  sidePanelView,
  threadStripView,
  visibleSections,
  withSectionCollapsed,
  type SideMode,
  type SidePanelInput,
  type SideSection,
} from './model/sidePanel.js'
import { threadPage, type ThreadSelection } from './model/threadDetail.js'
import { createThreadPanelView } from './dom/threadPanelView.js'
import { createThreadDetailView } from './dom/threadDetailView.js'
import { createMergeBarView } from './dom/mergeBarView.js'
import { sheetStore } from './dom/workingMarkView.js'

const bridge = window.hanekawa
if (!bridge) {
  document.body.textContent = 'Preload script not loaded; please reinstall the app.'
  throw new Error('Preload bridge is missing')
}

// Reserve native controls before any button is mounted, including while the
// overlay API is still waiting for its first geometry notification.
const overlayApi = (window.navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
const disposeWindowChrome = bindWindowChrome(document.documentElement, bridge.platform, window, overlayApi)
window.addEventListener('pagehide', disposeWindowChrome, { once: true })
const titleMenus = titleBarMenus(bridge.platform)

// One transport, many lanes: session traffic rides per-pane lanes untouched,
// and the reserved `__shell` lane speaks for the window.
const mux = createLaneMux(createBridgeChannel(bridge, window))
const shellClient = new ShellClient(mux.lane(SHELL_LANE))

// Theme. The preference lives in localStorage; the resolved theme is written to
// `documentElement.dataset.theme`, which the stylesheet reads. "Follow system"
// is resolved here (in JS), so the sheet stays flat token blocks — see
// `model/theme.ts`. A light-preference user sees a brief dark frame first (the
// bare `:root` default): CSP forbids an inline pre-paint script.
//
// This block must stay *after* the transport: `applyResolvedTheme` runs at
// module top level and tells the main process to repaint the native overlay, so
// `shellClient` has to be initialised by then. It was below once, and reading a
// `const` still in its temporal dead zone threw before a single view was built
// — a window with nothing in it but the static HTML.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themePreference: ThemePreference = parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
function applyResolvedTheme(preference: ThemePreference): void {
  const theme = resolveTheme(preference, systemThemeFromMatches(darkQuery.matches))
  document.documentElement.dataset.theme = theme
  // The window's three buttons are painted by the OS into chrome the document
  // does not reach (5g), so the main process has to be told. Fire-and-forget:
  // a shell without an overlay answers `ok`, and there is nothing here for the
  // user to act on if it does not.
  void shellClient.setWindowTheme(theme).catch(() => {})
}
applyResolvedTheme(themePreference)
darkQuery.addEventListener('change', () => {
  if (themePreference === 'system') applyResolvedTheme(themePreference)
})

const motionQuery = window.matchMedia(REDUCED_MOTION_QUERY)
document.documentElement.dataset.reducedMotion = String(motionQuery.matches)

// The rail's width. A local preference like the theme above, and written the
// same way: a custom property on the document element, which both `#sidebar` and
// `.sidebar-shell` read. Never `.style.width` — painting and layout numbers
// belong to the stylesheet, and a property it declares a fallback for is the one
// hole that keeps them there.
let sidebarWidth = parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
function applySidebarWidth(px: number): void {
  sidebarWidth = clampSidebarWidth(px)
  document.documentElement.style.setProperty(
    SIDEBAR_WIDTH_VARIABLE,
    sidebarWidthVariable(sidebarWidth),
  )
}
applySidebarWidth(sidebarWidth)

// --- the singleton views ------------------------------------------------------

// The blocking requests are cards in one dock that transforms the composer. The
// window-level singletons only ever paint for the active pane, so a click belongs
// to `activePane()` — the same routing `surface` and `rewindPanel` below use.
const composerDock = createDockedCard(required('composer'), required('composer-request'), {
  onLayoutChange: () => activePane()?.beginLayoutChange(),
  onReturnFocus: () => composer.focus(),
})
const permissionRequest = createPermissionRequestView(composerDock, required('composer-request'), (action) => {
  activePane()?.handleOverlayAction(action)
})
const questionCard = createQuestionCardView(composerDock, required('composer-request'), (intent) => {
  activePane()?.handleAskIntent(intent)
})
const planCard = createPlanCardView(composerDock, required('composer-request'), {
  onEnterIntent: (intent) => activePane()?.handleEnterPlanIntent(intent),
  onExitIntent: (intent) => activePane()?.handleExitPlanIntent(intent),
  onOpenPlan: () => showSideTab('plan'),
})
const surface = createSurfacePanel(required('surface'), (action) => {
  void activePane()?.runSurfaceAction(action)
})
const suggestions = createSuggestionsView(required('suggestions'), (index) => {
  void activePane()?.acceptCompletionAt(index)
})
// Resident, and window-level like every other singleton the active pane drives:
// it lives on the composer's own axis, so exactly one is on screen at a time.
const taskPanel = createTaskPanelView(required('task-panel'))
const processStrip = createProcessStripView(required('process-strip'), () => activePane()?.toggleBackgroundTasks())
const status = createStatusView({
  usage: required('status-usage'),
  cost: required('status-cost'),
})
const composer = createComposerView({
  input: required<HTMLTextAreaElement>('input'),
  submit: required<HTMLButtonElement>('submit'),
  stop: required<HTMLButtonElement>('stop'),
  attach: required<HTMLButtonElement>('composer-attach'),
  contextIndicator: required('composer-context'),
  chipRuntime: required<HTMLButtonElement>('chip-runtime'),
  chipShell: required('composer-chip'),
  chipPermission: required<HTMLButtonElement>('chip-permission'),
  permissionShell: required('composer-permission'),
  attachStrip: required('composer-attachments'),
}, {
  // The chip's popover is built from the same picker rows `/model` and `/effort`
  // open, and picking from it runs the same slash command — so the choice
  // persists. See `dom/composerView.ts`'s header for why not `setModel`.
  onOpenRuntimeMenu: () => void activePane()?.openRuntimeMenu(),
  onRuntimeAction: (action) => void activePane()?.runSurfaceAction(action),
  // The pill is the exception: the mode is the live gate's state, so it goes
  // straight to `set-permission-mode` and repaints off the snapshot that comes
  // back.
  onSelectPermissionMode: (mode) => void activePane()?.setPermissionMode(mode),
  onAttach: () => activePane()?.onComposerInput(),
  // The S11 attachment entrances. Every one routes to the *active* pane, the
  // same routing the popovers above use — the strip and its imports belong to
  // whichever conversation the composer is currently speaking for.
  onPickImages: () => void activePane()?.pickImages(),
  onRemoveAttachment: (draftId) => void activePane()?.removeDraftImage(draftId),
  onRetryAttachment: (draftId) => activePane()?.retryDraftImage(draftId),
  onOpenAttachment: (draftId) => void activePane()?.openDraftImage(draftId),
  onPreviewAttachment: (draftId) => void activePane()?.previewDraftImage(draftId),
  onPasteImages: (files) => void activePane()?.importImagesFromFiles(files),
})
const form = required<HTMLFormElement>('input-row')
const sidebarContainer = required('sidebar')
const canvas = required('canvas')
const rewindPanel = createRewindView(required('rewind'), required('rewind-panel'), (intent) => {
  activePane()?.handleRewindIntent(intent)
})
// The fullscreen image viewer. Window-level like the two above and routed the
// same way — but fixed over the whole window rather than inside `#canvas`,
// because an image at full size has nothing to do with one lane.
const imageViewer = createImageViewerView(required('lightbox'), {
  onZoom: (zoom) => activePane()?.setViewerZoom(zoom),
  onClose: () => activePane()?.onViewerClosed(),
})

// --- the pane sessions ----------------------------------------------------------

const transcriptArea = required('transcript-area')
/** One live pane per lane, in attach order; the last entry is the fallback on removal. */
const paneSessions = new Map<string, PaneSession>()
let activeLane: string | undefined

/**
 * When each lane was last activated. A monotonic counter rather than a clock,
 * because `paneBudget` orders on it and two activations inside a millisecond are
 * a real tie.
 */
const lastActiveTick = new Map<string, number>()
let tick = 0
/** Lanes already asked to close for budget reasons, so a repeat pass is a no-op. */
const evicting = new Set<string>()

function activePane(): PaneSession | undefined {
  return activeLane !== undefined ? paneSessions.get(activeLane) : undefined
}

function attachPaneSession(lane: string): void {
  if (paneSessions.has(lane)) return
  const session = createPaneSession({
    lane,
    channel: mux.lane(lane),
    mount: transcriptArea,
    permissionRequest,
    questionCard,
    planCard,
    onPlanProposed: () => showSideTab('plan'),
    onOpenPlan: () => showSideTab('plan'),
    rewindPanel,
    surface,
    suggestions,
    taskPanel,
    processStrip,
    status,
    composer,
    imageViewer,
    loadUsage: () => shellClient.usageStats().then((result) => result.days),
    onShellChanged: () => {
      // Every pane repaints the sidebar, not just the active one: the badges are
      // per row, so a background pane starting a turn has to show up. Cached
      // state only — the view's own signature guard absorbs the ticks that
      // change nothing, and the filesystem pull hangs off `turn-end` below.
      renderSidebar()
      // The header names the active session, and a `/clear` or a rename moves
      // that name without any lane opening or closing.
      renderCanvasHeader()
    },
    // The sidebar's row for a lane-only session appears on this edge, and the
    // pull it triggers is what swaps「未命名会话」for the real first-message
    // title — the same trigger `turn-end` uses, one interaction earlier.
    onFirstContent: () => void refreshSessions(),
    // A search result's path, clicked (§6.2 检索). The lane's project is read at
    // click time, not captured — a lane outlives any one `lanes` snapshot — and
    // the reply is awaited like the canvas header's "open location": "code is
    // not installed" has to reach the transcript, not vanish. The path stays
    // cwd-relative — the shell bounds it to the project's real cwd, which only
    // the host knows.
    onOpenFile: (path, line) => openInEditor(lane, path, line),
    onOpenSubagent: (id) => openSubagent(id),
    // A wake note's [查看]: the thread table of this lane's project names the
    // thread's session, which then opens like any other.
    onOpenThread: (threadId) => {
      const root = shellClient.getLanes().find((info) => info.lane === lane)?.projectRoot
      if (root === undefined) return
      const thread = coordinationByRoot.get(root)?.threads.find((candidate) => candidate.threadId === threadId)
      if (thread) openSessionById(root, thread.sessionId)
    },
    onSubagentsChanged: () => renderSubagents(),
    isCoordinator: () => shellClient.getLanes().find((info) => info.lane === lane)?.coordinationRole === 'coordinator',
    onOpenOverview: () => showSideTab('threads'),
    threadStrip: () => {
      const info = shellClient.getLanes().find((one) => one.lane === lane)
      return threadStripView(info?.coordinationRole !== undefined, info && coordinationByRoot.get(info.projectRoot))
    },
    onOpenThreads: (target) => {
      if (target.kind === 'overview') showSideTab('threads')
      else openSessionById(activeLaneInfo()!.projectRoot, target.sessionId)
    },
    coordinationOpening: () => {
      const root = shellClient.getLanes().find((info) => info.lane === lane)?.projectRoot
      return root !== undefined && coordinationByRoot.get(root)?.openingThreadId !== undefined
    },
    onExit: () => {
      // `/exit` closes this pane, not the window: the single window holds every
      // other lane, and `window.close()` would take them all down.
      const paneId = session.client.getSession()?.id
      if (paneId !== undefined) {
        void session.client.closePane(paneId).catch((error) => session.note(describe(error), 'error'))
      }
    },
    // 「选择图片」 (S11): the OS picker over the Electron boundary. The paths
    // are handed back to this pane, which imports them through the host — the
    // renderer never reads the files itself.
    onPickImages: async () => {
      // Anchored to the lane's project so the dialog opens somewhere the
      // conversation can actually see, the same anchoring `onOpenFile` uses.
      const root = shellClient.getLanes().find((info) => info.lane === lane)?.projectRoot
      const result = await shellClient.pickImages(root)
      return result.paths
    },
    onClosed: () => removePaneSession(lane),
    // The empty state's project pill lists what the sidebar lists, minus the
    // global workspace: 最近 is a place for sessions that belong to no project,
    // not a project to start one in. Read per paint rather than captured — a
    // project can be added or removed while a Hero is on screen.
    listProjects: () =>
      projects
        .filter((project) => project.isGlobal !== true)
        .map((project) => ({ root: project.projectRoot, name: project.projectName })),
    onSwitchProject: (root) => {
      // The rail first: the group the new session lands in has to be visible, or
      // the switch leaves the user looking at a sidebar that never moved.
      revealProject(root)
      // Then the same path「新会话」takes, so "open or reuse" is decided once.
      runSidebarIntent(newSessionIntent(root))
    },
    // `/provider` is the settings screen's `provider` page — the same editor
    // `Ctrl+,` reaches, named explicitly so the command lands on it rather than
    // on whichever page the user last left open.
    onOpenProviderSettings: () => runSettingsIntent({ kind: 'open', category: 'provider' }),
    // Sending the agent a message is the other half of「交还」— the same
    // statement, made by asking for something instead of by pressing a button.
    // This lane's, not the active one's: a queued send can land on a pane the
    // user has already switched away from.
    onUserMessage: () => releaseTakenOverTabs(lane),
  })
  paneSessions.set(lane, session)
  if (!lastActiveTick.has(lane)) lastActiveTick.set(lane, tick)

  // A finished turn is when the store's derived fields move — the title a
  // session gets from its first message, its `messageCount`, its `updatedAt`.
  // The event says so directly; watching `isStreaming` for a falling edge was a
  // per-lane map reconstructing a signal already on the wire. It also fires for
  // an aborted or failed turn, which move those fields too.
  session.client.onEvent((event) => {
    if (event.type !== 'turn-end') return
    void refreshSessions()
    // A pane pinned by its turn is evictable again the moment the turn ends.
    applyPaneBudget()
  })

  session.client.subscribe(() => openModelSetupIfNeeded())
  void session.start().then(() => openModelSetupIfNeeded()).catch((error) => {
    session.note(`Failed to start: ${describe(error)}`, 'error')
  })
}

function activateLane(lane: string): void {
  leaveProjects()
  if (!paneSessions.has(lane) || activeLane === lane) return
  // Whatever the route in — the sidebar, `Ctrl+T`, the title bar menu, a lane the
  // host opened and asked us to focus — a session coming on screen is the end of
  // the settings screen. This is the single choke point for every one of them.
  leaveSettings()
  activePane()?.deactivate()
  activeLane = lane
  lastActiveTick.set(lane, ++tick)
  paneSessions.get(lane)!.activate()
  pruneSidePanel()
  applyPaneBudget()
  renderSidebar()
  // A switch changes which session the header is about, so a rename in progress
  // and a pending confirmation both belong to the pane being left.
  headerRenaming = false
  headerMenuOpen = false
  headerPendingDelete = undefined
  renderCanvasHeader()
  // The panel follows the lane: a switch changes which tabs exist and which one
  // is on screen, so the native view has to be repositioned or hidden.
  renderBrowser()
  // The merge bar belongs to the lane's project and role: hide what the last
  // lane showed now, and pull this one's after the debounce.
  renderMergeBar()
  activePane()?.refreshWelcome()
  scheduleMergePull()
  openModelSetupIfNeeded()
}

function removePaneSession(lane: string): void {
  const session = paneSessions.get(lane)
  if (!session) return
  paneSessions.delete(lane)
  lastActiveTick.delete(lane)
  evicting.delete(lane)
  session.dispose()
  if (activeLane === lane) {
    activeLane = undefined
    // Nothing is active now; the composer showed the removed pane's draft.
    composer.clear()
    // The most recently *used* pane, not the most recently attached: the same
    // order `paneBudget` evicts by, so the fallback is the one the budget would
    // have protected.
    const next = [...paneSessions.keys()].sort(
      (a, b) => (lastActiveTick.get(b) ?? 0) - (lastActiveTick.get(a) ?? 0),
    )[0]
    if (next !== undefined) activateLane(next)
  }
  renderSidebar()
  renderCanvasHeader()
}

// --- the resident-pane budget ---------------------------------------------------

/** What each live lane contributes that no wire field carries. Built once per pass. */
function laneStatuses(): Map<string, SidebarLaneStatus> {
  const statuses = new Map<string, SidebarLaneStatus>()
  for (const [lane, session] of paneSessions) {
    statuses.set(lane, {
      streaming: session.client.getSnapshot().isStreaming,
      // `hasOverlay` is "a blocking request is drawn *or* parked" — the pane
      // folds every request into its queue whether or not it is painting.
      blocked: session.shellState().hasOverlay,
      // A background process the loop left behind keeps the session busy.
      processes: session.client.getBackgroundTasks().some((task) => task.status === 'running'),
      // A lane-only session's row exists exactly once its pane has a
      // conversation — the "new sessions are invisible" rule.
      hasConversation: session.hasConversation(),
    })
  }
  return statuses
}

/**
 * Releases the coldest idle panes when too many are resident.
 *
 * Closing a pane is not closing a session: the session stays on disk and the
 * sidebar keeps its row, just without a lane. The decision is
 * `paneBudget.selectEvictions`, which never picks the active pane, one running a
 * turn, or one holding an unanswered prompt — the last because a pane's teardown
 * drains its bridge with a *denial*, so evicting it would fail the user's tool
 * call instead of asking about it.
 */
function applyPaneBudget(): void {
  const statuses = laneStatuses()
  const tabs = shellClient.getBrowserTabs()
  const laneInfos = shellClient.getLanes()
  const entries: PaneBudgetEntry[] = [...paneSessions.keys()].map((lane) => ({
    lane,
    active: lane === activeLane,
    streaming: statuses.get(lane)?.streaming ?? false,
    blocked: statuses.get(lane)?.blocked ?? false,
    processes: statuses.get(lane)?.processes ?? false,
    tabs: tabsForLane(tabs, lane).length > 0,
    coordinator: laneInfos.find((info) => info.lane === lane)?.coordinationRole === 'coordinator',
    lastActiveTick: lastActiveTick.get(lane) ?? 0,
  }))

  for (const lane of selectEvictions({ entries, limit: DEFAULT_PANE_LIMIT })) {
    if (evicting.has(lane)) continue
    const session = paneSessions.get(lane)
    const paneId = session?.client.getSession()?.id
    if (!session || paneId === undefined) continue
    evicting.add(lane)
    // Through the lane's own client, exactly like a close from the sidebar: it
    // reaches whichever `SessionWorkspace` owns the pane.
    void session.client.closePane(paneId).catch(() => {
      // The pane may already be gone; the `lanes` diff is the source of truth.
      evicting.delete(lane)
    })
  }
}

// --- the sidebar ----------------------------------------------------------------

/** History, as last pulled. Kept so a repaint never has to reach the host. */
let projects: readonly SidebarProjectSessions[] = []
/**
 * The global workspace's root key, from `list-sessions`.
 *
 * Held separately because `projects` cannot carry it: the global group is
 * filtered out of the list until it is open or has history, and「不在项目中工作」
 * needs to name it in exactly that case. Never derived from the display name —
 * the renderer is not allowed to string-match `最近`.
 */
let globalRoot: string | undefined
/** What the user last asked the rail to be. */
let collapsed = false
/** Where the rail has got to. Lags `collapsed` by one animation. */
let collapsePhase: SidebarCollapsePhase = 'expanded'
let selectedIndex = -1
let pendingDelete: string | undefined
/** The project heading with a context menu open, if any. */
let projectMenu: string | undefined
/** The project heading asking "remove from the sidebar?", if any. */
let pendingRemoveProject: string | undefined
/**
 * Deletes and removals already on screen, waiting for the host to catch up.
 *
 * Renderer-local and never persisted: they exist only for the length of one
 * round trip. `deleteSession` / `removeProject` add and then always drop them,
 * so a failure needs no rollback — the next `refreshSessions()` is the truth.
 */
const deletingSessions = new Set<string>()
const removingProjects = new Set<string>()
let searchQuery = ''
/** The workspaces folded shut in the sidebar. View state; nothing persists it. */
let collapsedProjects: ReadonlySet<string> = new Set()
let helpOpen = false
/** The「最近」filter: only the sessions that belong to no project. Not persisted. */
let recentOnly = false
/** The title bar's open menu, if any. Window-level, like the bar itself. */
let titleBarMenu: string | undefined
let sessionsInFlight = false
let sessionsAgain = false

function currentSidebarState(): SidebarState {
  return createSidebarState({
    projects,
    lanes: shellClient.getLanes(),
    laneStatus: laneStatuses(),
    activeLane,
    collapsed,
    collapsePhase,
    selectedIndex,
    pendingDelete,
    projectMenu,
    pendingRemoveProject,
    deletingSessions,
    removingProjects,
    now: Date.now(),
    // Both buttons open something, which is wrong while a blocking dialog is up.
    canCreate: !(activePane()?.shellState().hasOverlay ?? false),
    searchQuery,
    collapsedProjects,
    helpOpen,
    recentOnly,
    projectsOpen,
    coordination: coordinationByRoot,
  })
}

function renderSidebar(): void {
  const view = buildSidebarView(currentSidebarState())
  sidebar.render(view)
  renderProjects()
  // The bar's two live fields are the sidebar's: whether the rail is collapsed,
  // and whether anything may be opened right now. One call site, so they cannot
  // drift apart — the bar's own signature guard absorbs the repaints.
  titleBar.render({
    menus: titleMenus,
    openMenu: titleBarMenu,
    sidebarCollapsed: view.collapsed,
    browserOpen: browserPanelShown(),
    canCreate: view.canCreate,
  })
}

/**
 * Makes one workspace's group visible in the rail, without moving anything else.
 *
 * The two ways a group can be off screen are answered separately because they
 * are different states: a folded group is unfolded, and the「最近」filter — which
 * lists *only* the global workspace — is turned off when the project being
 * revealed is not that workspace. The rail's own collapse is left alone: a user
 * who collapsed the sidebar asked for the canvas, and a switch is not a reason
 * to overrule that.
 */
function revealProject(projectRoot: string): void {
  collapsedProjects = toggleProject(collapsedProjects, projectRoot, false)
  if (recentOnly && projectRoot !== globalRoot) recentOnly = false
  renderSidebar()
}

function renderTitleBar(): void {
  renderSidebar()
}

/**
 * Pulls the session history, coalescing concurrent callers.
 *
 * This is the only thing in the renderer that reaches the filesystem, so it runs
 * on four occasions and no others: startup, a topology change, a turn ending, and
 * a delete. A second request while one is in flight is folded into one more pass
 * rather than queued — the answer is a whole snapshot, so only the last one
 * matters.
 */
async function refreshSessions(): Promise<void> {
  if (sessionsInFlight) {
    sessionsAgain = true
    return
  }
  sessionsInFlight = true
  try {
    do {
      sessionsAgain = false
      const result = await shellClient.listSessions()
      projects = result.projects
      // A removed project takes its thread table, and so its pinned row and card, with it.
      for (const root of coordinationByRoot.keys()) {
        if (!projects.some((project) => project.projectRoot === root)) coordinationByRoot.delete(root)
      }
      globalRoot = result.globalRoot
      renderSidebar()
      // The empty state's project switcher reads this list, and nothing else
      // repaints an idle pane — a project added while the Hero is up would
      // otherwise be missing from the popover until the next keystroke.
      activePane()?.refreshWelcome()
      // The thread tables ride on the same occasions: a delete, a project added
      // or removed, a turn that started a thread.
      pullCoordination()
    } while (sessionsAgain)
  } catch (error) {
    // Keep the last good list: a sidebar that empties itself on a transient
    // failure looks like the sessions were deleted.
    activePane()?.note(`Failed to list sessions: ${describe(error)}`, 'error')
  } finally {
    sessionsInFlight = false
  }
}

function closeLane(lane: string): void {
  const session = paneSessions.get(lane)
  const paneId = session?.client.getSession()?.id
  if (!session || paneId === undefined) return
  void session.client.closePane(paneId).catch((error) => session.note(describe(error), 'error'))
}

function runSidebarIntent(intent: SidebarIntent): void {
  switch (intent.kind) {
    case 'switch':
      // Every live row is a pane that already exists, so switching is local — no
      // `focus-pane` round trip, nothing for the host to do.
      activateLane(intent.lane)
      return
    case 'open':
      void shellClient
        .openSession({ sessionId: intent.sessionId, projectRoot: intent.projectRoot })
        .catch((error) => activePane()?.note(describe(error), 'error'))
      return
    case 'close':
      closeLane(intent.lane)
      return
    case 'new': {
      // Before anything else, and unconditionally: "new session" means "put me in
      // a conversation", so it leaves the settings screen whether or not a lane
      // ends up moving. Waiting for the host's round trip (or for the early
      // return below) would leave the click looking like it did nothing.
      leaveSettings()
      leaveProjects()
      // Already in a fresh session *of the project being asked about*? Then
      // "new session" is a no-op — an empty session is invisible in the sidebar,
      // so minting another would only pile up panes nobody can see. The composer
      // keeps whatever was typed.
      //
      // The project check is load-bearing now that every group heading has its
      // own `+`: without it, clicking `+` on project B while sitting in an empty
      // session of project A silently does nothing.
      const active = activePane()
      const activeRoot = activeLaneInfo()?.projectRoot
      const sameProject = intent.projectRoot === undefined || intent.projectRoot === activeRoot
      if (active && sameProject && !active.hasConversation()) {
        composer.focus()
        return
      }
      // "New session" is a window-level act, so it goes to the shell, targeting
      // the active pane's project.
      void shellClient
        .openSession(intent.projectRoot !== undefined ? { projectRoot: intent.projectRoot } : {})
        .catch((error) => activePane()?.note(describe(error), 'error'))
      return
    }
    case 'open-project':
      // The shell puts up a native directory picker; the new project's first
      // lane arrives as a `lanes` event once it is up.
      void shellClient.openProject().catch((error) => activePane()?.note(describe(error), 'error'))
      return
    case 'open-settings':
      leaveProjects()
      runSettingsIntent({ kind: 'open' })
      return
    case 'toggle-collapse':
      collapsed = !collapsed
      collapsePhase = nextCollapsePhase(collapsePhase, collapsed, 'intent')
      renderSidebar()
      return
    case 'collapse-settled': {
      // Arrives from the view's `transitionend` or its fallback timer, and both
      // can be late — a settle that no longer matches the intent comes back
      // unchanged, and an unchanged phase must not repaint.
      const next = nextCollapsePhase(collapsePhase, collapsed, 'settled')
      if (next === collapsePhase) return
      collapsePhase = next
      renderSidebar()
      return
    }
    case 'search':
      searchQuery = intent.query
      renderSidebar()
      return
    case 'toggle-project':
      collapsedProjects = toggleProject(collapsedProjects, intent.projectRoot)
      renderSidebar()
      return
    case 'open-project-menu': {
      // "Close whatever is open" arrives on every `focusout`, so a no-op has to
      // stay a no-op rather than a repaint per focus change.
      const next = projectMenu === intent.projectRoot ? undefined : intent.projectRoot
      if (next === projectMenu) return
      // Right-clicking the heading that already has a menu closes it, the same
      // toggle the title bar's menus use.
      projectMenu = next
      // A menu opening cancels a confirmation on some *other* heading: two
      // headings asking two different questions at once is a state nobody asked
      // for and the keyboard cannot navigate.
      if (projectMenu !== undefined) pendingRemoveProject = undefined
      renderSidebar()
      return
    }
    case 'request-remove-project':
      projectMenu = undefined
      pendingRemoveProject = intent.projectRoot
      renderSidebar()
      return
    case 'cancel-remove-project':
      if (pendingRemoveProject === undefined) return
      pendingRemoveProject = undefined
      renderSidebar()
      return
    case 'open-coordinator':
      projectMenu = undefined
      renderSidebar()
      void shellClient.openCoordinator(intent.projectRoot).catch((error) => {
        activePane()?.note(`Failed to open coordinator: ${describe(error)}`, 'error')
      })
      return
    case 'confirm-remove-project':
      void removeProject(intent.projectRoot)
      return
    case 'toggle-help':
      helpOpen = !helpOpen
      renderSidebar()
      return
    case 'toggle-projects':
      if (projectsOpen) leaveProjects()
      else openProjects()
      return
    case 'toggle-recent':
      recentOnly = !recentOnly
      // The cursor indexes the *visible* rows, and the filter has just changed
      // which those are — keeping it would point at a different session.
      selectedIndex = -1
      renderSidebar()
      return
    case 'request-delete':
      pendingDelete = intent.sessionId
      renderSidebar()
      return
    case 'cancel-delete':
      if (pendingDelete === undefined) return
      pendingDelete = undefined
      renderSidebar()
      return
    case 'confirm-delete':
      void deleteSession(intent.projectRoot, intent.sessionId)
      return
    case 'move':
      selectedIndex = moveSelection(buildSidebarView(currentSidebarState()), intent.direction)
      renderSidebar()
      return
    case 'none':
      return
    default:
      // Exhaustiveness, the `commandSchema.ts` discipline. Without it this
      // switch compiles with a variant missing and silently does nothing — a
      // sidebar button that looks wired and is not. A warn rather than a throw
      // because this runs on a keystroke, and a dead intent should not take the
      // window down.
      assertNeverIntent(intent)
  }
}

function assertNeverIntent(value: never): void {
  console.warn('Unhandled sidebar intent', value)
}

/**
 * Deletes a session for good.
 *
 * The confirmation is withdrawn *before* the request rather than after: the row
 * is about to disappear, and leaving it asking while the delete is in flight
 * invites a second Enter.
 */
async function deleteSession(projectRoot: string, sessionId: string): Promise<void> {
  pendingDelete = undefined
  // The row goes *now*, not when the host answers. Deleting a session detaches
  // its lane, releases a runtime and re-lists the store, and leaving the row on
  // screen for that round trip reads as "the click did nothing" — which is
  // exactly how a second, unwanted delete gets pressed.
  deletingSessions.add(sessionId)
  renderSidebar()
  try {
    await shellClient.deleteSession(projectRoot, sessionId)
  } catch (error) {
    activePane()?.note(`Failed to delete session: ${describe(error)}`, 'error')
  } finally {
    // The list below is the truth either way: on success the session is gone
    // from it, and on failure the row comes back on its own.
    deletingSessions.delete(sessionId)
  }
  // Always, even on failure: the host may have closed the lane before throwing.
  await refreshSessions()
}

/**
 * Takes a project off the sidebar and deletes its history.
 *
 * The host unregisters the root, releases its lanes and then deletes every one
 * of that project's sessions from disk — re-opening the directory brings back an
 * empty project, not its conversations. The confirmation is withdrawn before the
 * request for the same reason `deleteSession` withdraws its own: the heading is
 * about to disappear, and one still asking invites a second answer.
 */
async function removeProject(projectRoot: string): Promise<void> {
  pendingRemoveProject = undefined
  projectMenu = undefined
  // Same rule as `deleteSession`: the group leaves on the click, not on the
  // reply. Removing a project detaches every one of its lanes first.
  removingProjects.add(projectRoot)
  renderSidebar()
  try {
    await shellClient.removeProject(projectRoot)
  } catch (error) {
    activePane()?.note(`Failed to remove project: ${describe(error)}`, 'error')
  } finally {
    removingProjects.delete(projectRoot)
  }
  // Always: a failure may still have closed lanes, and the list is the truth.
  await refreshSessions()
}

// --- project coordination ---------------------------------------------------------

/**
 * Each project's thread table, as last pulled or pushed. The shell client fires
 * `onCoordinationThreads` for both, so this map is written in one place.
 */
const coordinationByRoot = new Map<string, WireCoordinationThreads>()
/** Thread ids with a stop or resolve in flight, from the panel or the breadcrumb. */
const pendingThreads = new Set<string>()
/** The thread panel's open folds. View state; nothing persists it. */
let threadFolds: ReadonlySet<ThreadFold> = new Set()

/** Statuses a user stop applies to — the same set the thread panel offers 停止 on. */
const STOPPABLE_THREAD: ReadonlySet<WireThreadStatus> = new Set(['running', 'needs-you', 'awaiting-coordinator'])

/** Pulls every project's thread table; replies land through `onCoordinationThreads`. */
function pullCoordination(): void {
  for (const project of projects) {
    if (project.isGlobal === true) continue
    void shellClient.coordinationThreads(project.projectRoot).catch(() => {})
  }
}

function activeCoordination(): WireCoordinationThreads | undefined {
  const root = activeLaneInfo()?.projectRoot
  return root === undefined ? undefined : coordinationByRoot.get(root)
}

/** The active project has a coordinator or threads, so the 线程 tab has something to say. */
function hasCoordination(state: WireCoordinationThreads | undefined): boolean {
  return state !== undefined && (state.coordinatorSessionId !== undefined || state.threads.length > 0)
}

/** Puts a session on screen: its live lane when it has one, otherwise the host opens it. */
function openSessionById(projectRoot: string, sessionId: string): void {
  const live = shellClient.getLanes().find((info) => info.sessionId === sessionId)
  if (live) {
    activateLane(live.lane)
    return
  }
  runSidebarIntent({ kind: 'open', sessionId, projectRoot })
}

/** A user stop or 结案 of one thread; the push that follows repaints its status. */
function runThreadCommand(projectRoot: string, threadId: string, kind: 'stop' | 'resolve'): void {
  if (pendingThreads.has(threadId)) return
  pendingThreads.add(threadId)
  renderSubagents()
  const request = kind === 'stop' ? shellClient.threadStop(projectRoot, threadId) : shellClient.threadResolve(projectRoot, threadId)
  void request
    .catch((error) => activePane()?.note(`Failed to ${kind} thread: ${describe(error)}`, 'error'))
    .finally(() => {
      pendingThreads.delete(threadId)
      renderSubagents()
      renderCanvasHeader()
    })
}

function runThreadPanelIntent(intent: ThreadPanelIntent): void {
  const root = activeLaneInfo()?.projectRoot
  switch (intent.kind) {
    case 'view':
      if (root === undefined) return
      viewedThread = { projectRoot: root, threadId: intent.threadId }
      threadNotice = undefined
      renderSubagents()
      return
    case 'open':
      if (root !== undefined) openSessionById(root, intent.sessionId)
      return
    case 'stop':
    case 'resolve':
      if (root !== undefined) runThreadCommand(root, intent.threadId, intent.kind)
      return
    case 'stop-all':
      if (root === undefined) return
      void shellClient.stopAllCoordination(root).catch((error) => {
        activePane()?.note(`Failed to stop threads: ${describe(error)}`, 'error')
      })
      return
    case 'toggle-fold': {
      const next = new Set(threadFolds)
      if (!next.delete(intent.fold)) next.add(intent.fold)
      threadFolds = next
      renderSubagents()
      return
    }
    default:
      assertNeverIntent(intent)
  }
}

// --- the merge bar ------------------------------------------------------------------

const mergeBarNode = required('merge-bar')
/** The active project's pending branches, as last pulled, and the root they belong to. */
let merges: readonly WireThreadMerge[] = []
let mergesRoot: string | undefined
/** Bumped per pull; a reply whose number is no longer current is dropped. */
let mergeSeq = 0
let mergeTimer: ReturnType<typeof setTimeout> | undefined
let mergeExpanded = false
/** Thread ids whose merge, resolve or dismiss is in flight. */
const pendingMerges = new Set<string>()

/**
 * Pulls the merges after a 200ms quiet period. `pendingMerges` runs git per
 * thread host-side, so a burst of pushes is folded into one pull.
 */
function scheduleMergePull(): void {
  if (mergeTimer !== undefined) clearTimeout(mergeTimer)
  mergeTimer = setTimeout(() => {
    mergeTimer = undefined
    void pullMerges()
  }, 200)
}

async function pullMerges(): Promise<void> {
  const seq = ++mergeSeq
  const info = activeLaneInfo()
  // Only a coordination canvas draws the bar; anything else has nothing to pull.
  if (!info || info.coordinationRole === undefined) {
    merges = []
    mergesRoot = undefined
    renderMergeBar()
    return
  }
  try {
    const result = await shellClient.threadMerges(info.projectRoot)
    if (seq !== mergeSeq) return
    merges = result.merges
    mergesRoot = info.projectRoot
  } catch {
    // A failed pull keeps the last answer: the bar is a reminder, not a gate.
    return
  }
  renderMergeBar()
}

function renderMergeBar(): void {
  const info = activeLaneInfo()
  const role = info?.coordinationRole
  const view = !info || role === undefined || mergesRoot !== info.projectRoot
    ? { kind: 'hidden' as const }
    : mergeBarView({
        role,
        ...(role === 'thread'
          ? { threadId: threadBySession(coordinationByRoot.get(info.projectRoot), info.sessionId)?.threadId }
          : {}),
        projectName: info.projectName,
        merges,
        expanded: mergeExpanded,
        pending: pendingMerges,
      })
  // A paint can remove the button the user just pressed (a merge that landed
  // takes its row with it). Focus goes back to the composer, after the paint.
  const hadFocus = mergeBarNode.contains(document.activeElement)
  mergeBar.render(view)
  if (hadFocus && !mergeBarNode.contains(document.activeElement)) composer.focus()
}

function runMergeIntent(intent: MergeBarIntent): void {
  if (intent.kind === 'toggle-expanded') {
    mergeExpanded = !mergeExpanded
    renderMergeBar()
    return
  }
  const root = mergesRoot
  const threadId = intent.threadId
  if (root === undefined || pendingMerges.has(threadId)) return
  pendingMerges.add(threadId)
  renderMergeBar()
  const run = async (): Promise<void> => {
    switch (intent.kind) {
      case 'merge': {
        const result = await shellClient.mergeThread(root, threadId)
        if (result.kind !== 'merged') {
          activePane()?.note(result.message ?? `合并未完成（${result.kind}）`, result.kind === 'conflict' || result.kind === 'error' ? 'error' : 'system')
        }
        return
      }
      case 'resolve':
        await shellClient.resolveThreadMerge(root, threadId)
        return
      case 'dismiss':
        await shellClient.dismissThreadMerge(root, threadId)
        return
      default:
        assertNeverIntent(intent)
    }
  }
  void run()
    .catch((error) => activePane()?.note(describe(error), 'error'))
    .finally(() => {
      pendingMerges.delete(threadId)
      renderMergeBar()
      scheduleMergePull()
    })
}

const mergeBar = createMergeBarView(mergeBarNode, (intent) => runMergeIntent(intent))

shellClient.onCoordinationThreads((state) => {
  const previous = coordinationByRoot.get(state.projectRoot)
  coordinationByRoot.set(state.projectRoot, state)
  // A thread just started in the project on screen: bring its list up. The
  // first pull has nothing to compare with, so opening the app opens nothing.
  const started = previous !== undefined
    && state.threads.some((thread) => !previous.threads.some((known) => known.threadId === thread.threadId))
  if (state.projectRoot === activeLaneInfo()?.projectRoot) {
    if (autoOpensOverview(started, overviewClosed.has(state.projectRoot)) && !coordinated()) showSideTab('threads')
    activePane()?.refreshWelcome()
  }
  renderSidebar()
  renderCanvasHeader()
  renderSubagents()
  if (state.projectRoot === activeLaneInfo()?.projectRoot) scheduleMergePull()
})

// --- the canvas header ----------------------------------------------------------

/**
 * Session identity, at the top of the canvas.
 *
 * Window-level like the sidebar, and for the same reason: everything it draws is
 * on `WireLaneInfo`, which the host re-broadcasts whenever a title, a session or
 * a project moves. No pane is involved, so `paneSession.ts` gained nothing for
 * it — and a rename started here survives the repaint that answering it causes.
 */
let headerMenuOpen = false
let headerRenaming = false
/** The session the header's delete is asking about, not a flag — see the model. */
let headerPendingDelete: string | undefined

function activeLaneInfo() {
  return activeLane === undefined
    ? undefined
    : shellClient.getLanes().find((info) => info.lane === activeLane)
}

/** The thread the active lane runs, when it is a coordination thread. */
function activeThread() {
  const info = activeLaneInfo()
  if (info?.coordinationRole !== 'thread') return undefined
  return threadBySession(coordinationByRoot.get(info.projectRoot), info.sessionId)
}

function renderCanvasHeader(): void {
  const info = activeLaneInfo()
  const thread = activeThread()
  canvasHeader.render(canvasHeaderView({
    lane: info,
    ...(info?.coordinationRole === undefined ? {} : { role: info.coordinationRole }),
    ...(thread === undefined
      ? {}
      : {
          thread: {
            title: thread.title,
            statusLabel: THREAD_STATUS_LABEL[thread.status],
            tone: threadTone(thread.status),
            canStop: STOPPABLE_THREAD.has(thread.status) && !pendingThreads.has(thread.threadId),
          },
        }),
    menuOpen: headerMenuOpen,
    renaming: headerRenaming,
    pendingDelete: headerPendingDelete,
    // A draft draws no header: see the model. The pane is the only holder of
    // that answer — the lane list cannot tell a fresh session from an empty one.
    hasConversation: activePane()?.hasConversation() ?? false,
  }))
  composer.setLocked(thread !== undefined && threadFinished(thread.status) ? '线程已完成，不能再发消息' : undefined)
}

function closeHeaderMenu(): void {
  // Idempotent, the 5f rule: a `focusout` fires whether or not a menu is open,
  // and an unconditional repaint here would run on every click in the header.
  if (!headerMenuOpen && headerPendingDelete === undefined) return
  headerMenuOpen = false
  headerPendingDelete = undefined
  renderCanvasHeader()
}

function runHeaderMenuItem(id: CanvasHeaderMenuItem['id']): void {
  const lane = activeLaneInfo()
  if (!lane) return
  switch (id) {
    case 'rename':
      headerMenuOpen = false
      headerRenaming = true
      renderCanvasHeader()
      return
    case 'delete':
      headerPendingDelete = lane.sessionId
      renderCanvasHeader()
      return
    case 'cancel-delete':
      headerPendingDelete = undefined
      renderCanvasHeader()
      return
    case 'confirm-delete':
      headerMenuOpen = false
      headerPendingDelete = undefined
      renderCanvasHeader()
      // The same path the sidebar's confirmation takes, so a delete is one
      // choreography however it was asked for.
      void deleteSession(lane.projectRoot, lane.sessionId)
      return
  }
}

const canvasHeader = createCanvasHeaderView(required('canvas-header'), {
  onToggleMenu: () => {
    headerMenuOpen = !headerMenuOpen
    if (!headerMenuOpen) headerPendingDelete = undefined
    renderCanvasHeader()
  },
  onCloseMenu: () => closeHeaderMenu(),
  onMenuItem: (id) => runHeaderMenuItem(id),
  onRename: (title) => {
    const lane = activeLaneInfo()
    headerRenaming = false
    renderCanvasHeader()
    if (!lane) return
    void shellClient
      .renameSession(lane.projectRoot, lane.sessionId, title)
      // The lanes broadcast that follows is what repaints the title, here and in
      // the sidebar; nothing is written locally in the meantime.
      .catch((error) => activePane()?.note(`Failed to rename: ${describe(error)}`, 'error'))
  },
  onCancelRename: () => {
    if (!headerRenaming) return
    headerRenaming = false
    renderCanvasHeader()
    composer.focus()
  },
  onOpenLocation: () => {
    const lane = activeLaneInfo()
    if (!lane) return
    void shellClient
      .openInEditor(lane.projectRoot)
      .catch((error) => activePane()?.note(describe(error), 'error'))
  },
  onBackToCoordinator: () => {
    const lane = activeLaneInfo()
    if (!lane) return
    void shellClient.openCoordinator(lane.projectRoot).catch((error) => {
      activePane()?.note(`Failed to open coordinator: ${describe(error)}`, 'error')
    })
  },
  onStopThread: () => {
    const lane = activeLaneInfo()
    const thread = activeThread()
    if (lane && thread) runThreadCommand(lane.projectRoot, thread.threadId, 'stop')
  },
  onOpenThreads: () => toggleOverview(),
})

// --- the projects page ---------------------------------------------------------

/**
 * Fills the canvas with one card per coordination project. Unlike settings the
 * sidebar stays up, and any lane activation ends it — the same choke point.
 */
let projectsOpen = false
let projectsError: string | undefined
const projectsNode = required('projects')
projectsNode.tabIndex = -1
const projectsPage = createProjectsPageView(projectsNode, {
  onOpen: (projectRoot) => {
    projectsError = undefined
    void shellClient.openCoordinator(projectRoot).catch(showProjectsError)
  },
  onNew: () => {
    projectsError = undefined
    void shellClient.newCoordinatorProject().catch(showProjectsError)
  },
})

function showProjectsError(error: unknown): void {
  projectsError = describe(error)
  renderProjects()
}

function renderProjects(): void {
  projectsNode.hidden = !projectsOpen
  canvas.classList.toggle('projects-open', projectsOpen)
  document.body.classList.toggle('projects-open', projectsOpen)
  if (projectsOpen) {
    const canCreate = !(activePane()?.shellState().hasOverlay ?? false)
    projectsPage.render(projectCards(projects, coordinationByRoot, removingProjects, Date.now()), projectsError, canCreate)
  }
}

function openProjects(): void {
  leaveSettings()
  projectsOpen = true
  projectsError = undefined
  renderSidebar()
  renderBrowser()
  // Into the page: the composer behind it is hidden, and Escape must reach the page.
  const first = projectsNode.querySelector<HTMLElement>('.project-card, .projects-new')
  ;(first ?? projectsNode).focus()
}

function leaveProjects(): void {
  if (!projectsOpen) return
  projectsOpen = false
  renderSidebar()
  renderBrowser()
  composer.focus()
}

// --- settings ---------------------------------------------------------------

/**
 * The settings screen. Window-level, like the sidebar — one instance, not one
 * per pane, because there is one `ConfigService` per *project* and the screen
 * can be pointed at a project none of the open lanes belong to.
 */
let settingsState = createSettingsState()
let modelSetupOpened = false
// Seed the model with the persisted theme so the appearance picker shows it.
settingsState = { ...settingsState, themePref: themePreference }

const settingsView_ = createSettingsView(
  required('settings'),
  (intent) => runSettingsIntent(intent),
  (chord) => {
    const intent = settingsKeyToIntent(chord, settingsState)
    if (intent.kind === 'none') return false
    runSettingsIntent(intent)
    return true
  },
)

function renderSettings(): void {
  canvas.classList.toggle('settings-open', settingsState.open)
  // The screen covers the whole window, not just the canvas: the class on `body`
  // is what takes the sidebar out, and the one on `#canvas` is what hides the
  // conversation's own three regions. Two classes because the two questions have
  // different answers — a collapsed sidebar is not an open settings screen.
  document.body.classList.toggle('settings-open', settingsState.open)
  // The stylesheet hides the panel's DOM, but a native view is not in the
  // document and would keep painting over the settings screen. It has to be told.
  renderBrowser()
  settingsView_.render(settingsView(settingsState))
}

/** Once per window, including panes that finish their hello after activation. */
function openModelSetupIfNeeded(): void {
  if (modelSetupOpened || activePane()?.client.getRuntimeSnapshot()?.status !== 'needs_configuration') return
  modelSetupOpened = true
  if (!settingsState.open) runSettingsIntent({ kind: 'open', category: 'provider' })
}

/**
 * Leaves the settings screen, if it is up.
 *
 * Called from every path that puts a *conversation* on screen, which is what
 * makes "new session" outrank the screen the user happens to be on: settings is
 * a place you go, never a place a session opens behind. Idempotent, so the
 * activation path can call it unconditionally.
 */
function leaveSettings(): void {
  if (!settingsState.open) return
  runSettingsIntent({ kind: 'close' })
}

function runSettingsIntent(intent: SettingsIntent): void {
  const wasOpen = settingsState.open
  const outcome = applySettingsIntent(settingsState, intent)
  settingsState = outcome.state
  renderSettings()
  if (wasOpen && !settingsState.open) composer.focus()
  if (outcome.themePreference) {
    themePreference = outcome.themePreference
    localStorage.setItem(THEME_STORAGE_KEY, themePreference)
    applyResolvedTheme(themePreference)
  }
  if (outcome.load) void loadSettingsNow()
  // The pending batch, not the raw changes: the rows are already drawn as though
  // they landed, and `runSettingsChanges` retires them by id as the replies come.
  if (outcome.pending) void runSettingsChangesNow(outcome.pending)
}

async function loadSettingsNow(): Promise<void> {
  settingsState = await loadSettings(shellClient, settingsState, () => settingsState)
  renderSettings()
}

/** Changes that add or remove skill slash commands, so the panes' cached completion list is stale. */
function changesCommandSet(changes: readonly SettingsChange[]): boolean {
  return changes.some(
    (change) =>
      change.kind === 'set-skill-enabled'
      || change.kind === 'reload-skills'
      || change.kind === 'import-skill',
  )
}

async function runSettingsChangesNow(batch: readonly PendingMutation[]): Promise<void> {
  const projectRoot = settingsState.projectRoot
  const changes = batch.map((entry) => entry.change)
  settingsState = await runSettingsChanges(shellClient, settingsState, batch, () => settingsState)
  renderSettings()
  // The host rebuilt the runtimes, but the composer's completion list is the
  // renderer's own cache, refreshed only after a slash command runs.
  if (changesCommandSet(changes)) {
    for (const pane of paneSessions.values()) {
      if (pane.ownProjectRoot === projectRoot) pane.refreshCommands()
    }
  }
  // A provider edit can move the model every open lane runs on, and the status
  // bar reads it off the pane's own snapshot — which the host has already
  // re-posted from `refreshAfterConfigChange`. Nothing to pull here; the
  // sidebar is repainted only because the project list may have moved.
  renderSidebar()
  // Coordination settings (quiet / auto-resolve days) move effective statuses.
  pullCoordination()
}

/**
 * The title bar's menus, which only ever re-enter the app through intents that
 * already existed — the rule `model/titleBar.ts` states.
 */
function runTitleBarAction(action: TitleBarAction): void {
  switch (action) {
    case 'new-session':
      runSidebarIntent(newSessionIntent(buildSidebarView(currentSidebarState()).activeProjectRoot))
      return
    case 'open-project':
      runSidebarIntent({ kind: 'open-project' })
      return
    case 'open-settings':
      runSidebarIntent({ kind: 'open-settings' })
      return
    case 'toggle-sidebar':
      runSidebarIntent({ kind: 'toggle-collapse' })
      return
    case 'toggle-browser':
      toggleBrowserPanel()
      return
    case 'toggle-help':
      // Opening the chord panel means showing the sidebar it lives in.
      if (collapsed) runSidebarIntent({ kind: 'toggle-collapse' })
      if (!helpOpen) runSidebarIntent({ kind: 'toggle-help' })
      return
    default:
      assertNeverIntent(action)
  }
}

// --- the browser panel ----------------------------------------------------------

/**
 * The panel's width per mode, stored and applied like the rail's: a custom
 * property the stylesheet reads, never an inline `width`. `undefined` leaves the
 * stylesheet's default in force.
 */
function applySideWidth(mode: SideMode, px: number | undefined): void {
  // An empty value removes the declaration (CSSOM `setProperty`).
  document.documentElement.style.setProperty(SIDE_WIDTH_VARIABLES[mode], px === undefined ? '' : `${clampSideWidth(px)}px`)
}
for (const mode of ['browser', 'overview'] as const) {
  applySideWidth(mode, parseSideWidth(localStorage.getItem(SIDE_WIDTH_STORAGE_KEYS[mode])))
}

/**
 * Whether the panel is up. A single boolean rather than a derivation from "this
 * lane has tabs", because it has to be possible to *close* a panel whose lane
 * still has tabs — a derived flag would spring straight back open.
 */
let browserOpen = false
/**
 * Which mode the ordinary session's panel is in while `browserOpen`: the browser,
 * or the overview's stack of sections.
 */
let sideMode: SideMode = 'browser'
/**
 * A coordinator or thread session ignores `browserOpen`: its 概览 switch is
 * remembered per project, and the browser is a second mode beside it.
 */
let overviewClosed = parseOverviewClosed(localStorage.getItem(OVERVIEW_CLOSED_STORAGE_KEY))
/** The browser has been raised in a coordination session, so its strip offers it. */
let coordBrowser = false
/** The mode a coordination session has up, kept apart from the ordinary session's `sideMode`. */
let coordMode: SideMode = 'overview'
/** The sections each project's user folded; the overview's memory, like `overviewClosed`. */
let sectionsCollapsed = parseSectionsCollapsed(localStorage.getItem(SECTIONS_COLLAPSED_STORAGE_KEY))

function coordinated(): boolean {
  return activeLaneInfo()?.coordinationRole !== undefined
}

function sidePanelInput(): SidePanelInput {
  const root = activeLaneInfo()?.projectRoot
  const pane = activePane()
  const isCoordinated = coordinated()
  return {
    coordinated: isCoordinated,
    browserOpen,
    mode: isCoordinated ? coordMode : sideMode,
    overviewClosed: root !== undefined && overviewClosed.has(root),
    has: {
      browser: !isCoordinated || (coordBrowser && laneHasBrowserTabs()),
      plan: pane?.plan() !== undefined,
      subagents: (pane?.subagents().length ?? 0) > 0,
      threads: isCoordinated || hasCoordination(activeCoordination()),
    },
  }
}

function laneHasBrowserTabs(): boolean {
  const lane = activeLane
  return mintingTabs > 0 || (lane !== undefined && tabsForLane(shellClient.getBrowserTabs(), lane).length > 0)
}

function setMode(mode: SideMode): void {
  if (coordinated()) coordMode = mode
  else sideMode = mode
}

/** Drops what the session on screen has nothing behind: the raised browser, a sub-agent selection. */
function pruneSidePanel(): void {
  if (!laneHasBrowserTabs()) coordBrowser = false
  const entries = activePane()?.subagents() ?? []
  selectedSubagent = keepSelectedSubagent(selectedSubagent, entries.map((entry) => entry.id))
}

function browserPanelShown(): boolean {
  const { open, mode } = sidePanelView(sidePanelInput())
  return open && mode === 'browser'
}

/** Opens or collapses the panel: the 概览 switch in a coordination session, the browser switch elsewhere. */
function setPanelOpen(open: boolean): void {
  const root = activeLaneInfo()?.projectRoot
  if (coordinated() && root !== undefined) {
    const next = new Set(overviewClosed)
    if (open) next.delete(root)
    else next.add(root)
    overviewClosed = next
    try {
      localStorage.setItem(OVERVIEW_CLOSED_STORAGE_KEY, serializeOverviewClosed(next))
    } catch {
      // Storage full or blocked: the choice still holds for this window.
    }
  } else {
    browserOpen = open
  }
}

function setSectionCollapsed(section: SideSection, fold: boolean): void {
  const root = activeLaneInfo()?.projectRoot
  if (root === undefined || isSectionCollapsed(sectionsCollapsed, root, section) === fold) return
  sectionsCollapsed = withSectionCollapsed(sectionsCollapsed, root, section, fold)
  try {
    localStorage.setItem(SECTIONS_COLLAPSED_STORAGE_KEY, serializeSectionsCollapsed(sectionsCollapsed))
  } catch {
    // Storage full or blocked: the choice still holds for this window.
  }
}

/** The sub-agent on its own page in the panel; `undefined` is the list. */
let selectedSubagent: string | undefined
/** Which tab each lane last had on screen, so switching back restores it. */
const browserActiveTab = new Map<string, string>()

function noteBrowserError(error: unknown): void {
  activePane()?.note(describe(error), 'error')
}

const browserPanel = createBrowserPanelView(browserPanelNodes(), {
  onSelectTab: (tabId) => {
    if (activeLane !== undefined) browserActiveTab.set(activeLane, tabId)
    renderBrowser()
  },
  onCloseTab: (tabId) => void shellClient.browserCloseTab(tabId).catch(noteBrowserError),
  onNewTab: () => {
    if (activeLane !== undefined) createPanelTab(activeLane)
  },
  onNavigate: (tabId, url) => void shellClient.browserNavigate(tabId, url).catch(noteBrowserError),
  onBack: (tabId) => void shellClient.browserGoBack(tabId).catch(noteBrowserError),
  onForward: (tabId) => void shellClient.browserGoForward(tabId).catch(noteBrowserError),
  onReload: (tabId) => void shellClient.browserReload(tabId).catch(noteBrowserError),
  onTakeOver: (tabId) => void shellClient.browserTakeOver(tabId).catch(noteBrowserError),
  onRelease: (tabId) => void shellClient.browserRelease(tabId).catch(noteBrowserError),
  // Fire-and-forget by construction — see `ShellClient.browserSetBounds`.
  onBounds: (tabId, rect, visible) => shellClient.browserSetBounds(tabId, rect, visible),
})

function renderBrowser(): void {
  const tabs = shellClient.getBrowserTabs()
  const lane = activeLane
  const activeTabId = resolveActiveTab(
    tabs,
    lane,
    lane === undefined ? undefined : browserActiveTab.get(lane),
  )
  if (lane !== undefined && activeTabId !== undefined) browserActiveTab.set(lane, activeTabId)
  browserPanel.render({
    tabs,
    lane,
    activeTabId,
    open: browserPanelShown(),
    // The settings screen fills the canvas and owns the window; a page painted
    // beside it would be the one thing on screen it does not cover.
    occluded: settingsState.open || projectsOpen,
  })
  renderSubagents()
}

// --- the side panel's other half: sub-agents -----------------------------------

const sidePanel = required('browser-panel')
const sideTabs = required('side-tabs')
const sideResizer = required('browser-resizer')
const subagentPanel = createSubagentPanelView(required('subagent-view'), {
  onSelect: (id) => {
    selectedSubagent = id
    renderSubagents()
  },
  loadTranscript: async (agentId) => (await activePane()?.client.getSubagentTranscript(agentId))?.records ?? [],
  onOpenPath: (path, line) => {
    if (activeLane !== undefined) openInEditor(activeLane, path, line)
  },
  onStop: (id) => {
    const client = activePane()?.client
    const task = client?.getBackgroundTasks().find((candidate) => candidate.toolUseId === id && candidate.status === 'running')
    if (task) void client!.killTask(task.id).catch(() => {})
  },
})
const planPanel = createPlanPanelView(required('plan-view'))
const threadView = required('thread-view')
const threadPanel = createThreadPanelView(threadView, (intent) => runThreadPanelIntent(intent))
const threadDetailHost = required('thread-detail-view')
const threadDetail = createThreadDetailView(threadDetailHost, {
  onBack: () => {
    viewedThread = undefined
    renderSubagents()
  },
  onOpen: (sessionId) => {
    const root = activeLaneInfo()?.projectRoot
    if (root !== undefined) openSessionById(root, sessionId)
  },
  onStop: (threadId) => {
    const root = activeLaneInfo()?.projectRoot
    if (root !== undefined) runThreadCommand(root, threadId, 'stop')
  },
  loadTranscript: (threadId, since) => viewedThread === undefined ? Promise.reject(new Error('No thread on screen')) : shellClient.threadTranscript(viewedThread.projectRoot, threadId, since),
  onOpenPath: (path, line) => {
    if (activeLane !== undefined) openInEditor(activeLane, path, line)
  },
})
/** The thread on its own page in the 概览 tab; `undefined` is the list. */
let viewedThread: ThreadSelection | undefined
/** Why the page the user was on went back to the list; gone after a few seconds. */
let threadNotice: string | undefined
let threadNoticeTimer: ReturnType<typeof setTimeout> | undefined
/** The strip's last paint, so a stream delta does not rebuild buttons under the pointer. */
let sideTabsDrawn: string | undefined

interface SectionNode { section: HTMLElement; head: HTMLElement; title: HTMLElement; count: HTMLElement; body: HTMLElement }
const sectionNodes: Record<SideSection, SectionNode> = {
  plan: sectionNode('plan'),
  subagents: sectionNode('subagents'),
  threads: sectionNode('threads'),
}
const sideSections = required('side-sections')

function sectionNode(id: SideSection): SectionNode {
  const section = required(`side-section-${id}`)
  const head = required(`side-section-${id}-head`)
  const title = el('span', 'side-section-title')
  const count = el('span', 'side-section-count')
  replace(head, title, count, icon('chevron-down'))
  head.addEventListener('click', () => {
    setSectionCollapsed(id, head.getAttribute('aria-expanded') === 'true')
    renderSubagents()
  })
  return { section, head, title, count, body: required(`side-section-${id}-body`) }
}

function renderSubagents(): void {
  const input = sidePanelInput()
  const view = sidePanelView(input)
  const visible = view.open && !settingsState.open && !projectsOpen
  show(sidePanel, visible)
  show(sideResizer, visible)
  sidePanel.classList.toggle('overview', view.mode === 'overview')
  const pane = activePane()
  const root = activeLaneInfo()?.projectRoot
  const onOverview = visible && view.mode === 'overview'
  const entries = onOverview ? pane?.subagents() ?? [] : []
  const coordination = activeCoordination()
  const plan = onOverview ? pane?.plan() : undefined
  const running = entries.filter((entry) => entry.status === 'running' || entry.status === 'awaiting-approval').length
  const labels: Record<SideMode, string> = { browser: '浏览器', overview: '概览' }
  const stripVisible = visible && (view.modes.length > 1 || view.mode === 'overview')
  show(sideTabs, stripVisible)
  sideTabs.classList.toggle('solo', view.modes.length < 2)
  const strip = `${view.mode}|${view.modes.join(',')}`
  if (strip !== sideTabsDrawn) {
    sideTabsDrawn = strip
    const tabNodes = view.modes.length < 2
      ? []
      : view.modes.map((mode) => {
        const node = button(`side-tab${view.mode === mode ? ' active' : ''}`, labels[mode], labels[mode], () => showSideTab(mode === 'browser' ? 'browser' : undefined))
        node.setAttribute('role', 'tab')
        node.setAttribute('aria-selected', String(view.mode === mode))
        return node
      })
    replace(
      sideTabs,
      ...tabNodes,
      button('side-tab-close', '✕', '关闭侧栏', () => {
        setPanelOpen(false)
        renderSidebar()
        renderBrowser()
      }),
    )
  }
  show(sideSections, onOverview)
  // A page opened inside a section stands alone; it is the thread detail, or the sub-agent the user selected.
  const page = onOverview && view.sections.includes('threads') ? threadPage(viewedThread, coordination, pendingThreads) : undefined
  const detail = page?.kind === 'detail' ? page : undefined
  const folded = new Set(SIDE_SECTIONS.filter((id) => isSectionCollapsed(sectionsCollapsed, root, id)))
  const shown = visibleSections(
    view.sections,
    folded,
    detail !== undefined ? 'threads' : selectedSubagent !== undefined ? 'subagents' : undefined,
  )
  const titles: Record<SideSection, string> = {
    plan: '计划',
    subagents: '子代理',
    threads: '线程',
  }
  const counts: Record<SideSection, string> = {
    plan: '',
    subagents: running > 0 ? `${running} 运行中` : '',
    threads: hasCoordination(coordination) ? `${coordinationCounts(coordination!.threads).running} 运行中` : '',
  }
  for (const id of SIDE_SECTIONS) {
    const node = sectionNodes[id]
    const present = onOverview && shown.sections.includes(id)
    const open = !folded.has(id)
    show(node.section, present)
    node.section.classList.toggle('focus', shown.focus === id)
    node.head.setAttribute('aria-expanded', String(open))
    node.title.textContent = titles[id]
    node.count.textContent = counts[id]
    show(node.body, open)
  }
  const bodyOpen = (id: SideSection): boolean => onOverview && shown.sections.includes(id) && !folded.has(id)
  if (bodyOpen('plan')) planPanel.render(plan)
  if (bodyOpen('subagents')) subagentPanel.render({ entries, selected: selectedSubagent })
  const onThreads = bodyOpen('threads')
  if (page?.kind === 'list' && page.clear) {
    viewedThread = undefined
    if (page.notice !== undefined) {
      threadNotice = page.notice
      clearTimeout(threadNoticeTimer)
      threadNoticeTimer = setTimeout(() => {
        threadNotice = undefined
        renderSubagents()
      }, 4000)
    }
  }
  show(threadView, onThreads && detail === undefined)
  show(threadDetailHost, onThreads && detail !== undefined)
  threadDetail.render(onThreads ? detail : undefined)
  if (onThreads && detail === undefined) {
    threadPanel.render(threadPanelView({
      state: coordination,
      now: Date.now(),
      activeSessionId: activeLaneInfo()?.sessionId,
      expanded: threadFolds,
      pending: pendingThreads,
      notice: threadNotice,
    }))
  }
  // A folded section keeps its selection: unfolding brings the same page back.
  pane?.setSelectedSubagent(onOverview && view.sections.includes('subagents') ? selectedSubagent : undefined)
}

/**
 * Raise the panel onto the browser or onto the overview. A section named here is
 * unfolded, so the thing the user asked to see is not behind a closed head.
 */
function showSideTab(target: 'browser' | SideSection | undefined): void {
  if (target === 'browser' && coordinated()) coordBrowser = true
  if (target !== undefined && target !== 'browser') setSectionCollapsed(target, false)
  setPanelOpen(true)
  setMode(target === 'browser' ? 'browser' : 'overview')
  // The title bar's browser button draws the browser half only.
  renderSidebar()
  // Opening onto nothing would be a blank panel, so the browser's first showing mints a tab.
  if (target === 'browser' && activeLane !== undefined && tabsForLane(shellClient.getBrowserTabs(), activeLane).length === 0) {
    createPanelTab(activeLane)
  }
  renderBrowser()
}

/** The title bar's browser button in a coordination session: back to the overview, the browser still on its strip's far side. */
function leaveBrowserMode(): void {
  coordBrowser = false
  coordMode = 'overview'
  renderSidebar()
  renderBrowser()
}

/** The 概览 button: collapses the panel when it is up, otherwise raises it onto the overview. */
function toggleOverview(): void {
  if (!sidePanelView(sidePanelInput()).open) {
    showSideTab(undefined)
    return
  }
  setPanelOpen(false)
  renderSidebar()
  renderBrowser()
}

function openSubagent(id: string): void {
  selectedSubagent = id
  showSideTab('subagents')
}

/**
 * Every tab the host has announced, so an arrival can be told from a change.
 *
 * Across every lane, not just the active one: a tab that first appears on a
 * background lane is not new any more when that lane is activated, and raising
 * the panel then would be the agent calling from a conversation the user has
 * already left.
 */
let knownBrowserTabs: ReadonlySet<string> = new Set()

/**
 * The user is talking to the agent again, so the browser goes back to it.
 *
 * Quiet on failure, unlike the button: this rides every send, the tab may have
 * closed under it, and a message the user sent is not the place to report that.
 */
function releaseTakenOverTabs(lane: string): void {
  for (const tab of tabsForLane(shellClient.getBrowserTabs(), lane)) {
    if (tab.takenOver === true) void shellClient.browserRelease(tab.tabId).catch(() => {})
  }
}

/** Panel-minted tabs whose create has not answered yet. */
let mintingTabs = 0

/**
 * A tab the user asked the panel for. Its arrival must not count as the agent
 * opening a page: the broadcast can land before or after the reply, and a panel
 * closed in between would otherwise be raised again by its own tab.
 */
function createPanelTab(lane: string): void {
  mintingTabs++
  void shellClient
    .browserCreateTab(lane)
    .then(({ tabId }) => {
      knownBrowserTabs = new Set([...knownBrowserTabs, tabId])
      browserActiveTab.set(lane, tabId)
      renderBrowser()
    })
    .catch(noteBrowserError)
    .finally(() => {
      mintingTabs--
    })
}

/**
 * The title bar's browser button. With the panel on its sub-agents it switches to
 * the browser rather than closing. Closing never touches the tabs: they belong
 * to the lane, not to the panel.
 */
function toggleBrowserPanel(): void {
  if (browserPanelShown()) {
    if (coordinated()) {
      leaveBrowserMode()
    } else {
      browserOpen = false
      renderSidebar()
      renderBrowser()
    }
    return
  }
  showSideTab('browser')
}

const titleBar = createTitleBarView(
  required('titlebar'),
  (action) => runTitleBarAction(action),
  (id) => {
    titleBarMenu = id
    renderTitleBar()
  },
  required('canvas-header'),
)

const sidebar = createSidebarView(
  sidebarContainer,
  (intent) => runSidebarIntent(intent),
  (chord) => {
    const intent = sidebarKeyToIntent(chord, currentSidebarState())
    if (intent.kind === 'none') return false
    runSidebarIntent(intent)
    return true
  },
  bridge.platform,
)

// Settle existing work when the OS preference changes or the window hides.
// Views read the current preference for every new intent; business state and
// pending requests remain owned by each pane throughout this visual cleanup.
function syncMotion(): void {
  document.documentElement.dataset.reducedMotion = String(motionQuery.matches)
  document.documentElement.dataset.windowHidden = String(document.hidden)
  finishPresenceWithin(document)
  sidebar.finishMotion()
  permissionRequest.finishMotion()
  taskPanel.finishMotion()
  for (const pane of paneSessions.values()) pane.syncMotion()
  if (motionQuery.matches || document.hidden) {
    // Changing transition-duration does not retime an already-running CSS
    // transition when its target value is unchanged. Apply the settled style
    // immediately; presence/fallback cleanup above already handled lifecycle.
    for (const animation of document.getAnimations?.() ?? []) {
      if ('transitionProperty' in animation) animation.cancel()
    }
  }
}
motionQuery.addEventListener('change', syncMotion)
document.addEventListener('visibilitychange', syncMotion)
// Decoded once the window is idle, so the first turn's mark grows in rather than starting as a dot.
sheetStore.prefetch()
window.addEventListener('pagehide', () => {
  motionQuery.removeEventListener('change', syncMotion)
  document.removeEventListener('visibilitychange', syncMotion)
  syncMotion()
  for (const pane of paneSessions.values()) pane.dispose()
})

// --- the rail's drag handle ---------------------------------------------------

/**
 * Dragging the sidebar's right edge.
 *
 * Pointer events with capture rather than document-level mouse listeners: the
 * pointer leaves the 3px handle on the first frame of any real drag, and capture
 * is what keeps the moves coming without a listener the teardown has to
 * remember. `body.resizing` is not cosmetic — `#sidebar` transitions
 * `flex-basis` for the collapse, so without it every dragged frame would chase a
 * layout curve.
 */
const sidebarResizer = required('sidebar-resizer')
let dragStartX = 0
let dragStartWidth = SIDEBAR_WIDTH_DEFAULT

sidebarResizer.addEventListener('pointerdown', (event) => {
  // Primary button only: a right-click here belongs to nothing, and starting a
  // drag on it would leave the rail following a pointer the user is not moving.
  if (event.button !== 0) return
  event.preventDefault()
  dragStartX = event.clientX
  dragStartWidth = sidebarWidth
  sidebarResizer.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing')
})

sidebarResizer.addEventListener('pointermove', (event) => {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return
  applySidebarWidth(dragStartWidth + (event.clientX - dragStartX))
})

function endSidebarDrag(event: PointerEvent): void {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return
  sidebarResizer.releasePointerCapture(event.pointerId)
  document.body.classList.remove('resizing')
  // Written once at the end, not per frame: a drag is one decision, and
  // `localStorage` is synchronous.
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
}
sidebarResizer.addEventListener('pointerup', endSidebarDrag)
// A cancelled pointer (the window losing focus mid-drag) must not leave the body
// stuck in `resizing`, which would kill the collapse animation for good.
sidebarResizer.addEventListener('pointercancel', endSidebarDrag)

sidebarResizer.addEventListener('dblclick', () => {
  applySidebarWidth(SIDEBAR_WIDTH_DEFAULT)
  localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
})

/**
 * The browser panel's drag handle — the rail's, mirrored.
 *
 * The sign is the whole difference: this handle is on the panel's *left* edge,
 * so dragging left (a falling `clientX`) makes the panel wider.
 */
const browserResizer = required('browser-resizer')
let browserDragStartX = 0
let browserDragStartWidth = 0
let browserDragWidth = 0
/** The mode whose width the drag writes; fixed at the press so a repaint mid-drag cannot switch it. */
let browserDragMode: SideMode = 'browser'

browserResizer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  browserDragMode = sidePanelView(sidePanelInput()).mode
  browserDragStartX = event.clientX
  // Measured rather than remembered: the default is a share of the window, not a number.
  browserDragStartWidth = browserDragWidth = sidePanel.getBoundingClientRect().width
  browserResizer.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing')
})

browserResizer.addEventListener('pointermove', (event) => {
  if (!browserResizer.hasPointerCapture(event.pointerId)) return
  browserDragWidth = clampSideWidth(browserDragStartWidth - (event.clientX - browserDragStartX))
  applySideWidth(browserDragMode, browserDragWidth)
  // The hole moved with the column. `ResizeObserver` would catch this too, but
  // only after a layout pass — measuring now is what keeps the page glued to
  // the panel instead of trailing it by a frame.
  browserPanel.measure()
})

function endBrowserDrag(event: PointerEvent): void {
  if (!browserResizer.hasPointerCapture(event.pointerId)) return
  browserResizer.releasePointerCapture(event.pointerId)
  document.body.classList.remove('resizing')
  localStorage.setItem(SIDE_WIDTH_STORAGE_KEYS[browserDragMode], String(browserDragWidth))
}
browserResizer.addEventListener('pointerup', endBrowserDrag)
browserResizer.addEventListener('pointercancel', endBrowserDrag)

browserResizer.addEventListener('dblclick', () => {
  const mode = sidePanelView(sidePanelInput()).mode
  applySideWidth(mode, undefined)
  browserPanel.measure()
  localStorage.removeItem(SIDE_WIDTH_STORAGE_KEYS[mode])
})

// --- the window's own dismissals ---------------------------------------------------

/**
 * The two popovers anchored to the composer — the `/model` and `/effort` cards
 * in `#surface`, and the slash-command completions — close on a press outside
 * the input row.
 *
 * Window-level rather than inside `composerView.ts` because both belong to a
 * *pane*: `#surface` and `#suggestions` are singletons the active pane fills, and
 * only `PaneSession` knows what closing one means. Their only exit used to be
 * Escape, which is the same gap every menu had — a card hanging over the
 * transcript that a click on the transcript does not dismiss.
 *
 * `#input-row` is the whole form, so the textarea, the chip and the send button
 * are all "inside": typing on with a completion list open is what the list is
 * for.
 *
 * Both calls are gated on the shell state rather than made unconditionally: this
 * runs on every click anywhere in the window, and `closeCompletions()` repaints
 * the suggestion list whether or not there was one.
 */
onPressOutside([form], () => {
  const pane = activePane()
  if (!pane) return
  const state = pane.shellState()
  if (state.completions !== 'none') pane.closeCompletions()
  if (state.hasSurface || state.hasCommandView) pane.hideSurface()
})

// --- the global key handler -------------------------------------------------------

/** What the key map sees when no pane is active: nothing is open, nothing blocks. */
const EMPTY_SHELL_STATE: ShellState = {
  hasOverlay: false,
  hasRewind: false,
  hasSurface: false,
  hasCommandView: false,
  completions: 'none',
  isStreaming: false,
  inputEmpty: true,
}

const composerInput = required<HTMLTextAreaElement>('input')

/**
 * A key the focused control answers itself: anything typed into a field other
 * than the composer (the sidebar search, the browser's address bar), or Enter
 * on a button. Left to the key map, Escape in those fields stopped the turn and
 * Enter on a thumbnail or a browser-panel button sent the draft.
 */
function ownedByTarget(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement) || target === composerInput) return false
  if (target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true
  return event.key === 'Enter' && target.matches('button, a[href], [role="button"]')
}

document.addEventListener('keydown', (event) => {
  // Mid-IME composition every key belongs to the input method: Enter commits the
  // pinyin letters, Escape cancels them. 229 covers the commit keydown some
  // platforms report with `isComposing` already false.
  if (event.isComposing || event.keyCode === 229) return
  const chord = {
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  }

  // Sidebar chords are checked before the global keymap: a Ctrl+T is always
  // "new session" regardless of the active dialog, mirroring the browser's tab
  // behavior. Only safe because `sidebarChordToIntent` answers `'none'` for
  // anything without ctrl/meta — an unmodified key resolving there would shadow
  // every dialog in the window.
  //
  // That same modifier test is repeated here rather than left to the model, so a
  // plain keystroke never pays for `currentSidebarState()` — which walks every
  // pane and reads the composer draft once per pane, on every keypress while
  // typing.
  if (chord.ctrlKey || chord.metaKey) {
    // Settings first, and for the same reason: it answers `'none'` without
    // ctrl/meta, so a bare comma still reaches the composer.
    const settingsIntent = settingsChordToIntent(chord)
    if (settingsIntent.kind !== 'none') {
      event.preventDefault()
      runSettingsIntent(settingsIntent)
      return
    }
    const sidebarIntent = sidebarChordToIntent(chord, currentSidebarState())
    if (sidebarIntent.kind !== 'none') {
      event.preventDefault()
      runSidebarIntent(sidebarIntent)
      return
    }
  }

  const pane = activePane()
  const action = resolveKey(chord, pane?.shellState() ?? EMPTY_SHELL_STATE)
  // The page hides its lane, so Escape closes it instead of interrupting that lane's turn.
  if (projectsOpen && chord.key === 'Escape' && action !== 'overlay' && action !== 'rewind' && !ownedByTarget(event)) {
    event.preventDefault()
    leaveProjects()
    return
  }
  // A blocking prompt and the rewind panel still take every key, wherever focus is.
  if (action !== 'overlay' && action !== 'rewind' && ownedByTarget(event)) return
  switch (action) {
    case 'overlay':
      pane?.handleOverlayKey(event)
      return
    case 'rewind':
      event.preventDefault()
      if (pane?.rewind) pane.handleRewindIntent(rewindKeyToIntent(chord, pane.rewind))
      return
    case 'accept-completion':
      event.preventDefault()
      void pane?.acceptCompletion('accept')
      return
    case 'submit-completion':
      event.preventDefault()
      void pane?.acceptCompletion('submit')
      return
    case 'move-completion-up':
      event.preventDefault()
      pane?.moveCompletion('up')
      return
    case 'move-completion-down':
      event.preventDefault()
      pane?.moveCompletion('down')
      return
    case 'close-completions':
      event.preventDefault()
      pane?.closeCompletions()
      return
    case 'close-surface':
      event.preventDefault()
      pane?.hideSurface()
      return
    case 'move-surface-up':
      event.preventDefault()
      pane?.moveSurfaceSelection('up')
      return
    case 'move-surface-down':
      event.preventDefault()
      pane?.moveSurfaceSelection('down')
      return
    case 'activate-surface':
      event.preventDefault()
      pane?.activateSurfaceRow()
      return
    case 'interrupt':
      event.preventDefault()
      void pane?.interrupt()
      return
    case 'submit':
      event.preventDefault()
      void pane?.send()
      return
    case 'enqueue':
      event.preventDefault()
      void pane?.queueMessage()
      return
    case 'newline':
    case 'none':
      return
  }
})

composerInput.addEventListener('input', () => {
  activePane()?.onComposerInput()
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  // Enter is handled by the global key map, which decides between sending and
  // queueing; this is the button path and it must reach the same verdict.
  void activePane()?.submitFromForm()
})

required<HTMLButtonElement>('stop').addEventListener('click', () => {
  void activePane()?.interrupt()
})

// Drag-and-drop: a file dragged onto the composer's capsule becomes an image
// attachment of the active pane (design §6.1). Navigation is suppressed for
// every drop — Electron would otherwise turn a dropped file into a page
// navigation and blank the shell — and only *image* files are imported; other
// drops land nowhere rather than being pasted as paths, which is not a thing
// this composer does.
//
// The listeners sit on the form rather than the window: the sidebar and the
// settings screen are not drop targets, and a file dropped there should stay
// the OS's business.
for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  form.addEventListener(type, (event) => {
    event.preventDefault()
  })
}
form.addEventListener('drop', (event) => {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0 || !files.some((file) => file.type.startsWith('image/'))) return
  activePane()?.importImagesFromFiles(files)
})

// --- startup --------------------------------------------------------------------

// Topology arrives as events from here on; the diff against the live sessions
// is what attaches new lanes and retires gone ones.
shellClient.onLanes((lanes) => {
  const live = new Set(lanes.map((info) => info.lane))
  for (const info of lanes) attachPaneSession(info.lane)
  for (const lane of [...paneSessions.keys()]) {
    if (!live.has(lane)) removePaneSession(lane)
  }
  applyPaneBudget()
  renderSidebar()
  renderCanvasHeader()
  // A topology change is also a history change: a new draft appeared, or a
  // `/clear` moved a pane onto a session the last pull had never heard of.
  void refreshSessions()
  // A lane that went away took its tabs with it, host-side.
  renderBrowser()
  // The active lane's coordination role can move with the topology.
  renderMergeBar()
  activePane()?.refreshWelcome()
  scheduleMergePull()
})

shellClient.onActivate((lane) => activateLane(lane))

shellClient.onBrowserState((tabs) => {
  // A *new* tab on the active lane raises the panel: the agent opening a page is
  // the request to look at it. Nothing else does — a load finishing, a title
  // changing, a navigation, a failure are all the same tab going about its
  // business, and a panel the user closed would otherwise be shoved back open by
  // a page that is merely still loading. It never closes the panel either; that
  // stays the user's decision, which is why `browserOpen` is state.
  const arrived = newTabsForLane(tabs, activeLane, knownBrowserTabs)
  knownBrowserTabs = new Set(tabs.map((tab) => tab.tabId))
  const latest = arrived.at(-1)
  if (latest !== undefined && activeLane !== undefined && (sidePanelView(sidePanelInput()).open || mintingTabs === 0)) {
    // A coordination session gets the browser as a tab beside 概览; a panel the
    // user collapsed stays collapsed.
    if (coordinated()) coordBrowser = true
    else browserOpen = true
    setMode('browser')
    // Onto the new tab, not whichever one was last on screen: the page the agent
    // just opened is the one it is asking about.
    browserActiveTab.set(activeLane, latest.tabId)
    // The title bar's browser button draws `browserOpen`, and `renderSidebar` is
    // the only call site that paints the bar.
    renderSidebar()
  }
  pruneSidePanel()
  renderBrowser()
})

void (async () => {
  // Pull the topology rather than trusting early pushes: anything main posted
  // before the bridge listener existed was dropped by Electron, so a pane
  // created before this point reaches the renderer only through this call.
  //
  // The history pull is *not* repeated here: `panes()` applies the lane list
  // synchronously, which fires `onLanes` above, which already owns that trigger.
  const lanes = await shellClient.panes()
  // Repaint the native overlay now that a round trip has proved the transport
  // is up. The module-eval call above happens before anything has answered, and
  // `main.ts` opens the window on the dark chrome unconditionally — so a light
  // user whose first send went nowhere would keep a dark three-button strip.
  // Idempotent: same `dataset.theme`, same command, `setTitleBarOverlay` twice.
  applyResolvedTheme(themePreference)
  for (const info of lanes) attachPaneSession(info.lane)
  const first = lanes[0]
  if (first) activateLane(first.lane)
  renderSidebar()
  renderCanvasHeader()
})().catch((error) => {
  document.body.textContent = `Failed to start: ${describe(error)}`
})

/** A path a tool printed, relative to the lane's project, opened in the user's editor. */
function openInEditor(lane: string, path: string, line: number | undefined): void {
  const root = shellClient.getLanes().find((info) => info.lane === lane)?.projectRoot
  if (root === undefined) return
  void shellClient
    .openInEditor(root, { path, ...(line === undefined ? {} : { line }) })
    .catch((error) => activePane()?.note(describe(error), 'error'))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
