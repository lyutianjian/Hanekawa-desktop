import type { WireCoordinationThreads, WireLaneInfo, WireSessionSummary } from '../../shellProtocol.js'
import type { DesktopPlatform } from '../../types.js'
import { coordinationCounts, isCoordinationProject } from './coordinationStatus.js'
import { desktopShortcut, isPrimaryModifier } from './desktopShortcuts.js'

/**
 * The sidebar as data: every session this process can reach, grouped by
 * workspace, with the open ones marked.
 *
 * Replaces `model/tabBar.ts`, which only ever listed *open* panes. The ordering
 * discipline is inherited wholesale — a stable partition rather than a
 * comparator on a boolean, one flattened row list that both the view renders and
 * the digit chords index — and extended a level, from "project → tab" to
 * "workspace → session".
 *
 * Workspace is the *only* grouping axis. It used to be two ("project → age →
 * session") behind a header dropdown that switched which project you were
 * looking at, which made the workspace something you navigated *to* before you
 * could see its sessions. Every workspace is now on screen at once, its group
 * collapsible, and the age sections are gone — inside a group the rows are
 * simply newest first.
 *
 * Two things this file is careful about:
 *
 * 1. **Badges are derived, not transported.** `running` and `awaiting-input`
 *    come from the pane's own `SessionClient` snapshot and its unanswered
 *    blocking requests, both of which the renderer already has. No wire field
 *    was added for them, so nothing can go stale between the host and the row.
 *    `failed` is the exception: a session nobody has open must still say that
 *    its last turn failed, so it rides the history row (`WireSessionSummary`).
 * 2. **There are two key entry points, and they are not interchangeable.**
 *    `sidebarChordToIntent` runs *before* the global keymap and therefore must
 *    answer `'none'` for anything without ctrl/meta — an unmodified key that
 *    resolved here would silently shadow every dialog in the window.
 *    `sidebarKeyToIntent` runs only while focus is inside the sidebar, which is
 *    what lets arrows and Enter mean navigation without stealing them from the
 *    composer.
 *
 * DOM-free on purpose; see `keymap.ts` for why (`model/` is compiled in the base
 * tsconfig program, which has no DOM lib).
 */

// --- text --------------------------------------------------------------------

/**
 * The tooltip of 新建会话, 打开项目… and a project's + while `canCreate` is false.
 * A blocking request parks the active lane, and a greyed button with no reason
 * reads as broken.
 */
export const CREATE_BLOCKED_HINT = '先回应当前会话里的授权请求或提问'

/** The nav row that turns the「最近」filter on and off. */
export const SIDEBAR_RECENT_LABEL = '最近'
/** The three things the list can say when it has no rows to draw. */
export const SIDEBAR_EMPTY_TEXT = '还没有会话。'
/** The「最近」filter is on and the global workspace has no history yet. */
export const SIDEBAR_EMPTY_RECENT_TEXT = '还没有无项目会话。'
export const SIDEBAR_NO_MATCHES_TEXT = '没有匹配的会话。'
/** The first read of the history failed and there is nothing older to show. */
export const SIDEBAR_LOAD_FAILED_TEXT = '读取会话失败'

/**
 * Where the history read stands. Only an *empty* list shows it: before the
 * first read lands the rail is skeleton rows rather than 「还没有会话」, which
 * read as every session having been deleted; and a first read that failed says
 * so with 重试 in its place. Once a list has been drawn a later failure keeps
 * it — the shell reports that one — because a rail that empties itself on a
 * transient error looks like a deletion too.
 */
export type SidebarListLoad = 'loading' | 'ready' | 'failed'

/** The `?` panel's rows: what each chord does, and the chord. */
export function sidebarHint(platform: DesktopPlatform): Array<{ label: string; chord: string }> {
  return [
    { label: '新建会话', chord: desktopShortcut(platform, 'new-session') },
    { label: '切换会话', chord: desktopShortcut(platform, 'switch-session') },
    { label: '关闭会话', chord: desktopShortcut(platform, 'close-session') },
    { label: '收起侧栏', chord: desktopShortcut(platform, 'toggle-sidebar') },
    { label: '打开项目', chord: desktopShortcut(platform, 'open-project') },
    { label: '打开设置', chord: desktopShortcut(platform, 'open-settings') },
  ]
}

// --- the view ----------------------------------------------------------------

/** What a row says about the pane behind it, if there is one. */
export type SidebarBadge = 'none' | 'running' | 'awaiting-input' | 'failed'

export interface SidebarRow {
  readonly sessionId: string
  readonly title: string
  /** Small prefix text for a coordination session; absent for an ordinary one. */
  readonly roleMarker?: string
  readonly projectRoot: string
  /** The lane this session is open on, absent when it is only history. */
  readonly lane?: string
  readonly badge: SidebarBadge
  /** The row the window is currently showing. At most one row is active. */
  readonly active: boolean
  readonly updatedAt: string
  readonly messageCount: number
  /** This row is asking "delete?" and has replaced its actions with the answer. */
  readonly confirmingDelete: boolean
}

/**
 * One project's pinned coordination entry: its coordinator session and its
 * threads' counts. The threads themselves are listed in the overview panel only.
 */
export interface SidebarCoordinationGroup {
  readonly projectRoot: string
  readonly projectName: string
  /** Absent when the project has threads but no coordinator session pointer. */
  readonly coordinator?: SidebarRow
  readonly running: number
  readonly blocked: number
}

/** 「2 运行中 · 1 需要你」; empty when neither count is above zero. */
export function coordinationCountsText(running: number, blocked: number): string {
  const parts: string[] = []
  if (running > 0) parts.push(`${running} 运行中`)
  if (blocked > 0) parts.push(`${blocked} 需要你`)
  return parts.join(' · ')
}

