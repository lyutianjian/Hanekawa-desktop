/**
 * The Electron main process.
 *
 * Single window, N live panes. One `BrowserWindow` owns one lane multiplexer
 * over its IPC channel; each pane is a lane carrying an untouched
 * `SessionHost`, and the reserved `__shell` lane carries a `ShellHost` — the
 * class every lane/project decision lives in, because nothing in this file is
 * testable (`app.requestSingleInstanceLock()` runs at module top level, so
 * `main.ts` cannot even be imported under plain node). What stays here: the
 * `BrowserWindow`'s lifecycle, the native dialogs, and `bootstrap()` — the
 * shell owns the MCP trust prompt and the error boxes, the same split
 * `ProjectDirectory` already draws.
 *
 * Lifecycle:
 *  1. `ensureProject(cwd)` is the only way a project comes into existence, and
 *     the first project goes through it exactly like the fifth. Inside it,
 *     `bootstrap()` runs with a `confirmMcpTrust` that drives a native
 *     `dialog.showMessageBox` for each untrusted MCP server — this fires
 *     before any channel exists, the only place a pre-channel prompt can live.
 *     Every project is entered through a *new empty session* — `openProject`
 *     from startup/`--cwd=`/the picker, or the shell's on-demand path when a
 *     history row of a not-yet-open project is clicked. Startup resolves the
 *     directory from the "added projects" registry (the project of the most
 *     recent session anywhere), falling back to the global workspace — the
 *     home directory, whose records land in `~/.myagent`. The registry keeps
 *     *added* order and re-opening does not move an entry, because it is also
 *     the sidebar's group order.
 *  2. `ensureShell()` builds the one window there is, wires the transport,
 *     the mux and the `ShellHost`, then loads the page. The initial lane opens
 *     after the window is up: the renderer's startup pulls the topology with
 *     `panes` rather than trusting anything posted before it attached
 *     (Electron drops pre-load IPC), so the ordering is a convenience, not a
 *     correctness requirement.
 *  3. A project is shut down when its last lane closes (`ShellHost.detachLane`)
 *     — `ProjectRuntime.shutdown` is the only call that stops background tasks
 *     and MCP clients, so a lane-less project would leave child processes
 *     running with nothing on screen to stop them.
 *  4. On `before-quit` we tear every lane down in order and wait for it, then
 *     shut every project down — but only up to `SHUTDOWN_DEADLINE_MS`. The
 *     window is destroyed in the first half of `teardown()`, so a project that
 *     never finishes draining used to leave a running process with nothing on
 *     screen. `window-all-closed` quits only when there are no panes left.
 *
 * Two keys, and they are not interchangeable: lane keys are minted by the
 * `ShellHost` and never move (session ids travel under `/clear` and `/resume`),
 * and the project map inside `ProjectDirectory` is keyed by the normalized
 * project root.
 *
 * The `node:fs` imports and the wall-clock commands stay here, never in the
 * renderer bundle.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  screen,
  shell as electronShell,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionStore, type SessionMeta } from '../sessions/service.js'
import { logDiagnostics } from '../harness/diagnostics.js'
import { IMAGE_FILE_EXTENSIONS } from '../tools/imageFile.js'
import type { McpServerConfig } from '../services/mcp/index.js'
import { bootstrap, RuntimeStartupError } from '../runtime/index.js'
import {
  ProjectDirectory,
  projectRootKey,
  SHUTDOWN_DEADLINE_MS,
  type ProjectEntry,
} from '../runtime/projectDirectory.js'
import { isGlobalWorkspaceRoot } from '../utils/paths.js'
import {
  recordProjectOpen,
  resolveStartupRoot,
  loadRecentProjects,
  forgetRecentProject,
} from './recentProjects.js'
import {
  SessionWorkspace,
  type SessionPane,
} from '../runtime/sessionWorkspace.js'
import { SessionHost } from '../runtime/protocol/host.js'
import { createLaneMux } from '../runtime/protocol/laneChannel.js'
import type { RuntimeHost } from '../runtime/types.js'
import { ShellHost } from './shellHost.js'
import { BrowserTabHost } from './browser/tabs.js'
import { DesktopBrowserHost } from './browser/host.js'
import { createBrowserTool } from '../tools/BrowserTool/BrowserTool.js'
import { createCoordinationTools } from '../tools/coordinationTools.js'
import { CoordinationService } from '../runtime/coordination/service.js'
import { CoordinationWakeEngine } from '../runtime/coordination/wakeEngine.js'
import type { CoordinationLaneControl } from '../runtime/protocol/coordinationHost.js'
import { coordinationSettings } from '../config/settings.js'
import { openInEditor } from './openInEditor.js'
import { appMenuTemplate, isPageMenuChord } from './appMenu.js'
import { contextMenuTemplate } from './contextMenu.js'
import type { WireMenuAction } from './shellProtocol.js'
import {
  DEFAULT_WINDOW_STATE,
  WINDOW_STATE_FILE,
  createWindowStateWriter,
  loadWindowState,
  minimumSize,
  placeWindow,
  type WindowState,
} from './windowState.js'
import {
  createElectronMainChannel,
  type MainSideIpc,
} from './ipc/electronChannel.js'

/**
 * Where this module's own siblings live — `preload.js` and `renderer/` are
 * emitted next to `main.js` under `dist/desktop/`.
 *
 * Anchored to the module rather than counted back to the repo root on purpose.
 * The previous `new URL('..', import.meta.url)` was written as if this file sat
 * one level deep, but the *emitted* file is `dist/desktop/main.js`, so it
 * resolved to `dist/` and every asset path came out as `dist/dist/desktop/…`.
 * Depth is now nobody's business but the bundler's.
 */
