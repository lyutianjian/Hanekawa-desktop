import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createSidebarView } from '../src/desktop/renderer/dom/sidebarView.js'
import { button } from '../src/desktop/renderer/dom/controls.js'
import {
  SIDEBAR_COLLAPSE_FALLBACK_MS,
  sidebarHint,
  sidebarView,
  createSidebarState,
  type SidebarIntent,
  type SidebarState,
  type SidebarView,
} from '../src/desktop/renderer/model/sidebar.js'
import type { DesktopPlatform } from '../src/desktop/types.js'
import type { WireLaneInfo } from '../src/desktop/shellProtocol.js'

/**
 * The sidebar's four regions, as DOM.
 *
 * `test/rendererSidebar.test.ts` covers the model — which rows exist, what a key
 * means. What only shows up here is the shape: the workspace header is gone and
 * every workspace has a folding heading *in the list*, the first-level actions
 * are rows under the search box, and the chord list lives behind the footer's `?`
 * instead of being printed under it.
 *
 * Not in the base TypeScript program; see `tsconfig.domtest.json`.
 */

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: SidebarIntent[]
  /** The keys the container handed to the model's key map. */
  readonly keys: string[]
  render(view: SidebarView): void
  focusProject(projectRoot: string): void
  finishMotion(): void
  root(): StubView
}

function viewOf(overrides: Partial<SidebarState> = {}): SidebarView {
  return sidebarView(createSidebarState(overrides))
}

function mount(t: { after(fn: () => void): void }, platform: DesktopPlatform = 'win32'): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('sidebar')
  const intents: SidebarIntent[] = []
  const keys: string[] = []
  const dom = createSidebarView(container, (intent) => intents.push(intent), (chord) => { keys.push(chord.key); return false }, platform)
  return {
    stub,
    container,
    intents,
    keys,
    render: (view) => dom.render(view),
    focusProject: (projectRoot) => dom.focusProject(projectRoot),
    finishMotion: () => dom.finishMotion(),
    root: () => stub.inspect(container),
  }
}

/** The one child of `#sidebar`: the column the four regions live in. */
const shell = (root: StubView): StubView => {
  const found = root.children.find((node) => node.classes.includes('sidebar-shell'))
  assert.ok(found, `no .sidebar-shell in ${root.children.map((c) => c.className).join(' | ')}`)
  return found
}

const region = (root: StubView, className: string): StubView => {
  const within = shell(root)
  const found = within.children.find((node) => node.classes.includes(className))
  assert.ok(found, `no .${className} in ${within.children.map((c) => c.className).join(' | ')}`)
  return found
}

/** Every node in the rendered subtree, root included. */
const descendants = (node: StubView): StubView[] =>
  [node, ...node.children.flatMap(descendants)]

const find = (root: StubView, className: string): StubView | undefined =>
  descendants(root).find((node) => node.classes.includes(className))

const sessionRows = (root: StubView): StubView[] =>
  descendants(root).filter((node) => node.classes.includes('session-row'))

/** One project with three sessions: the visible one, a background lane, history. */
function tieredState(): Partial<SidebarState> {
  const root = '/w/app'
  const laneOf = (key: string, paneId: string): WireLaneInfo => ({
    lane: key,
    paneId,
    sessionId: paneId,
    projectRoot: root,
    projectName: 'app',
  })
  return {
    projects: [
      {
        projectRoot: root,
        projectName: 'app',
        sessions: [
          { id: 'shown', title: '正在显示', updatedAt: new Date(Date.UTC(2026, 7, 20, 11)).toISOString(), messageCount: 4 },
          { id: 'background', title: '后台 lane', updatedAt: new Date(Date.UTC(2026, 7, 20, 10)).toISOString(), messageCount: 2 },
          { id: 'history', title: '只是历史', updatedAt: new Date(Date.UTC(2026, 7, 20, 9)).toISOString(), messageCount: 7 },
        ],
      },
    ],
    lanes: [laneOf('l1', 'shown'), laneOf('l2', 'background')],
    activeLane: 'l1',
  }
}

test('the sidebar opens on the search box: there is no workspace header', (t) => {
  // The dropdown that used to live here made a workspace something you navigated
  // *to* before you could see its sessions. Every workspace is a heading in the
  // list now, so the control that chose between them has nothing left to do.
  const { render, root } = mount(t)
  render(viewOf())

  assert.equal(shell(root()).children[0]?.className, 'sidebar-search')
  assert.equal(find(root(), 'sidebar-header'), undefined, 'the workspace header came back')
  assert.equal(find(root(), 'sidebar-workspace'), undefined, 'the workspace dropdown came back')
  assert.equal(find(root(), 'sidebar-collapse'), undefined, 'the sidebar grew a second collapse control')
})

test('a settled collapse takes the whole column off screen', (t) => {
  // The rail survived only so this view's own toggle stayed clickable. With that
  // toggle in the title bar, a collapsed sidebar is zero width — and a region
  // still drawn would be what keeps the column from reaching it. One `show()` on
  // the shell rather than four, now that the regions share a parent.
  const { render, root } = mount(t)
  render(viewOf({ collapsed: true, collapsePhase: 'collapsed' }))

  assert.equal(shell(root()).hidden, true, 'the shell is still on screen while collapsed')
  assert.ok(root().classes.includes('collapsed'), '#sidebar must carry the class the width animates on')
})

test('the column stays mounted while the fold is still moving', (t) => {
  // The reason the phase is not a boolean: unmounting on the click would leave
  // the collapse animating an empty column, and expanding would open onto a
  // blank pane for one frame before the rows arrived.
  const { render, root } = mount(t)
  render(viewOf({ ...tieredState(), collapsed: true, collapsePhase: 'collapsing' }))

  assert.equal(shell(root()).hidden, false, 'the shell went out before the width did')
  assert.ok(sessionRows(root()).length > 0, 'the rows have to be there to slide out')
  assert.ok(
    root().classes.includes('collapsed'),
    'the class goes on at the start of the move, not at the end of it',
  )

  // And the other direction: the rows are built before the column has width.
  render(viewOf({ ...tieredState(), collapsed: false, collapsePhase: 'expanding' }))
  assert.equal(shell(root()).hidden, false)
  assert.ok(sessionRows(root()).length > 0, 'expanding must build the rows the width is about to reveal')
  assert.equal(root().classes.includes('collapsed'), false)
})