export const SIDEBAR_COORDINATION_TITLE = '项目调度'

/**
 * Where the rail is between its two resting widths.
 *
 * A boolean cannot express the frame the collapse actually needs: the rows have
 * to stay in the DOM while the column narrows, or the animation is a fade of
 * nothing. So the fold is four states — two resting, two moving — and the
 * unmounting waits for `'collapsed'` rather than for the click.
 */
export type SidebarCollapsePhase = 'expanded' | 'collapsing' | 'collapsed' | 'expanding'

/**
 * What moves the fold along.
 *
 * `'intent'` is the user asking (the toggle, or one of the places that expands
 * the rail to reveal a heading). `'settled'` is the animation reporting that it
 * finished — `transitionend` on `flex-basis`, or the timer that stands in for it
 * when the transition never runs (a hidden window, `prefers-reduced-motion`).
 */
export type SidebarCollapseEvent = 'intent' | 'settled'

/**
 * The fold's one transition function.
 *
 * Pure, and total over the eight `(phase, event)` pairs, because the two things
 * that drive it are both unreliable: a user can toggle twice inside one
 * animation, and a `settled` can arrive from a transition that has already been
 * superseded. Both come out here as "no move" rather than as a rail that ends up
 * the wrong width.
 *
 * `wantCollapsed` is the intent the caller holds, not a copy of the phase: an
 * `'intent'` event is read against it, and a `'settled'` only rests where the
 * direction it was travelling agrees with it. A `settled` that disagrees is late
 * — the intent that reversed the phase has already been through here — so it is
 * dropped and the move it interrupted keeps running.
 */
export function nextCollapsePhase(
  current: SidebarCollapsePhase,
  wantCollapsed: boolean,
  event: SidebarCollapseEvent,
): SidebarCollapsePhase {
  if (event === 'intent') {
    if (wantCollapsed) return current === 'collapsed' ? 'collapsed' : 'collapsing'
    return current === 'expanded' ? 'expanded' : 'expanding'
  }
  if (current === 'collapsing') return wantCollapsed ? 'collapsed' : current
  if (current === 'expanding') return wantCollapsed ? current : 'expanded'
  // A `settled` in a resting phase is a callback from a move that already
  // finished (or a bare timer firing after `transitionend` beat it). Resting is
  // the answer either way.
  return current
}

/**
 * How long to wait for a `settled` that may never come, in milliseconds.
 *
 * `--motion-layout` plus delivery slack. `transitionend` is not a guarantee: a
 * hidden window runs no transitions, `prefers-reduced-motion` cuts them to 1ms,
 * and a `display: none` ancestor (the settings screen) cancels them outright.
 * Without the timer the fold would sit in `'collapsing'` forever and never
 * unmount its rows. `rendererStyleTokens` pins this against the token.
 */
export const SIDEBAR_COLLAPSE_FALLBACK_MS = 340

/**
 * Whether the rail's rows, search box, nav and footer belong in the DOM.
 *
 * The only phase that unmounts them is the settled one: `'collapsing'` still
 * has a column to draw them in, and `'expanding'` needs them built *before* the
 * width arrives or the rail opens onto a blank pane.
 */
export function sidebarContentMounted(phase: SidebarCollapsePhase): boolean {
  return phase !== 'collapsed'
}

/** One workspace's sessions, under its own heading. */
export interface SidebarGroup {
  readonly projectRoot: string
  readonly projectName: string
  /**
   * The home directory's implicit workspace rather than an added project.
   *
   * Read off the wire (`WireShellProjectSessions.isGlobal`), never matched on
   * the display name. The one group that cannot be removed from the sidebar,
   * because there is no registry entry to forget.
   */
  readonly isGlobal: boolean
  /**
   * The heading stands in for the session on screen, because that session has no
   * row yet.
   *
   * A session with no conversation in it is invisible in the rail, so a fresh
   * pane would otherwise leave nothing marked at all. The highlight belongs to
   * the *place* until the first message gives the session a row of its own, at
   * which point it moves down to `SidebarRow.active` — never both at once.
   */
  readonly active: boolean
  /** This group's context menu is open, so the view draws it under the heading. */
  readonly menuOpen: boolean
  /** This group is asking "remove?" and has replaced its `+` with the answer. */
  readonly confirmingRemove: boolean
  /**
   * Folded shut, so the view draws the heading and none of the rows.
   *
   * A collapsed group's rows are still carried here (the heading shows how
   * many), but they are absent from {@link SidebarView.rows} — the cursor and
   * `Ctrl+1`–`9` walk what is on screen, and a keyboard that steps into a hidden
   * row is a cursor the user cannot see.
   */
  readonly collapsed: boolean
  /** The group's sessions, newest first. Populated even while collapsed. */
  readonly rows: readonly SidebarRow[]
}

