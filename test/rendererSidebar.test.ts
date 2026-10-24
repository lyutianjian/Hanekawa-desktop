import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activateRow,
  createSidebarState,
  moveSelection,
  newSessionIntent,
  nextCollapsePhase,
  sidebarContentMounted,
  sidebarChordToIntent,
  sidebarKeyToIntent,
  sidebarRenderSignature,
  sidebarView,
  toggleProject,
  workspaceRootsOf,
  type SidebarCollapsePhase,
  type SidebarLaneStatus,
  type SidebarProjectSessions,
  type SidebarState,
  type SidebarView,
  nextUnreadLanes,
} from '../src/desktop/renderer/model/sidebar.js'
import type { WireCoordinationThreads, WireLaneInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'
import type { WireSessionSummary } from '../src/desktop/shellProtocol.js'

/**
 * The sidebar model — grouping by workspace, folding, badges, and the two key
 * entry points.
 *
 * Assertions land on `kind` rather than on labels: 4e localizes every string in
 * the shell, and a suite pinned to literals would have to be rewritten alongside
 * it without covering anything more.
 *
 * The load-bearing cases:
 *
 * - `sidebarChordToIntent` answers `'none'` without the platform's primary
 *   modifier (⌘ on macOS, Ctrl elsewhere). It resolves *before* the global
 *   keymap, so anything else silently shadows every dialog.
 * - `Ctrl+1`–`9` indexes the open rows only. Reaching into history would turn a
 *   switch into an open.
 * - A live lane with no file behind it still gets a row, or the session the user
 *   is typing into disappears from the list.
 * - A folded workspace contributes no rows to `rows`/`liveRows`, or the cursor
 *   and `Ctrl+1`–`9` step into sessions that are not on screen.
 */

const NOW = new Date(2026, 7, 20, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

function at(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString()
}

function session(id: string, overrides: Partial<WireSessionSummary> = {}): WireSessionSummary {
  return { id, updatedAt: at(0), messageCount: 3, ...overrides }
}

function project(
  projectRoot: string,
  projectName: string,
  sessions: WireSessionSummary[],
): SidebarProjectSessions {
  return { projectRoot, projectName, sessions }
}

function lane(key: string, paneId: string, projectRoot: string, overrides: Partial<WireLaneInfo> = {}): WireLaneInfo {
  return {
    lane: key,
    paneId,
    sessionId: paneId,
    projectRoot,
    projectName: projectRoot.split(/[\\/]/).pop() ?? projectRoot,
    ...overrides,
  }
}

/** A pane's live contribution. Defaults to "has a conversation, nothing running". */
function paneStatus(overrides: Partial<SidebarLaneStatus> = {}): SidebarLaneStatus {
  return { streaming: false, blocked: false, processes: false, hasConversation: true, ...overrides }
}

function stateWith(overrides: Partial<SidebarState> = {}): SidebarState {
  return createSidebarState({ now: NOW, ...overrides })
}

// --- coordination ---------------------------------------------------------------

test('a coordinator outside the thread table is an ordinary row with a role marker; a thread is never a row', () => {
  const view = sidebarView(
    stateWith({
      projects: [
        project('/a', 'alpha', [
          session('c', { coordinationRole: 'coordinator' }),
          session('t', { coordinationRole: 'thread' }),
          session('p'),
        ]),
      ],
    }),
  )
  const rows = view.groups[0]!.rows
  const marker = (id: string) => rows.find((row) => row.sessionId === id)?.roleMarker
  assert.equal(marker('c'), '调度')
  assert.equal(rows.some((row) => row.sessionId === 't'), false)
  assert.equal(marker('p'), undefined)
})

// --- ordering inside a workspace ---------------------------------------------

test('a workspace lists its sessions newest first, with no age sections', () => {
  // The age sections are gone: workspace is the only grouping axis, and inside a
  // group the list is simply a timeline.
  const view = sidebarView(
    stateWith({
      projects: [
        project('/a', 'alpha', [
          session('s-old', { updatedAt: at(40 * DAY) }),
          session('s-today', { updatedAt: at(0) }),
          session('s-week', { updatedAt: at(3 * DAY) }),
        ]),
      ],
    }),
  )

  assert.deepEqual(
    view.rows.map((row) => row.sessionId),
    ['s-today', 's-week', 's-old'],
  )
  assert.deepEqual(view.groups[0]!.rows, view.rows, 'the group carries the same order')
})

test('an unparseable timestamp sorts oldest rather than throwing', () => {
  // The store self-heals rather than rejecting bad records, so a row the user can
  // still delete beats a sidebar that will not draw.
  const view = sidebarView(
    stateWith({
      projects: [
        project('/a', 'alpha', [
          session('broken', { updatedAt: 'not a date' }),
          session('fine', { updatedAt: at(40 * DAY) }),
        ]),
      ],
    }),
  )
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['fine', 'broken'])
})

// --- grouping ---------------------------------------------------------------

test('the wire order stands regardless of which pane is active', () => {
  // Activation moves nothing: no group is hoisted, and while the active session
  // has a row of its own the heading above it stays unmarked — switching
  // sessions must not shift anything on screen.
  const state = stateWith({
    projects: [
      project('/a', 'alpha', [session('a1')]),
      project('/b', 'beta', [session('b1')]),
      project('/c', 'gamma', [session('c1')]),
    ],
    lanes: [lane('2', 'b1', '/b')],
    activeLane: '2',
  })

  const view = sidebarView(state)
  assert.deepEqual(
    view.groups.map((group) => group.projectName),
    ['alpha', 'beta', 'gamma'],
  )
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1', 'b1', 'c1'])
  // The active row still *knows* it is the shown one — data without styling.
  assert.deepEqual(view.rows.map((row) => row.active), [false, true, false])
  assert.deepEqual(view.groups.map((group) => group.active), [false, false, false])
})

test('a session with no row yet marks its project heading instead', () => {
  // A brand-new session is invisible in the list, so without this the rail says
  // nothing at all about where the user is. The heading holds the mark until the
  // first message gives the session a row, and never alongside it.
  const base = {
    projects: [
      project('/a', 'alpha', [session('a1')]),
      project('/b', 'beta', []),
    ],
    lanes: [lane('2', 'draft', '/b')],
    activeLane: '2',
  }

  const fresh = sidebarView(
    stateWith({ ...base, laneStatus: new Map([['2', paneStatus({ hasConversation: false })]]) }),
  )
  assert.deepEqual(fresh.rows.map((row) => row.sessionId), ['a1'], 'the draft has no row')
  assert.deepEqual(fresh.groups.map((group) => group.active), [false, true])

  // First message: the draft becomes a row, and the highlight moves down to it.
  const spoken = sidebarView(
    stateWith({ ...base, laneStatus: new Map([['2', paneStatus({ hasConversation: true })]]) }),
  )
  assert.deepEqual(spoken.rows.map((row) => row.active), [false, true])
  assert.deepEqual(spoken.groups.map((group) => group.active), [false, false])
})

test('a search that hides the active session leaves its heading unmarked', () => {
  // The query moved the user nowhere. Handing the highlight up to the heading
  // would read as "you are in a new session here", which is not what happened.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1', { title: 'alpha talk' })])],
      lanes: [lane('1', 'a1', '/a')],
      activeLane: '1',
      searchQuery: 'zzz',
    }),
  )
  assert.equal(view.rows.length, 0)
  assert.deepEqual(view.groups.map((group) => group.active), [])
})