test('the fold reports it settled, from the transition or from the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, root, container, stub, intents } = mount(t)

  render(viewOf({ collapsed: true, collapsePhase: 'collapsing' }))
  // `transitionend` bubbles from every hover colour and from the shell's own
  // fade; only the sidebar's own width may settle the fold.
  stub.dispatch(container, 'transitionend', { propertyName: 'opacity' })
  assert.deepEqual(intents, [], 'a bubbled transition settled the fold')
  stub.dispatch(container, 'transitionend', { propertyName: 'flex-basis' })
  assert.deepEqual(intents, [{ kind: 'collapse-settled' }])

  // And the transition that never runs — a hidden window, or reduced motion
  // cutting it to nothing — is what the fallback timer is for.
  intents.length = 0
  render(viewOf({ collapsed: false, collapsePhase: 'expanding' }))
  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS + 1)
  assert.deepEqual(intents, [{ kind: 'collapse-settled' }])
})

test('reduced sidebar folds settle promptly and hiding cancels remaining timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = mount(t)
  ;(view.stub.documentElement() as HTMLElement).dataset.reducedMotion = 'true'
  view.render(viewOf({ ...tieredState(), collapsed: true, collapsePhase: 'collapsing' }))
  t.mock.timers.tick(1)
  assert.deepEqual(view.intents, [{ kind: 'collapse-settled' }])
  view.intents.length = 0
  ;(view.stub.documentElement() as HTMLElement).dataset.reducedMotion = 'false'
  view.render(viewOf({ ...tieredState(), collapsePhase: 'expanding' }))
  view.finishMotion()
  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS)
  assert.deepEqual(view.intents, [{ kind: 'collapse-settled' }])
})

test('a superseded fold leaves no timer behind', (t) => {
  // The failure this guards: a collapse cancelled mid-flight, whose timer still
  // fires and settles the expansion that replaced it — a rail that unmounts its
  // rows a third of a second after being opened.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, container, stub, intents } = mount(t)

  render(viewOf({ collapsed: true, collapsePhase: 'collapsing' }))
  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS - 100)
  render(viewOf({ collapsed: false, collapsePhase: 'expanding' }))
  t.mock.timers.tick(101)
  assert.deepEqual(intents, [], 'the interrupted move fired its own timer')

  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS)
  assert.deepEqual(intents, [{ kind: 'collapse-settled' }], 'exactly one timer may be live')

  // A rested fold arms nothing at all, so a repaint at rest cannot queue work.
  intents.length = 0
  render(viewOf({ collapsed: false, collapsePhase: 'expanded' }))
  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS * 4)
  assert.deepEqual(intents, [])
  // The listener is installed once and consults the phase, so no toggle can add
  // a second one — this is what makes the add/remove pair unnecessary.
  stub.dispatch(container, 'transitionend', { propertyName: 'flex-basis' })
  assert.equal(intents.length, 1, 'the transition listener was installed more than once')
})

test('every workspace gets a folding heading, single project included', (t) => {
  // Drawn even for one project: the workspace is the list's only grouping axis,
  // so hiding the heading when there is one of them hides *what the axis is*.
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const heading = find(root(), 'project-heading')
  assert.ok(heading, 'no workspace heading in the list')
  assert.equal(find(heading, 'btn-label')?.text, 'app')
  assert.equal(heading.attributes.get('aria-expanded'), 'true')
  // Where the session count used to be. A number told the user what the rows
  // below already say; this is the action they came to the heading for.
  assert.ok(find(root(), 'project-new'), 'the heading row must offer a new session')

  stub.click(heading.node)
  assert.deepEqual(intents, [{ kind: 'toggle-project', projectRoot: '/w/app' }])
})

test('a folded workspace draws its heading and none of its rows', (t) => {
  const { render, root } = mount(t)
  render(viewOf({ ...tieredState(), collapsedProjects: new Set(['/w/app']) }))

  const group = find(root(), 'project-group')
  assert.ok(group?.classes.includes('collapsed'))
  assert.deepEqual(sessionRows(root()), [], 'a folded workspace still drew its sessions')
  // The `+` survives the fold: "new session here" is about the project, not
  // about whichever of its sessions happen to be on screen.
  assert.ok(find(root(), 'project-new'))
  assert.equal(find(root(), 'project-heading')?.attributes.get('aria-expanded'), 'false')
})

test('the group node survives the repaint that folds it', (t) => {
  // The whole reason `sidebarView` keeps a node map: `render()` rebuilds the
  // list wholesale, and a wrapper that is new every pass cannot transition —
  // a freshly inserted element starts at its final style. The fold is
  // `grid-template-rows: 1fr → 0fr`, so this identity *is* the animation.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))
  const first = find(root(), 'project-group')?.node
  const body = find(root(), 'project-body')?.node
  assert.ok(first && body, 'the group draws a wrapper and an animated body')

  render(viewOf({ ...tieredState(), collapsedProjects: new Set(['/w/app']) }))
  assert.equal(find(root(), 'project-group')?.node, first, 'the wrapper was rebuilt, so nothing animates')
  assert.equal(find(root(), 'project-body')?.node, body, 'detaching the body cancels its transition')
  assert.ok(find(root(), 'project-group')?.classes.includes('collapsed'))
})