const bundleDir = dirname(fileURLToPath(import.meta.url))

/**
 * The caption band's height, `--titlebar-height` in `styles.css`. The OS paints
 * its window controls onto the same band, so the two numbers move together or
 * the caption row and the controls stop sharing a centre line.
 */
const TITLEBAR_HEIGHT = 40

/**
 * The native title-bar overlay, per theme.
 *
 * The one place in the app that spells colours outside `styles.css`, and it has
 * to be: these are painted by Windows into chrome the document does not reach,
 * so no stylesheet rule and no renderer token can describe them. Kept in step
 * with `--surface-canvas` / `--text-secondary` by hand — a drift here shows up
 * as a three-button strip that does not match what is under it.
 */
const WINDOW_CHROME = {
  // `--surface-canvas`, not the frame's `--surface-base`: the three buttons sit
  // at the window's right edge, and what the document paints there is always
  // canvas — `#titlebar::before` with the side panel shut, the panel's gutter
  // with it open, and the settings screen's full-width strip. A base-coloured
  // overlay read as a grey tab stuck onto the corner.
  dark: { color: '#151515', symbolColor: '#c3c2b7', height: TITLEBAR_HEIGHT },
  light: { color: '#fcfcfb', symbolColor: '#52514e', height: TITLEBAR_HEIGHT },
} as const

/**
 * What the window is painted with before the document's first frame, per
 * theme: `body`'s `--surface-base`. Hand-kept beside `WINDOW_CHROME` for the
 * same reason — no stylesheet reaches a window that has not loaded one yet.
 */
const WINDOW_BACKGROUND = { dark: '#1a1a19', light: '#f3f3f0' } as const

// A plain annotation rather than `as unknown as`: `ipcMain` really is
// assignable to `MainSideIpc`, and letting the compiler confirm that is what
// keeps the structural types honest about the Electron API.
const mainIpc: MainSideIpc = ipcMain

/**
 * The name the native chrome shows: the about panel, the macOS menu's 关于 /
 * 隐藏 / 退出, the Windows notification identity. Not `app.setName`: that also
 * moves `userData`, and with it the theme and every other renderer preference
 * stored under the old name.
 */
const APP_DISPLAY_NAME = 'Hanekawa'

/**
 * The last window's placement and theme, loaded once at ready and kept current
 * while a window is up — see `windowState.ts` for why the theme lives here too.
 */
let windowState: WindowState = { ...DEFAULT_WINDOW_STATE }
const windowStateFile = (): string => join(app.getPath('userData'), WINDOW_STATE_FILE)

/** The one window, its mux, and the host that owns every lane decision. */
interface Shell {
  window: BrowserWindow
  host: ShellHost<RuntimeHost, SessionPane, SessionWorkspace>
}

/** Every open project. All decisions that used to be module-level variables live here. */
const directory = new ProjectDirectory()
/**
 * The browser's tabs, for every lane.
 *
 * Module-level and built before any window, deliberately: `openProject` runs
 * `ensureProject` — which is where a project's tools are assembled — *before*
 * `ensureShell`, so the browser has to be addressable while there is still
 * nothing to paint on. `attachWindow` gives it somewhere to draw later; until
 * then a tab can exist and load, it just is not on screen.
 */
const browserTabs = new BrowserTabHost()
/** The single window's shell, once the first project has opened it. */
let shell: Shell | undefined
let quitting = false
/** Lane keys are minted here so they are monotonic for the process lifetime. */
let laneCounter = 0
/**
 * The agent-facing half of the browser, and the `Browser` tool built over it.
 *
 * Module-level for the same reason the tab host is: the tool is handed to
 * `bootstrap()` while there is still no window. The lane lookup therefore reads
 * `shell` lazily — a session that asks before the shell exists has no lane, and
 * is told so rather than opening a tab nobody can see.
 */
const browserHost = new DesktopBrowserHost({
  tabs: browserTabs,
  laneForSession: (sessionId) => shell?.host.laneForSessionId(sessionId),
})
const browserTool = createBrowserTool(browserHost)

/**
 * Project coordination: the wake engine, the service the seven tools call,
 * and the tools themselves. Module-level for the browser's reason — the tools
 * go to `bootstrap()` before any window exists — so every lane lookup reads
 * `shell` lazily, and a lane that has to be opened builds the window first.
 *
 * Two ports, because the engine and the service want different stores out of
 * `storeFor`: the engine the project's thread table (the service's own
 * instance, so there is one per project), the service the session store.
 */