// --- folding ----------------------------------------------------------------

test('a folded workspace keeps its rows but shows only the session on screen', () => {
  // The heading still says how many are inside (`group.rows`), but `rows` is the
  // index space for the cursor and `Ctrl+1`–`9`, and both have to mean what is on
  // screen: a folded group draws the active session under its heading, and only
  // while it stays active.
  const base = {
    projects: [project('/a', 'alpha', [session('a1'), session('a2')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('1', 'a1', '/a'), lane('2', 'b1', '/b')],
    collapsedProjects: new Set(['/a']),
  }
  const state = stateWith({ ...base, activeLane: '1' })
  const view = sidebarView(state)

  assert.deepEqual(view.groups.map((group) => group.collapsed), [true, false])
  assert.equal(view.groups[0]!.rows.length, 2, 'the folded group still knows what it holds')
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1', 'b1'])
  assert.deepEqual(sidebarChordToIntent({ key: '1', ctrlKey: true }, state, 'win32'), { kind: 'switch', lane: '1' })

  // Switching away folds it back in.
  const away = stateWith({ ...base, activeLane: '2' })
  assert.deepEqual(sidebarView(away).rows.map((row) => row.sessionId), ['b1'])
  assert.deepEqual(sidebarChordToIntent({ key: '2', ctrlKey: true }, away, 'win32'), { kind: 'none' })
})

test('folding every workspace is not the empty state', () => {
  // "Nothing here" and "you folded it all up" are different screens, and the
  // second one still has headings to click.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')])],
      collapsedProjects: new Set(['/a']),
    }),
  )
  assert.deepEqual(view.rows, [])
  assert.equal(view.isEmpty, false)
  assert.equal(view.noMatches, false)
})

test('a search unfolds everything, or its matches would be hidden', () => {
  const view = sidebarView(
    stateWith({
      searchQuery: 'one',
      projects: [project('/a', 'alpha', [session('a1', { title: 'One' })])],
      collapsedProjects: new Set(['/a']),
    }),
  )
  assert.equal(view.groups[0]!.collapsed, false)
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1'])
})

test('toggleProject folds, unfolds, and takes a forced answer', () => {
  const shut = toggleProject(new Set(), '/a')
  assert.deepEqual([...shut], ['/a'])
  assert.deepEqual([...toggleProject(shut, '/a')], [], 'a second toggle opens it again')
  // The reveal path forces "open" rather than toggling: clicking the Hero project
  // name of an already-open workspace must not fold it.
  assert.deepEqual([...toggleProject(shut, '/a', false)], [])
  assert.deepEqual([...toggleProject(new Set(), '/a', false)], [])
})

test('the workspace roots are every project, in wire order', () => {
  // No hoisting here either — activation must not move anything.
  const roots = workspaceRootsOf(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
      lanes: [lane('2', 'b1', '/b'), lane('3', 'x', 'C:\\repo\\solo')],
      activeLane: '2',
    }),
  )
  assert.deepEqual(roots, ['/a', '/b', 'C:\\repo\\solo'])
})

// --- history × topology -----------------------------------------------------

test('a live lane with nothing on disk stays invisible until it has content', () => {
  // The rule the product asked for: a new session with no input and no output
  // draws no「未命名会话」row. Fresh boot, the sidebar shows only history.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1', { title: 'Yesterday', updatedAt: at(30 * DAY) })])],
      lanes: [lane('1', 'draft-1', '/a')],
      laneStatus: new Map([['1', paneStatus({ hasConversation: false })]]),
      activeLane: '1',
    }),
  )

  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1'])
  assert.equal(view.isEmpty, false, 'history still draws')

  // With no status entry at all (a pane the renderer has not built yet), the
  // same answer: hidden.
  const unbuilt = sidebarView(
    stateWith({
      projects: [],
      lanes: [lane('1', 'draft-1', '/a')],
    }),
  )
  assert.deepEqual(unbuilt.rows, [])
})

test('a live lane with nothing on disk gets a row once it has content', () => {
  // First input lands mid-turn, before the history pull ever hears of the
  // session: the pane's own transcript is the live truth.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1', { title: 'Yesterday', updatedAt: at(30 * DAY) })])],
      lanes: [lane('1', 'draft-1', '/a')],
      laneStatus: new Map([['1', paneStatus({ hasConversation: true })]]),
      activeLane: '1',
    }),
  )

  assert.deepEqual(view.rows.map((row) => row.sessionId), ['draft-1', 'a1'])
  assert.equal(view.rows[0]!.lane, '1')
  assert.equal(view.rows[0]!.active, true)
})

test('a session listed with messageCount 0 shows through its lane once it has content', () => {
  // The store lists a session the moment its first record lands, but its
  // `messageCount` in the *pulled* snapshot can lag the turn. The lane's
  // conversation bit is what keeps the row on screen.
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('fresh-1', { messageCount: 0, title: undefined })])],
      lanes: [lane('1', 'fresh-1', '/a')],
      laneStatus: new Map([['1', paneStatus({ hasConversation: true })]]),
    }),
  )
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['fresh-1'])

  // And a closed empty session — history with nothing in it — stays hidden.
  const closed = sidebarView(
    stateWith({ projects: [project('/a', 'alpha', [session('empty-1', { messageCount: 0 })])] }),
  )
  assert.deepEqual(closed.rows, [])
  // The *row* is hidden, but the project it belongs to is not: a listed project
  // keeps its heading whether or not anything under it is visible.
  assert.deepEqual(closed.groups.map((group) => group.projectRoot), ['/a'])
  assert.equal(closed.isEmpty, false, 'the project is still on screen')
})