export interface SidebarView {
  /**
   * The pinned section above the groups: one entry per coordination project, in
   * workspace order. Empty while recent-only is on.
   */
  readonly pinned: readonly SidebarCoordinationGroup[]
  readonly groups: readonly SidebarGroup[]
  /**
   * Every *visible* row, flattened in **visual** order — collapsed groups
   * contribute nothing. Keyboard navigation walks this, so the cursor and the
   * screen cannot disagree.
   */
  readonly rows: readonly SidebarRow[]
  /**
   * The open rows only, in the same visual order. `Ctrl+1`–`9` indexes *this*
   * rather than `rows`: the chord has always meant "switch between live panes",
   * and letting it reach into history would turn a switch into an open.
   */
  readonly liveRows: readonly SidebarRow[]
  /** The active pane's project, which is also the group hoisted to the top. */
  readonly activeProjectRoot: string | undefined
  /** The intent: what the user last asked the rail to be. */
  readonly collapsed: boolean
  /** Where the rail is between the two widths. See {@link SidebarCollapsePhase}. */
  readonly collapsePhase: SidebarCollapsePhase
  readonly selectedIndex: number
  /** Whether "new session" and "open project" are offered. */
  readonly canCreate: boolean
  /** Nothing to list at all — the empty state, not merely a collapsed sidebar. */
  readonly isEmpty: boolean
  /** The current search text, so the box can reflect it and the miss state read. */
  readonly searchQuery: string
  /** A search is active but matched nothing — distinct from an empty project. */
  readonly noMatches: boolean
  /**
   * The「最近」filter is on, so only the global workspace's group is listed.
   *
   * A filter and not a destination: it opens nothing and creates nothing, which
   * is what makes it safe to leave on — the sessions that belong to no project
   * are simply the only ones on screen until it is turned off.
   */
  readonly recentOnly: boolean
  /** The projects page is up, so the nav's「项目」item wears its on-state. */
  readonly projectsOpen: boolean
  /** Whether the history has been read yet; see {@link SidebarListLoad}. */
  readonly listLoad: SidebarListLoad
  /**
   * Whether the `?` panel is showing {@link sidebarHint}.
   *
   * The chord list used to be printed under the footer at all times, which put a
   * two-line wall of 10px text where the reference builds have a user row and a
   * `?` (design_guidance 三.2). The text is the same; the difference is that it
   * is now asked for.
   */
  readonly helpOpen: boolean
}

/**
 * One project's history, as `list-sessions` reports it.
 *
 * The session shape is the wire's narrow projection, not `SessionMeta`: the
 * sidebar reads four fields, and one it does not read (`checkpoints`) grows
 * without bound.
 */
export interface SidebarProjectSessions {
  readonly projectRoot: string
  readonly projectName: string
  readonly projectPath?: string
  /** See {@link SidebarGroup.isGlobal}. Absent is treated as "an added project". */
  readonly isGlobal?: boolean
  readonly sessions: readonly WireSessionSummary[]
}

/** What a live pane contributes that no wire field carries. */
export interface SidebarLaneStatus {
  readonly streaming: boolean
  /** An unanswered blocking request is parked on this pane. */
  readonly blocked: boolean
  /** A background process (shell or agent task) is still running on this pane. */
  readonly processes: boolean
  /**
   * Whether the pane's transcript has any conversation in it — the visibility
   * rule for a session that exists only as a lane: a new session stays
   * invisible until its first input or output.
   */
  readonly hasConversation: boolean
}

export interface SidebarState {
  /** History, per project, in the order projects were opened. */
  readonly projects: readonly SidebarProjectSessions[]
  /** The lane topology, which is a subset of the history plus fresh drafts. */
  readonly lanes: readonly WireLaneInfo[]
  /** Keyed by lane. A lane with no entry contributes no badge. */
  readonly laneStatus: ReadonlyMap<string, SidebarLaneStatus>
  readonly activeLane: string | undefined
  /** The intent the toggle writes; {@link nextCollapsePhase} reads it. */
  readonly collapsed: boolean
  /**
   * The fold's visual state, which lags the intent by one animation.
   *
   * Held beside `collapsed` rather than derived from it because that lag is the
   * whole point: the two disagree for exactly as long as the rail is moving.
   */
  readonly collapsePhase: SidebarCollapsePhase
  /** The keyboard cursor into {@link SidebarView.rows}; `-1` for "no cursor". */
  readonly selectedIndex: number
  /** The session whose row is asking for confirmation, if any. */
  readonly pendingDelete: string | undefined
  /** The project whose heading has a context menu open, if any. */
  readonly projectMenu: string | undefined
  /** The project whose heading is asking "remove from the sidebar?", if any. */
  readonly pendingRemoveProject: string | undefined
  /**
   * Deletes and removals the user has confirmed, drawn as done before the host
   * says so.
   *
   * Both acts take a round trip — a delete detaches the lane, releases a runtime
   * and re-lists the store — and a row that stays put for it reads as a click
   * that missed, which is how a second delete gets pressed. Renderer-local, never
   * persisted, and cleared by the refresh that follows either outcome: on success
   * the row is genuinely gone, on failure it comes back on its own.
   */
  readonly deletingSessions: ReadonlySet<string>
  readonly removingProjects: ReadonlySet<string>
  /** Milliseconds, injected so a draft's synthesized timestamp is testable. */
  readonly now: number
  /** False while a blocking dialog is up: both buttons open something. */
  readonly canCreate: boolean
  /** The session-search text; empty means no filter. */
  readonly searchQuery: string
  /**
   * The workspaces folded shut, by project root.
   *
   * Renderer-local and deliberately not persisted: it is a view fold, not a
   * preference, and a project that came back collapsed after a restart would
   * look like its sessions were gone.
   */
  readonly collapsedProjects: ReadonlySet<string>
  /** Whether the footer's `?` panel is open. */
  readonly helpOpen: boolean
  /**
   * Show only the global workspace — the sessions that belong to no project.
   *
   * Renderer-local and deliberately not persisted, for the reason
   * `collapsedProjects` is not: it is a view the user is standing in, and a
   * filter that survived a restart would look like every project had vanished.
   */
  readonly recentOnly: boolean
  readonly projectsOpen: boolean
  readonly listLoad: SidebarListLoad
  /**
   * Each project's thread table, by project root. Sessions named here (the
   * coordinator and every thread) are drawn in the pinned section and left out
   * of the ordinary project groups.
   */
  readonly coordination: ReadonlyMap<string, WireCoordinationThreads>
}