const coordinationEngine = new CoordinationWakeEngine({
  storeFor: (cwd) => coordination.coordinationStore(cwd),
  laneControl: (sessionId) => shell?.host.laneControlFor(sessionId),
  openLane: (cwd, sessionId, options) => openCoordinationLane(cwd, sessionId, options.activate),
  notify: (notice) => notifyCoordination(notice),
  // Lazy: the service is built after the engine.
  reseedCoordinator: (cwd, sessionId) => coordination.reseedCoordinator(cwd, sessionId),
  onError: (error) => {
    console.error('[hanekawa] coordination:', error)
  },
})
const coordination = new CoordinationService(
  {
    storeFor: (cwd) => {
      const entry = directory.get(cwd)
      if (!entry) throw new Error(`No project is open at ${cwd}`)
      return entry.project.store
    },
    laneControl: (sessionId) => shell?.host.laneControlFor(sessionId),
    openLane: (cwd, sessionId, options) => openCoordinationLane(cwd, sessionId, options.activate),
    notify: (notice) => notifyCoordination(notice),
    settings: (cwd) => coordinationSettings(directory.get(cwd)?.project.getSettings() ?? {}),
  },
  coordinationEngine,
)
const coordinationTools = createCoordinationTools(coordination)
/** Shown notifications, held until clicked or closed so a click is never collected away. */
const liveNotifications = new Set<Notification>()

if (!app.requestSingleInstanceLock()) {
  // `app.quit()` does not stop module evaluation, so everything below has to
  // stay inside the else — otherwise a second instance runs a whole
  // `bootstrap()` (MCP connects, store init) on a process that is exiting.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // A second launch is a request for *that* directory's project: open it if it
    // is new, focus it if it is already here. There is only one window now, so
    // focusing it is the whole of "bring Hanekawa to the front" — the project
    // itself gets its newest lane activated through the shell protocol. The
    // launch directory is explicit intent here, unlike a first launch's bare
    // `process.cwd()`.
    if (shell && !shell.window.isDestroyed()) focusWindow(shell.window)
    void openProjectInteractive(explicitCwd(argv) ?? workingDirectory)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    // Teardown is async and Electron will not wait for it on its own:
    // `project.shutdown()` is the only place background tasks get stopped, so
    // exiting out from under it leaks child processes. Cancel this quit, drain,
    // then quit again — the guard above lets the second pass through.
    event.preventDefault()
    void teardown().finally(() => {
      app.quit()
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) reopenWindow()
  })

  void app.whenReady().then(async () => {
    // Windows ties notifications and the taskbar button to this id; without
    // one a toast can be dropped or credited to "electron.app". A dev run has
    // no installer to register a shortcut under a stable id, so it borrows the
    // executable's path — the id Windows gives an unregistered process anyway.
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.hanekawa.desktop' : process.execPath)
    // Menus (5g). Windows and Linux get none: the window is frameless and the
    // renderer draws 文件 / 视图 in the title bar. macOS gets its menu bar in
    // Chinese (`appMenu.ts`) — removing it would also remove 退出 and the
    // clipboard roles, and Electron's default is English and reloads on ⌘R.
    if (process.platform === 'darwin') {
      app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME, applicationVersion: app.getVersion() })
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({
        appName: APP_DISPLAY_NAME,
        devTools: !app.isPackaged,
        run: runMenuAction,
      })))
    } else {
      Menu.setApplicationMenu(null)
    }
    // Before any native surface exists: the theme the window, the caption
    // overlay and every dialog open in is the one the renderer last reported.
    windowState = await loadWindowState(windowStateFile())
    nativeTheme.themeSource = windowState.themePreference
    try {
      await openProject(await resolveStartupProject())
    } catch (error) {
      if (error instanceof RuntimeStartupError) {
        dialog.showErrorBox('Hanekawa 无法启动', error.message)
      } else {
        dialog.showErrorBox(
          'Hanekawa 无法启动',
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
      }
      app.quit()
    }
  })
}

/**
 * A window for a process that has none — the Dock icon clicked, or a menu item
 * chosen, after the last window closed (macOS keeps running). Projects did not
 * survive the window (their last lane died with it), so this reopens whichever
 * entry is left and, when nothing is, the registry's answer: the same
 * resolution a fresh launch would make.
 */
function reopenWindow(): void {
  const first = directory.entries()[0]
  if (first) {
    void openProject(first.cwd)
  } else {
    void resolveStartupRoot().then((resolution) => openProject(resolution.root))
  }
}

/** The window, while there is one to parent a dialog or receive an event. */
function liveWindow(): BrowserWindow | undefined {
  return shell && !shell.window.isDestroyed() ? shell.window : undefined
}

/**
 * A macOS menu item. The renderer decides what it means — the same intents the
 * title-bar menu reaches on Windows. With no window, the two items that make
 * one still work; the rest have nothing to act on.
 */
function runMenuAction(action: WireMenuAction): void {
  const built = shell
  if (built && !built.window.isDestroyed()) {
    focusWindow(built.window)
    built.host.postMenuAction(action)
    return
  }
  if (action === 'new-session') reopenWindow()
  else if (action === 'open-project') void openProjectInteractive()
}

/**
 * Brings a project into the process — bootstrap, pane, directory, registry —
 * without opening a lane.
 *
 * Split from `openProject` because two callers need the halves separately: the
 * sidebar's history opens a *named* session of a not-yet-open project
 * (bootstrapped over that session, so the project's first pane is the pane the
 * click asked for, never a throwaway), while startup and "open project…" want
 * a fresh draft.
 *
 * Idempotent: `directory.add` refuses a duplicate root, since two
 * `ProjectRuntime`s over one `.myagent/` means two `SessionStore`s appending
 * to the same JSONL files, so an already-open project is handed back as-is —
 * which is also what makes repeated "open this project" requests safe.
 *
 * A request that arrives while the same root is still bootstrapping waits for
 * that bootstrap instead of starting a second one, and is answered like the
 * already-open case: the bootstrap session belongs to the first caller.
 *
 * Throws for bootstrap failures; the startup path wants an error box and a
 * quit.
 */
