import {
  SIDEBAR_COLLAPSE_FALLBACK_MS,
  SIDEBAR_EMPTY_RECENT_TEXT,
  SIDEBAR_EMPTY_TEXT,
  sidebarHint,
  SIDEBAR_NO_MATCHES_TEXT,
  CREATE_BLOCKED_HINT,
  SIDEBAR_RECENT_LABEL,
  activateRow,
  coordinationCountsText,
  newSessionIntent,
  sidebarContentMounted,
  sidebarRenderSignature,
  type SidebarCoordinationGroup,
  type SidebarGroup,
  type SidebarIntent,
  type SidebarRow,
  type SidebarView,
} from '../model/sidebar.js'
import type { DesktopPlatform } from '../../types.js'
import { PROJECTS_PAGE_TITLE } from '../model/projectsPage.js'
import { desktopShortcut } from '../model/desktopShortcuts.js'
import {
  MARQUEE_DURATION_VARIABLE,
  MARQUEE_SHIFT_VARIABLE,
  marqueeMotion,
} from '../model/marquee.js'
import { el, reconcile, replace, show } from './dom.js'
import { createPresence, finishPresenceWithin, type Presence } from './presence.js'
import { motionDelay } from './motion.js'
import { button, textField } from './controls.js'
import { onPressOutside } from './dismiss.js'
import { icon } from './icons.js'

/**
 * The sidebar as DOM.
 *
 * Four fixed regions, following `design_guidance.md` 三.2 top to bottom: the
 * session search box, the first-level actions, a scrolling middle of workspace
 * groups, and a footer carrying 设置 and the `?` panel. All four live in one
 * shell held at the open width; the stylesheet takes `#sidebar` around it to zero
 * — the one collapse control is the title bar's `.titlebar-rail`.
 *
 * The fold is the third thing this file owns that the model cannot: the phase
 * comes in on the view, but the *evidence* that a move finished is a
 * `transitionend` (or the timer standing in for one that never ran), and both are
 * DOM. It reports them back as `collapse-settled` and lets `nextCollapsePhase`
 * decide what they mean.
 *
 * The header that used to sit above the search box is gone with the workspace
 * dropdown it held: every workspace now has a heading *in the list*, so a control
 * whose job was to choose which one you could see had nothing left to do.
 *
 * Every decision — which rows exist, what order they are in, what a keystroke
 * means, whether a row is asking for confirmation — belongs to
 * `model/sidebar.ts`. This file turns those into nodes and events, and owns
 * exactly two things the model cannot: the `keydown` that feeds
 * `sidebarKeyToIntent` only while focus is inside the sidebar, and the two
 * exits that withdraw a pending delete when the user's attention leaves — a
 * `focusout`, and a press landing outside the rail (`dom/dismiss.ts`). The
 * second exists because the first cannot see a click on unfocusable scenery:
 * the transcript's background moves no focus, so `focusout` never fires and a
 * confirmation asked in the sidebar used to sit there unanswerable.
 *
 * That second one is why no rank had to be added to `resolveKey`: a delete
 * confirmation scoped to sidebar focus cannot become a dialog that is drawn but
 * unanswerable, which is the trap the per-pane overlay rules exist to avoid.
 *
 * No `innerHTML` — session titles and project names are filesystem- and
 * model-authored. The `el()` helper is the enforcement.
 */

export type SidebarAction = (intent: SidebarIntent) => void

export interface SidebarDom {
  render(view: SidebarView): void
  finishMotion(): void
  /**
   * Moves focus to one workspace's heading and scrolls it into view.
   *
   * The reveal path for something outside the sidebar that names a project — the
   * welcome screen's Hero project name. Focus rather than a highlight, because
   * the heading is a real button and the next Tab or Enter should be about the
   * group the user just asked for.
   */
  focusProject(projectRoot: string): void
}

const BADGE_LABELS = {
  running: '运行中',
  'awaiting-input': '等待授权',
} as const