export function createSidebarState(overrides: Partial<SidebarState> = {}): SidebarState {
  return {
    projects: [],
    lanes: [],
    laneStatus: new Map(),
    activeLane: undefined,
    collapsed: false,
    collapsePhase: 'expanded',
    selectedIndex: -1,
    pendingDelete: undefined,
    projectMenu: undefined,
    pendingRemoveProject: undefined,
    deletingSessions: new Set(),
    removingProjects: new Set(),
    now: Date.UTC(2026, 7, 20, 12, 0, 0),
    canCreate: true,
    searchQuery: '',
    collapsedProjects: new Set(),
    helpOpen: false,
    recentOnly: false,
    projectsOpen: false,
    listLoad: 'ready',
    coordination: new Map(),
    ...overrides,
  }
}

// --- building the view -------------------------------------------------------

/**
 * A row's place on the timeline, as a number.
 *
 * An unparseable `updatedAt` sorts oldest rather than throwing — the store
 * self-heals rather than rejecting bad records, and a row the user can still
 * delete is more useful than a sidebar that will not draw.
 */
function touchedAt(updatedAt: string): number {
  const touched = Date.parse(updatedAt)
  return Number.isFinite(touched) ? touched : 0
}

function badgeFor(lane: string | undefined, state: SidebarState, failed: boolean): SidebarBadge {
  const status = lane === undefined ? undefined : state.laneStatus.get(lane)
  // Awaiting input outranks running: a turn parked on a permission prompt is
  // technically still streaming, and "waiting for you" is the actionable half.
  if (status?.blocked) return 'awaiting-input'
  // "Running" is the agent loop *or* a process it left behind — a backgrounded
  // command keeps the session busy after the turn ends.
  if (status?.streaming || status?.processes) return 'running'
  return failed ? 'failed' : 'none'
}

/**
 * Builds the sidebar.
 *
 * The row set is the union of two sources, and the union is the point: history
 * comes from the store, but a fresh draft has no file yet and exists only as a
 * lane. Listing only one of them would either hide the session the user is
 * typing into or hide everything they did yesterday.
 */