test('a session on disk carries its lane when one is open', () => {
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1'), session('a2')])],
      lanes: [lane('7', 'a2', '/a')],
    }),
  )

  assert.equal(view.rows.find((row) => row.sessionId === 'a1')!.lane, undefined)
  assert.equal(view.rows.find((row) => row.sessionId === 'a2')!.lane, '7')
  assert.deepEqual(view.liveRows.map((row) => row.sessionId), ['a2'])
})

test('a lane whose project has no history entry is grouped from its own fields', () => {
  const view = sidebarView(
    stateWith({
      lanes: [lane('1', 'x', 'C:\\repo\\solo')],
      laneStatus: new Map([['1', paneStatus({ hasConversation: true })]]),
    }),
  )
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0]!.projectName, 'solo')
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['x'])
})

test('a session with no title still names itself', () => {
  const view = sidebarView(stateWith({ projects: [project('/a', 'alpha', [session('a1')])] }))
  assert.equal(typeof view.rows[0]!.title, 'string')
  assert.ok(view.rows[0]!.title.length > 0)
})

test('an empty directory reports the empty state', () => {
  const view = sidebarView(stateWith({}))
  assert.equal(view.isEmpty, true)
  assert.deepEqual(view.rows, [])
  assert.equal(view.selectedIndex, -1)
})

// --- projects outlive their sessions -----------------------------------------

test('a listed project keeps its group with no sessions at all', () => {
  // The point of the change: a project is a place to come back to, not a label
  // on a pile of sessions. Deleting the last session used to delete the row that
  // was the only way back to the project.
  const view = sidebarView(stateWith({ projects: [project('/a', 'alpha', [])] }))

  assert.deepEqual(view.groups.map((group) => group.projectRoot), ['/a'])
  assert.deepEqual(view.rows, [])
  assert.equal(view.isEmpty, false)
  assert.equal(view.noMatches, false)
})

test('a search still drops the groups it emptied', () => {
  // The empty group survives *absence of sessions*, not a filter: a heading with
  // no match under it reads as "here is your result" and is not one.
  const view = sidebarView(
    stateWith({
      projects: [
        project('/a', 'alpha', [session('a1', { title: 'report' })]),
        project('/b', 'beta', [session('b1', { title: 'other' })]),
        project('/c', 'gamma', []),
      ],
      searchQuery: 'report',
    }),
  )

  assert.deepEqual(view.groups.map((group) => group.projectRoot), ['/a'])
})

test('the global workspace is marked from the wire, never from its name', () => {
  const view = sidebarView(
    stateWith({
      projects: [
        { projectRoot: '/home/me', projectName: '最近', isGlobal: true, sessions: [] },
        project('/a', 'alpha', []),
      ],
    }),
  )

  assert.deepEqual(view.groups.map((group) => group.isGlobal), [true, false])
})

test('the recent filter lists the global workspace and nothing else', () => {
  const state = stateWith({
    projects: [
      {
        projectRoot: '/home/me',
        projectName: '最近',
        isGlobal: true,
        sessions: [session('g1', { title: 'loose' })],
      },
      project('/a', 'alpha', [session('a1', { title: 'work' })]),
    ],
    recentOnly: true,
  })
  const view = sidebarView(state)

  assert.deepEqual(view.groups.map((group) => group.projectRoot), ['/home/me'])
  // The cursor and `Ctrl+1`–`9` index what is on screen, so a filtered-away row
  // must not be reachable from either.
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['g1'])
  assert.equal(view.recentOnly, true)
  // Off again, both workspaces are back — the filter drops nothing on the way.
  assert.equal(sidebarView({ ...state, recentOnly: false }).groups.length, 2)
})

test('the recent filter with nothing loose is an empty state of its own', () => {
  const view = sidebarView(
    stateWith({ projects: [project('/a', 'alpha', [session('a1')])], recentOnly: true }),
  )

  // `isEmpty`, not `noMatches`: nothing was searched for. The view says which
  // empty it is, and `dom/sidebarView.ts` picks the sentence from `recentOnly`.
  assert.deepEqual([view.isEmpty, view.noMatches], [true, false])
})

test('the heading carries its own menu and confirmation state', () => {
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', []), project('/b', 'beta', [])],
      projectMenu: '/a',
      pendingRemoveProject: '/b',
    }),
  )

  assert.deepEqual(view.groups.map((group) => group.menuOpen), [true, false])
  assert.deepEqual(view.groups.map((group) => group.confirmingRemove), [false, true])
})

test('Escape backs out of the heading menu before the row confirmation', () => {
  // Innermost first, the settings-screen ordering: one layer per keystroke.
  const base = stateWith({
    projects: [project('/a', 'alpha', [session('a1')])],
    pendingDelete: 'a1',
    pendingRemoveProject: '/a',
    projectMenu: '/a',
  })

  assert.deepEqual(sidebarKeyToIntent({ key: 'Escape' }, base), {
    kind: 'open-project-menu',
    projectRoot: undefined,
  })
  assert.deepEqual(sidebarKeyToIntent({ key: 'Escape' }, { ...base, projectMenu: undefined }), {
    kind: 'cancel-remove-project',
  })
  assert.deepEqual(
    sidebarKeyToIntent(
      { key: 'Escape' },
      { ...base, projectMenu: undefined, pendingRemoveProject: undefined },
    ),
    { kind: 'cancel-delete' },
  )
})

// --- badges -----------------------------------------------------------------

test('badges come off the pane snapshot, with awaiting-input outranking running', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1'), session('a2'), session('a3'), session('a4'), session('a5'), session('a6')])],
    lanes: [lane('1', 'a1', '/a'), lane('2', 'a2', '/a'), lane('3', 'a3', '/a'), lane('4', 'a4', '/a'), lane('5', 'a5', '/a')],
    laneStatus: new Map([
      ['1', paneStatus({ streaming: true })],
      // Still streaming, but parked on a prompt: "waiting for you" is the
      // actionable half, so it wins.
      ['2', paneStatus({ streaming: true, blocked: true })],
      ['3', paneStatus()],
      // The turn ended but a process it left behind is still running.
      ['4', paneStatus({ processes: true })],
      ['5', paneStatus()],
    ]),
  })

  const badges = new Map(sidebarView(state).rows.map((row) => [row.sessionId, row.badge]))
  assert.equal(badges.get('a1'), 'running')
  assert.equal(badges.get('a2'), 'awaiting-input')
  assert.equal(badges.get('a3'), 'none')
  assert.equal(badges.get('a4'), 'running', 'a leftover background process keeps the session busy')
  assert.equal(badges.get('a5'), 'none')
  assert.equal(badges.get('a6'), 'none', 'a closed session has no pane to report')
})