async function ensureProject(
  cwd: string,
  options: { sessionId?: string } = {},
): Promise<{ entry: ProjectEntry; session: SessionMeta | undefined }> {
  const open = directory.get(cwd)
  if (open) return { entry: open, session: undefined }

  const key = projectRootKey(cwd)
  const pending = bootstrapping.get(key)
  if (pending) return { entry: (await pending).entry, session: undefined }

  const started = bootstrapProject(cwd, options)
  bootstrapping.set(key, started)
  try {
    return await started
  } finally {
    bootstrapping.delete(key)
  }
}

/** Bootstraps in flight, by root key — what keeps `ensureProject` from racing itself. */
const bootstrapping = new Map<string, Promise<{ entry: ProjectEntry; session: SessionMeta }>>()

async function bootstrapProject(
  cwd: string,
  options: { sessionId?: string },
): Promise<{ entry: ProjectEntry; session: SessionMeta }> {
  // A macOS Dock reopen can land while the last window's close is still
  // shutting this root down; two runtimes over one `.myagent/` must not overlap.
  await directory.whenClosed(cwd)
  const store = new SessionStore(cwd)
  await store.init()
  // Nothing of this project runs before its bootstrap, so a thread still
  // marked running was interrupted. Fail-open: a broken thread table must not
  // keep the project from opening.
  try {
    await coordination.reconcileOnStartup(cwd)
  } catch (error) {
    console.error('[hanekawa] coordination reconcile failed:', error)
  }

  // Every entry into a project is a *new* session — startup never resumes
  // history (`sessions.at(0)` is gone). A history row names the session it
  // wants, so the bootstrap scope is built over it; anything else gets an
  // in-memory draft, and nothing touches disk until the first `message`
  // record either way.
  let session: SessionMeta
  if (options.sessionId !== undefined) {
    const named = await store.resolve(options.sessionId)
    if (!named) throw new Error(`Session not found: ${options.sessionId}`)
    session = named
  } else {
    session = store.createDraft()
  }

  const project = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: promptTrustMcpServer,
    // The one tool the shared registry cannot build: it needs this process's
    // window. The TUI's `bootstrap()` passes none, so `Browser` is desktop-only
    // by construction rather than by a runtime check.
    // The coordination tools ride along: they reach the shell through
    // `CoordinationService`, and `Tool.sessionRoles` keeps each one to the
    // coordinator or thread sessions it belongs to.
    extraTools: [browserTool, ...coordinationTools],
  })

  logDiagnostics(project.diagnostics)
  const workspace = new SessionWorkspace(project)
  // The bootstrap session is the first pane; `adopt` registers the existing
  // scope without rebuilding it (which `open` would). Handing the session back
  // alongside the entry is what lets `openProject` open its lane *on this
  // pane*, rather than minting a second draft and leaving this one lane-less.
  workspace.adopt(project)
  const entry = directory.add(project, workspace)

  // The registry is the desktop's memory of "added projects": it decides the
  // next launch's startup directory and the sidebar's full history *and its
  // order*, which is why this write appends rather than hoists. The global
  // workspace is implicit — always a startup candidate, never a member.
  if (!isGlobalWorkspaceRoot(cwd)) await recordProjectOpen(cwd)
  return { entry, session }
}

/**
 * Opens a project and lands in a new empty session — the path every explicit
 * "open this project" takes: startup, `--cwd=`, a second instance, the
 * directory picker. An already-open project is focused instead.
 */
async function openProject(cwd: string): Promise<void> {
  const { entry, session } = await ensureProject(cwd)
  // No session of its own: the project was already open, or another request
  // is bootstrapping it and owns its first pane.
  if (session === undefined) {
    focusProject(entry)
    return
  }
  try {
    const built = await ensureShell()
    // The bootstrap pane (over the fresh draft) is the lane's pane — exactly
    // one pane per open, never a ghost draft pane left in the workspace.
    await built.host.openLane(entry, { sessionId: session.id })
  } catch (error) {
    dialog.showErrorBox(
      '无法打开会话',
      error instanceof Error ? error.message : String(error),
    )
    await directory.closeProject(entry, 'window-failed')
  }
}

/**
 * The interactive policy for `openProject`: pick a directory if none was given,
 * report failures without taking the process down.
 */