export function sidebarView(state: SidebarState): SidebarView {
  const active = state.activeLane === undefined
    ? undefined
    : state.lanes.find((lane) => lane.lane === state.activeLane)
  const laneBySession = new Map<string, WireLaneInfo>()
  for (const lane of state.lanes) laneBySession.set(lane.paneId, lane)

  // Case-insensitive title substring. Empty query keeps every row — the filter
  // reads on the built row's `title`, which is where the "未命名会话" fallback
  // already lives, so a search matches what the user actually sees.
  const needle = state.searchQuery.trim().toLowerCase()
  const matches = (row: SidebarRow): boolean =>
    needle === '' || row.title.toLowerCase().includes(needle)

  // Keyed by project root and insertion-ordered, so projects appear in the
  // order `list-sessions` reported them and a project known only from a lane lands
  // after the ones with history.
  const byProject = new Map<
    string,
    { projectName: string; isGlobal: boolean; rows: SidebarRow[] }
  >()
  const bucketFor = (projectRoot: string, projectName: string, isGlobal = false) => {
    const existing = byProject.get(projectRoot)
    if (existing) return existing
    const created = { projectName, isGlobal, rows: [] as SidebarRow[] }
    byProject.set(projectRoot, created)
    return created
  }

  /** Whether a lane's session has had any input or output — see the lane pass. */
  const laneHasConversation = (lane: string): boolean =>
    state.laneStatus.get(lane)?.hasConversation ?? false

  // Sessions the history pull listed *and drew*. A listed-but-hidden (still
  // empty) session must not count as seen — the lane pass below is what brings
  // it on screen the moment its pane has content, without waiting for the next
  // pull.
  const seen = new Set<string>()
  // Coordinator and thread sessions live in the pinned section only.
  const coordinationSessions = new Set<string>()
  const summaryById = new Map<string, WireSessionSummary>()
  for (const table of state.coordination.values()) {
    if (table.coordinatorSessionId !== undefined) coordinationSessions.add(table.coordinatorSessionId)
    for (const thread of table.threads) coordinationSessions.add(thread.sessionId)
  }
  // Whether the pane on screen got a row at all. Set on the built row rather than
  // on the search-filtered one: a query that hides the active session has not
  // moved the user anywhere, so it must not hand the highlight back to the
  // heading.
  let activeHasRow = false
  for (const project of state.projects) {
    const bucket = bucketFor(project.projectRoot, project.projectName, project.isGlobal ?? false)
    for (const session of project.sessions) {
      summaryById.set(session.id, session)
      if (coordinationSessions.has(session.id) || session.coordinationRole === 'thread') {
        seen.add(session.id)
        continue
      }
      // A session with no input and no output stays invisible — that is the
      // whole rule for new sessions, and history with nothing in it (a
      // not-yet-cleaned empty session) gets the same answer.
      if (session.messageCount === 0) continue
      // Confirmed and on its way out: seen, so the lane pass below cannot draw
      // it back as a draft, but never turned into a row.
      seen.add(session.id)
      if (state.deletingSessions.has(session.id)) continue
      const lane = laneBySession.get(session.id)
      const row = rowFor(session, project.projectRoot, lane?.lane, active?.paneId, state)
      if (row.active) activeHasRow = true
      if (matches(row)) bucket.rows.push(row)
    }
  }

  // Lanes the history pull cannot speak for: a fresh draft has no index entry
  // until its first message, and a mid-first-turn session is listed with
  // `messageCount: 0` until the next pull. Either way the pane's own transcript
  // is the live truth — the row exists exactly when there is a conversation in
  // it, so a new session is invisible until its first input or output and
  // cannot blink out between submit and the turn's end.
  //
  // Synthesized into the same summary shape rather than built by a second row
  // constructor: badge, active and confirming are one decision each, and two
  // constructors is two places for them to drift.
  for (const lane of state.lanes) {
    if (seen.has(lane.paneId) || coordinationSessions.has(lane.paneId) || lane.coordinationRole === 'thread') continue
    if (state.deletingSessions.has(lane.paneId)) continue
    if (!laneHasConversation(lane.lane)) continue
    const draft: WireSessionSummary = {
      id: lane.paneId,
      ...(lane.sessionTitle !== undefined ? { title: lane.sessionTitle } : {}),
      // Nothing written yet, so "now" is the truth — and it puts the draft at the
      // top of its group, where the user just made it.
      updatedAt: new Date(state.now).toISOString(),
      messageCount: 0,
    }
    const row = rowFor(draft, lane.projectRoot, lane.lane, active?.paneId, state)
    if (row.active) activeHasRow = true
    const bucket = bucketFor(lane.projectRoot, lane.projectName)
    if (matches(row)) bucket.rows.push(row)
  }

  const coordination = state.recentOnly
    ? []
    : coordinationGroupsOf(state, summaryById, laneBySession, active?.paneId, needle)
  for (const group of coordination) if (group.coordinator?.active) activeHasRow = true

  // Drop only what the *search* emptied. Without a query an empty bucket keeps
  // its group: a project is a place, not a label on a pile of sessions, so one
  // whose sessions were all deleted still draws its heading — and stays
  // clickable — until the user removes it from the sidebar on purpose. The host
  // decides which projects are listed at all (`listSessions`); this filter used
  // to quietly overrule it.
  // The project the active pane belongs to, but only while that pane has no row
  // of its own: a session with nothing in it is invisible here, so without this
  // a brand-new session leaves the whole rail unmarked. It hands the highlight
  // back the instant the first message turns the draft into a row.
  const activeHeadingRoot = active !== undefined && !activeHasRow
    ? active.projectRoot
    : undefined

  const searching = needle !== ''
  const groups = [...byProject.entries()]
    // The「最近」filter, applied before the search's own: it selects *which
    // workspaces* are on screen, so a project group emptied by it is not an
    // empty project — it is not being listed at all.
    .filter(([projectRoot]) => !state.removingProjects.has(projectRoot))
    .filter(([, bucket]) => !state.recentOnly || bucket.isGlobal)
    .filter(([, bucket]) => !searching || bucket.rows.length > 0)
    .map(([projectRoot, bucket]) =>
      groupOf(projectRoot, bucket.projectName, bucket.rows, {
        // A search un-folds everything: the whole point of the query is to find a
        // session, and a match hidden behind a collapsed heading reads as "no
        // such session".
        collapsed: !searching && state.collapsedProjects.has(projectRoot),
        isGlobal: bucket.isGlobal,
        active: activeHeadingRoot === projectRoot,
        // A menu or a confirmation on a group that is being searched away would
        // be unanswerable, so both read on the same filtered set the view draws.
        menuOpen: state.projectMenu === projectRoot,
        confirmingRemove: state.pendingRemoveProject === projectRoot,
      }),
    )

  // The wire order stands: registry order (the order projects were added, first
  // added first, global workspace last). Activation never *moves* a group — no
  // hoisting — so switching sessions shifts nothing on screen; the only mark it
  // leaves is the heading highlight above, and only while the active session has
  // no row to carry it. The registry itself is stable across opens, so creating
  // a session in a project cannot move its group either.
  const ordered = groups
  // Collapsed groups are drawn as a heading and nothing else, so they are absent
  // here: this list is the cursor's and the digit chords' index space, and both
  // have to mean what is on screen.
  // The pinned coordinators are drawn above every group, so they lead here too.
  const rows = [
    ...coordination.flatMap((group) => (group.coordinator ? [group.coordinator] : [])),
    ...ordered.filter((group) => !group.collapsed).flatMap((group) => group.rows),
  ]

  // `groups` is empty only when there is genuinely nothing; a collapsed group is
  // still something to show, so the empty state reads on the groups rather than
  // on the visible rows.
  const nothing = ordered.length === 0 && coordination.length === 0
  return {
    pinned: coordination,
    groups: ordered,
    rows,
    liveRows: rows.filter((row) => row.lane !== undefined),
    activeProjectRoot: active?.projectRoot,
    collapsed: state.collapsed,
    collapsePhase: state.collapsePhase,
    selectedIndex: clampIndex(state.selectedIndex, rows.length),
    canCreate: state.canCreate,
    isEmpty: nothing && !searching,
    searchQuery: state.searchQuery,
    noMatches: nothing && searching,
    helpOpen: state.helpOpen,
    recentOnly: state.recentOnly,
    projectsOpen: state.projectsOpen,
    listLoad: state.listLoad,
  }
}

/**
 * The pinned section: one entry per project that has a coordinator pointer
 * or threads, in workspace order. The coordinator row stands for its threads
 * too: it is the active row while one of them is on screen. A search keeps an
 * entry only when its coordinator matches.
 */