test('a folding group keeps its rows until the fold arrives', (t) => {
  // Same discipline as the rail's four phases: rows taken out on the click would
  // leave the fold animating an empty box. They go when the transition reports
  // it finished — and then they are *gone*, not merely hidden, so no button
  // behind a shut heading can be reached with Tab.
  const { render, root, stub } = mount(t)
  render(viewOf(tieredState()))
  assert.equal(sessionRows(root()).length, 3)

  render(viewOf({ ...tieredState(), collapsedProjects: new Set(['/w/app']) }))
  assert.equal(sessionRows(root()).length, 3, 'the rows have to be there to fold')

  const body = find(root(), 'project-body')
  assert.ok(body)
  // The rows inside transition too, and every one of those bubbles to the body.
  stub.dispatch(body.node, 'transitionend', { propertyName: 'background-color' })
  assert.equal(sessionRows(root()).length, 3, 'a bubbled transition settled the fold')
  stub.dispatch(body.node, 'transitionend', { propertyName: 'grid-template-rows' })
  assert.deepEqual(sessionRows(root()), [], 'the settled fold left its rows in the DOM')

  // And back: the rows are rebuilt before the track has height to show them in.
  render(viewOf(tieredState()))
  assert.equal(sessionRows(root()).length, 3)
})

test('a group fold that never animates still settles, and cannot leak a timer', (t) => {
  // `transitionend` is not a guarantee — a hidden window runs none, reduced
  // motion cuts them to 1ms — so the group arms the rail's fallback beside it.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, root } = mount(t)
  const open = () => viewOf(tieredState())
  const shut = () => viewOf({ ...tieredState(), collapsedProjects: new Set(['/w/app']) })

  render(open())
  render(shut())
  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS + 1)
  assert.deepEqual(sessionRows(root()), [], 'the fold never arrived and the rows stayed')

  // A fold reversed mid-flight: the timer that belonged to the interrupted move
  // must not fire on the group that replaced it and empty a group the user just
  // opened.
  render(shut())
  render(open())
  t.mock.timers.tick(SIDEBAR_COLLAPSE_FALLBACK_MS * 4)
  assert.equal(sessionRows(root()).length, 3, 'a superseded fold unmounted an open group')
})

test('a folding group paints no row as the cursor', (t) => {
  // A collapsing group's rows are already out of `view.rows`, so their index is
  // -1 — which is also the "no cursor" index, and reading them as equal would
  // paint every folding row selected.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))
  render(viewOf({ ...tieredState(), collapsedProjects: new Set(['/w/app']) }))

  assert.deepEqual(
    sessionRows(root()).filter((row) => row.classes.includes('selected')),
    [],
    'the folding rows took the cursor with them',
  )
})

test('the cursor row is named on the list and brought into view when it moves', (t) => {
  // Focus stays on the list while the arrows move a cursor, so the list has to
  // say which row that is, and a cursor moved past the rail's edge used to
  // leave the visible part of the list. Only a *move* scrolls: a repaint from a
  // streamed token must not yank a list the user is scrolling by hand.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))
  const proto = Object.getPrototypeOf(sessionRows(root())[0]!.node) as { scrollIntoView(options?: unknown): void }
  const scrolled: string[] = []
  t.mock.method(proto, 'scrollIntoView', function (this: HTMLElement) { scrolled.push(this.id) })
  const list = (): StubView => region(root(), 'sidebar-list')

  render(viewOf({ ...tieredState(), selectedIndex: 2 }))
  assert.equal(list().attributes.get('aria-activedescendant'), 'session-row-history')
  assert.deepEqual(scrolled, ['session-row-history'])

  // The same cursor, a different badge: no scroll.
  render(viewOf({ ...tieredState(), selectedIndex: 2, pendingDelete: 'shown' }))
  assert.deepEqual(scrolled, ['session-row-history'])

  render(viewOf({ ...tieredState(), selectedIndex: -1 }))
  assert.equal(list().attributes.has('aria-activedescendant'), false)
})

test('an empty list says why: still reading, a read that failed, or nothing at all', (t) => {
  // Before the first read landed the rail said 「还没有会话」, and after a failed
  // first read it said the same — both read as every session having been
  // deleted. A list that has been drawn keeps its rows on a later failure.
  const { stub, render, root, intents } = mount(t)
  const list = (): StubView => region(root(), 'sidebar-list')

  render(viewOf({ listLoad: 'loading' }))
  assert.deepEqual(list().children.map((child) => child.className), ['session-skeleton', 'session-skeleton', 'session-skeleton'])
  assert.equal(list().children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(list().attributes.get('aria-busy'), 'true')

  render(viewOf({ listLoad: 'failed' }))
  const failed = list().children[0]!
  assert.deepEqual(failed.classes, ['sidebar-empty', 'sidebar-load-failed'])
  assert.equal(failed.attributes.get('role'), 'alert')
  assert.equal(list().attributes.has('aria-busy'), false)
  const retry = find(failed, 'sidebar-load-retry')!
  assert.equal(retry.text, '重试')
  stub.click(retry.node)
  assert.deepEqual(intents.at(-1), { kind: 'retry-load' })

  render(viewOf({ listLoad: 'ready' }))
  assert.equal(list().children[0]!.text, '还没有会话。')

  render(viewOf({ ...tieredState(), listLoad: 'failed' }))
  assert.equal(sessionRows(root()).length, 3, 'drawn rows outlive a later failure')
})

test('the heading + creates a session in *its own* project', (t) => {
  // The reason `newSessionIntent` is reached through the model rather than
  // spelled here: `Ctrl+T` resolves the active project and this resolves the one
  // under the cursor, and the two must not disagree about what "new" targets.
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const plus = find(root(), 'project-new')
  assert.ok(plus, 'no + on the heading row')
  stub.click(plus.node)
  assert.deepEqual(intents, [{ kind: 'new', projectRoot: '/w/app' }])
})

test('the + is disabled while a blocking dialog is up', (t) => {
  // Same gate the nav buttons are behind: a control that opens something must
  // not look available while a pane is parked on a permission prompt.
  const { render, root } = mount(t)
  render(viewOf({ ...tieredState(), canCreate: false }))

  assert.equal(find(root(), 'project-new')?.disabled, true)
})

test('right-clicking a heading opens its menu, and the menu item asks first', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const row = find(root(), 'project-row')
  assert.ok(row, 'no heading row to right-click')
  const event = stub.dispatch(row.node, 'contextmenu')
  assert.equal(event.defaultPrevented, true, 'the OS menu must not also open')
  assert.deepEqual(intents, [{ kind: 'open-project-menu', projectRoot: '/w/app' }])

  // The menu is state, and the node it is drawn in outlives that state: it is
  // kept across repaints so its entrance animation runs once, when it opens,
  // rather than on every one of the repaints a streaming turn causes.
  assert.equal(find(root(), 'project-menu')?.hidden, true, 'a shut menu is hidden, not drawn')
  assert.equal(find(root(), 'project-menu-item'), undefined, 'a shut menu holds nothing tabbable')
  intents.length = 0
  render(viewOf({ ...tieredState(), projectMenu: '/w/app' }))
  const opened = find(root(), 'project-menu')
  assert.equal(opened?.hidden, false, 'the menu the model opened is not showing')
  const items = descendants(root()).filter((node) => node.classes.includes('project-menu-item'))
  assert.deepEqual(items.map((node) => node.text), ['移除项目并删除历史'])
  const item = items[0]!

  // A repaint that has nothing to do with the menu — the rail gets one per
  // streamed token — must leave the menu's node and its item alone. Re-inserting
  // either is what replayed `drop-in` on every flush and took the focus off an
  // item the user was aiming at.
  render(viewOf({ ...tieredState(), projectMenu: '/w/app', pendingDelete: 'history' }))
  assert.equal(find(root(), 'project-menu')?.node, opened?.node, 'the menu was rebuilt')
  assert.equal(descendants(root()).filter((node) => node.classes.includes('project-menu-item'))[0]?.node, item.node, 'the menu item was rebuilt')

  stub.click(item.node)
  assert.deepEqual(intents, [{ kind: 'request-remove-project', projectRoot: '/w/app' }])
})