test('a session whose last turn failed says so, on a closed row and an open one, until work resumes', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [
      session('a1', { failed: true }),
      session('a2', { failed: true }),
      session('a3', { failed: true }),
      session('a4'),
    ])],
    lanes: [lane('2', 'a2', '/a'), lane('3', 'a3', '/a')],
    laneStatus: new Map([
      ['2', paneStatus()],
      // Retrying: the spinner outranks the previous failure.
      ['3', paneStatus({ streaming: true })],
    ]),
  })

  const badges = new Map(sidebarView(state).rows.map((row) => [row.sessionId, row.badge]))
  assert.equal(badges.get('a1'), 'failed', 'a closed session still carries it')
  assert.equal(badges.get('a2'), 'failed')
  assert.equal(badges.get('a3'), 'running')
  assert.equal(badges.get('a4'), 'none')
})

test('a lane with no status entry yet carries no badge', () => {
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('a1')])],
      lanes: [lane('1', 'a1', '/a')],
    }),
  )
  assert.equal(view.rows[0]!.badge, 'none')
})

// --- search -----------------------------------------------------------------

test('the search box filters rows by title, case-insensitively and across projects', () => {
  const state = stateWith({
    searchQuery: 'REPORT',
    projects: [
      project('/a', 'alpha', [
        session('a1', { title: 'Weekly report' }),
        session('a2', { title: 'Bugfix' }),
      ]),
      project('/b', 'beta', [session('b1', { title: 'Report draft' })]),
    ],
  })
  const view = sidebarView(state)
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1', 'b1'])
  // Beta kept a match, alpha's second session did not; both groups still stand.
  assert.deepEqual(view.groups.map((group) => group.projectName), ['alpha', 'beta'])
})

test('an empty query keeps every row', () => {
  const view = sidebarView(
    stateWith({
      searchQuery: '   ',
      projects: [project('/a', 'alpha', [session('a1', { title: 'One' }), session('a2', { title: 'Two' })])],
    }),
  )
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['a1', 'a2'])
  assert.equal(view.noMatches, false)
  assert.equal(view.isEmpty, false)
})

test('a search that matches nothing reports noMatches, not the empty state', () => {
  // The two are different screens: "no sessions yet" versus "nothing matched
  // your search", and the sidebar draws a different message for each.
  const view = sidebarView(
    stateWith({
      searchQuery: 'zzz',
      projects: [project('/a', 'alpha', [session('a1', { title: 'One' })])],
    }),
  )
  assert.deepEqual(view.rows, [])
  assert.equal(view.noMatches, true)
  assert.equal(view.isEmpty, false)

  // A genuinely empty directory is the empty state, never noMatches.
  const empty = sidebarView(stateWith({ searchQuery: '' }))
  assert.equal(empty.isEmpty, true)
  assert.equal(empty.noMatches, false)
})

// --- global chords ----------------------------------------------------------

test('an unmodified key is never a sidebar intent', () => {
  // The whole reason these chords may resolve before the global keymap. An
  // unmodified key answering here would shadow every dialog in the window.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
  })
  for (const key of ['1', '2', 'b', 'B', 't', 'w', 'o', 'Enter', 'Escape', 'ArrowDown', 'x']) {
    assert.deepEqual(
      sidebarChordToIntent({ key }, state, 'win32'),
      { kind: 'none' },
      `expected ${key} without a modifier to be none`,
    )
  }
})

test('Ctrl+1-9 switches among open lanes in visual order', () => {
  const state = stateWith({
    projects: [
      project('/a', 'alpha', [session('a1'), session('a2')]),
      project('/b', 'beta', [session('b1')]),
    ],
    lanes: [lane('5', 'a2', '/a'), lane('6', 'b1', '/b')],
    activeLane: '6',
  })

  // Visual order is wire order (alpha before beta), activation irrelevant.
  assert.deepEqual(sidebarChordToIntent({ key: '1', ctrlKey: true }, state, 'win32'), { kind: 'switch', lane: '5' })
  assert.deepEqual(sidebarChordToIntent({ key: '2', ctrlKey: true }, state, 'win32'), { kind: 'switch', lane: '6' })
  assert.deepEqual(sidebarChordToIntent({ key: '3', ctrlKey: true }, state, 'win32'), { kind: 'none' })
})

test('Ctrl+1-9 never reaches into history', () => {
  // Three sessions on disk, one open. The chord means "switch between live
  // panes"; letting it index closed rows would turn a switch into an open.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1'), session('a2'), session('a3')])],
    lanes: [lane('9', 'a3', '/a')],
  })

  assert.deepEqual(sidebarChordToIntent({ key: '1', ctrlKey: true }, state, 'win32'), { kind: 'switch', lane: '9' })
  assert.deepEqual(sidebarChordToIntent({ key: '2', ctrlKey: true }, state, 'win32'), { kind: 'none' })
  assert.deepEqual(sidebarChordToIntent({ key: '3', ctrlKey: true }, state, 'win32'), { kind: 'none' })
})

test('Ctrl+B toggles the sidebar, on the platform’s own modifier only', () => {
  const state = stateWith({})
  assert.deepEqual(sidebarChordToIntent({ key: 'b', ctrlKey: true }, state, 'win32'), { kind: 'toggle-collapse' })
  assert.deepEqual(sidebarChordToIntent({ key: 'B', metaKey: true }, state, 'darwin'), { kind: 'toggle-collapse' })
  // Control on macOS is Cocoa's text-editing modifier — Ctrl+B moves the caret
  // back a character in every field — so it must reach the field untouched.
  // And the ⊞ key on Windows is the system's.
  assert.deepEqual(sidebarChordToIntent({ key: 'b', ctrlKey: true }, state, 'darwin'), { kind: 'none' })
  assert.deepEqual(sidebarChordToIntent({ key: 'b', metaKey: true }, state, 'win32'), { kind: 'none' })
})

test('a chord under the other platform’s modifier, or with Alt, is no chord', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
  })
  for (const key of ['1', 'b', 't', 'w', 'O']) {
    // Ctrl+T transposes and Ctrl+O opens a line in a macOS field.
    assert.deepEqual(sidebarChordToIntent({ key, ctrlKey: true, shiftKey: key === 'O' }, state, 'darwin'), { kind: 'none' }, `⌃${key} on macOS`)
    assert.deepEqual(sidebarChordToIntent({ key, metaKey: true, shiftKey: key === 'O' }, state, 'win32'), { kind: 'none' }, `⊞${key} on Windows`)
    // Ctrl+Alt is AltGr on many Windows layouts: it types characters.
    assert.deepEqual(sidebarChordToIntent({ key, ctrlKey: true, altKey: true }, state, 'win32'), { kind: 'none' }, `Ctrl+Alt+${key}`)
    // Both modifiers at once is neither platform's chord.
    assert.deepEqual(sidebarChordToIntent({ key, ctrlKey: true, metaKey: true }, state, 'darwin'), { kind: 'none' }, `⌃⌘${key}`)
  }
})