function coordinationGroupsOf(
  state: SidebarState,
  summaryById: ReadonlyMap<string, WireSessionSummary>,
  laneBySession: ReadonlyMap<string, WireLaneInfo>,
  activePaneId: string | undefined,
  needle: string,
): SidebarCoordinationGroup[] {
  const roots = [...workspaceRootsOf(state)]

  const groups: SidebarCoordinationGroup[] = []
  for (const root of roots) {
    const table = state.coordination.get(root)
    if (!table || state.removingProjects.has(root)) continue
    if (!isCoordinationProject(table)) continue
    const coordinatorId = table.coordinatorSessionId

    let coordinator: SidebarRow | undefined
    if (coordinatorId !== undefined && !state.deletingSessions.has(coordinatorId)) {
      const lane = laneBySession.get(coordinatorId)
      const summary = summaryById.get(coordinatorId)
      const row = rowFor(
        {
          id: coordinatorId,
          title: summary?.title ?? lane?.sessionTitle ?? SIDEBAR_COORDINATION_TITLE,
          updatedAt: summary?.updatedAt ?? new Date(state.now).toISOString(),
          messageCount: summary?.messageCount ?? 0,
          coordinationRole: 'coordinator',
        },
        root,
        lane?.lane,
        activePaneId,
        state,
      )
      const threadOnScreen = table.threads.some((thread) => thread.sessionId === activePaneId)
      coordinator = threadOnScreen ? { ...row, active: true } : row
    }

    if (needle !== '' && (coordinator === undefined || !coordinator.title.toLowerCase().includes(needle))) continue

    const { running, blocked } = coordinationCounts(table.threads)
    groups.push({
      projectRoot: root,
      projectName: projectNameOf(state, root),
      ...(coordinator ? { coordinator } : {}),
      running,
      blocked,
    })
  }
  return groups
}

function projectNameOf(state: SidebarState, root: string): string {
  return state.projects.find((project) => project.projectRoot === root)?.projectName
    ?? state.lanes.find((lane) => lane.projectRoot === root)?.projectName
    ?? (root.split(/[\\/]/).filter(Boolean).pop() ?? root)
}

/** The marker a coordination session's row carries; ordinary sessions have none. */
export function roleMarkerFor(role: 'coordinator' | 'thread' | undefined): string | undefined {
  if (role === 'coordinator') return '调度'
  if (role === 'thread') return '线程'
  return undefined
}

function rowFor(
  session: WireSessionSummary,
  projectRoot: string,
  lane: string | undefined,
  activePaneId: string | undefined,
  state: SidebarState,
): SidebarRow {
  return {
    sessionId: session.id,
    title: session.title ?? '未命名会话',
    ...(roleMarkerFor(session.coordinationRole) !== undefined
      ? { roleMarker: roleMarkerFor(session.coordinationRole) }
      : {}),
    projectRoot,
    ...(lane !== undefined ? { lane } : {}),
    badge: badgeFor(lane, state, session.failed === true),
    active: session.id === activePaneId,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    confirmingDelete: state.pendingDelete === session.id,
  }
}

/**
 * One workspace's group: its rows, newest first.
 *
 * Sorted here rather than trusted, because two sources feed the list —
 * `SessionStore.list` already answers newest-first, but the drafts appended
 * after it are the *newest* things in the group and arrive last. A stable sort
 * keeps same-instant rows in arrival order, so a draft made in the same
 * millisecond as a save does not shuffle between paints.
 */
function groupOf(
  projectRoot: string,
  projectName: string,
  rows: readonly SidebarRow[],
  options: {
    collapsed: boolean
    isGlobal: boolean
    active: boolean
    menuOpen: boolean
    confirmingRemove: boolean
  },
): SidebarGroup {
  return {
    projectRoot,
    projectName,
    isGlobal: options.isGlobal,
    active: options.active,
    menuOpen: options.menuOpen,
    confirmingRemove: options.confirmingRemove,
    collapsed: options.collapsed,
    rows: [...rows].sort((left, right) => touchedAt(right.updatedAt) - touchedAt(left.updatedAt)),
  }
}

function clampIndex(index: number, length: number): number {
  if (length === 0 || index < 0) return -1
  return Math.min(index, length - 1)
}

// --- intents -----------------------------------------------------------------

export type SidebarIntent =
  /** Make an already-open lane the visible one. Renderer-local; no host round trip. */
  | { kind: 'switch'; lane: string }
  /** Open a session from history as a new lane. */
  | { kind: 'open'; projectRoot: string; sessionId: string }
  /** Release a lane's runtime. The session stays on disk. */
  | { kind: 'close'; lane: string }
  | { kind: 'new'; projectRoot?: string }
  | { kind: 'open-project' }
  /** Swap the canvas for the settings screen. Window-level, not per session. */
  | { kind: 'open-settings' }
  | { kind: 'toggle-collapse' }
  /**
   * The fold's animation reported that it finished — `transitionend`, or the
   * fallback timer standing in for one that never ran. View-generated: no key
   * and no button produces it, which is why `sidebarChordToIntent` cannot.
   */
  | { kind: 'collapse-settled' }
  /** Set the session-search filter. */
  | { kind: 'search'; query: string }
  /** Fold one workspace's group shut, or open it again. */
  | { kind: 'toggle-project'; projectRoot: string }
  /** Open a heading's context menu, or close whatever is open (`undefined`). */
  | { kind: 'open-project-menu'; projectRoot: string | undefined }
  /** Ask the heading "remove from the sidebar?" — the menu item's answer. */
  | { kind: 'request-remove-project'; projectRoot: string }
  /** Unregister the project. Its sessions stay on disk; only the row goes. */
  | { kind: 'confirm-remove-project'; projectRoot: string }
  | { kind: 'cancel-remove-project' }
  /** Open (or focus) the project's coordinator session — a coordination group's row. */
  | { kind: 'open-coordinator'; projectRoot: string }
  /** Open or close the footer's `?` panel. */
  | { kind: 'toggle-help' }
  /** Show only the sessions that belong to no project, or every workspace again. */
  | { kind: 'toggle-recent' }
  /** Show or leave the projects page. Renderer-local. */
  | { kind: 'toggle-projects' }
  | { kind: 'request-delete'; sessionId: string }
  | { kind: 'confirm-delete'; projectRoot: string; sessionId: string }
  | { kind: 'cancel-delete' }
  /** Read the history again after a first read that failed. */
  | { kind: 'retry-load' }
  | { kind: 'move'; direction: 'up' | 'down' }
  | { kind: 'none' }