test('a coordination session row carries its role marker', (t) => {
  const { render, root } = mount(t)
  const base = tieredState()
  render(viewOf({
    ...base,
    projects: [{
      projectRoot: '/w/app',
      projectName: 'app',
      sessions: [
        { id: 'c1', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1, coordinationRole: 'coordinator' },
        { id: 'o1', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 },
      ],
    }],
  }))
  const markers = descendants(root()).filter((node) => node.classes.includes('session-role'))
  assert.deepEqual(markers.map((node) => node.text), ['调度'])
})

test('the confirming heading replaces its + with an answer', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf({ ...tieredState(), pendingRemoveProject: '/w/app' }))

  assert.equal(find(root(), 'project-new'), undefined, 'the + must not survive the question')
  const yes = find(root(), 'session-confirm-yes')
  const no = find(root(), 'session-confirm-no')
  assert.ok(yes && no)
  stub.click(yes.node)
  stub.click(no.node)
  assert.deepEqual(intents, [
    { kind: 'confirm-remove-project', projectRoot: '/w/app' },
    { kind: 'cancel-remove-project' },
  ])
})

test('the global workspace has no remove menu', (t) => {
  // There is no registry entry to forget, and `isGlobal` comes off the wire —
  // the renderer must not recognize it by matching the display name.
  const { render, root, stub, intents } = mount(t)
  render(
    viewOf({
      projects: [{ projectRoot: '/home/me', projectName: '最近', isGlobal: true, sessions: [] }],
    }),
  )

  const row = find(root(), 'project-row')
  assert.ok(row)
  stub.dispatch(row.node, 'contextmenu')
  assert.deepEqual(intents, [])
})

test('a project with no sessions still draws its heading', (t) => {
  // Deleting the last session used to delete the only way back to the project.
  const { render, root } = mount(t)
  render(viewOf({ projects: [{ projectRoot: '/w/app', projectName: 'app', sessions: [] }] }))

  assert.equal(find(root(), 'project-heading')?.text?.includes('app'), true)
  assert.deepEqual(sessionRows(root()), [])
  assert.ok(find(root(), 'project-empty'), 'an empty group must say it is empty, not look unloaded')
  assert.equal(find(root(), 'sidebar-empty'), undefined, 'this is not the empty state')
})

test('focusProject scrolls to the heading but leaves the keyboard on the list', (t) => {
  // The reveal path for the welcome screen's Hero project name. The heading is
  // what gets scrolled to — it is rebuilt every pass, so this has to read the
  // current one — but it is *not* what gets the focus: a `<button>` keeps its
  // ring until something else takes it, and a ring sitting on a project whose
  // session does not exist yet reads as a selection this rail does not have.
  // The list owns the arrow keys, so the keyboard still lands somewhere useful.
  const { render, root, stub, focusProject } = mount(t)
  render(viewOf(tieredState()))
  // A second paint that rebuilds the list, so a heading cached from the first one
  // would now be detached.
  render(viewOf({ ...tieredState(), pendingDelete: 'history' }))

  focusProject('/w/app')
  assert.equal(stub.activeElement(), find(root(), 'sidebar-list')?.node)
  assert.notEqual(stub.activeElement(), find(root(), 'project-heading')?.node)

  stub.focus(find(root(), 'sidebar-search')?.node)
  focusProject('/w/nothing-here')
  assert.equal(
    stub.activeElement(),
    find(root(), 'sidebar-search')?.node,
    'an unknown project must not move focus',
  )
})