test('Ctrl+Shift+O resolves before the unshifted letters', () => {
  // A browser reports `'O'` for Ctrl+Shift+O, so the letter branches below would
  // never see it — but checking the modifier is what keeps this honest on a
  // layout that disagrees.
  const state = stateWith({})
  assert.deepEqual(
    sidebarChordToIntent({ key: 'O', ctrlKey: true, shiftKey: true }, state, 'win32'),
    { kind: 'open-project' },
  )
  assert.deepEqual(
    sidebarChordToIntent({ key: 'o', ctrlKey: true, shiftKey: true }, state, 'win32'),
    { kind: 'open-project' },
  )
})

test('Ctrl+T targets the active pane project, and answers without one', () => {
  const withActive = stateWith({
    projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('2', 'b1', '/b')],
    activeLane: '2',
  })
  assert.deepEqual(sidebarChordToIntent({ key: 't', ctrlKey: true }, withActive, 'win32'), {
    kind: 'new',
    projectRoot: '/b',
  })
  assert.deepEqual(sidebarChordToIntent({ key: 'T', ctrlKey: true }, stateWith({}), 'win32'), { kind: 'new' })
})

test('Ctrl+W closes the active lane, and does nothing without one', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('4', 'a1', '/a')],
    activeLane: '4',
  })
  assert.deepEqual(sidebarChordToIntent({ key: 'w', ctrlKey: true }, state, 'win32'), { kind: 'close', lane: '4' })
  assert.deepEqual(
    sidebarChordToIntent({ key: 'w', ctrlKey: true }, stateWith({}), 'win32'),
    { kind: 'none' },
  )
})

test('Command chords retain session routing and blocking-dialog gates', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('1', 'a1', '/a'), lane('2', 'b1', '/b')],
    activeLane: '2',
  })
  assert.deepEqual(sidebarChordToIntent({ key: '1', metaKey: true }, state, 'darwin'), { kind: 'switch', lane: '1' })
  assert.deepEqual(sidebarChordToIntent({ key: 't', metaKey: true }, state, 'darwin'), { kind: 'new', projectRoot: '/b' })
  assert.deepEqual(sidebarChordToIntent({ key: 'w', metaKey: true }, state, 'darwin'), { kind: 'close', lane: '2' })
  assert.deepEqual(sidebarChordToIntent({ key: 'w', metaKey: true }, stateWith({}), 'darwin'), { kind: 'none' })
  assert.deepEqual(sidebarChordToIntent({ key: 'O', metaKey: true, shiftKey: true }, state, 'darwin'), { kind: 'open-project' })
  assert.deepEqual(sidebarChordToIntent({ key: 't', metaKey: true }, { ...state, canCreate: false }, 'darwin'), { kind: 'none' })
  assert.deepEqual(sidebarChordToIntent({ key: 'O', metaKey: true, shiftKey: true }, { ...state, canCreate: false }, 'darwin'), { kind: 'none' })
})

// --- sidebar-focused keys ---------------------------------------------------

const NAV_STATE = stateWith({
  projects: [project('/a', 'alpha', [session('a1'), session('a2'), session('a3')])],
  lanes: [lane('1', 'a2', '/a')],
})

test('a modified key is not a sidebar-focused intent', () => {
  // The two entry points must not both claim a chord: the global one already
  // answered it before focus was consulted.
  assert.deepEqual(sidebarKeyToIntent({ key: 'ArrowDown', ctrlKey: true }, NAV_STATE), { kind: 'none' })
  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter', metaKey: true }, NAV_STATE), { kind: 'none' })
})

test('arrows move the cursor and clamp at both ends', () => {
  const at = (selectedIndex: number): SidebarView => sidebarView({ ...NAV_STATE, selectedIndex })
  assert.equal(moveSelection(at(-1), 'down'), 0, 'no cursor yet: down enters at the top')
  assert.equal(moveSelection(at(-1), 'up'), 2, 'and up enters at the bottom')
  assert.equal(moveSelection(at(1), 'down'), 2)
  assert.equal(moveSelection(at(2), 'down'), 2, 'clamps rather than wrapping')
  assert.equal(moveSelection(at(0), 'up'), 0)
  assert.equal(moveSelection(sidebarView(stateWith({})), 'down'), -1, 'nothing to select')

  assert.deepEqual(sidebarKeyToIntent({ key: 'ArrowUp' }, NAV_STATE), { kind: 'move', direction: 'up' })
  assert.deepEqual(sidebarKeyToIntent({ key: 'ArrowDown' }, NAV_STATE), { kind: 'move', direction: 'down' })
})

test('an out-of-range cursor is clamped rather than trusted', () => {
  const view = sidebarView({ ...NAV_STATE, selectedIndex: 99 })
  assert.equal(view.selectedIndex, 2)
})

test('Enter opens a closed row and switches to an open one, exactly like a click', () => {
  const onClosed = sidebarKeyToIntent({ key: 'Enter' }, { ...NAV_STATE, selectedIndex: 0 })
  assert.deepEqual(onClosed, { kind: 'open', projectRoot: '/a', sessionId: 'a1' })

  const onOpen = sidebarKeyToIntent({ key: 'Enter' }, { ...NAV_STATE, selectedIndex: 1 })
  assert.deepEqual(onOpen, { kind: 'switch', lane: '1' })

  // The click path is the same decision, so the two cannot drift apart.
  const rows = sidebarView(NAV_STATE).rows
  assert.deepEqual(activateRow(rows[0]!), onClosed)
  assert.deepEqual(activateRow(rows[1]!), onOpen)
})

test('Enter with no cursor does nothing', () => {
  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter' }, NAV_STATE), { kind: 'none' })
})

// --- deletion ---------------------------------------------------------------