export interface SidebarChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}

/**
 * The **global** chords, resolved before `resolveKey`.
 *
 * Everything here requires the platform's primary modifier (`isPrimaryModifier`:
 * ⌘ on macOS, Ctrl elsewhere), and the early return is what makes the ordering
 * safe: an unmodified key that resolved to an intent would shadow every dialog,
 * panel and composer keystroke in the window. The tab bar this replaced had the
 * same rule and the same reason.
 */
export function sidebarChordToIntent(chord: SidebarChord, state: SidebarState, platform: DesktopPlatform): SidebarIntent {
  if (!isPrimaryModifier(chord, platform)) return { kind: 'none' }

  // `Ctrl+1`–`9` over the *live* rows in visual order, so the nth chord and the
  // nth open session on screen are the same pane. The view is built inside this
  // branch rather than above the switch: it groups and sections every row, and
  // every other chord here discards it.
  if (chord.key >= '1' && chord.key <= '9') {
    const target = sidebarView(state).liveRows[Number.parseInt(chord.key, 10) - 1]
    if (target?.lane === undefined) return { kind: 'none' }
    return { kind: 'switch', lane: target.lane }
  }

  // Shift-qualified first: a browser reports `'O'` for Ctrl+Shift+O, so the
  // unshifted branches below would never see it — but testing the modifier
  // rather than the case is what keeps this honest on a layout that disagrees.
  if (chord.shiftKey === true && (chord.key === 'o' || chord.key === 'O')) {
    // Gated on `canCreate` like the button is: "key path and button must agree"
    // is a shell rule, and a chord that fires while a blocking prompt is up is
    // the button's disabled state being a lie.
    return state.canCreate ? { kind: 'open-project' } : { kind: 'none' }
  }
  if (chord.key === 'b' || chord.key === 'B') return { kind: 'toggle-collapse' }
  if (chord.key === 't' || chord.key === 'T') {
    if (!state.canCreate) return { kind: 'none' }
    return newSessionIntent(activeProjectRootOf(state))
  }
  if (chord.key === 'w' || chord.key === 'W') {
    if (state.activeLane === undefined) return { kind: 'none' }
    return { kind: 'close', lane: state.activeLane }
  }

  return { kind: 'none' }
}

/**
 * The keys that only apply while focus is inside the sidebar.
 *
 * Kept out of the global handler on purpose: arrows and Enter belong to the
 * composer and to whatever dropdown is open, and claiming them globally to move
 * a list cursor would be a regression the moment anyone typed. Escape here
 * cancels a pending delete rather than interrupting the turn, which is only
 * correct *because* it is scoped to the sidebar having focus.
 */
export function sidebarKeyToIntent(chord: SidebarChord, state: SidebarState): SidebarIntent {
  if (chord.ctrlKey === true || chord.metaKey === true) return { kind: 'none' }

  if (chord.key === 'Escape') {
    // Innermost first, the `settingsKeyToIntent` ordering: a menu, then the
    // question it opened, then the row's own confirmation. Escape backs out one
    // layer at a time rather than clearing everything at once.
    if (state.projectMenu !== undefined) return { kind: 'open-project-menu', projectRoot: undefined }
    if (state.pendingRemoveProject !== undefined) return { kind: 'cancel-remove-project' }
    return state.pendingDelete !== undefined ? { kind: 'cancel-delete' } : { kind: 'none' }
  }
  if (chord.key === 'ArrowUp') return { kind: 'move', direction: 'up' }
  if (chord.key === 'ArrowDown') return { kind: 'move', direction: 'down' }

  const view = sidebarView(state)
  const row = view.rows[view.selectedIndex]
  if (!row) return { kind: 'none' }

  if (chord.key === 'Enter') {
    // A row already asking for confirmation answers *yes* — the confirm is the
    // thing under the cursor, not the session behind it.
    if (row.confirmingDelete) {
      return { kind: 'confirm-delete', projectRoot: row.projectRoot, sessionId: row.sessionId }
    }
    // Through `activateRow` so Enter and a click cannot drift apart about what
    // "open or switch" means.
    return activateRow(row)
  }
  if (chord.key === 'Delete' || chord.key === 'Backspace') {
    if (row.confirmingDelete) return { kind: 'none' }
    return { kind: 'request-delete', sessionId: row.sessionId }
  }

  return { kind: 'none' }
}

/**
 * Where the cursor lands after a move. Clamps rather than wrapping: the list is
 * long and grouped, and wrapping from the last project's oldest session to the
 * first project's newest is a jump nobody asked for.
 *
 * Takes the built view rather than the state, because every caller already has
 * one — an arrow key used to build three.
 */
export function moveSelection(view: SidebarView, direction: 'up' | 'down'): number {
  if (view.rows.length === 0) return -1
  if (view.selectedIndex === -1) return direction === 'down' ? 0 : view.rows.length - 1
  const next = view.selectedIndex + (direction === 'down' ? 1 : -1)
  return Math.max(0, Math.min(next, view.rows.length - 1))
}