test('a press outside the rail withdraws what is asking, and only that press is eaten', (t) => {
  // The hole `focusout` alone leaves: a click on the transcript's background
  // moves no focus at all, so a delete confirmation drawn in the sidebar used to
  // sit there with nothing able to answer it. The press that withdraws it is the
  // whole gesture: the click behind it must not also activate what was under the
  // pointer.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, stub, intents } = mount(t)
  render(viewOf({ ...tieredState(), pendingDelete: 'history' }))

  const elsewhere = stub.createContainer('canvas')
  const press = stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(intents.map((intent) => intent.kind), ['cancel-delete'])
  assert.equal(press.propagationStopped, true, 'the pointerdown stops at the document')
  assert.equal(stub.dispatchDocument('click', { target: elsewhere }).defaultPrevented, true)
  stub.dispatchDocument('pointerup', { target: elsewhere })
  t.mock.timers.tick(1)
})

test('nothing asking means a press is nobody’s business', (t) => {
  // Every press in the window reaches the rail's registrations; with no question
  // on screen none of them may withdraw anything or eat the click.
  const { render, stub, intents } = mount(t)
  render(viewOf(tieredState()))

  const elsewhere = stub.createContainer('canvas')
  const press = stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(intents, [])
  assert.equal(press.propagationStopped, false)
  assert.equal(stub.dispatchDocument('click', { target: elsewhere }).defaultPrevented, false)
})

test('each question is scoped to itself, not to the rail', (t) => {
  // The rail is not one popover. A confirmation lives in one row's actions slot,
  // and pressing *another* row — or a heading, or the blank space under the list
  // — is the user saying "not that": scoping the withdrawal to the whole sidebar
  // left the question standing for every press inside it, which is most of the
  // blank space anyone reaches for.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, root, stub, intents } = mount(t)
  render(viewOf({ ...tieredState(), pendingDelete: 'history' }))

  stub.dispatchDocument('pointerdown', { target: find(root(), 'project-heading')?.node })
  assert.deepEqual(
    intents.map((intent) => intent.kind),
    ['cancel-delete'],
    'a press on a heading withdraws the confirmation asked in a row',
  )

  // The confirmation's own two buttons are the one place that is *inside*: the
  // press that lands on 删除 must reach it, not be answered as a withdrawal.
  intents.length = 0
  stub.dispatchDocument('pointerup')
  t.mock.timers.tick(1)
  const yes = stub.dispatchDocument('pointerdown', { target: find(root(), 'session-confirm-yes')?.node })
  assert.deepEqual(intents, [], 'a press on the confirmation is not a press outside it')
  assert.equal(yes.propagationStopped, false)
})

test('a press on a heading closes the menu hanging off it and is eaten', (t) => {
  // The reported shape: right-click project A's heading, then left-press project
  // B's. The menu is withdrawn by the press, and the click behind it must not
  // also fold B's group — the repaint that click caused drew the menu again over
  // a rail that had moved. The menu itself is the only thing that stays inside.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, root, stub, intents } = mount(t)
  render(
    viewOf({
      projects: [
        { projectRoot: '/w/app', projectName: 'app', sessions: [] },
        { projectRoot: '/w/lib', projectName: 'lib', sessions: [] },
      ],
      projectMenu: '/w/app',
    }),
  )

  const rows = descendants(root()).filter((node) => node.classes.includes('project-row'))
  assert.equal(rows.length, 2, 'expected a heading per workspace')
  const [mine, other] = rows

  stub.dispatchDocument('pointerdown', { target: other?.node })
  assert.deepEqual(
    intents.filter((intent) => intent.kind === 'open-project-menu'),
    [{ kind: 'open-project-menu', projectRoot: undefined }],
    'pressing another workspace’s heading leaves the menu standing',
  )
  assert.equal(stub.dispatchDocument('click', { target: other?.node }).defaultPrevented, true)
  stub.dispatchDocument('pointerup')
  t.mock.timers.tick(1)

  // Its own heading closes it as well: the swallowed `contextmenu` behind a
  // right press is what keeps the menu from opening straight back.
  intents.length = 0
  stub.dispatchDocument('pointerdown', { target: mine?.node, button: 2 })
  assert.deepEqual(
    intents.filter((intent) => intent.kind === 'open-project-menu'),
    [{ kind: 'open-project-menu', projectRoot: undefined }],
  )
  assert.equal(stub.dispatchDocument('contextmenu', { target: mine?.node }).defaultPrevented, true)
  stub.dispatchDocument('pointerup')
  t.mock.timers.tick(1)

  intents.length = 0
  const menu = find(root(), 'project-menu')?.node
  stub.dispatchDocument('pointerdown', { target: menu })
  assert.deepEqual(intents, [], 'a press inside the menu is not a press outside it')
})

const rowTitled = (root: StubView, title: string): StubView => {
  const found = sessionRows(root).find((row) => find(row, 'session-title-run')?.text === title)
  assert.ok(found, `no row titled ${title}`)
  return found
}

test('Escape in the search box clears the query, then leaves the field', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf(tieredState()))
  const search = find(root(), 'sidebar-search')!
  const field = search.node as { value: string }
  stub.focus(search.node)
  field.value = '后台'

  const first = stub.dispatch(search.node, 'keydown', { key: 'Escape' })
  assert.equal(field.value, '')
  assert.deepEqual(intents, [{ kind: 'search', query: '' }])
  assert.equal(stub.activeElement(), search.node, 'the first Escape keeps the field')
  assert.equal(first.defaultPrevented && first.propagationStopped, true, 'and never interrupts the turn')

  intents.length = 0
  stub.dispatch(search.node, 'keydown', { key: 'Escape' })
  assert.equal(stub.activeElement(), undefined, 'the second one leaves it')
  assert.deepEqual(intents, [])
})

test('asking to delete puts the keyboard on 取消, and cancelling gives it back to the trash button', (t) => {
  // The row is rebuilt for the question and Chromium fires no blur for the
  // removed button, so focus used to fall to `<body>` — where Escape interrupts
  // the turn instead of backing out of the question.
  const { render, root, stub } = mount(t)
  render(viewOf(tieredState()))
  stub.focus(find(rowTitled(root(), '只是历史'), 'session-delete')!.node)

  render(viewOf({ ...tieredState(), pendingDelete: 'history' }))
  assert.equal(
    stub.activeElement(),
    find(rowTitled(root(), '只是历史'), 'session-confirm-no')!.node,
    'the safe answer, not the destructive one',
  )

  render(viewOf(tieredState()))
  assert.equal(stub.activeElement(), find(rowTitled(root(), '只是历史'), 'session-delete')!.node)
})