test('Delete asks, Enter confirms, Escape cancels', () => {
  const asking = sidebarKeyToIntent({ key: 'Delete' }, { ...NAV_STATE, selectedIndex: 0 })
  assert.deepEqual(asking, { kind: 'request-delete', sessionId: 'a1' })

  const pending: SidebarState = { ...NAV_STATE, selectedIndex: 0, pendingDelete: 'a1' }
  assert.equal(sidebarView(pending).rows[0]!.confirmingDelete, true)
  assert.equal(sidebarView(pending).rows[1]!.confirmingDelete, false, 'only the asked row')

  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter' }, pending), {
    kind: 'confirm-delete',
    projectRoot: '/a',
    sessionId: 'a1',
  })
  assert.deepEqual(sidebarKeyToIntent({ key: 'Escape' }, pending), { kind: 'cancel-delete' })
})

test('Backspace asks too, and a second ask on a pending row is ignored', () => {
  assert.deepEqual(sidebarKeyToIntent({ key: 'Backspace' }, { ...NAV_STATE, selectedIndex: 2 }), {
    kind: 'request-delete',
    sessionId: 'a3',
  })
  assert.deepEqual(
    sidebarKeyToIntent({ key: 'Delete' }, { ...NAV_STATE, selectedIndex: 0, pendingDelete: 'a1' }),
    { kind: 'none' },
  )
})

test('Escape with nothing pending falls through to the global keymap', () => {
  // Otherwise Escape in the sidebar would stop meaning "interrupt the turn".
  assert.deepEqual(sidebarKeyToIntent({ key: 'Escape' }, NAV_STATE), { kind: 'none' })
})

test('an open session can be confirmed for deletion — the lane closes first', () => {
  // The host closes the lane before touching the store; the model just has to
  // offer the action on a row that has one.
  const pending: SidebarState = { ...NAV_STATE, selectedIndex: 1, pendingDelete: 'a2' }
  assert.equal(sidebarView(pending).rows[1]!.lane, '1')
  assert.deepEqual(sidebarKeyToIntent({ key: 'Enter' }, pending), {
    kind: 'confirm-delete',
    projectRoot: '/a',
    sessionId: 'a2',
  })
})

// --- chrome -----------------------------------------------------------------

test('canCreate gates the buttons *and* the chords, and collapsing keeps the data', () => {
  const state = stateWith({
    canCreate: false,
    collapsed: true,
    projects: [project('/a', 'alpha', [session('a1')])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
  })
  const blocked = sidebarView(state)
  assert.equal(blocked.canCreate, false)
  assert.equal(blocked.collapsed, true)
  assert.equal(blocked.rows.length, 1, 'a collapsed sidebar still knows what it holds')

  // "Key path and button must agree": a chord that fires while the button is
  // disabled makes the disabled state a lie.
  assert.deepEqual(sidebarChordToIntent({ key: 't', ctrlKey: true }, state, 'win32'), { kind: 'none' })
  assert.deepEqual(
    sidebarChordToIntent({ key: 'O', ctrlKey: true, shiftKey: true }, state, 'win32'),
    { kind: 'none' },
  )
  // Switching, closing and collapsing are not "create", so they still work.
  assert.deepEqual(sidebarChordToIntent({ key: 'b', ctrlKey: true }, state, 'win32'), { kind: 'toggle-collapse' })
  assert.deepEqual(sidebarChordToIntent({ key: 'w', ctrlKey: true }, state, 'win32'), { kind: 'close', lane: '1' })
})

test('the new-session intent is one decision, so the button and Ctrl+T agree', () => {
  // They did not: the button emitted a bare `{kind:'new'}`, and `ShellHost`
  // falls back to the *first project opened* when no root rides along — so with
  // two projects open the button created the session in the wrong one.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1')]), project('/b', 'beta', [session('b1')])],
    lanes: [lane('2', 'b1', '/b')],
    activeLane: '2',
  })
  const view = sidebarView(state)
  assert.equal(view.activeProjectRoot, '/b')
  assert.deepEqual(
    sidebarChordToIntent({ key: 't', ctrlKey: true }, state, 'win32'),
    newSessionIntent(view.activeProjectRoot),
  )
  assert.deepEqual(newSessionIntent(undefined), { kind: 'new' }, 'no active pane: let the host choose')
})

// --- the render signature ---------------------------------------------------

test('the signature moves for everything the view draws', () => {
  // The guard behind it skips the repaint when the signature matches, so a field
  // that is drawn but not signed goes stale on screen. Each case below changes
  // one drawn thing and must therefore change the signature.
  const base = stateWith({
    projects: [project('/a', 'alpha', [session('a1', { title: 'One' }), session('a2', { title: 'Two' })])],
    lanes: [lane('1', 'a1', '/a')],
    activeLane: '1',
    selectedIndex: 0,
  })
  const of = (state: SidebarState): string => sidebarRenderSignature(sidebarView(state))
  const reference = of(base)

  assert.equal(of(stateWith({ ...base })), reference, 'an identical state signs identically')

  const moved: Array<[string, SidebarState]> = [
    ['collapsed', { ...base, collapsed: true }],
    ['canCreate', { ...base, canCreate: false }],
    ['selectedIndex', { ...base, selectedIndex: 1 }],
    ['pendingDelete', { ...base, pendingDelete: 'a1' }],
    // 'o' matches both 'One' and 'Two', so the row set is unchanged — this
    // isolates the query field itself moving the signature.
    ['searchQuery', { ...base, searchQuery: 'o' }],
    ['a folded workspace', { ...base, collapsedProjects: new Set(['/a']) }],
    ['badge', { ...base, laneStatus: new Map([['1', paneStatus({ streaming: true })]]) }],
    ['title', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'Renamed' }), session('a2', { title: 'Two' })])] }],
    ['messageCount', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One', messageCount: 99 }), session('a2', { title: 'Two' })])] }],
    ['a row gained a lane', { ...base, lanes: [lane('1', 'a1', '/a'), lane('2', 'a2', '/a')] }],
    ['active row', { ...base, lanes: [lane('1', 'a2', '/a')] }],
    ['row set', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One' })])] }],
    // The order the rows sort into is what the timeline shows up as, now that
    // there are no section headings to sign.
    ['row order', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One', updatedAt: at(40 * DAY) }), session('a2', { title: 'Two' })])] }],
    ['a second project', { ...base, projects: [project('/a', 'alpha', [session('a1', { title: 'One' }), session('a2', { title: 'Two' })]), project('/b', 'beta', [session('b1')])] }],
    // Both are drawn on the heading and neither changes a row, so an unsigned
    // one is a right-click (or a confirmation) the render guard swallows whole.
    ['the heading menu', { ...base, projectMenu: '/a' }],
    ['the heading confirmation', { ...base, pendingRemoveProject: '/a' }],
    // The middle of the fold is a frame the guard would swallow otherwise: the
    // intent has not moved, only where the rail has got to.
    ['the fold mid-animation', { ...base, collapsed: true, collapsePhase: 'collapsing' }],
    // The nav row carries an on-state and the empty text changes with it, so an
    // unsigned filter is a click the render guard swallows.
    ['the recent filter', { ...base, recentOnly: true }],
  ]
  for (const [what, state] of moved) {
    assert.notEqual(of(state), reference, `expected ${what} to move the signature`)
  }
})