/**
 * What a click on a row means. The one place "open or switch" is decided, so the
 * mouse path and the Enter path cannot drift apart.
 */
export function activateRow(row: SidebarRow): SidebarIntent {
  if (row.lane !== undefined) return { kind: 'switch', lane: row.lane }
  return { kind: 'open', projectRoot: row.projectRoot, sessionId: row.sessionId }
}

/**
 * "New session", targeted at a project. The one place that decision is made, for
 * the reason `activateRow` exists: `Ctrl+T` resolved the project and the button
 * did not, so with two projects open the button created the session in whichever
 * was opened *first* — `ShellHost` falls back to `directory.entries()[0]` when
 * the intent carries no root, and its tooltip promised the current project.
 */
export function newSessionIntent(projectRoot: string | undefined): SidebarIntent {
  return { kind: 'new', ...(projectRoot !== undefined ? { projectRoot } : {}) }
}

/**
 * The workspaces with a group on screen, in visual order.
 *
 * Built from `state` rather than from a built view so callers that only need the
 * roots — "which project does this pane belong to", the reveal path — do not pay
 * for grouping. History projects come first in wire order (added order, first
 * added first); a project known only from a lane lands after them. No hoisting:
 * activation is imperceptible, so the order never moves.
 */
export function workspaceRootsOf(state: SidebarState): readonly string[] {
  const roots: string[] = []
  const add = (root: string): void => {
    if (!roots.includes(root)) roots.push(root)
  }
  for (const project of state.projects) add(project.projectRoot)
  for (const lane of state.lanes) add(lane.projectRoot)
  return roots
}

/**
 * Folding a workspace open or shut, as the next collapsed set.
 *
 * A `Set` rather than a toggle on the state so `app.ts` holds one field and this
 * file owns what "toggle" means — including that revealing a project is the same
 * operation with the answer fixed.
 */
export function toggleProject(
  collapsed: ReadonlySet<string>,
  projectRoot: string,
  force?: boolean,
): ReadonlySet<string> {
  const next = new Set(collapsed)
  const shut = force ?? !next.has(projectRoot)
  if (shut) next.add(projectRoot)
  else next.delete(projectRoot)
  return next
}

/**
 * Everything the DOM draws, as one comparable string.
 *
 * The sidebar repaints from `onShellChanged`, which fires on every
 * `SessionClient` snapshot change — and that includes background-task
 * `outputBytes`, so a backgrounded `npm test` would rebuild every history row at
 * output-flush rate. Rebuilding is not cheap: ~9 nodes and 2 listeners per row,
 * unbounded by the conversation because rows are *sessions on disk*.
 *
 * So the view compares this first and returns early when nothing it draws has
 * moved — the same field-diff discipline `SessionClient.applySnapshot` and
 * `ShellClient.applyLanes` use, and for the same reason. It must cover every
 * field `render()` reads: a field drawn but not signed goes stale on screen.
 * `updatedAt` is deliberately absent — it is not drawn, only sorted on, and the
 * order it produces shows up as the order the rows are signed in.
 */
export function sidebarRenderSignature(view: SidebarView): string {
  const parts: string[] = [
    view.collapsed ? 'c' : '-',
    // The middle phases are frames the guard would otherwise swallow: without
    // this, a collapse would repaint only once it had already finished.
    `p:${view.collapsePhase}`,
    view.canCreate ? 'n' : '-',
    view.isEmpty ? 'e' : '-',
    view.noMatches ? 'm' : '-',
    // Signed, or the panel opens and the render guard swallows the repaint —
    // the failure this signature exists to prevent.
    view.helpOpen ? 'h' : '-',
    // Signed for the same reason: the nav row carries an on-state, and the
    // empty text it produces is different from the plain one.
    view.recentOnly ? 'r' : '-',
    view.projectsOpen ? 'o' : '-',
    `l:${view.listLoad}`,
    String(view.selectedIndex),
    `q:${view.searchQuery}`,
  ]
  for (const entry of view.pinned) {
    parts.push(`k:${entry.projectRoot}${entry.projectName}${entry.running}/${entry.blocked}`)
    const row = entry.coordinator
    if (row) parts.push(`${row.sessionId}${row.lane ?? ''}${row.badge}${row.active ? '1' : '0'}${row.confirmingDelete ? '1' : '0'}`)
  }
  for (const group of view.groups) {
    // The menu and the confirmation are drawn on the heading, a collapsed
    // group's included, so they are signed even where the rows below are not —
    // an unsigned `menuOpen` is a right-click the render guard swallows. The
    // heading's own highlight signs for the same reason: it is the only mark a
    // brand-new session gets, and it arrives without any row changing.
    parts.push(
      `g:${group.projectRoot}${group.projectName}${group.collapsed ? '1' : '0'}${group.isGlobal ? 'g' : '-'}`
        + `${group.menuOpen ? 'm' : '-'}${group.confirmingRemove ? 'r' : '-'}${group.rows.length}${group.active ? 'a' : '-'}`,
    )
    if (group.collapsed) continue
    for (const row of group.rows) {
      parts.push(
        `r:${row.sessionId}${row.lane ?? ''}${row.badge}${row.active ? '1' : '0'}`
          + `${row.confirmingDelete ? '1' : '0'}${row.title}${row.messageCount}`
          + `${row.roleMarker ?? ''}`,
      )
    }
  }
  return parts.join('')
}

function activeProjectRootOf(state: SidebarState): string | undefined {
  if (state.activeLane === undefined) return undefined
  return state.lanes.find((lane) => lane.lane === state.activeLane)?.projectRoot
}