test('focus that was elsewhere stays there when a question appears', (t) => {
  // Asking takes the keyboard only for the control that was asked through: the
  // rail repaints per streamed token and must not pull focus from the composer.
  const { render, stub } = mount(t)
  render(viewOf(tieredState()))
  const composer = stub.createContainer('composer')
  stub.focus(composer)

  render(viewOf(tieredState()))
  assert.equal(stub.activeElement(), composer)
})

test('deleting a session hands the keyboard to the row beside it', (t) => {
  const { render, root, stub } = mount(t)
  render(viewOf({ ...tieredState(), pendingDelete: 'background' }))
  stub.focus(find(rowTitled(root(), '后台 lane'), 'session-confirm-yes')!.node)

  const [shown, , history] = tieredState().projects![0]!.sessions
  render(viewOf({ ...tieredState(), projects: [{ ...tieredState().projects![0]!, sessions: [shown!, history!] }] }))

  assert.equal(
    stub.activeElement(),
    find(rowTitled(root(), '只是历史'), 'session-open')!.node,
    'focus fell to <body> with the row it was on',
  )
})

test('Enter on a confirmation or menu button is the button’s, not the cursor row’s', (t) => {
  // The container's key map reads Enter as "activate the cursor row"; on a
  // focused 取消 that would confirm the very delete being cancelled.
  const { render, root, stub, container, keys } = mount(t)
  render(viewOf({ ...tieredState(), pendingDelete: 'history' }))

  const cancel = find(rowTitled(root(), '只是历史'), 'session-confirm-no')!
  stub.dispatch(container, 'keydown', { key: 'Enter', target: cancel.node })
  assert.deepEqual(keys, [])

  stub.dispatch(container, 'keydown', { key: 'Enter', target: find(rowTitled(root(), '正在显示'), 'session-open')!.node })
  assert.deepEqual(keys, ['Enter'], 'a row keeps its Enter')
})

test('opening the project menu focuses its item, and closing it returns to the heading', (t) => {
  const { render, root, stub } = mount(t)
  render(viewOf(tieredState()))

  render(viewOf({ ...tieredState(), projectMenu: '/w/app' }))
  assert.equal(stub.activeElement(), find(root(), 'project-menu-item')!.node)

  render(viewOf(tieredState()))
  assert.equal(stub.activeElement(), find(root(), 'project-heading')!.node)
})

test('a repaint keeps the rows, nav and footer whose inputs did not change', (t) => {
  // A node rebuilt under the pointer eats the click that was aimed at it, and a
  // rebuilt focused node drops the keyboard to `<body>`.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))
  const before = sessionRows(root()).map((row) => row.node)
  const nav = find(root(), 'sidebar-nav-item')!.node
  const settings = find(root(), 'sidebar-settings')!.node

  const renamed = tieredState().projects![0]!
  render(viewOf({
    ...tieredState(),
    projects: [{ ...renamed, sessions: renamed.sessions.map((s) => (s.id === 'history' ? { ...s, title: '改过名' } : s)) }],
  }))

  const after = sessionRows(root()).map((row) => row.node)
  assert.equal(after[0], before[0])
  assert.equal(after[1], before[1])
  assert.notEqual(after[2], before[2], 'only the row that changed is rebuilt')
  assert.equal(find(root(), 'sidebar-nav-item')!.node, nav)
  assert.equal(find(root(), 'sidebar-settings')!.node, settings)
})

test('the marquee’s second copy is hidden from the accessibility tree', (t) => {
  // The loop needs the name twice — that is what it wraps onto — and saying a
  // session's name twice to a screen reader is not a cosmetic problem. The echo
  // carries `aria-hidden`, the visible run does not, and the stylesheet keeps the
  // echo out of the layout until the marquee runs.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))

  const row = sessionRows(root())[0]
  assert.ok(row, 'no rows drawn')
  const run = find(row, 'session-title-run')
  const echo = find(row, 'session-title-echo')
  assert.equal(run?.text, '正在显示')
  assert.equal(echo?.text, run?.text, 'the echo is the same name, or the loop shows two')
  assert.equal(echo?.attributes.get('aria-hidden'), 'true', 'the second copy must not be announced')
  assert.equal(run?.attributes.get('aria-hidden'), undefined, 'the first copy is the name')
})

test('a row carries its tier as data — and no tier paints anything', (t) => {
  // `active` is the one the window is showing, `open` is a lane that exists but
  // is not in front, and neither class is history. All three paint identically
  // now — activation is imperceptible by design — but the classes stay: they
  // feed `aria-selected` and the smoke probes, and this is the guard that they
  // still exist on the nodes.
  const { render, root } = mount(t)
  render(viewOf(tieredState()))

  assert.deepEqual(
    sessionRows(root()).map((row) => [
      // `session-title-run` rather than `session-title`: the title box also holds
      // the marquee's `aria-hidden` echo of the same name.
      find(row, 'session-title-run')?.text,
      row.classes.filter((name) => name !== 'session-row'),
    ]),
    [
      ['正在显示', ['active', 'open']],
      ['后台 lane', ['open']],
      ['只是历史', []],
    ],
  )
})