test('the signature ignores what the view does not draw', () => {
  // `updatedAt` is sorted on, never rendered — so a change that does not move a
  // row must not force a rebuild of every row.
  const rows = (updatedAt: string): SidebarState =>
    stateWith({ projects: [project('/a', 'alpha', [session('a1', { title: 'One', updatedAt })])] })
  assert.equal(
    sidebarRenderSignature(sidebarView(rows(at(0)))),
    sidebarRenderSignature(sidebarView(rows(at(60 * 1000)))),
    'a minute later, same order, same paint',
  )
})

// --- the fold's state machine ------------------------------------------------

test('a fold runs through its middle state and rests where the intent points', () => {
  assert.equal(nextCollapsePhase('expanded', true, 'intent'), 'collapsing')
  assert.equal(nextCollapsePhase('collapsing', true, 'settled'), 'collapsed')
  assert.equal(nextCollapsePhase('collapsed', false, 'intent'), 'expanding')
  assert.equal(nextCollapsePhase('expanding', false, 'settled'), 'expanded')
})

test('an intent that agrees with a resting fold moves nothing', () => {
  // The rail is asked to collapse from several places (`Ctrl+B`, and the two
  // spots that expand it before revealing a heading). Asking for the width it
  // already has must not restart an animation.
  assert.equal(nextCollapsePhase('collapsed', true, 'intent'), 'collapsed')
  assert.equal(nextCollapsePhase('expanded', false, 'intent'), 'expanded')
})

test('a reversal mid-animation turns around rather than queueing', () => {
  assert.equal(nextCollapsePhase('collapsing', false, 'intent'), 'expanding')
  assert.equal(nextCollapsePhase('expanding', true, 'intent'), 'collapsing')
})

test('a late settle from a superseded move is dropped', () => {
  // The DOM layer clears its listener and its fallback timer on every
  // transition, but a `transitionend` already queued cannot be recalled. If it
  // landed, the rail would rest at the width the user just cancelled.
  assert.equal(nextCollapsePhase('expanding', true, 'settled'), 'expanding')
  assert.equal(nextCollapsePhase('collapsing', false, 'settled'), 'collapsing')
  // And a settle with nothing to settle leaves the resting phase alone.
  assert.equal(nextCollapsePhase('expanded', false, 'settled'), 'expanded')
  assert.equal(nextCollapsePhase('collapsed', true, 'settled'), 'collapsed')
})

test('the transition is total, and every phase it names is reachable', () => {
  const phases: readonly SidebarCollapsePhase[] = [
    'expanded',
    'collapsing',
    'collapsed',
    'expanding',
  ]
  const reached = new Set<SidebarCollapsePhase>()
  for (const phase of phases) {
    for (const want of [true, false]) {
      for (const event of ['intent', 'settled'] as const) {
        const next = nextCollapsePhase(phase, want, event)
        assert.ok(phases.includes(next), `${phase}/${want}/${event} left the enum`)
        reached.add(next)
      }
    }
  }
  assert.equal(reached.size, phases.length, 'a phase nothing can reach is a phase to delete')
})

test('the rail keeps its content until the collapse has finished', () => {
  // The reason the enum exists: unmounting on the click fades an empty column.
  assert.equal(sidebarContentMounted('collapsing'), true)
  assert.equal(sidebarContentMounted('expanding'), true)
  assert.equal(sidebarContentMounted('expanded'), true)
  assert.equal(sidebarContentMounted('collapsed'), false)
})

// --- optimistic deletes -------------------------------------------------------

test('a session being deleted leaves the list on the click, not on the reply', () => {
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('s-1'), session('s-2')])],
    deletingSessions: new Set(['s-1']),
  })
  const view = sidebarView(state)

  assert.deepEqual(view.rows.map((row) => row.sessionId), ['s-2'])
  // And the guard sees the difference, or the repaint is swallowed and the row
  // stays on screen anyway.
  assert.notEqual(
    sidebarRenderSignature(view),
    sidebarRenderSignature(sidebarView(stateWith({ ...state, deletingSessions: new Set() }))),
  )
})

test('a session being deleted cannot come back as a live lane row', () => {
  // The lane is still open — the host detaches it as part of the delete — so
  // without the second check the row would reappear the moment history dropped it.
  const view = sidebarView(
    stateWith({
      lanes: [lane('1', 's-1', '/a')],
      laneStatus: new Map([['1', paneStatus()]]),
      deletingSessions: new Set(['s-1']),
    }),
  )
  assert.deepEqual(view.rows, [])
})

test('a history row being opened says so until it has a lane', () => {
  // Opening loads a transcript and builds a runtime. A row that showed nothing
  // meanwhile read as a missed click, and the second click was the usual answer.
  const state = stateWith({
    projects: [project('/a', 'alpha', [session('s-1'), session('s-2')])],
    openingSessions: new Set(['s-1']),
  })
  const view = sidebarView(state)
  assert.deepEqual(view.rows.map((row) => [row.sessionId, row.opening]), [['s-1', true], ['s-2', false]])
  assert.notEqual(
    sidebarRenderSignature(view),
    sidebarRenderSignature(sidebarView(stateWith({ ...state, openingSessions: new Set() }))),
    'the guard sees the pending state come and go',
  )

  // Once the lane is there the row is open, whatever the settle has not yet cleared.
  const opened = sidebarView(stateWith({
    lanes: [lane('1', 's-1', '/a')],
    laneStatus: new Map([['1', paneStatus()]]),
    openingSessions: new Set(['s-1']),
  }))
  assert.equal(opened.rows.find((row) => row.sessionId === 's-1')?.opening, false)
})

test('a project being removed takes its whole group with it', () => {
  const view = sidebarView(
    stateWith({
      projects: [project('/a', 'alpha', [session('s-1')]), project('/b', 'beta', [session('s-2')])],
      removingProjects: new Set(['/a']),
    }),
  )
  assert.deepEqual(view.groups.map((group) => group.projectRoot), ['/b'])
})

// --- pinned coordination section -----------------------------------------------------------

function threadInfo(id: string, status: WireThreadStatus, title = id) {
  return { threadId: `th-${id}`, sessionId: id, title, status, lastActivityAt: at(0) }
}