async function openProjectInteractive(path?: string): Promise<void> {
  try {
    const target = path ?? (await promptForProjectDirectory())
    if (!target) return
    await openProject(target)
  } catch (error) {
    dialog.showErrorBox(
      '无法打开这个项目',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * A native open dialog, parented to the window when there is one: a sheet that
 * slides out of the title bar on macOS, a modal that stays in front of its owner
 * on Windows — rather than a free-floating panel that can land behind it.
 * `message` repeats the title because macOS does not draw a dialog title.
 */
function showOpenDialog(options: OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const parent = liveWindow()
  const withMessage = { ...options, ...(options.title !== undefined ? { message: options.title } : {}) }
  return parent ? dialog.showOpenDialog(parent, withMessage) : dialog.showOpenDialog(withMessage)
}

/** Native directory picker. Cancelling is a no-op, not an error. */
async function promptForDirectory(options: {
  title: string
  buttonLabel: string
}): Promise<string | undefined> {
  const result = await showOpenDialog({
    title: options.title,
    buttonLabel: options.buttonLabel,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled) return undefined
  return result.filePaths[0]
}

async function promptForProjectDirectory(): Promise<string | undefined> {
  return promptForDirectory({ title: '打开项目', buttonLabel: '打开' })
}

/**
 * The image picker's filter list, from the pipeline's own candidate set: the
 * extension only nominates, the pipeline's content sniff decides — and a
 * known-but-unsupported format (BMP, HEIC…) is *offered* so its rejection is
 * the pipeline's explainable one rather than the picker's silence.
 */
const IMAGE_PICKER_EXTENSIONS = [...IMAGE_FILE_EXTENSIONS].map((extension) => extension.slice(1))

/**
 * Builds the single window: transport, lane mux, `ShellHost`, page — in that
 * order, so every lane that ever opens has a host to land on before the
 * renderer exists.
 *
 * Idempotent: the second and every later project share the first window.
 */
async function ensureShell(): Promise<Shell> {
  if (shell) return shell

  // Where the last window was, if that is still on a screen; otherwise room for
  // the sidebar, a full reading column and a side panel beside it, centred on
  // the primary display (`windowState.ts`). The minimums are where the two
  // columns and the composer's action bar still fit without wrapping — clamped
  // to the work area, because a laptop at 125% has less height than that.
  const placement = placeWindow(
    windowState.bounds,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  )
  const floor = minimumSize(placement.workArea)
  const theme = windowState.theme
  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: floor.width,
    minHeight: floor.height,
    // Hidden until the first frame is painted, then shown in one step — no
    // empty frame, and a remembered maximized window does not flash at its
    // restored size first. `reveal` below.
    show: false,
    // Frameless chrome (5g): the renderer draws the title bar — the rail toggle
    // and the Chinese menus — and Windows keeps drawing its own three buttons
    // into `titleBarOverlay`, so no window-control IPC has to exist at all.
    // `backgroundColor` is what the frame is painted with before the first
    // frame arrives; without it the app opens as a white flash. Both start on
    // the theme the renderer last reported, so a light launch is light.
    // macOS draws the frame (title bar and sidebar) as the system's sidebar
    // material; the window stays clear so `body`'s translucent fill lets it through.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000' }
      : { backgroundColor: WINDOW_BACKGROUND[theme] }),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? { height: TITLEBAR_HEIGHT } : WINDOW_CHROME[theme],
    webPreferences: {
      preload: join(bundleDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  guardNavigation(window)

  // `guardNavigation` locks *this* window's one document down — it denies every
  // in-window navigation, because the app shell only ever loads its own file.
  // The browser's views are the deliberate exception and carry their own policy
  // (`browser/tabs.ts`): they exist to navigate to arbitrary sites, and they are
  // children of `contentView` rather than this `webContents`, so nothing above
  // applies to them.
  browserTabs.attachWindow(window)

  if (process.platform === 'darwin') {
    // The menu bar lists the app's own chords (⌘T, ⌘W, …) but the page handles
    // them — only it knows whether a prompt is up or which lane is active. AppKit
    // would fire the menu item as well, so the menu stands aside for exactly
    // those keys while this document has focus (`appMenu.ts`); copy, paste,
    // quit and full screen are reset to the menu's on every other input.
    window.webContents.on('before-input-event', (_event, input) => {
      window.webContents.setIgnoreMenuShortcuts(isPageMenuChord(input))
    })
  }

  // Right-click (`contextMenu.ts`). Chromium shows nothing on its own, so a
  // selected path in the transcript could not be copied with the mouse.
  window.webContents.on('context-menu', (_event, params) => {
    const contents = window.webContents
    const template = contextMenuTemplate(params, process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux', {
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => {
        contents.session.addWordToSpellCheckerDictionary(word)
      },
      copyText: (text) => clipboard.writeText(text),
      copyImageAt: (x, y) => contents.copyImageAt(x, y),
    })
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window })
  })

  // Placement is remembered as it changes, debounced; `close` flushes, because
  // by `closed` the bounds are gone. Bounds are read only from a window in its
  // normal state — a minimized or full-screen window's rectangle is not where
  // the user left it — and `getNormalBounds` is the restore rectangle of a
  // maximized one.
  const snapshot = (): WindowState | undefined => {
    if (window.isDestroyed()) return undefined
    const fullScreen = window.isFullScreen()
    const bounds = fullScreen || window.isMinimized() ? windowState.bounds : window.getNormalBounds()
    windowState = {
      ...windowState,
      ...(bounds !== undefined ? { bounds } : {}),
      maximized: window.isMaximized(),
      fullScreen,
    }
    return windowState
  }
  const stateWriter = createWindowStateWriter(windowStateFile(), snapshot)
  const scheduleState = (): void => stateWriter.schedule()
  window.on('resize', scheduleState)
  window.on('move', scheduleState)
  window.on('maximize', scheduleState)
  window.on('unmaximize', scheduleState)
  window.on('enter-full-screen', scheduleState)
  window.on('leave-full-screen', scheduleState)
  window.on('close', () => {
    void stateWriter.flush()
  })

  let revealed = false
  const reveal = (): void => {
    if (revealed || window.isDestroyed()) return
    revealed = true
    // `maximize` shows the window itself; full screen needs a shown window.
    if (windowState.maximized) window.maximize()
    window.show()
    if (windowState.fullScreen) window.setFullScreen(true)
  }
  window.once('ready-to-show', reveal)

  // One transport for the whole window; panes are lanes on it, not senders of
  // their own — which is the whole reason the lane mux exists.
  const channel = createElectronMainChannel(mainIpc, window.webContents)
  const mux = createLaneMux(channel)

  // The occupant factory closes the loop: the ShellHost owns lane bookkeeping,
  // and each lane's occupant is a SessionHost wired straight back into it.
  // `shellHost` is assigned below; every callback here fires long after.
  let shellHost: ShellHost<RuntimeHost, SessionPane, SessionWorkspace> | undefined
  const host = new ShellHost<RuntimeHost, SessionPane, SessionWorkspace>({
    mux,
    directory,
    nextLaneKey: () => `${++laneCounter}`,
    createOccupant: (attach) => {
      // A finished turn hands the session's browser tabs back to the user: the
      // 「agent 正在操作」banner goes, and touching the page stops counting as
      // a takeover. The id is read at the event, not captured here — the pane
      // outlives any one session in it.
      const controller = attach.pane.controller
      const offTurnEnd = controller.onEvent((event) => {
        if (event.type === 'turn-end') browserHost.turnEnded(controller.getSessionId())
      })
      const sessionHost = new SessionHost({
        channel: attach.channel,
        controller: attach.pane.controller,
        runtimeSlot: attach.pane.runtimeSlot,
        project: attach.project.project,
        scope: attach.pane.scope,
        workspace: attach.project.workspace,
        // A pane opened by this lane's host (`open-pane` from its renderer):
        // the host has already registered it in the workspace, the shell
        // attaches its lane — dedup on pane identity activates instead.
        onPaneOpened: (pane) => {
          shellHost?.attachPane(attach.project, pane)
        },
        onPaneClosed: (paneId) => {
          shellHost?.detachLaneBySessionId(paneId, 'pane-closed')
        },
        // The renderer no longer sends `focus-pane` (activation is local to
        // the single window), but the command stays on the wire for the TUI —
        // and it maps naturally onto "activate that pane's lane".
        onFocusPane: (paneId) => {
          const lane = shellHost?.laneForSessionId(paneId)
          if (lane === undefined) return false
          shellHost?.requestActivate(lane)
          return true
        },
        onOpenProject: () => {
          void openProjectInteractive()
        },
        // `open-attachment` resolved to its on-disk path: the host stays
        // Electron-free, so `shell.openPath` lives here. The path is
        // host-derived from a registered `(session, imageId)` pair — never a
        // renderer-supplied `file://` value.
        onOpenAttachment: (filePath) => {
          void electronShell.openPath(filePath)
        },
        // The shell answers from its lane map so every row the renderer draws
        // is a row it can switch to.
        describePanes: () => shellHost?.describeLanes() ?? [],
        // The host just told its own lane; every other lane and the shell lane
        // are ours to tell.
        onPaneListChanged: () => {
          shellHost?.broadcastLanes()
        },
      })
      // Thread turn-ends become coordinator notes, and coordinator turn-ends
      // re-evaluate waking it; the engine ignores lanes with no role.
      const offCoordination = coordinationEngine.attachLane(attach.project.cwd, controller, sessionHost)
      // Delegated one for one rather than handing the `SessionHost` over as the
      // occupant: `LaneOccupant` is what `ShellHost` is allowed to say to a
      // lane, and keeping it a three-method view is what stops the shell from
      // reaching into a session's runtime.
      return {
        dispose: () => {
          offTurnEnd()
          offCoordination()
          sessionHost.dispose()
        },
        refreshAfterConfigChange: (options) => {
          sessionHost.refreshAfterConfigChange(options)
        },
        refreshSessionMeta: (session) => {
          sessionHost.refreshSessionMeta(session)
        },
        activeModelKey: () => sessionHost.activeModelKey(),
        coordination: sessionHost,
      }
    },
    onOpenProject: () => {
      void openProjectInteractive()
    },
    onPickDirectory: (options) => promptForDirectory(options),
    // 「选择图片」 (S11): the Electron boundary's half of the composer's
    // attachment entrance. Multi-select, images only — every format the import
    // pipeline can classify, so an unsupported one (BMP, say) is *rejected by
    // the pipeline with a reason* rather than never offered at all. The
    // `defaultPath` anchor arrives shell-resolved.
    onPickImages: async (options) => {
      const result = await showOpenDialog({
        title: '选择图片',
        buttonLabel: '添加',
        properties: ['openFile', 'multiSelections'],
        ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
        filters: [{ name: '图片', extensions: IMAGE_PICKER_EXTENSIONS }],
      })
      if (result.canceled) return undefined
      return result.filePaths
    },
    // The sidebar's history is every *added* project, most of them without an
    // open runtime — the registry is the source, read live so a project added
    // by another window (or a stale root) is never cached wrong.
    knownProjects: async () =>
      (await loadRecentProjects()).filter(
        (cwd) => !isGlobalWorkspaceRoot(cwd) && existsSync(cwd),
      ),
    // A history row of a not-yet-open project bootstraps it on demand, over
    // the session the click named.
    ensureProject: async (cwd, options) => (await ensureProject(cwd, options)).entry,
    ensureProjectFresh: async (cwd) => {
      const { entry, session } = await ensureProject(cwd)
      return { entry, ...(session ? { session } : {}) }
    },
    // The write half of "从侧边栏移除": registry only. The shell has already
    // closed the lanes by the time this runs, and nothing on disk is deleted —
    // opening the directory again restores the group and its history.
    onForgetProject: async (cwd) => {
      await forgetRecentProject(cwd)
    },
    // Returned rather than fired-and-forgotten: the shell awaits it so "code is
    // not installed" comes back as a `fail` the renderer writes into the
    // transcript, instead of a native box no test can see. A `target` (T15) is
    // one search hit's file and line, already resolved and bounded host-side.
    onOpenInEditor: (cwd, target) => openInEditor(cwd, target),
    // The overlay is drawn by the OS, so the renderer — where the theme
    // preference lives — cannot repaint it itself. `setTitleBarOverlay` only
    // exists on Windows; elsewhere the command still answers `ok`, because the
    // shell treats a missing overlay as "this platform has none".
    onWindowTheme: ({ theme, preference }) => {
      // Native surfaces follow the app rather than the OS: the traffic lights,
      // dialogs, a `<select>`'s popup, scrollbars and the embedded browser's
      // `prefers-color-scheme`. Set only on a change — every assignment makes
      // Chromium re-evaluate the media query in every renderer.
      if (nativeTheme.themeSource !== preference) nativeTheme.themeSource = preference
      // The window's own fill shows wherever the document has not painted yet:
      // the edge a Windows resize drag uncovers, a reload's first frame. Left
      // dark under a light theme, it flashed black there.
      if (process.platform !== 'darwin') window.setBackgroundColor(WINDOW_BACKGROUND[theme])
      // Remembered for the next launch's first frame.
      if (windowState.theme !== theme || windowState.themePreference !== preference) {
        windowState = { ...windowState, theme, themePreference: preference }
        stateWriter.schedule()
      }
      if (process.platform === 'darwin') return
      window.setTitleBarOverlay(WINDOW_CHROME[theme])
    },
    // A prompt is waiting. Only while the user is elsewhere: the window in front
    // already shows the card, and flashing it would be nagging.
    onRequestAttention: () => {
      if (window.isDestroyed() || window.isFocused()) return
      if (process.platform === 'darwin') app.dock?.bounce('informational')
      else window.flashFrame(true)
    },
    browser: browserTabs,
    coordination,
    isQuitting: () => quitting,
    onAllLanesClosed: () => {
      // The last lane of the single window is the single-window equivalent of
      // "the last window closed". Non-darwin quits, exactly as it always did;
      // darwin keeps the empty window — its tab bar still offers new tabs and
      // "Open project", which the 4b sidebar builds on.
      if (process.platform !== 'darwin') app.quit()
    },
  })
  shellHost = host

  // The tab host is the only side that knows a page finished loading or changed
  // its title; the shell lane is the only way to tell the renderer. Bursts are
  // already coalesced upstream, so this is one call per page load, not five.
  const stopTabUpdates = browserTabs.onChanged((tabs) => {
    host.broadcastBrowserState(tabs)
  })
  // Every thread-table write, from the service and the wake engine alike;
  // the host coalesces them per project before re-reading the table.
  const stopThreadUpdates = coordination.onThreadsChanged((cwd) => host.broadcastCoordinationThreads(cwd))
  // The renderer dims its chrome while the window is inactive. Focus also ends
  // a taskbar flash; Windows would otherwise keep it lit until clicked.
  window.on('focus', () => {
    window.flashFrame(false)
    host.broadcastWindowFocus(true)
  })
  window.on('blur', () => host.broadcastWindowFocus(false))

  const built: Shell = { window, host }
  shell = built

  // The renderer is gone: every lane dies with it. The transport is already
  // dead by the time 'closed' fires, so `detachLane`'s control frames are
  // dropped by the mux and the local cleanup is the whole job.
  window.on('closed', () => {
    // Before the guard: the tab host outlives the window, and a failed load
    // destroys the window after `shell` was already reset.
    stopTabUpdates()
    stopThreadUpdates()
    host.dispose()
    if (shell !== built) return
    shell = undefined
    // Before the lanes: `detachLane` closes each lane's tabs one by one, and
    // every one of those would be reaching into a `contentView` that is already
    // gone. Dropping the views first makes that a no-op instead of a race.
    browserTabs.detachWindow()
    for (const key of host.laneKeys()) host.detachLane(key, 'window-closed')
  })

  try {
    await window.loadFile(join(bundleDir, 'renderer', 'index.html'))
    // `ready-to-show` normally comes first; this is the net for a page whose
    // first paint never reports (it must not leave a loaded window hidden).
    reveal()
  } catch (error) {
    // The one window failed to build: nothing can be shown at all.
    shell = undefined
    if (!window.isDestroyed()) window.destroy()
    throw error
  }

  return built
}

async function teardown(): Promise<void> {
  // Lanes first, in the fixed order inside `workspace.close`
  // (`interrupt('exit')` → controller → slot → scope), then the projects: a
  // project shut down under a live pane pulls the tools out from beneath a turn
  // that is still draining. `detachLane` skips project shutdown while quitting
  // — `shutdownAll` owns that ordering.
  if (shell) {
    for (const key of shell.host.laneKeys()) shell.host.detachLane(key, 'app-quit')
    if (!shell.window.isDestroyed()) shell.window.destroy()
  }
  // After the window, like every other native child: a `WebContentsView` whose
  // parent is already destroyed has nothing left to detach from, and this call
  // is then only closing whatever web contents outlived it.
  browserHost.dispose()
  browserTabs.dispose()
  // Bounded, because `before-quit` has already cancelled the real quit and is
  // waiting on this: an unbounded await here is how "the window closed but the
  // process is still running" happens. Timing out is not a failure to report to
  // the user — there is no UI left — so it goes to stderr like every other
  // main-process diagnostic.
  const outcome = await directory.shutdownAll('app-quit', { timeoutMs: SHUTDOWN_DEADLINE_MS })
  if (outcome === 'timed-out') {
    console.error(`[hanekawa] shutdown did not drain in ${SHUTDOWN_DEADLINE_MS}ms; quitting anyway`)
  }
}

/**
 * An already-open project: focus the window and activate its newest lane —
 * the single-window equivalent of raising that project's window.
 */
function focusProject(project: ProjectEntry): void {
  const built = shell
  if (!built || built.window.isDestroyed()) return
  focusWindow(built.window)
  const lanes = built.host.describeLanes().filter((lane) => lane.projectRoot === project.root)
  const latest = lanes.at(-1)
  if (latest) built.host.requestActivate(latest.lane)
}

/**
 * Opens a session's lane for coordination. The window is built first when
 * there is none, so a cold-opened thread or a wake still has a lane to run on.
 */
async function openCoordinationLane(
  cwd: string,
  sessionId: string,
  activate: boolean,
): Promise<CoordinationLaneControl> {
  const built = await ensureShell()
  return built.host.openLaneForCwd(cwd, sessionId, activate)
}

/** A coordination notice as an OS notification; clicking it brings that session's lane forward. */
function notifyCoordination(notice: { title: string; body: string; sessionId: string }): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: notice.title, body: notice.body })
  liveNotifications.add(notification)
  notification.on('click', () => {
    liveNotifications.delete(notification)
    const built = shell
    if (!built || built.window.isDestroyed()) return
    focusWindow(built.window)
    const lane = built.host.laneForSessionId(notice.sessionId)
    if (lane !== undefined) built.host.requestActivate(lane)
  })
  notification.on('close', () => {
    liveNotifications.delete(notification)
  })
  notification.show()
}