test('the delete confirmation keeps the name and takes over the actions slot', (t) => {
  // The regression: the confirmation used to replace the whole row, so the one
  // moment the user had to know *which* session they were deleting was the one
  // moment its name was off screen (todo D6).
  const { render, root, stub, intents } = mount(t)
  render(viewOf({ ...tieredState(), pendingDelete: 'background' }))

  const row = sessionRows(root()).find((node) => node.classes.includes('confirming'))
  assert.ok(row, 'no row is asking for confirmation')
  assert.ok(row.classes.includes('confirming'))
  assert.equal(find(row, 'session-title-run')?.text, '后台 lane', 'the name left the row')

  // Disabled, not merely unlistened: a name that still looks clickable invites an
  // answer the row will not give.
  const open = find(row, 'session-open')
  assert.equal(open?.disabled, true)
  stub.click(open?.node)
  assert.deepEqual(intents, [], 'the title answered something while the row was asking')

  const actions = find(row, 'session-actions')
  assert.deepEqual(
    actions?.children.map((child) => child.className),
    ['session-confirm-yes', 'session-confirm-no'],
  )
  stub.click(actions?.children[0]?.node)
  stub.click(actions?.children[1]?.node)
  assert.deepEqual(intents, [
    { kind: 'confirm-delete', projectRoot: '/w/app', sessionId: 'background' },
    { kind: 'cancel-delete' },
  ])
})

test('the first-level actions are rows under the search box', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf())

  const nav = region(root(), 'sidebar-nav')
  assert.deepEqual(nav.children.map((child) => child.text), ['新建会话', '打开项目…', '项目调度', '最近'])
  // Rows, not the bordered pills they used to be: they belong to the same column
  // of destinations the session rows are in.
  assert.deepEqual(nav.children.map((child) => child.classes), [
    ['sidebar-nav-item'],
    ['sidebar-nav-item'],
    ['sidebar-nav-item'],
    ['sidebar-nav-item'],
  ])

  stub.click(nav.children[0]?.node)
  stub.click(nav.children[1]?.node)
  stub.click(nav.children[2]?.node)
  stub.click(nav.children[3]?.node)
  assert.deepEqual(intents.map((intent) => intent.kind), ['new', 'open-project', 'toggle-projects', 'toggle-recent'])
})

test('the recent filter says it is on, and unlike the other two rows never disables', (t) => {
  const { render, root } = mount(t)
  render(viewOf({ recentOnly: true, canCreate: false }))

  const rows = region(root(), 'sidebar-nav').children
  assert.deepEqual(rows.map((child) => child.classes.includes('on')), [false, false, false, true])
  // A filter opens nothing, so a blocking dialog is no reason to withhold it.
  assert.deepEqual(rows.map((child) => child.disabled), [true, true, false, false])
})

test('both opening nav rows are disabled while a blocking dialog is up', (t) => {
  // `canCreate` is false exactly then, and both of those rows open something.
  const { render, root } = mount(t)
  render(viewOf({ canCreate: false }))

  assert.deepEqual(
    region(root(), 'sidebar-nav').children.slice(0, 2).map((child) => child.disabled),
    [true, true],
  )
})

test('the chord list is behind the ? and reports a toggle', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf())

  const footer = () => region(root(), 'sidebar-footer')
  assert.equal(
    footer().children.some((child) => child.classes.includes('sidebar-hint')),
    false,
    'the hint is printed under the footer again',
  )

  const help = footer().children
    .find((child) => child.classes.includes('sidebar-footer-row'))
    ?.children.find((child) => child.classes.includes('sidebar-help'))
  assert.ok(help, 'no .sidebar-help in the footer row')
  stub.click(help.node)
  assert.deepEqual(intents, [{ kind: 'toggle-help' }])

  // The click only *reports*; `app.ts` owns the flag, so the panel appears on the
  // next view that carries it.
  render(viewOf({ helpOpen: true }))
  const hint = footer().children.find((child) => child.classes.includes('sidebar-hint'))
  assert.ok(hint, 'the ? panel did not open')
  assert.equal(hint.text, '快捷键' + sidebarHint('win32').map((row) => row.label + row.chord).join(''))
})

test('macOS sidebar tooltips and help agree on Command shortcuts', (t) => {
  const { render, root } = mount(t, 'darwin')
  render(viewOf({ helpOpen: true }))
  const nav = region(root(), 'sidebar-nav').children
  assert.equal((nav[0]?.node as HTMLElement).title, '在当前项目里新建会话（⌘T）')
  assert.equal((nav[1]?.node as HTMLElement).title, '打开另一个项目（⇧⌘O）')
  assert.equal((find(root(), 'sidebar-settings')?.node as HTMLElement).title, '打开设置（⌘,）')
  assert.deepEqual(sidebarHint('darwin').map((row) => row.chord), ['⌘T', '⌘1-9', '⌘W', '⌘B', '⇧⌘O', '⌘,'])
  assert.ok(find(root(), 'sidebar-hint')?.text.includes('打开设置⌘,'))
})

test('the open ? panel closes on a press outside it and on Escape', (t) => {
  const { render, root, stub, intents, container } = mount(t)
  render(viewOf({ helpOpen: true }))

  stub.dispatchDocument('pointerdown', { target: find(root(), 'sidebar-hint')?.node })
  assert.ok(!intents.some((intent) => intent.kind === 'toggle-help'), 'a press inside the panel closed it')

  stub.dispatchDocument('pointerdown', { target: stub.createContainer('canvas') })
  assert.equal(intents.filter((intent) => intent.kind === 'toggle-help').length, 1)

  stub.dispatch(container, 'keydown', { key: 'Escape' })
  assert.equal(intents.filter((intent) => intent.kind === 'toggle-help').length, 2)
})

test('a repaint that only flips the help panel is not swallowed by the render guard', (t) => {
  // `sidebarRenderSignature` is the reason this view is affordable, and a field it
  // draws but does not sign goes stale on screen. Verified by mutation: dropping
  // `helpOpen` from the signature reds this and the `?` test above (both open the
  // panel on a second paint), and nothing else in the suite.
  const { render, root } = mount(t)
  render(viewOf())
  render(viewOf({ helpOpen: true }))

  assert.ok(
    region(root(), 'sidebar-footer').children.some((child) => child.classes.includes('sidebar-hint')),
  )
})