export function createSidebarView(
  container: HTMLElement,
  onIntent: SidebarAction,
  /**
   * Fed the raw chord; the caller maps it through `sidebarKeyToIntent` and
   * answers whether it consumed the key. A consumed key is also stopped from
   * bubbling — the global handler is on `document`, and letting an Enter through
   * would activate the row *and* send the composer's text.
   */
  onKey: (chord: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => boolean,
  platform: DesktopPlatform,
): SidebarDom {
  // Persistent, not rebuilt by `render()`: the sidebar repaints on every shell
  // snapshot, and re-creating the input on each pass would drop the caret and the
  // focus mid-search. `app.ts` holds the query as the source of truth, so this
  // never has its `value` written back — it only reports edits outward.
  const search = textField({
    className: 'sidebar-search',
    value: '',
    ariaLabel: '搜索会话',
    placeholder: '搜索会话…',
    onCommit: (value) => onIntent({ kind: 'search', query: value }),
  })
  search.addEventListener('input', () => onIntent({ kind: 'search', query: search.value }))
  // The first-level actions, between the search box and the history. A row, not
  // a bordered pill: it belongs to the same column of destinations the session
  // rows are in (design_guidance 三.2).
  const nav = el('div', 'sidebar-nav')
  const list = el('div', 'sidebar-list')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', '会话')
  // `tabindex` rather than relying on the row buttons: the arrow keys have to
  // work the moment the list is entered, including from a click on a heading.
  list.tabIndex = 0
  const footer = el('div', 'sidebar-footer')

  // The four regions live in a shell held at the open width rather than directly
  // in `#sidebar`, which is the element that animates. A flex column narrowing
  // to zero reflows on every frame; the shell keeps its 280px, `#sidebar` crops
  // it, and the collapse is a slide rather than a re-wrap. See `styles.css`.
  const shell = el('div', 'sidebar-shell')
  shell.appendChild(search)
  shell.appendChild(nav)
  shell.appendChild(list)
  shell.appendChild(footer)
  container.appendChild(shell)

  /**
   * The fallback timer for the fold, and the only thing here that needs
   * clearing.
   *
   * The `transitionend` listener below is installed once and never removed —
   * one listener that consults the current phase cannot accumulate, which is the
   * leak an add/remove pair per toggle exists to avoid. The timer is per move,
   * so an unfired one from the move being superseded is cancelled here.
   */
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const clearSettleTimer = (): void => {
    if (settleTimer === undefined) return
    clearTimeout(settleTimer)
    settleTimer = undefined
  }

  container.addEventListener('transitionend', (event) => {
    // Only the sidebar's own width: the rows inside it transition too (hover
    // colours, the shell's own fade), and every one of those bubbles to here.
    if (event.target !== container) return
    if (event.propertyName !== 'flex-basis') return
    clearSettleTimer()
    onIntent({ kind: 'collapse-settled' })
  })

  container.addEventListener('keydown', (event) => {
    // The search box lives inside the sidebar, so its keystrokes bubble to this
    // handler — and Backspace/arrows/Enter there mean "edit the query", not
    // "delete a row" or "move the cursor". Let the input own its own keys.
    if (event.target === search) return
    const consumed = onKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
    if (!consumed) return
    event.preventDefault()
    // The global handler lives on `document`, so this is what keeps a consumed
    // Enter from also submitting the composer.
    event.stopPropagation()
  })

  /** The group headings from the last render, so `focusProject` can reach one. */
  const projectHeadings = new Map<string, HTMLButtonElement>()

  /**
   * The row the pointer is on, and every row's marquee measurement.
   *
   * Both exist for the same reason: `render()` builds new nodes, and the pointer
   * does not move when it does. `:hover` transfers to the replacement by itself,
   * but `mouseenter` does not fire again — so the row under the cursor has to be
   * re-measured by hand after a repaint or its name silently stops scrolling.
   * The map is rebuilt every render and holds only the rows that render drew.
   */
  let hovered: string | undefined
  let measures = new Map<string, () => void>()

  /**
   * One workspace's nodes, kept across repaints.
   *
   * The reason this map exists at all: `render()` rebuilds the list wholesale,
   * and a node that is new every pass cannot transition — a freshly inserted
   * element starts at its final style. The group's fold is `grid-template-rows:
   * 1fr → 0fr`, so the element it runs on has to outlive the repaint that
   * changes it, which is the same rule the stylesheet's motion block states
   * (`CLAUDE.md`: transitions only on nodes that survive their state change).
   *
   * An entrance `@keyframes` was the alternative and is not available here:
   * `sidebarRenderSignature` signs the badges, so a streaming answer repaints
   * this list continuously and the animation would replay on every flush.
   *
   * `head` and `body` are the two halves that make the reuse cheap — the heading
   * row is thrown away and rebuilt each pass (it carries the menu, the
   * confirmation and their listeners), while `body`/`rows` are never detached,
   * because detaching is exactly what cancels a running transition.
   */
  interface GroupNodes {
    readonly wrapper: HTMLElement
    /** The heading row; rebuilt every render. */
    readonly head: HTMLElement
    /**
     * The heading's context menu, kept across repaints and hidden when shut.
     *
     * Rebuilt-per-render is what it used to be, and `.project-menu` carries the
     * `drop-in` entrance: every repaint while the menu was open re-inserted the
     * node and replayed the animation — a click on another project's row, or any
     * badge change during a streaming turn, made the menu jump. A node that
     * outlives its own open state animates once, when `hidden` comes off, which
     * is the same rule the fold below follows and the one the workspace picker
     * already relies on.
     */
    readonly menu: HTMLElement
    readonly menuPresence: Presence
    /** The open state the menu was last drawn in, so its item is built once. */
    menuShown: boolean
    /** The animated track. `rows` is its single, shrinkable child. */
    readonly body: HTMLElement
    readonly rows: HTMLElement
    /** The fold state this group was last drawn in. */
    shut: boolean
    /** The fold finished moving, so the rows are gone from the DOM. */
    settled: boolean
    timer?: ReturnType<typeof setTimeout>
  }
  const groupNodes = new Map<string, GroupNodes>()

  /**
   * The fold arrived. Unmounting waits for this rather than for the click, for
   * the reason the rail's phase is four states and not a boolean: rows taken out
   * on the click would leave the fold animating an empty box.
   */
  const settleGroup = (entry: GroupNodes): void => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (!entry.shut || entry.settled) return
    entry.settled = true
    replace(entry.rows)
  }

  /** Arms the fallback for one group's move, cancelling the one it supersedes. */
  const startGroupMove = (entry: GroupNodes): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    // The rail's constant, reused deliberately: it is an upper bound (the group
    // folds at `--motion-disclosure`, the rail at `--motion-layout`) and it is the one
    // already pinned against the tokens. A `transitionend` that does arrive
    // disarms it long before it fires.
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      settleGroup(entry)
    }, motionDelay(SIDEBAR_COLLAPSE_FALLBACK_MS))
  }

  const ensureGroupNodes = (group: SidebarGroup): GroupNodes => {
    const existing = groupNodes.get(group.projectRoot)
    if (existing) return existing
    const wrapper = el('div', 'project-group')
    const head = el('div', 'project-head')
    const menu = el('div', 'project-menu')
    menu.setAttribute('role', 'menu')
    menu.hidden = true
    const body = el('div', 'project-body')
    const rows = el('div', 'project-rows')
    body.appendChild(rows)
    wrapper.appendChild(head)
    // Between the heading and the rows, where it was when it was a child of
    // `head`: the menu pushes the rows down rather than floating over them.
    wrapper.appendChild(menu)
    wrapper.appendChild(body)
    // A group first drawn shut has nothing to animate out and no rows to keep:
    // it starts settled, so the first paint is a heading and nothing else.
    const entry: GroupNodes = {
      wrapper,
      head,
      menu,
      menuPresence: createPresence(menu, { direction: 'drop', onClosed: () => replace(menu) }),
      menuShown: false,
      body,
      rows,
      shut: group.collapsed,
      settled: group.collapsed,
    }
    body.addEventListener('transitionend', (event) => {
      // The rows inside transition too (hover colours, the active bar), and
      // every one of those bubbles through here.
      if (event.target !== body) return
      if (event.propertyName !== 'grid-template-rows') return
      settleGroup(entry)
    })
    groupNodes.set(group.projectRoot, entry)
    return entry
  }

  // The same three withdrawals the `focusout` below makes, on the press that
  // lands outside them. Three registrations rather than one on the rail, because
  // the three ask three different questions and each is answered by pressing
  // anywhere that is not *it*: a confirmation in one row is withdrawn by
  // pressing another row, and a heading's menu by pressing a session. A single
  // sidebar-wide scope left all three standing for any press inside the rail,
  // which is most of the blank space a user reaches for.
  //
  // All three are no-ops when nothing is asking, which is what keeps this off
  // the repaint path: every press in the window arrives here, and `app.ts`
  // answers an unchanged state without rendering.
  onPressOutside(['.session-actions'], () => onIntent({ kind: 'cancel-delete' }))
  onPressOutside(['.project-actions'], () => onIntent({ kind: 'cancel-remove-project' }))
  // The menu's *own* heading row stays inside, and only it: the menu is opened
  // by a `contextmenu` on that row and `open-project-menu` toggles, so answering
  // the press here would close what the row's own handler is about to re-open
  // and the right-click would stop toggling. Every *other* heading is outside —
  // scoping this to a bare `.project-row` made all of them the trigger, so
  // left-pressing a different project left the menu standing over a rail that
  // had just repainted underneath it.
  onPressOutside(['.project-menu', '.project-menu-open'], () =>
    onIntent({ kind: 'open-project-menu', projectRoot: undefined }),
  )

  container.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    // `null` means focus went nowhere, which is exactly what this view's own
    // `replace()` looks like — clicking 🗑 focuses that button, the repaint that
    // draws the confirmation destroys it, and treating that as "the user left"
    // cancelled the confirmation in the same frame it appeared. A real departure
    // lands on some other element.
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    onIntent({ kind: 'cancel-delete' })
    // The heading's question and its context menu are scoped to sidebar focus
    // for the same reason the row's confirmation is: neither may survive as a
    // dialog drawn where nothing can answer it.
    onIntent({ kind: 'cancel-remove-project' })
    onIntent({ kind: 'open-project-menu', projectRoot: undefined })
  })

  const rowNode = (
    row: SidebarRow,
    index: number,
    selected: boolean,
    trailing?: HTMLElement,
    /** What the row's delete removes, when that is not simply "this session". */
    deleteTarget = '会话',
  ): HTMLElement => {
    const classes = ['session-row']
    if (row.active) classes.push('active')
    if (selected) classes.push('selected')
    if (row.lane !== undefined) classes.push('open')
    if (row.confirmingDelete) classes.push('confirming')

    const node = el('div', classes.join(' '))
    node.dataset.sessionId = row.sessionId
    node.dataset.index = String(index)
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', String(row.active))

    // One construction path, confirming or not: the confirmation used to replace
    // the whole row, which took the session's name off screen at exactly the
    // moment the user had to decide *which* session they were deleting (S7/D6).
    // Only the right-hand actions swap; the name, the badge and the truncation
    // are one decision each, as they are in `model/sidebar.ts`.
    const open = el('button', 'session-open')
    open.type = 'button'
    open.title = `${row.title} · ${row.messageCount} 条消息`
    // The name is a box — the clipper, with the ellipsis — around a track that
    // travels inside it. Translating the clipper itself would slide the
    // already-truncated box out of view rather than reveal anything.
    //
    // The track carries the name twice. The echo is `display: none` until the
    // marquee runs, so at rest it costs the layout nothing and the measurement
    // below is the width of one copy; while the marquee runs it is what the loop
    // wraps onto, and it is `aria-hidden` because it is the same name again.
    if (row.roleMarker !== undefined) open.appendChild(el('span', 'session-role', row.roleMarker))
    const title = el('span', 'session-title')
    const track = el('span', 'session-title-text')
    const echo = el('span', 'session-title-echo', row.title)
    echo.setAttribute('aria-hidden', 'true')
    // Two siblings rather than a text node plus a copy: the name the row *shows*
    // is then a node of its own, which is what anything reading this row — a
    // test, a screen reader following `aria-hidden` — should land on.
    track.appendChild(el('span', 'session-title-run', row.title))
    track.appendChild(echo)
    title.appendChild(track)
    open.appendChild(title)
    // Measured on arrival, never during `render()`: this list repaints on every
    // shell snapshot — once per streamed token — and `scrollWidth` on each of its
    // rows would force a layout at that rate. One hovered row, once, is free, and
    // it is also the only moment the answer can be right: the row's width depends
    // on the rail's, which the user can drag.
    const measure = (): void => {
      // The clipper is what gets measured, not the track inside it: at rest that
      // track is a plain inline box, and `scrollWidth` on one of those is 0.
      const motion = marqueeMotion(title.scrollWidth, title.clientWidth)
      title.classList.toggle('marquee', motion !== undefined)
      if (!motion) return
      title.style.setProperty(MARQUEE_SHIFT_VARIABLE, motion.shift)
      title.style.setProperty(MARQUEE_DURATION_VARIABLE, motion.duration)
    }
    // Kept so a repaint can put the marquee back. `render()` rebuilds every row,
    // and the pointer does not move when it does — `mouseenter` would never fire
    // again, so a name would stop mid-scroll the first time a badge changed.
    measures.set(row.sessionId, measure)
    // Keyboard reaches the same affordance: the rule keys off `:hover` and
    // `:focus-within`, so a row arrived at by Tab has to have been measured too.
    node.addEventListener('mouseenter', () => {
      hovered = row.sessionId
      measure()
    })
    node.addEventListener('mouseleave', () => {
      if (hovered === row.sessionId) hovered = undefined
    })
    node.addEventListener('focusin', measure)
    if (trailing) open.appendChild(trailing)
    if (row.badge !== 'none') {
      const badge = el('span', `session-badge ${row.badge}`)
      badge.setAttribute('aria-label', BADGE_LABELS[row.badge])
      badge.title = BADGE_LABELS[row.badge]
      // Running spins; awaiting-input is a still dot. The spinner is stroked so
      // the `.running` colour rule reaches it through `currentColor`.
      badge.appendChild(icon(row.badge === 'running' ? 'spinner' : 'dot'))
      // Awaiting input says so in words, and running does not. The asymmetry is
      // the point: the permission request is now drawn in the *composer* of one
      // lane, so a request parked on a background session has nothing on screen
      // at all — the rail is the only place it can be seen, and a 8px dot the
      // user has to already suspect is not a notification. "Running" needs no
      // label; it is the state a session is in most of the time.
      if (row.badge === 'awaiting-input') {
        badge.appendChild(el('span', 'session-badge-label', BADGE_LABELS[row.badge]))
      }
      open.appendChild(badge)
    }
    if (row.confirmingDelete) {
      // Disabled rather than merely unlistened: the row is asking a question, and
      // a name that still looks clickable invites an answer it will not give.
      open.disabled = true
    } else {
      // Through the model so a click and Enter cannot disagree about "open or
      // switch".
      open.addEventListener('click', () => onIntent(activateRow(row)))
    }
    node.appendChild(open)

    const actions = el('div', 'session-actions')
    // No close button, deliberately (stage-4 decision 2): a session the user
    // clicked stays alive, and the resident cap is released by `paneBudget`
    // silently. "Close" would ask them to think about runtimes rather than
    // sessions — `Ctrl+W` is still there for the habit, and delete is the only
    // action on a row that means anything to them.
    if (row.confirmingDelete) {
      // The question is carried by the two buttons and the row's own surface, not
      // by a sentence: at 268px a "删除此会话？" label and a title cannot both fit,
      // and the title is the half only the user can supply.
      actions.appendChild(
        button('session-confirm-yes', '删除', `确认删除${deleteTarget}`, () =>
          onIntent({ kind: 'confirm-delete', projectRoot: row.projectRoot, sessionId: row.sessionId }),
        ),
      )
      actions.appendChild(
        button('session-confirm-no', '取消', '取消删除', () => onIntent({ kind: 'cancel-delete' })),
      )
    } else {
      actions.appendChild(
        button('session-delete', '', `删除${deleteTarget}`, () =>
          onIntent({ kind: 'request-delete', sessionId: row.sessionId }),
          { icon: 'trash' },
        ),
      )
    }
    node.appendChild(actions)
    return node
  }

  /** One pinned coordination project: its coordinator row, or a stand-in that recreates the coordinator. */
  const pinnedNode = (
    entry: SidebarCoordinationGroup,
    indexOf: (row: SidebarRow) => number,
    selectedIndex: number,
  ): HTMLElement => {
    const counts = coordinationCountsText(entry.running, entry.blocked)
    const trailing = counts ? el('span', 'coord-counts', counts) : undefined
    if (entry.coordinator) {
      const index = indexOf(entry.coordinator)
      return rowNode(
        { ...entry.coordinator, title: entry.projectName },
        index,
        index >= 0 && index === selectedIndex,
        trailing,
        `项目「${entry.projectName}」的协调会话及其全部线程`,
      )
    }
    const open = button('session-open', entry.projectName, '打开此项目的协调会话', () =>
      onIntent({ kind: 'open-coordinator', projectRoot: entry.projectRoot }))
    if (trailing) open.appendChild(trailing)
    return el('div', 'session-row', open)
  }

  /**
   * One workspace: a heading that folds the group, a `+`, and its rows.
   *
   * The heading is a real `<button>` rather than the `<div>` label it replaced —
   * it toggles, and it is the target `focusProject` reveals to. Drawn for a
   * single project too: the workspace is the sidebar's only grouping axis now, so
   * hiding the heading when there is one of them would hide *what the axis is*.
   * Drawn for an *empty* project too, which is the whole point of the group
   * surviving its last session: the project is a place to come back to, not a
   * label on a pile of sessions.
   *
   * The heading and the `+` are siblings inside `.project-row` rather than
   * nested, because a `<button>` cannot contain a `<button>` — which is also why
   * the count that used to live inside the heading could be a `<span>` and its
   * replacement cannot.
   *
   * Draws *into* the nodes `ensureGroupNodes` keeps rather than building a
   * wrapper: the fold is a transition, and a transition needs an element that
   * outlives the repaint that changes it.
   */
  const groupNode = (
    group: SidebarGroup,
    indexOf: (row: SidebarRow) => number,
    selectedIndex: number,
    canCreate: boolean,
  ): HTMLElement => {
    const entry = ensureGroupNodes(group)
    if (group.collapsed !== entry.shut) {
      entry.shut = group.collapsed
      entry.settled = false
      startGroupMove(entry)
    }
    // `active` marks the heading as standing in for a session with no row of its
    // own — a pane the user just created. It is the same "you are here" the
    // active session row wears, and the model guarantees only one of the two is
    // ever set.
    const headingClasses = ['project-row']
    if (group.active) headingClasses.push('active')
    // The open menu's trigger, which is what `dom/dismiss.ts` above keeps inside
    // the popover. A marker rather than a compound selector on `.project-row`:
    // it marks exactly one row, and one class token is all `closest` needs.
    if (group.menuOpen) headingClasses.push('project-menu-open')
    const headingRow = el('div', headingClasses.join(' '))
    const heading = button(
      'project-heading',
      group.projectName,
      group.projectRoot,
      () => onIntent({ kind: 'toggle-project', projectRoot: group.projectRoot }),
      // The leading glyph says *what the group is*, not where its fold goes: a
      // folder for a project on disk, a clock for the global workspace, which is
      // not a directory the user opened. The fold direction was the chevron's
      // job and is now carried by the rows themselves being there or not — the
      // row is still the toggle, and `aria-expanded` still says which way.
      { icon: group.isGlobal ? 'clock' : 'folder' },
    )
    heading.setAttribute('aria-expanded', String(!group.collapsed))
    if (group.active) heading.setAttribute('aria-current', 'true')
    projectHeadings.set(group.projectRoot, heading)
    headingRow.appendChild(heading)

    const actions = el('div', 'project-actions')
    if (group.confirmingRemove) {
      // The same two-button answer a session row gives, and for the same reason
      // the question is not spelled out: the project name is right there, and it
      // is the half only the user can supply. The button's title carries what is
      // irreversible about it — the rows under the heading are about to be gone
      // from disk, not just off the sidebar.
      actions.appendChild(
        button('session-confirm-yes', '删除', '删除此项目的全部会话记录并从侧边栏移除', () =>
          onIntent({ kind: 'confirm-remove-project', projectRoot: group.projectRoot }),
        ),
      )
      actions.appendChild(
        button('session-confirm-no', '取消', '取消移除', () =>
          onIntent({ kind: 'cancel-remove-project' }),
        ),
      )
    } else {
      // Replaces the session count. A number told the user something they could
      // already see; this is the action they came to the heading for.
      actions.appendChild(
        button('project-new', '', canCreate ? `在 ${group.projectName} 新建会话` : CREATE_BLOCKED_HINT, () =>
          onIntent(newSessionIntent(group.projectRoot)),
          { enabled: canCreate, icon: 'plus' },
        ),
      )
    }
    headingRow.appendChild(actions)

    // The global workspace has no registry entry to forget, so it has no menu —
    // and `isGlobal` comes off the wire rather than from matching the display
    // name, which the renderer is not allowed to do.
    if (!group.isGlobal) {
      headingRow.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        onIntent({ kind: 'open-project-menu', projectRoot: group.projectRoot })
      })
    }

    // A left press on the row the open menu belongs to closes it, exactly as a
    // press anywhere else does — "点开的 popover 按哪里都要关" includes its own
    // trigger. It cannot come from `dom/dismiss.ts`: that scope has to keep this
    // row *inside*, or the close it sends on `pointerdown` would be undone by the
    // `contextmenu` that follows in the same gesture and the right-click would
    // stop toggling. Hence the button check — 2 is that right-click, and it is
    // the one press this must not answer.
    //
    // The repaint this causes detaches the heading, so the `click` behind the
    // press lands on nothing and the group does not also fold. That is the read
    // a menu's own trigger should have: the press shuts the menu, and nothing else.
    if (group.menuOpen) {
      headingRow.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        onIntent({ kind: 'open-project-menu', projectRoot: undefined })
      })
    }

    replace(entry.head, headingRow)

    // Only when the open state actually changes: this runs on every repaint, and
    // rebuilding the item under a menu the user is aiming at would take the
    // keyboard's focus off it mid-turn. The item's only variable is
    // `group.projectRoot`, which is this entry's key and cannot drift.
    if (group.menuOpen !== entry.menuShown) {
      entry.menuShown = group.menuOpen
      if (group.menuOpen && !entry.menu.firstElementChild) {
        entry.menu.appendChild(button('project-menu-item', '移除项目并删除历史', '从侧边栏移除此项目，并删除它的全部会话记录', () =>
          onIntent({ kind: 'request-remove-project', projectRoot: group.projectRoot })))
      }
      entry.menuPresence.set(group.menuOpen)
    }

    // The class the fold transitions on, toggled on the surviving wrapper.
    entry.wrapper.classList.toggle('collapsed', group.collapsed)

    if (entry.shut && entry.settled) {
      // Rest: the fold is over and the rows are not merely hidden but gone, so
      // no button behind a shut heading can be reached with Tab.
      replace(entry.rows)
      return entry.wrapper
    }
    // Still moving (or open): the rows have to be in the DOM for the track to
    // have a height to travel to. A collapsing group's rows are already out of
    // `view.rows`, so `indexOf` answers -1 for them — which must not read as the
    // "no cursor" index and paint every one of them selected.
    const children: HTMLElement[] = []
    for (const row of group.rows) {
      const index = indexOf(row)
      children.push(rowNode(row, index, index >= 0 && index === selectedIndex))
    }
    // A project kept for its own sake rather than for its sessions has to say
    // so; an empty group with nothing under the heading reads as a load that
    // has not finished.
    if (children.length === 0) children.push(el('div', 'project-empty', '还没有会话'))
    replace(entry.rows, ...children)
    return entry.wrapper
  }

  /**
   * The last drawn view's signature. The guard below is what makes this view
   * affordable: it repaints from `onShellChanged`, which fires on every
   * `SessionClient` snapshot change — including background-task `outputBytes`,
   * so a backgrounded `npm test` would otherwise rebuild every history row at
   * output-flush rate.
   */
  let drawn: string | undefined

  return {
    finishMotion() {
      const moving = settleTimer !== undefined
      clearSettleTimer()
      for (const entry of groupNodes.values()) settleGroup(entry)
      finishPresenceWithin(container)
      if (moving) onIntent({ kind: 'collapse-settled' })
    },
    focusProject(projectRoot) {
      const heading = projectHeadings.get(projectRoot)
      if (!heading) return
      heading.scrollIntoView({ block: 'nearest' })
      // The list takes the focus, not the heading. A heading is a `<button>` and
      // keeps its focus ring until something else takes it — which, sitting on a
      // group whose session has not been created yet, reads as "this project is
      // the active one" and competes with `.session-row.active`, the rail's one
      // real selection mark. The list is `tabIndex = 0` and owns the arrow keys,
      // so revealing a workspace still leaves the keyboard somewhere useful.
      list.focus()
    },
    render(view) {
      const signature = sidebarRenderSignature(view)
      if (signature === drawn) return
      drawn = signature

      // One index lookup built per render, so the row → cursor mapping is the
      // view's flattened order rather than a per-group count that could drift.
      const indices = new Map<string, number>()
      view.rows.forEach((row, index) => indices.set(row.sessionId, index))
      const indexOf = (row: SidebarRow): number => indices.get(row.sessionId) ?? -1

      replace(
        nav,
        button(
          'sidebar-nav-item',
          '新建会话',
          view.canCreate ? `在当前项目里新建会话（${desktopShortcut(platform, 'new-session')}）` : CREATE_BLOCKED_HINT,
          // Through the model, so this and `Ctrl+T` cannot disagree about *which*
          // project — the same rule the row buttons follow via `activateRow`.
          () => onIntent(newSessionIntent(view.activeProjectRoot)),
          { enabled: view.canCreate, icon: 'plus' },
        ),
        button(
          'sidebar-nav-item',
          '打开项目…',
          view.canCreate ? `打开另一个项目（${desktopShortcut(platform, 'open-project')}）` : CREATE_BLOCKED_HINT,
          () => onIntent({ kind: 'open-project' }),
          { enabled: view.canCreate, icon: 'folder' },
        ),
        button(
          `sidebar-nav-item${view.projectsOpen ? ' on' : ''}`,
          '项目',
          view.projectsOpen ? '回到会话' : '查看所有项目',
          () => onIntent({ kind: 'toggle-projects' }),
          { icon: 'folder' },
        ),
        // A filter, not a destination: it opens nothing, so unlike the two rows
        // above it stays enabled while a blocking dialog is up.
        button(
          `sidebar-nav-item${view.recentOnly ? ' on' : ''}`,
          SIDEBAR_RECENT_LABEL,
          view.recentOnly ? '显示全部工作区' : '只看不属于任何项目的会话',
          () => onIntent({ kind: 'toggle-recent' }),
          { icon: 'clock' },
        ),
      )

      // The class goes on at the *start* of the collapse and comes off at the
      // start of the expansion — it is what the width transitions between, so it
      // follows the moving phase rather than the settled one.
      const shut = view.collapsePhase === 'collapsing' || view.collapsePhase === 'collapsed'
      container.classList.toggle('collapsed', shut)

      // Arm the fallback the moment a move starts, and disarm it the moment one
      // rests. A move that supersedes another lands here too, so the timer that
      // belonged to the interrupted move never outlives it.
      clearSettleTimer()
      if (view.collapsePhase === 'collapsing' || view.collapsePhase === 'expanding') {
        settleTimer = setTimeout(() => {
          settleTimer = undefined
          onIntent({ kind: 'collapse-settled' })
        }, motionDelay(SIDEBAR_COLLAPSE_FALLBACK_MS))
      }

      // The rail that used to survive a collapse existed only so this view's own
      // toggle stayed reachable by mouse; that toggle now lives in the title bar,
      // which a collapsed sidebar does not touch. Unmounting waits for the fold
      // to *finish*: taken out on the click, the collapse would be a fade of an
      // empty column. Returning here rather than after building means a settled
      // collapse builds no rows at all — the guard above already banked the
      // signature, so expanding repaints.
      const mounted = sidebarContentMounted(view.collapsePhase)
      show(shell, mounted)
      if (!mounted) return

      // Rebuilt from the groups actually drawn, so a heading that is gone cannot
      // be revealed and a stale node cannot be focused into a detached tree.
      projectHeadings.clear()
      // Same contract for the marquee measurements: `rowNode` refills this while
      // the groups below build, and a row that is no longer drawn takes its
      // closure — and the detached node it holds — with it.
      measures = new Map()
      reconcile(
        list,
        view.isEmpty
          ? [
              el(
                'div',
                'sidebar-empty',
                // The filter's own empty state: "还没有会话" under a「最近」that
                // is switched on reads as every project having disappeared.
                view.recentOnly ? SIDEBAR_EMPTY_RECENT_TEXT : SIDEBAR_EMPTY_TEXT,
              ),
            ]
          : view.noMatches
            ? [el('div', 'sidebar-empty', SIDEBAR_NO_MATCHES_TEXT)]
            : [
                ...(view.pinned.length === 0
                  ? []
                  : [
                      el('div', 'sidebar-pinned',
                        el('div', 'sidebar-pinned-title', PROJECTS_PAGE_TITLE),
                        ...view.pinned.map((entry) => pinnedNode(entry, indexOf, view.selectedIndex))),
                    ]),
                ...view.groups.map((group) =>
                  groupNode(group, indexOf, view.selectedIndex, view.canCreate),
                ),
              ],
      )

      // Workspaces that are no longer listed. Their nodes are detached by the
      // `replace` above, but a pending fallback timer would still fire on them —
      // and the map is what keeps a group's fold state across repaints, so it is
      // also what would keep a removed project's state forever.
      const listed = new Set(view.groups.map((group) => group.projectRoot))
      for (const [projectRoot, entry] of groupNodes) {
        if (listed.has(projectRoot)) continue
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.menuPresence.dispose()
        groupNodes.delete(projectRoot)
      }

      // The row under the pointer is on a node that did not exist a moment ago,
      // and no pointer event announces that. One measurement, only while a row is
      // actually hovered — the cost this avoids paying per row is why the rest of
      // them are measured on arrival instead.
      if (hovered !== undefined) measures.get(hovered)?.()

      // A profile row and a `?`, side by side, with the chord list behind the `?`
      // rather than printed under them (design_guidance 三.2). "Open project…"
      // moved up to the nav block, where it reads as an action rather than as
      // part of the personal corner.
      const footerRow = el('div', 'sidebar-footer-row')
      // Always enabled, unlike the nav items: settings is a window-level screen
      // and does not need a project to be open to be reached.
      footerRow.appendChild(
        button('sidebar-settings', '设置', `打开设置（${desktopShortcut(platform, 'open-settings')}）`, () =>
          onIntent({ kind: 'open-settings' }),
          { icon: 'gear' },
        ),
      )
      footerRow.appendChild(
        button(
          `sidebar-help${view.helpOpen ? ' open' : ''}`,
          '',
          view.helpOpen ? '收起快捷键' : '快捷键',
          () => onIntent({ kind: 'toggle-help' }),
          { icon: 'help' },
        ),
      )
      replace(
        footer,
        ...(view.helpOpen ? [el('div', 'sidebar-hint', sidebarHint(platform))] : []),
        footerRow,
      )
    },
  }
}