function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.focus()
}

/**
 * Keep every navigation out of the pane's own window.
 *
 * The renderer is a single `loadFile`, so following a link in place would replace
 * the whole UI with a web page and leave every `SessionHost` talking to a
 * renderer that no longer exists. Markdown links (`dom/markdownView.ts`) carry
 * `target="_blank"`, which lands in `setWindowOpenHandler`; `will-navigate`
 * catches the rest (a dragged URL, a same-window link a future view forgets to
 * mark). Both hand `http(s)` to the OS browser and drop anything else — the href
 * already passed `safeHref` in the parser, and this is the second net.
 *
 * Untested, like everything else in this file: `main.ts` cannot be imported under
 * plain node.
 */
function guardNavigation(window: BrowserWindow): void {
  const openExternally = (url: string): void => {
    if (/^https?:\/\//i.test(url)) void electronShell.openExternal(url)
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternally(url)
  })
}

/**
 * MCP trust prompt. `confirmMcpTrust` is awaited inside `bootstrap()`, before
 * any channel exists, so this cannot be a renderer dialog — a native modal is
 * the only thing available this early. Every project asks for its own servers.
 *
 * The async `showMessageBox` answers `{ response }`; `showMessageBoxSync`,
 * which this used before, answers the bare button *index* — and reading
 * `.response` off that number once made this return `undefined`, silently
 * rejecting every server even when the user clicked 信任. The async form is
 * also the one that can take a parent window without blocking the main loop.
 */