test('a session waiting for approval says so in words; a running one does not', (t) => {
  // The permission request is drawn in the *active* lane's composer now
  // (`dom/permissionRequestView.ts`), so a request parked on a background
  // session has nothing on screen anywhere but here — and an 8px dot is only
  // findable by someone already looking for it. "Running" keeps the bare
  // spinner: it is the state a session is in most of the time.
  const r = mount(t)
  const base = tieredState()
  r.render(sidebarView(createSidebarState({
    ...base,
    laneStatus: new Map([
      ['l1', { streaming: true, blocked: false, processes: false, hasConversation: true }],
      ['l2', { streaming: true, blocked: true, processes: false, hasConversation: true }],
    ]),
  })))

  const [running, waiting] = sessionRows(r.root()).map((row) => find(row, 'session-badge'))
  assert.ok(running, 'the streaming lane has a badge')
  assert.ok(running.classes.includes('running'))
  assert.equal(find(running, 'session-badge-label'), undefined, 'running stays a bare spinner')

  assert.ok(waiting, 'the parked lane has a badge')
  assert.ok(waiting.classes.includes('awaiting-input'))
  const label = find(waiting, 'session-badge-label')
  assert.ok(label, 'a parked request names itself on the row')
  assert.equal(label.text, '等待授权')
  // The label is the visible half of what `aria-label` already said; both stay,
  // because the badge is still the thing being described.
  assert.equal(waiting.attributes.get('aria-label'), '等待授权')
})

test('a session whose last turn failed names it in words, like a parked request', (t) => {
  const r = mount(t)
  const base = tieredState()
  r.render(sidebarView(createSidebarState({
    ...base,
    projects: base.projects!.map((project) => ({
      ...project,
      sessions: project.sessions.map((session, index) => (index === 0 ? { ...session, failed: true } : session)),
    })),
  })))

  const failed = sessionRows(r.root()).map((row) => find(row, 'session-badge')).find((badge) => badge?.classes.includes('failed'))
  assert.ok(failed, 'the failed session has a badge')
  assert.equal(find(failed, 'session-badge-label')?.text, '失败')
  assert.equal(failed.attributes.get('aria-label'), '失败')
})

test('the pinned section draws the coordinator under its project name with thread counts, then ordinary rows; no thread rows', (t) => {
  const { render, root, stub, intents } = mount(t)
  const at = '2026-01-01T00:00:00.000Z'
  render(viewOf({
    projects: [{
      projectRoot: '/w/app',
      projectName: 'app',
      sessions: [{ id: 'c1', updatedAt: at, messageCount: 1 }, { id: 'o1', updatedAt: at, messageCount: 1 }],
    }],
    coordination: new Map([['/w/app', {
      projectRoot: '/w/app',
      coordinatorSessionId: 'c1',
      threads: [
        { threadId: 'a', sessionId: 't1', title: 'build', status: 'running', lastActivityAt: at },
        { threadId: 'b', sessionId: 't2', title: 'review', status: 'needs-you', lastActivityAt: at },
        { threadId: 'c', sessionId: 't3', title: 'old', status: 'quiet', lastActivityAt: at },
      ],
    }]]),
  }))
  const section = root()
  assert.equal(find(section, 'coord-section'), undefined, 'no separate section')
  assert.equal(find(section, 'project-empty'), undefined)
  assert.equal(find(section, 'coord-counts')?.text, '1 运行中 · 1 需要你')
  const rows = sessionRows(section)
  assert.deepEqual(rows.length, 2, 'the coordinator plus the ordinary row')
  assert.equal(find(rows[0]!, 'session-title-run')?.text, 'app', 'the pinned row names the project')
  const open = find(rows[0]!, 'session-open')
  assert.ok(open)
  stub.click(open.node)
  assert.deepEqual(intents, [{ kind: 'open', projectRoot: '/w/app', sessionId: 'c1' }])
})

test('the projects item wears its on-state while the page is up', (t) => {
  const { render, root } = mount(t)
  render(viewOf({ projectsOpen: true }))

  const rows = region(root(), 'sidebar-nav').children
  assert.deepEqual(rows.map((child) => child.classes.includes('on')), [false, false, true, false])
})

test('a started project with no coordinator row is pinned as a button that reopens it', (t) => {
  const { render, root, stub, intents } = mount(t)
  render(viewOf({
    projects: [{ projectRoot: '/w/app', projectName: 'app', sessions: [] }],
    coordination: new Map([['/w/app', { projectRoot: '/w/app', started: true, threads: [] }]]),
  }))

  const pinned = find(root(), 'sidebar-pinned')
  assert.ok(pinned)
  const open = find(pinned, 'session-open')
  assert.ok(open)
  assert.equal(open.text, 'app')
  stub.click(open.node)
  assert.deepEqual(intents, [{ kind: 'open-coordinator', projectRoot: '/w/app' }])
})

/**
 * `button()` is shared by every view; it sits here beside the sidebar's retry
 * button, the case that motivated the rule. A title that only repeats the visible
 * text was a native tooltip over words already on screen; one that says more is
 * the name a screen reader needs to tell this row's button from the next.
 */
test('a text button keeps a title only when it says more than the label', () => {
  const stub = installDomStub()
  try {
    const titleOf = (view: StubView): string => (view.node as unknown as { title: string }).title
    const plain = stub.inspect(button('dialog-btn', '跳过', '跳过', () => {}))
    assert.equal(titleOf(plain), '')
    assert.equal(plain.attributes.get('aria-label'), undefined)
    const more = stub.inspect(button('sidebar-load-retry', '重试', '再次读取会话列表', () => {}))
    assert.equal(titleOf(more), '再次读取会话列表')
    assert.equal(more.attributes.get('aria-label'), '再次读取会话列表')
    const iconOnly = stub.inspect(button('icon-btn', '', '关闭', () => {}))
    assert.equal(iconOnly.attributes.get('aria-label'), '关闭')
  } finally {
    stub.uninstall()
  }
})