function coordState(overrides: Partial<SidebarState> = {}, threads: WireCoordinationThreads['threads'] = []) {
  return stateWith({
    projects: [project('/a', 'alpha', [session('coord'), session('t1'), session('t2'), session('plain')])],
    coordination: new Map([['/a', { projectRoot: '/a', coordinatorSessionId: 'coord', threads }]]),
    ...overrides,
  })
}

const sampleThreads = [
  threadInfo('t1', 'running', 'build'),
  threadInfo('t2', 'needs-you', 'review'),
  threadInfo('t3', 'quiet'),
  threadInfo('t4', 'resolved'),
]

test('the pinned coordinator leads the rows; threads stay out of the sidebar', () => {
  const view = sidebarView(coordState({}, sampleThreads))
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['coord', 'plain'])
  assert.deepEqual(view.groups[0]!.rows.map((row) => row.sessionId), ['plain'])
  const group = view.pinned[0]!
  assert.equal(group.projectName, 'alpha')
  assert.equal(group.running, 1)
  assert.equal(group.blocked, 1)
  assert.equal(group.coordinator?.roleMarker, '调度')
})

test('a thread session is never an ordinary row, even once it left the thread table', () => {
  const view = sidebarView(stateWith({
    projects: [project('/a', 'alpha', [session('orphan', { coordinationRole: 'thread' }), session('plain')])],
    lanes: [lane('l1', 'live', '/a', { coordinationRole: 'thread' })],
    laneStatus: new Map([['l1', paneStatus()]]),
  }))
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['plain'])
})

test('the coordinator row is active while one of its threads is on screen', () => {
  const view = sidebarView(coordState({ lanes: [lane('l1', 't1', '/a')], activeLane: 'l1' }, sampleThreads))
  assert.equal(view.pinned[0]!.coordinator?.active, true)
})

test('search keeps a pinned entry only when its coordinator matches', () => {
  const miss = sidebarView(coordState({ searchQuery: 'review' }, sampleThreads))
  assert.equal(miss.pinned.length, 0)
  assert.equal(miss.noMatches, true)
  const hit = sidebarView(coordState({ searchQuery: '项目' }, sampleThreads))
  assert.equal(hit.pinned[0]!.coordinator?.sessionId, 'coord')
})

test('recentOnly hides the section', () => {
  const view = sidebarView(coordState({ recentOnly: true }, sampleThreads))
  assert.equal(view.pinned.length, 0)
  assert.ok(!view.rows.some((row) => row.sessionId === 't1'))
})

test('a project with threads but no coordinator is still pinned; the signature covers its counts', () => {
  const state = coordState({
    coordination: new Map([['/a', { projectRoot: '/a', threads: sampleThreads }]]),
  })
  const view = sidebarView(state)
  assert.equal(view.pinned[0]!.coordinator, undefined)
  const changed = sidebarView(coordState({}, [threadInfo('t1', 'idle', 'build')]))
  assert.notEqual(sidebarRenderSignature(view), sidebarRenderSignature(changed))
})

test('pinned entries follow workspace order, skip unstarted projects, and drop one being removed', () => {
  const table = (root: string, started: boolean): [string, WireCoordinationThreads] => [
    root,
    { projectRoot: root, ...(started ? { started: true as const } : {}), threads: [] },
  ]
  const state = stateWith({
    projects: [project('/a', 'alpha', []), project('/b', 'beta', []), project('/c', 'gamma', []), project('/d', 'delta', [])],
    coordination: new Map([table('/d', true), table('/c', true), table('/b', false), table('/a', true)]),
    removingProjects: new Set(['/a']),
  })
  assert.deepEqual(sidebarView(state).pinned.map((entry) => entry.projectRoot), ['/c', '/d'])
})

test('a started project whose coordinator was deleted stays pinned with no coordinator row', () => {
  const view = sidebarView(stateWith({
    projects: [project('/a', 'alpha', [session('plain')])],
    coordination: new Map([['/a', { projectRoot: '/a', started: true, threads: [] }]]),
  }))
  assert.equal(view.pinned.length, 1)
  assert.equal(view.pinned[0]!.coordinator, undefined)
  assert.deepEqual(view.rows.map((row) => row.sessionId), ['plain'])
})

test('a late thread table for a root that is no longer a project is not pinned', () => {
  const view = sidebarView(stateWith({
    projects: [project('/a', 'alpha', [])],
    coordination: new Map([
      ['/a', { projectRoot: '/a', started: true, threads: [] }],
      ['/gone', { projectRoot: '/gone', started: true, threads: [] }],
    ]),
  }))
  assert.deepEqual(view.pinned.map((entry) => entry.projectRoot), ['/a'])
})

test('a project known only from a lane is still pinned', () => {
  const view = sidebarView(stateWith({
    lanes: [lane('l1', 'x', '/lane-only')],
    coordination: new Map([['/lane-only', { projectRoot: '/lane-only', started: true, threads: [] }]]),
  }))
  assert.deepEqual(view.pinned.map((entry) => entry.projectRoot), ['/lane-only'])
})

/**
 * A background session that finished used to look exactly like one that never
 * ran; the user had to open each to find the answer. Its row now carries the
 * thread panel's blue dot until it is opened.
 */
test('a turn that ends out of sight leaves the row unread until it is opened', () => {
  const was = new Map([['1', true], ['2', true], ['3', false]])
  const now = new Map([['1', false], ['2', false], ['3', false]])
  const unread = nextUnreadLanes(new Set(), was, now, '2')
  assert.deepEqual([...unread], ['1'], 'the active lane was watched, and an idle one has nothing new')
  assert.deepEqual([...nextUnreadLanes(unread, now, now, undefined)], ['1'], 'it stays until read')
  assert.deepEqual([...nextUnreadLanes(unread, now, now, '1')], [], 'opening it reads it')
  assert.deepEqual([...nextUnreadLanes(unread, now, new Map(), undefined)], [], 'a closed lane drops out')

  const state = stateWith({
    projects: [project('/a', 'alpha', [session('a1'), session('a2', { failed: true })])],
    lanes: [lane('1', 'a1', '/a'), lane('2', 'a2', '/a')],
    laneStatus: new Map([['1', paneStatus({ unread: true })], ['2', paneStatus({ unread: true })]]),
  })
  const badges = new Map(sidebarView(state).rows.map((row) => [row.sessionId, row.badge]))
  assert.equal(badges.get('a1'), 'unread')
  assert.equal(badges.get('a2'), 'failed', 'a failure is the thing to read')
})