async function promptTrustMcpServer(
  name: string,
  server: McpServerConfig,
): Promise<boolean> {
  const detail =
    server.transport === 'stdio'
      ? `命令：${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}`
      : server.url
        ? `地址：${server.url}`
        : '未知的连接方式'
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['信任', '拒绝'],
    // Both default to Reject: a dismissed dialog must not grant trust.
    defaultId: 1,
    cancelId: 1,
    title: '信任 MCP 服务器',
    // The line macOS shows in bold — it draws no title at all.
    message: `要信任 MCP 服务器「${name}」吗？`,
    detail,
  }
  // Parented when a window exists (a project opened after the first): a sheet
  // on macOS, a modal owned by the window on Windows. The first project's
  // servers are asked before any window is built, so that one floats.
  const parent = liveWindow()
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response === 0
}

/**
 * The `--cwd=` flag, when it names a directory that exists.
 *
 * Explicit only: the launch's own working directory is deliberately *not* a
 * candidate anywhere else — a shortcut whose working directory is the install
 * folder, or a terminal sitting anywhere else, is not a statement about which
 * project to open.
 */
function explicitCwd(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--cwd='))
  if (!flag) return undefined
  const value = flag.slice('--cwd='.length)
  return existsSync(value) ? value : undefined
}

/**
 * Where a fresh launch lands.
 *
 * An explicit `--cwd=` wins. Otherwise the registry's answer to
 * “最近一次会话的目录”： the project whose newest session is the newest
 * anywhere, the most recently added project when nothing has sessions yet, or
 * the global workspace (the home directory) when no project has ever been
 * added — the welcome-screen state whose records land in `~/.myagent`.
 */
async function resolveStartupProject(): Promise<string> {
  const explicit = explicitCwd()
  if (explicit !== undefined) return explicit
  return (await resolveStartupRoot()).root
}
