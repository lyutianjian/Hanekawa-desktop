/**
 * The ten acceptance items of stage 4, one named step each — except item 4,
 * which has two: S4 deletes an open session with other lanes around it, S4b
 * deletes the window's last one (D1). Item 8 has two as well: S8 is the settings
 * screen, and S11 is the theme that lives on its 外观 page (todo V9). Neither is
 * an eleventh acceptance item; both ride the number of the item they extend.
 *
 * Ordering is a set of constraints, not a preference:
 *
 * - **S7 first**: one lane, no side effects. A failure here means keys are not
 *   reaching the app at all, and there is no point spending 90 seconds on S6 to
 *   learn the same thing.
 * - **S2 before S6**: S6 reuses S2's mechanism — a parked permission prompt — as
 *   the deterministic pin for "never evict a blocked pane".
 * - **S6 before S3/S4**: S6 leaves four open lanes and several closed sessions,
 *   which is exactly the state S3 (delete a closed session) and S4 (delete an
 *   open one) need.
 * - **S5 after S3/S4, before S8**: S5 wants a low lane count so opening project B
 *   does not evict something mid-assertion, and S8 wants two of project A's lanes
 *   still open to observe a config fan-out across lanes.
 * - **S9 before S1**: "subsequent turns reflect it" is only observable if the
 *   effort change precedes the one paid turn.
 * - **S11 between S9 and S1**: it is the one step that changes how everything
 *   looks, so it runs after every other visual screenshot has been taken in the
 *   dark theme. It also leans on the settings screen and the composer popovers,
 *   which S8 and S9 have proved by then — so a red S11 is about the theme.
 * - **S1 last of the paid ones**: the only step that spends money. Everything
 *   else fails before the charge.
 * - **S4b after S1**: it collapses the window to a single lane (project B
 *   included, which shuts that project down), so nothing may need a lane after
 *   it. It is also the one step whose regression takes the whole app down.
 *
 * Item 10 is not a step: it is the harness's own before/after process accounting.
 *
 * Three app facts shape the assertions below, and each one invalidates the
 * obvious version of a check:
 *
 * 1. **A background pane does not repaint.** `renderTranscript` and friends
 *    early-return when the pane is inactive (`paneSession.ts:224-236`). So "the
 *    turn keeps streaming while you are away" cannot be observed as text growing
 *    in a hidden pane; it is the badge, plus the frozen length, plus the jump on
 *    return.
 * 2. **`set-startup-permission-mode` is startup-only** (`shellHost.ts:1157`,
 *    `sessionScope.ts:74`). The status bar moves after a restart, not on save —
 *    so item 8's "the status bar follows" splits in two, and only the provider
 *    half is immediate.
 * 3. **The composer is `display:none` while settings are open**
 *    (`styles.css:814-819`), so "does the long form push the composer out of the
 *    window" is really "does `#settings-body` scroll inside itself".
 */
import * as app from './app.mjs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearViewport, evaluate, key, mouseClick, setViewport, sleep, waitFor } from './cdp.mjs'
import * as probes from './probes.mjs'
import {
  assertArtifactsGone,
  existingArtifacts,
  indexEntries,
  readGlobalConfig,
  readLocalSettings,
  seededArtifactPaths,
} from './fixtures.mjs'

const read = (ctx, probe) => evaluate(ctx.cdp, probe)

/** The lane topology, straight from the shell. */
const lanes = (ctx) => app.shell(ctx.app, { type: 'panes' }).then((result) => result.lanes)

/**
 * Waits out the sheet's entrance animations, so a geometry read measures the
 * settled layout rather than the keyframe's first frame — rise-in/slide-in
 * carry a translate that leaves a freshly opened panel a few px off its
 * resting place, and `getBoundingClientRect` reports the translated box. The
 * two infinite animations (spin, breathe) are excluded: their `finished`
 * promises never resolve. A cancelled animation rejects `finished`, which is
 * not a failure here — the element is gone, and its resting place with it.
 */
async function settleAnimations(ctx) {
  await evaluate(ctx.cdp, `Promise.all(
    document.getAnimations()
      .filter((animation) => animation.effect && animation.effect.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))
  ).then(() => true)`)
}

/** Opens a fixture session as a lane and waits for its row to go active. */
async function openSession(ctx, session, projectRoot) {
  const result = await app.shell(ctx.app, {
    type: 'open-session',
    sessionId: session.id,
    ...(projectRoot ? { projectRoot } : {}),
  })
  ctx.state.lanesSeen.add(Number(result.lane))
  noteActivation(ctx, result.lane)
  await waitFor(`lane ${result.lane} to carry ${session.marker}`, async () => {
    const view = await read(ctx, probes.sidebar())
    return view.rows.some((row) => row.sessionId === session.id && row.open)
  })
  return result
}

/**
 * The activation order the pane budget evicts by.
 *
 * Tracked here so the driver can compute `selectEvictions`' expected answer
 * itself rather than asserting whatever happened — `lastActiveTick` lives in the
 * renderer and no wire field carries it.
 */
function noteActivation(ctx, lane) {
  ctx.state.activation = (ctx.state.activation ?? []).filter((entry) => entry !== lane)
  ctx.state.activation.push(lane)
}

/** Switches to a session's row through the app's own click handler. */
async function activate(ctx, session) {
  await read(ctx, probes.clickRow(session.id))
  await waitFor(`${session.marker} to become the active row`, async () => {
    const view = await read(ctx, probes.sidebar())
    return view.rows.some((row) => row.sessionId === session.id && row.active)
  })
  const topology = await lanes(ctx)
  const lane = topology.find((info) => info.paneId === session.id)?.lane
  if (lane) noteActivation(ctx, lane)
  return lane
}

const rowFor = (view, sessionId) => view.rows.find((row) => row.sessionId === sessionId)

const markerOf = (ctx, sessionId) =>
  [...ctx.sessionsA, ...ctx.sessionsB].find((session) => session.id === sessionId)?.marker

/**
 * Raises a permission prompt on a pane, for free.
 *
 * `run-tool` reaches `loop.runTool` through the permission gate without any
 * provider request (`protocol/host.ts:659`), and the seeded `ask: ['Write']` rule
 * makes the prompt certain rather than dependent on the gate's default for a
 * `confirm` tool.
 */
async function raisePrompt(ctx, lane, fileName) {
  const since = (await app.events(ctx.app, 0)).seq
  const id = await app.post(ctx.app, lane, {
    type: 'run-tool',
    name: 'Write',
    input: { filePath: fileName, content: 'smoke 4f\n' },
  })
  const request = await waitFor(`a permission prompt on lane ${lane}`, async () => {
    const { entries } = await app.events(ctx.app, since)
    return entries.find((entry) => entry.type === 'ui-request' && entry.kind === 'permission' && entry.lane === lane)
  })
  return { id, request }
}

// --- S7: Ctrl+B ---------------------------------------------------------------

/** `.transcript`'s top padding in `styles.css`: `--space-2` plus the 8px `--transcript-tuck` under the title bar. */
const TRANSCRIPT_PADDING = 16
/**
 * `ANCHOR_REST_PX` in `model/transcriptAnchor.ts`: where the pad rests once a
 * turn is over. A fixture conversation is settled by definition — no turn is in
 * flight — so the lift arithmetic is short-circuited and this is the number the
 * step reads. (The pad used to stay at its streaming height forever; the
 * shortening at turn end is documented in that module.)
 */
const TRANSCRIPT_ANCHOR_REST = 24

async function step7(ctx) {
  // Startup lands in a NEW empty session — never the newest fixture — so the
  // first thing on the canvas is the welcome screen, and the fresh draft has
  // no row in the sidebar (empty sessions are invisible by design).
  const launch = (await lanes(ctx))[0]
  const hero = await waitFor('the welcome hero to come up', async () => {
    const view = await read(ctx, probes.welcome())
    return view !== null && view.project.includes('projA') ? view : undefined
  })
  ctx.ok('startup shows the welcome hero naming the project', hero.project.includes('projA'), hero.project)
  const initial = await waitFor('the fixture sessions to be listed', async () => {
    const view = await read(ctx, probes.sidebar())
    return view.rowCount >= 8 ? view : undefined
  })
  ctx.ok(
    'the fresh empty session has no sidebar row yet',
    initial.rows.every((row) => row.sessionId !== launch.paneId),
    `lane pane ${launch.paneId}`,
  )

  // A fixture supplies the short conversation this step is about: open the
  // youngest one, the way a user picking history off the sidebar would.
  await openSession(ctx, ctx.sessionsA[0])

  const before = await read(ctx, probes.sidebar())
  ctx.ok('the sidebar starts expanded', before.collapsed === false, `collapsed=${before.collapsed}`)
  ctx.ok('the fixture sessions are listed', before.rowCount >= 8, `${before.rowCount} rows`)
  await ctx.shot('07a-sidebar-expanded', 'the expanded sidebar: workspace headings, folding, row density')

  // Where a turn sits, and this step is where it is observable: a fixture is
  // exactly one user message (`fixtures.mjs:seedSession`), so the anchor is the
  // session's first and the lift takes it all the way to the top of the
  // viewport. Asserted before Ctrl+B, while the canvas is at its full width.
  const short = await read(ctx, probes.conversation())
  ctx.ok('a pane is showing a conversation', short !== null, 'no visible pane with a transcript')
  if (short) {
    // A settled conversation rests at `ANCHOR_REST_PX`, not at the lift's
    // streaming height — that arithmetic only runs while a turn is in flight,
    // and no free step can keep one running. What is still assertable is the
    // rest contract itself, exactly rather than `<=`.
    ctx.ok(
      'the conversation is settled with a question to anchor',
      short.items >= 1 && short.anchor !== null,
      `items=${short.items} anchor=${JSON.stringify(short.anchor)}`,
    )
    ctx.eq('the pad rests at the turn-over value', short.pad, `${TRANSCRIPT_ANCHOR_REST}px`)
    // Exact, not `<=`: the bubble is the session's first, so it goes to the very
    // top and the scroller's own padding is the only thing above it. D7 set the
    // precedent that a layout judgement stays exact rather than being loosened
    // into something that cannot fail.
    ctx.eq(
      'the newest question sits at the top of the viewport',
      short.anchor ? short.anchor.top - short.scroller.top : null,
      TRANSCRIPT_PADDING,
    )
    // And the scroller has run out of travel: with the question at the top there
    // is nowhere left for it to go, which is the settled state's own claim —
    // one pixel of scrollHeight either way and the bubble would be able to
    // slide past the top or fall short of it.
    ctx.eq('the scroller has no travel left under the question', short.scrollHeight, short.clientHeight)
  }
  await ctx.shot('07c-short-session', 'a two-message session: is the question at the top of the canvas with the answer under it')

  await key(ctx.cdp, 'Ctrl+b')
  // Collapsed for geometry purposes means the width has settled at zero, not
  // just that the class flipped: `#sidebar` animates its flex-basis over
  // `--motion-slow`, and a read on the first frame after the class lands would
  // still see the whole 280px column.
  const collapsed = await waitFor('the sidebar to collapse', async () => {
    const view = await read(ctx, probes.sidebar())
    return view.collapsed && view.width === 0 && view.shellHidden === true ? view : undefined
  })
  // One `show()` on the shell, and it happens on `transitionend` (or the
  // fallback timer) rather than on the click: taken out when the class flipped,
  // the collapse would be an empty column sliding shut.
  ctx.ok('the column is hidden once collapsed', collapsed.shellHidden === true, `shellHidden=${collapsed.shellHidden}`)
  // Not "no rows exist": `render()` returns before rebuilding the list, so the
  // rows built while expanded stay in the hidden container. What collapse
  // guarantees — and what the rail is for — is that none of them is on screen
  // while the toggle still is.
  ctx.eq('no row is on screen while collapsed', collapsed.visibleRowCount, 0)
  // And the column itself is gone, not narrowed to a rail: the toggle that rail
  // existed for is in the title bar, so there is nothing left to keep reachable.
  ctx.eq('the rail is gone entirely', collapsed.width, 0)
  await ctx.shot('07b-sidebar-collapsed', 'the collapsed sidebar: the column is gone and the canvas keeps its 8px inset')

  await key(ctx.cdp, 'Ctrl+b')
  const after = await waitFor('the sidebar to expand again', async () => {
    const view = await read(ctx, probes.sidebar())
    return view.collapsed === false ? view : undefined
  })
  ctx.eq('expanding restores every row', after.rowCount, before.rowCount)
}

// --- S2: a parked permission prompt ------------------------------------------

async function step2(ctx) {
  const topology = await lanes(ctx)
  const projectRoot = topology[0].projectRoot
  ctx.state.projectRootA = projectRoot
  const a1 = ctx.sessionsA[0]
  const a2 = ctx.sessionsA[1]

  const opened = await openSession(ctx, a2, projectRoot)
  await activate(ctx, a2)
  ctx.note(`A2 is on lane ${opened.lane}`)

  // 5e: the canvas header names whichever session is active. Asserted against the
  // sidebar's own row rather than against a literal — one session, one name is
  // the invariant, and both views derive it from the same lane list.
  const headerA2 = await read(ctx, probes.canvasHeader())
  const rowA2 = rowFor(await read(ctx, probes.sidebar()), a2.id)
  ctx.ok('the canvas header is drawn for the active session', headerA2.hidden === false, JSON.stringify(headerA2))
  ctx.eq('and it names the same session the sidebar row does', headerA2.title, rowA2?.title ?? '')
  ctx.ok('and it offers to open the project in VS Code', headerA2.openLocation.includes('VS Code'), headerA2.openLocation)

  // The `⋯` menu, opened and dismissed with **real mouse events**. The DOM tests
  // cover the wiring; only this covers delivery, and the difference is the whole
  // bug: `element.click()` fires no `pointerdown`, so a synthetic-click check
  // passes over a menu that in the user's hands can only be closed by choosing
  // from it. Which is what it did — the menu sat over the transcript through
  // every click anywhere in the window.
  const trigger = await read(ctx, probes.centreOf('#canvas-header .canvas-menu-trigger'))
  ctx.ok('the header has a hittable ⋯', trigger !== null, JSON.stringify(trigger))
  await mouseClick(ctx.cdp, trigger.x, trigger.y)
  const opened2 = await waitFor('the header menu to open', async () => {
    const view = await read(ctx, probes.canvasHeader())
    return view.menuItems.length > 0 ? view : undefined
  })
  ctx.eq('the ⋯ menu offers rename and delete', opened2.menuItems.length, 2)

  // Pressing the transcript is the gesture the user reported. It must also stay
  // a *pass-through*: the press dismisses, and nothing about the session changes.
  const elsewhere = await read(ctx, probes.centreOf('#transcript-area'))
  ctx.ok('the transcript is hittable', elsewhere !== null, JSON.stringify(elsewhere))
  await mouseClick(ctx.cdp, elsewhere.x, elsewhere.y)
  const dismissed = await waitFor('the header menu to close on a press outside it', async () => {
    const view = await read(ctx, probes.canvasHeader())
    return view.menuItems.length === 0 ? view : undefined
  })
  ctx.eq('and the session it belongs to is untouched', dismissed.title, headerA2.title)

  const prompt = await raisePrompt(ctx, opened.lane, 'smoke-write-target.txt')
  const dialog = await waitFor('the permission request to be drawn', async () => {
    const view = await read(ctx, probes.permissionRequest())
    return view.open ? view : undefined
  })
  // Asserted on the *file*, not the tool name: the card is localized (the title
  // reads 写入文件), so matching 'Write' would be asserting the English build.
  ctx.ok('the request names the file it would write', dialog.block.includes('smoke-write-target.txt'), dialog.block)
  ctx.ok('the request has a title', dialog.title.length > 0, dialog.title)
  // Upper case as of S5: the keys are badges on the buttons, not a transcribed
  // `[y/n]` hint line.
  ctx.ok('the request badges the Y/N keys', dialog.hotkeys.includes('Y') && dialog.hotkeys.includes('N'), dialog.hotkeys.join(''))
  // Exactly one primary, and it is 允许一次: neither 拒绝 (which Escape does) nor
  // 始终允许 (which writes a lasting rule) may look like the recommended answer.
  ctx.ok(
    'the answers are buttons, with exactly one primary',
    dialog.actions.length >= 2 && dialog.actions.filter((action) => action.primary).length === 1,
    JSON.stringify(dialog.actions),
  )
  // The request transforms the composer instead of covering the lane: it is
  // *inside* the capsule, on the capsule's own axis, and the textarea and the
  // action bar it stands in for are off screen. A card drawn over a live
  // composer would be the modal it replaced with an extra step.
  ctx.ok('the request is drawn inside the composer capsule', dialog.insideComposer === true, JSON.stringify(dialog.box))
  ctx.ok('the capsule reports the transform', dialog.transformed === true, `transformed=${dialog.transformed}`)
  ctx.ok(
    'the textarea and the action bar stepped aside for it',
    dialog.inputVisible === false && dialog.barVisible === false,
    `input=${dialog.inputVisible} bar=${dialog.barVisible}`,
  )
  ctx.ok(
    'and it sits on the composer axis rather than floating on its own',
    dialog.box && dialog.composerBox && dialog.box.right <= dialog.composerBox.right
      && dialog.box.left >= dialog.composerBox.left,
    JSON.stringify({ card: dialog.box, composer: dialog.composerBox }),
  )
  // Nothing is dimmed or covered: the transcript the question is about stays
  // reachable. The hit test is the evidence — `getBoundingClientRect` answers in
  // full for a node that is covered.
  const scope = await read(ctx, probes.dockScope())
  ctx.ok(
    'the transcript the question is about is still reachable',
    scope.atCanvas?.inDock === false,
    JSON.stringify(scope.atCanvas),
  )
  // And the sidebar, so switching away from a parked pane stays a supported move
  // — which is the whole reason the badge below has to be visible.
  ctx.ok(
    'the sidebar is live while a request is parked',
    scope.atSidebar?.inSidebar === true && scope.atSidebar?.inDock === false,
    JSON.stringify(scope.atSidebar),
  )
  await ctx.shot('02a-permission-request', 'the permission request drawn inside the composer capsule — no scrim, the transcript still readable — with its title, question, command block and button bar')

  await activate(ctx, a1)
  const away = await waitFor('the parked pane to show the awaiting-input badge', async () => {
    const view = await read(ctx, probes.sidebar())
    const row = rowFor(view, a2.id)
    return row && row.badge !== 'none' ? { view, row } : undefined
  })
  ctx.eq('the parked pane shows 等待授权', away.row.badge, '等待授权')
  ctx.ok('the switched-to row is the active one', rowFor(away.view, a1.id)?.active === true, JSON.stringify(rowFor(away.view, a1.id)))
  // `deactivate()` clears the paint but not the state: a request drawn while its
  // pane is not the keyboard target would be unanswerable, and here it would be
  // worse than unanswerable — the composer is a singleton, so a card left behind
  // would sit in the *next* pane's capsule and answer its gate.
  const awayCard = await read(ctx, probes.permissionRequest())
  ctx.ok('the request is not left in another pane\'s composer', awayCard.open === false, `open=${awayCard.open}`)
  ctx.ok('and that pane has its composer back', awayCard.inputVisible === true, `input=${awayCard.inputVisible}`)
  await ctx.shot('02b-awaiting-badge', 'the 等待授权 badge on a background row, next to the active row')

  await activate(ctx, a2)
  const back = await waitFor('the request to come back with the pane', async () => {
    const view = await read(ctx, probes.permissionRequest())
    return view.open && view.settled ? view : undefined
  })
  ctx.ok('coming back restores the same request', back.block.includes('smoke-write-target.txt'), back.block)

  // Answered with a **real mouse event**, not `y` and not `element.click()`.
  // Until S4 `overlayView.ts` had zero listeners, so the whole dialog was
  // keyboard-only; a synthetic click would have passed even then, and it would
  // still pass over a row that is covered or clipped. What follows — the tool
  // ran, the file landed, the card closed — is the proof the pixel answered.
  // 允许一次 rather than 允许, so a card that also offers 始终允许 cannot match
  // the wrong button and write a rule into the scratch project's settings.
  const allow = back.actions.find((action) => action.label.includes('允许一次'))
  ctx.ok('the request offers a clickable 允许一次 button', allow !== undefined, JSON.stringify(back.actions))
  await mouseClick(ctx.cdp, allow.x, allow.y)
  const result = await app.reply(ctx.app, prompt.id, { label: 'run-tool Write', timeout: 20000 })
  ctx.ok('clicking 允许一次 runs the tool', result !== undefined, JSON.stringify(result).slice(0, 120))
  ctx.ok(
    'the tool actually wrote the file into the scratch project',
    existsSync(join(ctx.projectA.root, 'smoke-write-target.txt')),
    join(ctx.projectA.root, 'smoke-write-target.txt'),
  )
  const written = await read(ctx, probes.permissionRequest())
  ctx.ok('the request closes after the answer', written.open === false, `open=${written.open}`)
  ctx.ok('and the composer is a composer again', written.inputVisible === true, `input=${written.inputVisible}`)
  let badge = 'unread'
  try {
    await waitFor(
      'the badge to clear',
      async () => {
        const view = await read(ctx, probes.sidebar())
        badge = rowFor(view, a2.id)?.badge
        return badge === 'none'
      },
      { timeout: 8000 },
    )
  } catch {
    // Recorded rather than thrown: this is exactly the kind of thing the smoke
    // run exists to find, and the remaining assertions are still worth having.
    const state = await app.laneState(ctx.app)
    ctx.note(`lane state at the stale badge: ${JSON.stringify(state.state)}`)
  }
  ctx.eq('the badge clears once the prompt is answered', badge, 'none')
}

// --- S6: the resident-pane budget --------------------------------------------

/** `DEFAULT_PANE_LIMIT` in `src/desktop/paneBudget.ts`. */
const PANE_LIMIT = 4

async function step6(ctx) {
  const projectRoot = ctx.state.projectRootA ?? (await lanes(ctx))[0].projectRoot
  const before = await lanes(ctx)
  ctx.note(`starting with ${before.length} lanes (${before.map((info) => info.lane).join(',')})`)

  for (const session of ctx.sessionsA.slice(2, 6)) await openSession(ctx, session, projectRoot)

  const settled = await waitFor('the lane count to settle at the cap', async () => {
    const topology = await lanes(ctx)
    return topology.length === PANE_LIMIT ? topology : undefined
  })
  ctx.eq('the resident lane count settles at the cap', settled.length, PANE_LIMIT)
  // The driver knows the activation order, so it can predict `selectEvictions`'
  // answer instead of accepting whatever happened: the survivors are the last
  // `PANE_LIMIT` lanes activated.
  ctx.eq(
    'the lanes that survive are the most recently activated ones',
    settled.map((info) => info.lane).sort(),
    ctx.state.activation.slice(-PANE_LIMIT).sort(),
  )
  const openIds = new Set(settled.map((info) => info.paneId))
  const view = await read(ctx, probes.sidebar())
  ctx.ok('every fixture session still has a row', view.rowCount >= 8, `${view.rowCount} rows`)
  // Releasing a pane is not closing a session: the row stays, without its lane.
  ctx.eq(
    'an evicted session keeps its row and loses only its lane',
    view.rows.filter((row) => row.open && !openIds.has(row.sessionId)).length,
    0,
  )
  await ctx.shot('06a-six-sessions-four-lanes', 'eight rows, four marked open — eviction takes the runtime, not the session')

  const evicted = ctx.sessionsA.find((session) => !openIds.has(session.id))
  const highestLane = Math.max(...ctx.state.lanesSeen)
  const reopened = await openSession(ctx, evicted, projectRoot)
  ctx.ok(
    'reopening mints a fresh lane key rather than reusing the released one',
    Number(reopened.lane) > highestLane,
    `${reopened.lane} > ${highestLane}`,
  )
  const rebuilt = await waitFor('the reopened pane to replay its records', async () => {
    const pane = await read(ctx, probes.paneByMarker(evicted.marker))
    return pane.found && pane.len > 0 ? pane : undefined
  })
  ctx.ok('the reopened pane rebuilt from disk', rebuilt.len > 0, `${rebuilt.len} chars of transcript`)

  // The pin. `paneBudget.isPinned` refuses to evict a pane holding an unanswered
  // request, because teardown drains the bridge with a *denial* — the user's tool
  // call would fail silently instead of being asked about.
  const prompt = await raisePrompt(ctx, reopened.lane, 'smoke-pin-target.txt')
  ctx.note(`parked a prompt on lane ${reopened.lane}`)
  for (const info of (await lanes(ctx)).filter((entry) => entry.lane !== reopened.lane)) {
    const session = ctx.sessionsA.find((entry) => entry.id === info.paneId)
    if (session) await activate(ctx, session)
  }
  const live = new Set((await lanes(ctx)).map((info) => info.lane))
  const coldestIdle = ctx.state.activation.find((lane) => lane !== reopened.lane && live.has(lane))
  const openNow = new Set((await lanes(ctx)).map((info) => info.paneId))
  const nextSession = ctx.sessionsA.find((session) => !openNow.has(session.id) && !ctx.state.deleted.has(session.id))
  await openSession(ctx, nextSession, projectRoot)
  const after = await waitFor('the budget pass to settle again', async () => {
    const topology = await lanes(ctx)
    return topology.length === PANE_LIMIT ? topology : undefined
  })
  const laneKeys = after.map((info) => info.lane)
  ctx.ok(
    'a pane holding an unanswered prompt is never evicted',
    laneKeys.includes(reopened.lane),
    `lanes now ${laneKeys.join(',')}, parked ${reopened.lane}`,
  )
  ctx.ok(
    'an idle lane was released in its place',
    coldestIdle !== undefined && !laneKeys.includes(coldestIdle),
    `coldest idle was ${coldestIdle}`,
  )

  // Answer through the real path — keys reach the active pane only, so the parked
  // pane has to be activated first.
  await activate(ctx, evicted)
  await key(ctx.cdp, 'n')
  let denial = 'no reply'
  try {
    denial = JSON.stringify(await app.reply(ctx.app, prompt.id, { label: 'denied run-tool', timeout: 15000 }))
  } catch (error) {
    denial = error instanceof Error ? error.message : String(error)
  }
  ctx.ok(
    'denying the parked prompt does not write the file',
    !existsSync(join(ctx.projectA.root, 'smoke-pin-target.txt')),
    denial.slice(0, 140),
  )
}

// --- S3: delete a closed session ---------------------------------------------

async function step3(ctx) {
  const topology = await lanes(ctx)
  const openIds = new Set(topology.map((info) => info.paneId))
  const target = ctx.sessionsA.find((session) => !openIds.has(session.id) && !ctx.state.deleted.has(session.id))
  ctx.ok('there is a closed fixture session to delete', target !== undefined, target?.marker ?? 'none')
  if (!target) return

  // A delete test that starts from nothing proves nothing: the artifacts a *ran*
  // session leaves are seeded, so this asserts they existed first. The expected
  // count is derived from the seeder itself — a literal here went stale the day
  // the shadow-git artifacts were removed, and the step failed on every machine
  // for three commits before anyone ran the smoke again.
  const seeded = existingArtifacts(ctx.projectA, target.id)
  ctx.eq(
    'the session has every seeded artifact on disk before the delete',
    seeded.length,
    seededArtifactPaths(ctx.projectA, target.id).length,
  )

  const named = rowFor(await read(ctx, probes.sidebar()), target.id)
  ctx.ok('the row to be deleted has a name to keep', (named?.title ?? '') !== '', named?.title ?? 'none')

  await read(ctx, probes.clickDelete(target.id))
  const confirming = await waitFor('the row to ask for confirmation', async () => {
    const view = await read(ctx, probes.sidebar())
    const row = rowFor(view, target.id)
    return row?.confirming ? row : undefined
  })
  ctx.ok('the confirmation replaces the row inline', confirming.confirming === true, JSON.stringify(confirming))
  // The name stays put and the buttons take the actions slot (S7/D6). It used to
  // be replaced wholesale, which took the session's name off screen at exactly
  // the moment the user had to decide which session they were deleting.
  ctx.eq('the name is still on screen while confirming', confirming.title, named?.title ?? '')
  await ctx.shot('03a-delete-confirm', 'the inline delete confirmation: an answerable question, not a broken row')

  await read(ctx, probes.clickConfirmYes(target.id))
  // The row is withdrawn *optimistically*, before the host has deleted anything
  // (app.ts hides it the moment the confirm is clicked so a slow round trip
  // cannot invite a second delete) — so the row going away is not the delete.
  // The artifacts have to be waited for, or the sweep below races a delete that
  // is still moving files and reads a half-deleted session as a leak.
  await waitFor('the delete to finish removing the artifacts', async () => {
    const still = existingArtifacts(ctx.projectA, target.id)
    const indexed = indexEntries(ctx.projectA).some((session) => session.id === target.id)
    return still.length === 0 && !indexed
  }, { timeout: 20000 })
  await waitFor('the row to disappear', async () => {
    const view = await read(ctx, probes.sidebar())
    return rowFor(view, target.id) === undefined
  })
  ctx.state.deleted.add(target.id)
  let gone = 'clean'
  try {
    assertArtifactsGone(ctx.projectA, target.id)
  } catch (error) {
    gone = error instanceof Error ? error.message : String(error)
  }
  ctx.eq('every artifact and the index entry are gone', gone, 'clean')
}

// --- S4: delete the session that is open --------------------------------------

async function step4(ctx) {
  const topology = await lanes(ctx)
  const view = await read(ctx, probes.sidebar())
  const activeRow = view.rows.find((row) => row.active)
  const target = ctx.sessionsA.find((session) => session.id === activeRow?.sessionId)
  ctx.ok('the active pane is a fixture session', target !== undefined, activeRow?.title ?? 'none')
  if (!target) return
  const lane = topology.find((info) => info.paneId === target.id)?.lane
  const panesBefore = await read(ctx, probes.panes())
  const since = (await app.events(ctx.app, 0)).seq

  await read(ctx, probes.clickDelete(target.id))
  await waitFor('the confirmation', async () => {
    const now = await read(ctx, probes.sidebar())
    return rowFor(now, target.id)?.confirming === true
  })
  await read(ctx, probes.clickConfirmYes(target.id))

  await waitFor('the lane to close', async () => {
    const now = await lanes(ctx)
    return now.every((info) => info.lane !== lane)
  })
  ctx.state.deleted.add(target.id)
  const { entries } = await app.events(ctx.app, since)
  ctx.ok(
    'the lane was closed as part of the delete',
    entries.some((entry) => entry.type === 'lane-close' && entry.lane === lane)
      || entries.some((entry) => entry.type === 'lanes' && !entry.lanes.some((info) => info.lane === lane)),
    entries.map((entry) => entry.type).join(','),
  )
  const panesAfter = await read(ctx, probes.panes())
  ctx.eq('the pane subtree is gone with it', panesAfter.length, panesBefore.length - 1)
  const ghost = await read(ctx, probes.paneByMarker(target.marker))
  ctx.ok('no ghost pane keeps the deleted transcript', ghost.found === false, JSON.stringify(ghost))
  ctx.eq('exactly one pane is visible', panesAfter.filter((pane) => pane.visible).length, 1)
  const afterView = await read(ctx, probes.sidebar())
  ctx.ok('the row is gone', rowFor(afterView, target.id) === undefined)
  // Deleting the *active* pane is the harder case: something else has to become
  // active, or the window is left with no keyboard target.
  ctx.ok(
    'another pane took over as active',
    afterView.rows.some((row) => row.active),
    JSON.stringify(afterView.rows.filter((row) => row.open).map((row) => row.title)),
  )
  let gone = 'clean'
  try {
    assertArtifactsGone(ctx.projectA, target.id)
  } catch (error) {
    gone = error instanceof Error ? error.message : String(error)
  }
  ctx.eq('every artifact of the open session is gone too', gone, 'clean')
  await ctx.shot('04-after-open-delete', 'after deleting the open session: no ghost pane, one visible transcript, a sane active row')
}

// --- S4b: deleting the *last* lane ----------------------------------------------

/**
 * The single-lane branch of S4 (D1).
 *
 * S4 always deletes with other lanes still open, which is exactly why the bug
 * survived it: `detachLane` fired `onAllLanesClosed` only when the map emptied,
 * and that quits the app off darwin. So this step first collapses the window to
 * one lane, then deletes the session behind it, and asserts the window is still
 * there with a draft in its place.
 *
 * Last in the run, and for two reasons: it closes every other lane (project B
 * included, so that project shuts down), and it is the one step that would take
 * the whole app down with it if it regressed.
 */
async function step4b(ctx) {
  const topology = await lanes(ctx)
  // A project A fixture, not a draft and not project B: `delete-session`
  // resolves through the store (a draft has no index entry), and the artifact
  // sweep below is asserted against project A's directory.
  const survivor = topology.find(
    (info) => ctx.sessionsA.some((session) => session.id === info.paneId) && !ctx.state.deleted.has(info.paneId),
  )
  ctx.ok('a fixture lane can be left alone as the last one', survivor !== undefined, JSON.stringify(topology.map((info) => info.lane)))
  if (!survivor) return

  // `close-pane` self-destructs its lane's host, so its reply is lost by
  // construction (see `app.reply`): post, then wait on the topology.
  for (const info of topology) {
    if (info.lane === survivor.lane) continue
    await app.post(ctx.app, info.lane, { type: 'close-pane', paneId: info.paneId })
  }
  const only = await waitFor('the window to be down to one lane', async () => {
    const now = await lanes(ctx)
    return now.length === 1 && now[0].lane === survivor.lane ? now[0] : undefined
  })
  await ctx.shot('04b-last-lane', 'the window with a single lane left, about to lose it')

  await app.shell(ctx.app, {
    type: 'delete-session',
    projectRoot: only.projectRoot,
    sessionId: only.paneId,
  })
  ctx.state.deleted.add(only.paneId)

  // The bug: this is where the app used to quit. `liveness` is the detector that
  // survives a dead main process — a screenshot of a gone window proves nothing.
  let alive = 'quit'
  try {
    alive = (await app.liveness(ctx.app)) ? 'answering' : 'silent'
  } catch (error) {
    alive = error instanceof Error ? error.message : String(error)
  }
  ctx.eq('deleting the last session does not take the window with it', alive, 'answering')
  ctx.ok('and the process is still there', app.isAlive(ctx.app.pid), `pid ${ctx.app.pid}`)

  const replaced = await waitFor('a replacement lane', async () => {
    const now = await lanes(ctx)
    return now.length === 1 && now[0].lane !== survivor.lane ? now[0] : undefined
  })
  ctx.ok('the deleted session did not come back as its own replacement', replaced.paneId !== only.paneId, replaced.paneId)
  ctx.eq('the replacement belongs to the same project', replaced.projectRoot, only.projectRoot)
  // The replacement is a fresh empty session — invisible in the sidebar by
  // design — so the proof of activation is its welcome screen on the visible
  // pane, not a row going active.
  await waitFor('the replacement to activate and show its welcome screen', async () => {
    const hero = await read(ctx, probes.welcome())
    return hero !== null && hero.project.includes('projA') ? hero : undefined
  })
  const view = await read(ctx, probes.sidebar())
  ctx.ok('the row for the deleted session is gone', rowFor(view, only.paneId) === undefined)
  ctx.ok(
    'the empty replacement has no row of its own',
    rowFor(view, replaced.paneId) === undefined,
    `replacement pane ${replaced.paneId}`,
  )
  let gone = 'clean'
  try {
    assertArtifactsGone(ctx.projectA, only.paneId)
  } catch (error) {
    gone = error instanceof Error ? error.message : String(error)
  }
  ctx.eq('the artifacts went with it', gone, 'clean')
  await ctx.shot('04c-after-last-delete', 'after deleting the last session: an empty draft, not a closed window')
}

// --- S5: a second project ------------------------------------------------------

async function step5(ctx) {
  const rootA = ctx.state.projectRootA ?? (await lanes(ctx))[0].projectRoot
  // `path` is always passed, which is what keeps `promptForProjectDirectory`'s
  // native picker (`main.ts:236`) out of the run — CDP could not answer it.
  await app.shell(ctx.app, { type: 'open-project', path: ctx.projectB.root })
  const withB = await waitFor('a lane belonging to project B', async () => {
    const topology = await lanes(ctx)
    const lane = topology.find((info) => info.projectRoot !== rootA)
    return lane ? { topology, lane } : undefined
  })
  const rootB = withB.lane.projectRoot
  ctx.state.projectRootB = rootB
  for (const info of withB.topology) ctx.state.lanesSeen.add(Number(info.lane))
  ctx.ok('project B opened with a lane', withB.lane !== undefined, `${withB.lane.lane} @ ${rootB}`)
  // Every entry into a project is a NEW empty session — never its newest
  // fixture. The pane carries no fixture marker and the welcome hero names
  // project B.
  ctx.ok(
    'the new project opens a new empty session',
    markerOf(ctx, withB.lane.paneId) === undefined,
    `pane ${withB.lane.paneId} unexpectedly carries fixture ${markerOf(ctx, withB.lane.paneId) ?? ''}`,
  )
  await waitFor('project B to land in its welcome screen', async () => {
    const hero = await read(ctx, probes.welcome())
    return hero !== null && hero.project.includes('projB') ? hero : undefined
  })

  // The sidebar lists every *added* project — the registry — not just open
  // ones, so the machine's own registered projects ride along; every count
  // below filters to the roots this run created.
  const listed = await app.shell(ctx.app, { type: 'list-sessions' })
  const listedRoots = listed.projects.map((project) => project.projectRoot)
  ctx.ok(
    'both projects report their history',
    listedRoots.includes(rootA) && listedRoots.includes(rootB),
    JSON.stringify(listedRoots),
  )
  const view = await waitFor('the sidebar to show both project groups', async () => {
    const now = await read(ctx, probes.sidebar())
    const roots = now.groups.map((group) => group.root)
    return roots.includes(rootA) && roots.includes(rootB) ? now : undefined
  })
  ctx.ok(
    'each group is labelled once there is more than one project',
    view.groups
      .filter((group) => group.root === rootA || group.root === rootB)
      .every((group) => group.label.length > 0),
    JSON.stringify(view.groups.map((group) => group.label)),
  )
  await ctx.shot('05a-two-projects', 'two labelled project groups: does this read as two projects rather than one long list')

  // B's single lane is its fresh draft — invisible in the sidebar (empty) and
  // active from the open — so the real chord is the way to close it.
  await key(ctx.cdp, 'Ctrl+w')
  await waitFor('every project B lane to close', async () => {
    const now = await lanes(ctx)
    return now.every((info) => info.projectRoot !== rootB)
  })
  // `list-sessions` walks the registry, so B staying listed is the new point,
  // not a leak: a closed project's history is exactly what the sidebar keeps.
  // The runtime shutdown shows up one paragraph below, as the fresh bootstrap.
  const afterClose = await app.shell(ctx.app, { type: 'list-sessions' })
  ctx.ok(
    "closing B's last lane keeps its history listed",
    afterClose.projects.some((project) => project.projectRoot === rootB),
    JSON.stringify(afterClose.projects.map((project) => project.projectRoot)),
  )

  const highest = Math.max(...ctx.state.lanesSeen)
  await app.shell(ctx.app, { type: 'open-project', path: ctx.projectB.root })
  const reopened = await waitFor('project B to come back', async () => {
    const topology = await lanes(ctx)
    return topology.find((info) => info.projectRoot === rootB)
  })
  ctx.ok(
    'reopening the same path bootstraps it again — a fresh lane, not a revived one',
    Number(reopened.lane) > highest,
    `${reopened.lane} > ${highest}`,
  )

  // Leave the run with one project, so the settings step is not competing with
  // B's lanes for the four resident slots.
  for (const info of (await lanes(ctx)).filter((entry) => entry.projectRoot === rootB)) {
    await app.post(ctx.app, info.lane, { type: 'close-pane', paneId: info.paneId })
  }
  await waitFor('project B to close again', async () => {
    const now = await lanes(ctx)
    return now.every((info) => info.projectRoot !== rootB)
  })
}

// --- S8: settings ---------------------------------------------------------------

/** `WINDOW_CHROME.*.height` in `src/desktop/main.ts`, and `#titlebar` in `styles.css`. */
const TITLE_BAR_HEIGHT = 40

async function step8(ctx) {
  const rootA = ctx.state.projectRootA ?? (await lanes(ctx))[0].projectRoot
  // Two lanes of project A, so the fan-out has more than one runtime to rebuild.
  for (const session of ctx.sessionsA) {
    if ((await lanes(ctx)).length >= 2) break
    const openIds = new Set((await lanes(ctx)).map((info) => info.paneId))
    if (!openIds.has(session.id) && !ctx.state.deleted.has(session.id)) await openSession(ctx, session, rootA)
  }

  // 8a — the screen, and the one assertable claim about its layout.
  await key(ctx.cdp, 'Ctrl+,')
  const open = await waitFor('the settings screen', async () => {
    const view = await read(ctx, probes.settings())
    return view.open ? view : undefined
  })
  ctx.ok('Ctrl+, opens settings over the canvas', open.canvasOpen === true, `canvasOpen=${open.canvasOpen}`)
  // The screen owns the whole window now: the sidebar it used to leave live is
  // what made「新建会话」open a session behind it.
  ctx.ok(
    'the settings screen covers the sidebar too',
    open.bodyOpen === true && open.sidebarBoxes === 0,
    `bodyOpen=${open.bodyOpen} sidebarBoxes=${open.sidebarBoxes}`,
  )
  // `ALL_CATEGORIES` in `renderer/model/settings.ts`: provider, extensions,
  // permissions, agent, general, personalization, appearance. A number rather
  // than a derivation — the smoke reads the built renderer, and a category
  // silently disappearing from the nav is exactly what this is here to catch.
  ctx.eq('all seven categories are live', open.nav.length, 7)
  ctx.eq('the screen loaded without an error', open.error, '')
  ctx.note(`focus after opening: ${open.focus} (inside the screen: ${open.focusInside})`)

  // 8a2 — the other half of S2's "the scrim covers exactly the canvas":
  // a border here would inset the full-window layers by 1px on every side.
  ctx.eq('the canvas has no border', open.canvasBorder, '0px')

  let longest = { rowCount: -1, label: '' }
  for (const item of open.nav) {
    await read(ctx, probes.clickSettingsNav(item.label))
    const page = await waitFor(`the ${item.label} page`, async () => {
      const view = await read(ctx, probes.settings())
      return view.nav.find((entry) => entry.label === item.label)?.selected ? view : undefined
    })
    ctx.ok(`the ${item.label} page draws cards or its editor`, page.cards.length > 0 || page.editor, page.cards.join(' | '))
    if (page.rowCount > longest.rowCount) longest = { ...page, label: item.label }
    await ctx.shot(`08a-settings-${item.label}`, `the ${item.label} category: column layout, row density, control alignment`)

    // The 外观 page is the one that showed todo D3: its theme card is a single
    // row, so the dropdown opens entirely outside the card and used to be clipped
    // away by it. Done here, at the default viewport — the squeeze below would
    // change what fits on screen.
    if (item.label === '外观') {
      await read(ctx, probes.clickSettingsPill())
      const menu = await waitFor('the theme dropdown', async () => {
        const view = await read(ctx, probes.settingsMenu())
        return view.open ? view : undefined
      })
      ctx.ok('the theme dropdown really hangs out of its card', menu.menuBottom > menu.cardBottom, `menu ${menu.menuBottom} > card ${menu.cardBottom}`)
      ctx.ok('the dropdown is on screen to be hit-tested', menu.inViewport === true, `body bottom ${menu.bodyBottom}`)
      // Hit testing, not geometry: a clipped node still reports its full rect.
      ctx.ok('the last option is really painted, not clipped away', menu.lastItemHit === true, `elementFromPoint hit ${menu.hitClass}`)
      await ctx.shot('08a-settings-menu-open', 'the theme dropdown open over the card below it: three options, a float shadow, nothing cut off')
      // Closed through the trigger rather than Escape, which this screen also
      // reads as "leave settings" when no menu is open.
      await read(ctx, probes.clickSettingsPill())
      await waitFor('the theme dropdown to close', async () => {
        const view = await read(ctx, probes.settingsMenu())
        return view.open ? undefined : view
      })
    }
  }
  ctx.note(`longest page: ${longest.label}, ${longest.rowCount} rows, ${longest.toggles} toggles`)

  // 8a3 — todo V7, the reading column, which only a wide window can show: at the
  // default 1200 the body's content box may already be narrower than 760, so the
  // clamp never engages and any `max-width` would pass. Widen, then assert the
  // measure exactly (not `<= 760`) and that the scroller kept its own full width.
  const columnAt = async (label) => {
    const view = await read(ctx, probes.settings())
    const available = view.bodyContent ? view.bodyContent.right - view.bodyContent.left : 0
    const gaps = view.column && view.bodyContent
      ? [view.column.left - view.bodyContent.left, view.bodyContent.right - view.column.right]
      : []
    ctx.eq(`the settings body reads in an 760px column at ${label}`, view.column?.width, Math.min(760, available))
    // 2px, not 1: both edges of both boxes are `Math.round`ed by the probe, and
    // on a scaled display (a 200%-DPI screen is a normal Windows laptop) the
    // layout points land on fractional CSS pixels, so each edge can round a
    // pixel its own way. Two pixels on a column this wide is still centred;
    // what the check must catch is a column stuck to one side.
    ctx.ok(
      `the column is centred inside the full-width scroller at ${label}`,
      gaps.length === 2 && Math.abs(gaps[0] - gaps[1]) <= 2,
      `gaps ${gaps.join(' / ')} inside ${available}px`,
    )
  }
  await setViewport(ctx.cdp, 1600, 900)
  await sleep(300)
  await columnAt('1600x900')
  await ctx.shot('08a-settings-wide', 'the settings body at 1600x900: the cards stay in an 760px column, the scroller keeps the panel width')
  await clearViewport(ctx.cdp)
  await sleep(300)

  // The layout claim, as numbers. A short viewport forces the overflow on any
  // monitor; `min-height: 0` is what should keep it inside the panel. Since the
  // window went frameless (`titleBarStyle: 'hidden'`), `body` is `#titlebar` plus
  // `#shell`, so `#shell` is *meant* to be one title bar shorter than the viewport
  // — that is not the defect it reads like.
  await read(ctx, probes.clickSettingsNav(longest.label))
  await setViewport(ctx.cdp, 1000, 520)
  await sleep(300)
  const squeezed = await read(ctx, probes.settings())
  ctx.ok('the long form overflows at a short viewport', squeezed.scrollHeight > squeezed.clientHeight, `${squeezed.scrollHeight} > ${squeezed.clientHeight}`)
  ctx.eq('the document never grows past the window', squeezed.docScroll, squeezed.viewport)
  ctx.eq('the title bar is the documented height', squeezed.titleBarHeight, TITLE_BAR_HEIGHT)
  ctx.eq('the shell fills the window below the title bar', squeezed.shellHeight, squeezed.viewport - TITLE_BAR_HEIGHT)
  ctx.ok('the composer is hidden rather than pushed out', squeezed.composerHidden === true, `composerHidden=${squeezed.composerHidden}`)
  // The narrow end of the same claim: the column gives way instead of overflowing.
  await columnAt('1000x520')
  await ctx.shot('08a-settings-squeezed', 'the longest form at 1000x520: it must scroll inside its own panel, nothing clipped off-window')
  await clearViewport(ctx.cdp)

  // 8b — provider edits and the cross-lane fan-out.
  const laneCount = (await lanes(ctx)).length
  const endpoint = await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'provider', kind: 'set-endpoint', name: 'smoke-endpoint', provider: 'anthropic', baseUrl: 'https://smoke.invalid' },
  })
  ctx.ok(
    'a new endpoint is stored',
    endpoint.settings.endpoints.some((entry) => entry.name === 'smoke-endpoint'),
    endpoint.settings.endpoints.map((entry) => entry.name).join(','),
  )
  const model = await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'provider', kind: 'set-model', key: 'smoke-model', model: 'smoke-model-id', endpoint: 'smoke-endpoint' },
  })
  const modelRow = model.settings.models.find((entry) => entry.key === 'smoke-model')
  ctx.ok('a new model is stored, and says whether it resolves', modelRow !== undefined, JSON.stringify(modelRow))

  const since = (await app.events(ctx.app, 0)).seq
  const routing = await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'provider', kind: 'set-routing', role: 'main', value: ctx.opts.model },
  })
  ctx.eq('routing.main is what the screen reports back', routing.settings.routing.main, ctx.opts.model)
  ctx.ok('every open lane of the project rebuilt its runtime', routing.rebuiltLanes >= laneCount, `${routing.rebuiltLanes} of ${laneCount} lanes`)
  const { entries } = await app.events(ctx.app, since)
  const refreshed = new Set(entries.filter((entry) => entry.type === 'runtime-snapshot').map((entry) => entry.lane))
  ctx.ok(
    'the fan-out reached more than one live session',
    refreshed.size >= Math.min(2, laneCount),
    `runtime snapshots on lanes ${[...refreshed].join(',') || 'none'}`,
  )
  // The global-only config lives in the Electron child's disposable home.
  const config = readGlobalConfig(ctx.home)
  ctx.ok(
    'the edits reached the config on disk, not just the reply',
    config.endpoints['smoke-endpoint'] !== undefined && config.routing.main === ctx.opts.model,
    JSON.stringify(config.routing),
  )

  // 8c — permission rules, and the startup mode's honest scope.
  const allow = await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'permissions', kind: 'set-permission-entries', behavior: 'allow', entries: ['Read'] },
  })
  const allowGroup = allow.settings.permissions.groups.find((group) => group.behavior === 'allow')
  ctx.eq('the new rule is reported as local', allowGroup?.local ?? [], ['Read'])
  ctx.eq('nothing inherited was copied into the local group', allowGroup?.inherited ?? [], [])
  ctx.eq(
    'the local file holds only the local rules',
    readLocalSettings(ctx.projectA).permissions,
    { ask: ['Write'], allow: ['Read'] },
  )
  await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'permissions', kind: 'set-permission-entries', behavior: 'allow', entries: [] },
  })
  const afterRemoval = readLocalSettings(ctx.projectA).permissions
  ctx.eq('removing the rule leaves the group empty', afterRemoval.allow ?? [], [])
  ctx.eq('and leaves the other group alone', afterRemoval.ask, ['Write'])

  await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'permissions', kind: 'set-startup-permission-mode', mode: 'auto' },
  })
  ctx.eq('the startup mode is written locally', readLocalSettings(ctx.projectA).permissions.mode, 'auto')
  const statusNow = await read(ctx, probes.status())
  // Not a bug: `permissions.mode` is read once when a scope is built
  // (`sessionScope.ts:74`), so the row promises the next new session, not this
  // one. S8R checks the other half after the restart.
  // Read off the composer's permission pill since 5e — the status bar no longer
  // carries the mode, and 请求批准 is what `default` is called there.
  ctx.ok('the startup mode does not retroactively change an open session', statusNow.mode.includes('请求批准'), statusNow.mode)

  // 8d — a reconnect must not open a native window. The reply arriving at all is
  // the assertion: `showMessageBoxSync` would have frozen the main process.
  await app.shell(ctx.app, { type: 'settings-change', projectRoot: rootA, change: { scope: 'extensions', kind: 'reconnect-mcp' } }, { timeout: 8000 })
  ctx.ok('reconnecting MCP answers, so no native dialog was opened', true, 'reply received within budget')

  // 8e — the one setting that genuinely needs a rebuild.
  const cache = await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: { scope: 'general', kind: 'set-cache-ttl', enabled: true },
  })
  ctx.ok('the cache TTL toggle rebuilds the runtimes that captured it', cache.rebuiltLanes >= 1, `${cache.rebuiltLanes} lanes`)
  ctx.eq('and is written locally', readLocalSettings(ctx.projectA).cache, { ttl1h: true })
  await ctx.shot('08e-settings-after-edits', 'the provider page after the edits: the new endpoint and model rows, and how the toggles look')

  await key(ctx.cdp, 'Escape')
  const closed = await waitFor('settings to close', async () => {
    const view = await read(ctx, probes.settings())
    return view.open === false ? view : undefined
  })
  ctx.ok('Escape returns to the conversation', closed.composerHidden === false, `composerHidden=${closed.composerHidden}`)
}

// --- S9: the effort chip --------------------------------------------------------

async function step9(ctx) {
  const globalSettings = join(ctx.home, '.myagent', 'settings.json')
  const before = existsSync(globalSettings) ? statSync(globalSettings).mtimeMs : undefined
  const chipBefore = await read(ctx, probes.chip())
  ctx.ok(
    'the chip shows a model and an effort level',
    chipBefore.model.length > 0 && chipBefore.effort.length > 0,
    JSON.stringify(chipBefore),
  )
  ctx.ok(
    'the context indicator is beside the chip, not inside it',
    chipBefore.context.present && chipBefore.context.insideRuntimeChip === false,
    JSON.stringify(chipBefore.context),
  )

  // Read while the popover is shut, so the transcript's height has a before.
  const shut = await read(ctx, probes.chipMenu())

  await read(ctx, probes.clickChip())
  const menu = await waitFor('the chip popover', async () => {
    const view = await read(ctx, probes.chipMenu())
    return view.open ? view : undefined
  })
  ctx.eq('the chip opens one popover for both fields', menu.rows.map((row) => row.label), ['模型', '推理强度'])
  ctx.eq('each row names the value in force', menu.rows[1].value, chipBefore.effort)
  // Geometry is read on the settled frame: rise-in's translate is still live
  // on the frame the waitFor returns on, and the judgement below is about
  // where the popover lives, not where its entrance is taking it. The popover
  // hangs off the chip — `bottom: 30px` above the chip shell — so it clears
  // its trigger and may legitimately cover the composer's input row above it;
  // that is the construction the design prototype draws.
  await settleAnimations(ctx)
  const settled = await read(ctx, probes.chipMenu())
  ctx.ok(
    'it hangs off the chip rather than spanning the reading column',
    settled.rect.bottom <= settled.chipTop && settled.rect.right - settled.rect.left < 400,
    `panel=${settled.rect.left}..${settled.rect.right} bottom=${settled.rect.bottom} chip top=${settled.chipTop}`,
  )
  // A float, not a flex sibling: opening it must not resize the conversation.
  ctx.eq('and floats over the transcript instead of squeezing it', settled.transcriptHeight, shut.transcriptHeight)

  await read(ctx, probes.hoverChipRow('推理强度'))
  const flown = await waitFor('the effort flyout', async () => {
    const view = await read(ctx, probes.chipMenu())
    return view.flyout ? view : undefined
  })
  ctx.eq('hovering a row offers its levels', flown.flyout.title, '选择思考强度')
  ctx.eq(
    'every effort level is offered',
    flown.flyout.items.map((item) => item.label),
    ['低', '中', '高', '极高', '最高'],
  )
  // Same settled-frame rule as the popover above: slide-in's translateX is
  // what a read on the first frame would measure — not the flyout's place.
  await settleAnimations(ctx)
  const flownSettled = await read(ctx, probes.chipMenu())
  ctx.ok(
    'and the flyout opens beside the popover, not over it',
    flownSettled.flyout.right <= flownSettled.rect.left,
    `flyout right=${flownSettled.flyout.right} popover left=${flownSettled.rect.left}`,
  )
  await ctx.shot('09a-effort-flyout', 'the chip popover with the effort flyout open: the level in force ticked, any over-ceiling level explaining itself')

  const since = (await app.events(ctx.app, 0)).seq
  await read(ctx, probes.clickChipFlyoutItem('低'))
  const chipAfter = await waitFor('the chip to show the new level', async () => {
    const view = await read(ctx, probes.chip())
    return view.effort === '低' ? view : undefined
  })
  ctx.eq('the chip reflects the new level', chipAfter.effort, '低')
  const { entries } = await app.events(ctx.app, since)
  ctx.ok(
    'the runtime was told about it, so the next turn uses it',
    entries.some((entry) => entry.type === 'runtime-snapshot' && entry.effort === 'low'),
    entries.filter((entry) => entry.type === 'runtime-snapshot').map((entry) => `${entry.lane}:${entry.effort}`).join(',') || 'none',
  )
  const menuAfter = await read(ctx, probes.chipMenu())
  ctx.ok('the popover closes', menuAfter.open === false, `open=${menuAfter.open}`)
  await ctx.shot('09b-chip-low', 'the runtime group, shut: does the context indicator read independently beside the model · effort chip')

  // The chip is a second *route* to the choice, not a replacement for the slash
  // command: `/effort` still opens its own `#surface` card, and both end in the
  // same `/effort <level>`.
  await read(ctx, probes.submitLine('/effort'))
  const card = await waitFor('the effort picker', async () => {
    const view = await read(ctx, probes.surface())
    return view.open ? view : undefined
  })
  ctx.eq('/effort still opens the picker card', card.title, '选择思考强度')
  ctx.eq('with the same five levels', card.rows.map((row) => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  await read(ctx, probes.clickSurfaceRow('high'))
  const restored = await waitFor('the chip to follow the card', async () => {
    const view = await read(ctx, probes.chip())
    return view.effort === '高' ? view : undefined
  })
  ctx.eq('and the chip follows it', restored.effort, '高')
  // The UI path must not persist: `set-effort` with `persist: true` writes the
  // user's *global* settings file (`config/settings.ts:399`), and the chip runs
  // `/effort` instead — which is why a smoke run can drive it at all.
  const after = existsSync(globalSettings) ? statSync(globalSettings).mtimeMs : undefined
  ctx.eq('changing effort from the chip does not touch ~/.myagent/settings.json', after, before)
}

// --- S26: image attachments, end to end -----------------------------------------

/**
 * The S26 image-attachment pass, against real image bytes on the real wire.
 *
 * The model never needs to accept an image for this step to be honest about
 * delivery: a fixture image is *stored* by the host's import command, referenced
 * by the submit that follows it, and turned down by the host's own pre-flight
 * gate — the same code path (S15/S19) that would carry it into a request, minus
 * the provider. What that proves is the whole renderer → wire → store →
 * submission chain; the payload half is covered by S17/S18's tests and the paid
 * turn is a different step's business.
 *
 * Capability comes from a scratch endpoint and model the step itself creates:
 * the harness supplies a disposable home, so the image-capable `smoke-img-model`
 * and S8's `smoke-endpoint` stay in that home's private config. The provider
 * behind it is `anthropic` but nothing is ever sent to it — every submit below
 * is either gated or aimed at a *second*, non-capable model.
 *
 * Ordering: after S9 (the composer is proven), before S11 (it leaves the run in
 * the dark theme the screenshots prefer).
 */
async function step26(ctx) {
  const rootA = ctx.state.projectRootA ?? (await lanes(ctx))[0].projectRoot

  // A fixture session as the working pane, so every switch this step makes has
  // a sidebar row to click back through. With `--only=S26` the startup draft is
  // an empty session that no row represents, and the isolation half needs to
  // leave and come back.
  const initialOpen = new Set((await lanes(ctx)).map((info) => info.paneId))
  const working = ctx.sessionsA.find(
    (entry) => !ctx.state.deleted.has(entry.id) && !initialOpen.has(entry.id),
  )
  let lane = (await lanes(ctx))[0].lane
  // The model the lane started on, for the restore at the end: `opts.model` is
  // a default key this machine's config may not have, and the point of the
  // restore is leaving the pane as it was found, not re-routing it.
  const laneState0 = await app.laneState(ctx.app)
  const modelBefore = laneState0?.runtime?.[lane]?.modelKey
  if (working) {
    const opened = await openSession(ctx, working, rootA)
    lane = opened.lane
  }

  // --- the capability setup ---------------------------------------------------
  // A model that cannot take images — the *default* state of every model until
  // the switch is turned on. The strip's note and the gate's rejection both key
  // off this, and the run restores the config file in teardown whatever happens.
  await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: {
      scope: 'provider', kind: 'set-endpoint',
      name: 'smoke-img-endpoint', provider: 'anthropic', baseUrl: 'https://smoke.invalid',
    },
  })
  await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: {
      scope: 'provider', kind: 'set-model',
      key: 'smoke-img-model', model: 'smoke-img-model-id', endpoint: 'smoke-img-endpoint',
    },
  })
  const withImages = await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: {
      scope: 'provider', kind: 'set-model',
      key: 'smoke-img-model', model: 'smoke-img-model-id', endpoint: 'smoke-img-endpoint',
      supportsImageInput: true,
    },
  })
  const modelRow = withImages.settings.models.find((entry) => entry.key === 'smoke-img-model')
  ctx.ok('an image-capable model is configured', modelRow?.imageCapable === true, JSON.stringify(modelRow))

  // Point the lane at the capable model for the whole step: the strip's note is
  // snapshot-driven, and the *incapable* half is asserted later on the same
  // lane re-routed to a second scratch model, so the developer's own routing is
  // never what a submit is aimed at.
  await read(ctx, probes.submitLine('/model smoke-img-model'))
  await waitFor('the lane to report the capable model', async () => {
    const state = await app.laneState(ctx.app)
    const info = state?.runtime?.[lane]
    return info?.supportsImageInput === true ? info : undefined
  }, { timeout: 20000 })

  // --- import: paste, then drop (work items 1 and 2) ----------------------------
  const fixtures = fixtureImages()
  // One real clipboard-shaped paste: a ClipboardEvent carrying a File, through
  // the composer's own paste listener. The bytes are the committed transparent
  // PNG — the S04 ladder has already decided what the store does with it; here
  // the question is only whether it arrives and settles into a ready row.
  await read(ctx, probes.pasteImageFile(fixtures.png.name, fixtures.png.base64, 'image/png'))
  const pasted = await waitFor('the pasted image to become a ready row', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 1 && view.rows[0].state === 'ready' ? view : undefined
  })
  ctx.eq('the paste became one ready row', pasted.rows[0].state, 'ready')
  ctx.ok(
    'the row names the file and its send-size facts',
    pasted.rows[0].label.includes(fixtures.png.name) && pasted.rows[0].label.includes('64×64'),
    pasted.rows[0].label,
  )
  ctx.ok('the strip is a labelled list', pasted.role === 'list' && pasted.ariaLabel.length > 0, `${pasted.role} ${pasted.ariaLabel}`)

  // A drop at the composer capsule: the DragEvent path `app.ts` wires, aimed at
  // the same form element a real file drop lands on.
  await read(ctx, probes.dropImageFile(fixtures.exif.name, fixtures.exif.base64, 'image/jpeg'))
  const dropped = await waitFor('the dropped image to settle next to the first', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 2 && view.rows.every((row) => row.state === 'ready') ? view : undefined
  })
  // EXIF orientation 6 on a 64x48 file reads as 48x64 after the pipeline
  // applies the rotation — the number the strip reports is the *sent* shape.
  ctx.ok(
    'the EXIF file reports its oriented shape',
    dropped.rows[1].label.includes('48×64'),
    dropped.rows[1].label,
  )
  // Import order is arrival order, which the strip's numbering states.
  ctx.ok(
    'rows are numbered in arrival order',
    dropped.rows[0].label.startsWith('图片 1：') && dropped.rows[1].label.startsWith('图片 2：'),
    `${dropped.rows[0].label} / ${dropped.rows[1].label}`,
  )
  await ctx.shot('26a-two-attachments', 'the tile grid with two ready images: square rounded thumbnails, no drawn names, the ✕ appearing only on hover')

  // A multi-frame GIF keeps its first frame and says so in the row (S04/S05).
  await read(ctx, probes.pasteImageFile(fixtures.gif.name, fixtures.gif.base64, 'image/gif'))
  const animated = await waitFor('the animated GIF to settle with its first frame', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 3 && view.rows[2].state === 'ready' ? view : undefined
  })
  ctx.ok('an animated import is labelled with its first frame', animated.rows[2].label.includes('动画首帧'), animated.rows[2].label)

  // A corrupt file is a *failed row with a retry*, not a broken composer: the
  // strip is the only place the failure lands, and one failure must not take
  // the three successes with it.
  await read(ctx, probes.pasteImageFile(fixtures.corrupt.name, fixtures.corrupt.base64, 'image/png'))
  const withFailed = await waitFor('the corrupt paste to land as a failed row', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 4 && view.rows[3].state === 'failed' ? view : undefined
  })
  ctx.ok('a failed row offers 重试', withFailed.rows[3].hasRetry === true, JSON.stringify(withFailed.rows[3]))
  ctx.ok(
    'one failure did not touch the successful rows',
    withFailed.rows.slice(0, 3).every((row) => row.state === 'ready'),
    withFailed.rows.map((row) => row.state).join(','),
  )
  ctx.ok(
    'the send gate explains itself while a failed row is present',
    withFailed.sendNote.length > 0,
    withFailed.sendNote,
  )

  // --- remove: the ✕ path (work item 2) ----------------------------------------
  // Remove the failed row first: its ✕ must not ask the host anything (a failed
  // draft owns no store id), and the successes stay.
  await read(ctx, probes.clickAttachmentRemove(3))
  const afterFailedRemove = await waitFor('the failed row to leave', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 3 ? view : undefined
  })
  ctx.ok('removing the failed row kept the three successes', afterFailedRemove.rows.every((row) => row.state === 'ready'))

  // Then a ready row: its ✕ also releases the host-side hold.
  await read(ctx, probes.clickAttachmentRemove(2))
  const afterRemove = await waitFor('the removed ready row to leave', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 2 ? view : undefined
  })
  ctx.ok('the strip renumbers after a removal', afterRemove.rows[1].label.startsWith('图片 2：'), afterRemove.rows[1].label)

  // --- thumbnails: on demand, and not re-requested (work item 2, S12) -----------
  // Thumbnails arrive after the row paints — one ask per id. The probe's
  // thumbLoaded is the arrival; what follows plants a marker on the node and
  // forces the snapshot-driven repaint the gate would do anyway, then checks
  // the *same node* is still there: a rebuilt row would drop the marker.
  const loaded = await waitFor('the thumbnails to arrive', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 2 && view.rows.every((row) => row.thumbLoaded) ? view : undefined
  }, { timeout: 20000 })
  ctx.ok('every ready tile paints its thumbnail data URL', loaded.rows.every((row) => row.thumbLoaded))
  // The button's tooltip is its label when nothing blocks the send — a plain
  // 发送, not a note. A *note* here would mean the strip still thinks the model
  // cannot take the images.
  ctx.eq('no send gate note remains for the capable model', loaded.sendNote, '发送')
  await read(ctx, probes.markAttachmentThumb())
  // A snapshot repaint is what a streaming turn drives once per chunk; the
  // runtime snapshot path is the free way to trigger the strip's own gate
  // repaint (paneSession.ts calls it whenever the snapshot moves).
  await app.shell(ctx.app, { type: 'list-sessions' })
  await sleep(600)
  const markerHeld = await read(ctx, probes.attachmentStrip())
  ctx.ok('a snapshot repaint did not rebuild the grid tiles', markerHeld.markedThumbs === 1, `marked=${markerHeld.markedThumbs}`)

  // --- the fullscreen viewer (work item 2) -------------------------------------
  // A tile's click opens the window's viewer, which asks the host for a
  // screen-sized copy of its own. Both tiers end up as a data URL, so what the
  // probe watches is the settle: the picture is there on the click's own frame
  // (the thumbnail), and it stays there once the larger copy lands.
  await read(ctx, probes.clickAttachmentThumb())
  const viewer = await waitFor('the image viewer to open', async () => {
    const view = await read(ctx, probes.imageViewer())
    return view.open && view.srcIsDataUrl ? view : undefined
  }, { timeout: 20000 })
  ctx.ok('the viewer is a labelled dialog', viewer.role === 'dialog', viewer.role ?? '')
  ctx.ok('the viewer paints a data URL', viewer.srcIsDataUrl === true)
  ctx.ok(
    'the viewer names the file and its dimensions',
    viewer.caption.includes(fixtures.png.name) && viewer.caption.includes('64×64'),
    viewer.caption,
  )
  ctx.ok('the viewer offers − / % / + and a close', viewer.zoomSteps === 2 && viewer.hasClose === true, `steps=${viewer.zoomSteps}`)
  // A 64×64 original is smaller than the stage, so it opens at 100% and cannot
  // zoom out past the ladder's floor — but + must still be live.
  ctx.eq('a small image opens at its own size', viewer.zoom, '100%')
  // The shot is the one judgement no assertion makes, so it waits for the
  // entry transition *and* the screen-sized copy: a frame grabbed on the click
  // catches a transparent scrim over a half-faded picture, which is a picture
  // of the animation rather than of the viewer.
  await waitFor('the viewer to finish opening', async () => {
    const view = await read(ctx, probes.imageViewer())
    return view.open && view.settled ? view : undefined
  })
  await ctx.shot('26b-image-viewer', 'the fullscreen viewer: the picture over a full-window scrim, the zoom capsule below it, the ✕ at the corner')

  await read(ctx, probes.clickImageViewerZoom(1))
  const zoomed = await waitFor('the zoom to step up', async () => {
    const view = await read(ctx, probes.imageViewer())
    return view.open && view.zoom !== '100%' ? view : undefined
  })
  ctx.ok('+ walks the zoom ladder', zoomed.zoom === '150%', zoomed.zoom)

  // Closed three ways, but the driver proves the cheapest one here: the
  // viewer's own ✕. Escape and the scrim press are the DOM tests' assertions.
  await read(ctx, probes.clickImageViewerClose())
  await waitFor('the viewer to close', async () => {
    const view = await read(ctx, probes.imageViewer())
    return view.open === false ? view : undefined
  })
  ctx.ok('the viewer closes through its own button', true, 'closed via ✕')

  // --- submission: capable model, text plus images (work item 2) ---------------
  // The composer's real send path assembles the imageIds itself from the strip
  // (paneSession.send), so driving it is one `submitLine` with the drafts in
  // place. The gate at the capable model accepts the input and the turn starts;
  // the scratch endpoint has no credentials, so the provider fails fast and the
  // turn ends on its own — no interrupt, because an interrupt that lands before
  // the user record is written *rolls the turn back*: the message and its
  // images return to the composer, and the transcript half below would race
  // which of the two won.
  const since = (await app.events(ctx.app, 0)).seq
  await read(ctx, probes.submitLine('describe these images'))
  // The turn-start event carries the images: the host resolved the ids, ran the
  // pre-flight gate, and emitted the record the transcript will paint.
  let turnCarriedImages = false
  try {
    await waitFor('the turn to start with the images', async () => {
      const { entries } = await app.events(ctx.app, since)
      return entries.some(
        (entry) => entry.type === 'turn' && entry.turn === 'turn-start' && entry.lane === lane && entry.images?.length > 0,
      )
    }, { timeout: 30000 })
    turnCarriedImages = true
  } catch {
    turnCarriedImages = false
  }
  // The turn ends by itself (credential-less endpoint): the record is on disk,
  // the message is not coming back, and nothing needs interrupting.
  await waitFor('the turn to end on its own', async () => {
    const { entries } = await app.events(ctx.app, since)
    return entries.some((entry) => entry.type === 'turn' && entry.turn === 'turn-end' && entry.lane === lane)
  }, { timeout: 30000 }).catch(() => app.post(ctx.app, lane, { type: 'interrupt', reason: 'user-cancel' }))
  ctx.ok(
    'the capable model accepted an image-bearing submit',
    turnCarriedImages,
    turnCarriedImages
      ? 'turn-start observed with images; the turn ended at the credential-less endpoint'
      : 'no turn-start carrying images; the gate or the command path refused the submit',
  )

  // The sent message paints its thumbnail in the transcript. The pixels come
  // from the same cache the composer's tiles drew from — the submit moved the
  // image from the draft list to a message, not from one cache to another — so
  // the tile is loaded without a second round trip.
  const tiles = await waitFor('the transcript image thumbnail to appear', async () => {
    const view = await read(ctx, probes.transcriptImageTiles())
    return view.some((tile) => tile.text.includes(fixtures.png.name) && tile.loaded) ? view : undefined
  }, { timeout: 15000 })
  ctx.ok(
    'a sent image paints a clickable thumbnail whose alt carries the facts',
    tiles.some((tile) => tile.text.includes('图片 1：') && tile.text.includes('64×64') && tile.labelled && tile.loaded),
    tiles.map((tile) => tile.text).join(' | '),
  )

  // And it opens the same viewer the composer's tiles do.
  await read(ctx, probes.clickTranscriptImageTile(0))
  const sentViewer = await waitFor('the viewer to open from the transcript', async () => {
    const view = await read(ctx, probes.imageViewer())
    return view.open && view.srcIsDataUrl ? view : undefined
  }, { timeout: 20000 })
  ctx.ok('a sent image opens the fullscreen viewer', sentViewer.caption.includes(fixtures.png.name), sentViewer.caption)
  await read(ctx, probes.clickImageViewerClose())
  await waitFor('the viewer to close again', async () => {
    const view = await read(ctx, probes.imageViewer())
    return view.open === false ? view : undefined
  })

  // --- submission: incapable model, nothing sent (work item 2, S15/S19) --------
  // A second scratch model, same endpoint, switch off: the only difference from
  // `smoke-img-model` is the capability. The capable-model submit above took
  // the strip's images with it (they belong to that sent message now), so a
  // fresh paste puts real ids in front of the gate for this half.
  await app.shell(ctx.app, {
    type: 'settings-change',
    projectRoot: rootA,
    change: {
      scope: 'provider', kind: 'set-model',
      key: 'smoke-img-none', model: 'smoke-img-none-id', endpoint: 'smoke-img-endpoint',
    },
  })
  await read(ctx, probes.submitLine('/model smoke-img-none'))
  await waitFor('the lane to report the incapable model', async () => {
    const state = await app.laneState(ctx.app)
    const info = state?.runtime?.[lane]
    return info && info.supportsImageInput !== true ? info : undefined
  }, { timeout: 20000 })
  await read(ctx, probes.pasteImageFile(fixtures.png.name, fixtures.png.base64, 'image/png'))
  await waitFor('the fresh image to settle against the incapable model', async () => {
    const view = await read(ctx, probes.attachmentStrip())
    return view.rows.length === 1 && view.rows[0].state === 'ready' ? view : undefined
  })
  // One frame's grace: the strip's send-gate note follows the runtime snapshot
  // through a rAF-scheduled repaint (frame.ts), so a submit dispatched on the
  // frame the snapshot arrived can still read the *old* gate. The wait above
  // saw the wire frame; this waits for the paint that consumed it.
  await sleep(400)
  // The current high-water mark, not 0: the tap's ring buffer still holds this
  // step's own capable-model turn-start, and reading "everything since the
  // beginning" would count that as the refusal having failed.
  const gateSince = (await app.events(ctx.app, 0)).seq
  await read(ctx, probes.submitLine('should not send'))
  // The gate at the incapable model refuses the submit before any turn starts,
  // and nothing is recorded. The strip's note explains the refusal at the same
  // time — both halves of "the user is told, not left guessing".
  let blocked = false
  let blockedMessage = ''
  let gateEvents = { entries: [] }
  for (let attempt = 0; attempt < 3 && !blocked; attempt += 1) {
    gateEvents = await app.events(ctx.app, gateSince)
    blocked = gateEvents.entries.some(
      (entry) => entry.type === 'turn' && entry.turn === 'turn-start' && entry.lane === lane,
    )
    if (blocked) break
    await sleep(500)
  }
  if (blocked) {
    await app.post(ctx.app, lane, { type: 'interrupt', reason: 'user-cancel' })
    blockedMessage = 'turn-start appeared — the gate did not refuse the images'
    ctx.note(`events since the incapable submit: ${JSON.stringify(gateEvents.entries.map((e) => ({ t: e.type, turn: e.turn, images: e.images?.length, text: (e.text || '').slice(0, 40) })))}`)
  } else {
    blockedMessage = 'no turn-start: the gate refused the submit before anything was recorded'
  }
  ctx.ok('the incapable model refuses a new-image submit outright', !blocked, blockedMessage)
  // And the draft survived: the composer's failure path restored text and
  // attachments both, so the strip still holds its rows.
  const survivors = await read(ctx, probes.attachmentStrip())
  ctx.ok(
    'the refused submit left the draft intact',
    survivors.rows.some((row) => row.label.includes(fixtures.png.name)),
    survivors.rows.map((row) => row.label).join(' | '),
  )
  ctx.ok('the send gate explains the refusal', survivors.sendNote.length > 0, survivors.sendNote)

  // --- pane isolation (work item 2) ---------------------------------------------
  // A second lane, its own drafts, none of the first lane's: the strip is a
  // singleton painted from the *active* pane's state, so switching lanes must
  // show the other pane's list and switching back must restore the first's.
  const openNow = new Set((await lanes(ctx)).map((info) => info.paneId))
  const session = ctx.sessionsA.find(
    (entry) => !ctx.state.deleted.has(entry.id) && !openNow.has(entry.id),
  )
  if (session) {
    await openSession(ctx, session, rootA)
    const otherLane = (await lanes(ctx)).find((info) => info.paneId === session.id)?.lane
    const otherStrip = await read(ctx, probes.attachmentStrip())
    ctx.eq('a fresh pane starts with no draft rows', otherStrip.rows.length, 0)
    // Import on the *other* pane, then switch back: neither list may bleed.
    await read(ctx, probes.pasteImageFile(fixtures.gif.name, fixtures.gif.base64, 'image/gif'))
    const otherReady = await waitFor('the other pane to hold its own draft', async () => {
      const view = await read(ctx, probes.attachmentStrip())
      return view.rows.length === 1 && view.rows[0].state === 'ready' ? view : undefined
    })
    ctx.ok('the other pane imported its own image', otherReady.rows[0].label.includes(fixtures.gif.name), otherReady.rows[0].label)
    // Back to the *first* pane, through its own sidebar row — the switch the
    // isolation rule is about. The singleton strip must repaint from the
    // first pane's drafts, and neither list may bleed into the other.
    if (working) await activate(ctx, working)
    const backStrip = await waitFor('the first pane to restore its drafts', async () => {
      const view = await read(ctx, probes.attachmentStrip())
      return view.rows.some((row) => row.label.includes(fixtures.png.name)) ? view : undefined
    })
    ctx.ok('switching back restored the first pane drafts', backStrip.rows.length > 0, `${backStrip.rows.length} rows`)
    ctx.ok(
      'the panes kept separate draft lists',
      backStrip.rows.some((row) => row.label.includes(fixtures.png.name))
        && !backStrip.rows.some((row) => row.label.includes(fixtures.gif.name)),
      backStrip.rows.map((row) => row.label).join(' | '),
    )
    // Close the helper lane the way a user would, so the step leaves the
    // topology it found.
    if (otherLane !== undefined) {
      await app.post(ctx.app, otherLane, { type: 'close-pane', paneId: session.id })
      await waitFor('the helper lane to close', async () => {
        const now = await lanes(ctx)
        return now.every((info) => info.lane !== otherLane)
      })
    }
  } else {
    ctx.skip('pane isolation', 'no fixture session left to open a second lane on')
  }

  // Restore the lane's model to what it started on: the smoke-img models live
  // only in the disposable config, and the pane must not be left routed at one.
  if (modelBefore !== undefined) {
    await read(ctx, probes.submitLine(`/model ${modelBefore}`))
    await waitFor('the lane to be back on the model it started on', async () => {
      const state = await app.laneState(ctx.app)
      const info = state?.runtime?.[lane]
      return info?.modelKey === modelBefore ? info : undefined
    }, { timeout: 20000 })
  }
}

/**
 * The committed image fixtures as paste payloads. Read once per run, base64
 * here rather than in the probe: the probe string is evaluated in the page, and
 * a megabyte of base64 inside it would make every `evaluate` pay for it.
 */
function fixtureImages() {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..', '..', 'test', 'fixtures', 'images')
  const read = (name) => {
    const bytes = readFileSync(join(root, name))
    return { name, bytes, base64: bytes.toString('base64') }
  }
  return {
    png: read('transparent.png'),
    exif: read('exif-orientation.jpg'),
    gif: read('animated.gif'),
    corrupt: read('corrupt.png'),
  }
}



/** `THEME_LABELS` in `src/desktop/renderer/model/settings.ts`. */
const THEME_LABELS = { system: '跟随系统', dark: '深色', light: '浅色' }

/** `parseThemePreference`: junk, null and unknown all mean "follow the system". */
const themeLabelFor = (stored) => THEME_LABELS[stored] ?? THEME_LABELS.system

/**
 * Relative brightness of a computed `rgb(...)` colour, 0..255.
 *
 * Rec. 601 weights rather than sRGB luminance: the only question asked of it is
 * "is the text darker than the surface it sits on", and for that the cheap
 * version and the correct one never disagree.
 */
function brightness(colour) {
  const channels = rgb(colour)
  if (!channels) return undefined
  return 0.299 * channels[0] + 0.587 * channels[1] + 0.114 * channels[2]
}

/**
 * `#rrggbb` or `rgb(...)` to three numbers.
 *
 * Both spellings are in play and neither is negotiable: a custom property comes
 * back as the literal the sheet declared, while a resolved `background-color`
 * always comes back as `rgb(...)`. Comparing the strings would fail on notation
 * rather than on colour.
 */
function rgb(colour) {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((colour ?? '').trim())
  if (hex) return [1, 2, 3].map((index) => Number.parseInt(hex[index], 16))
  const fn = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(colour ?? '')
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : undefined
}

const sameColour = (a, b) => {
  const left = rgb(a)
  const right = rgb(b)
  return left !== undefined && right !== undefined && left.every((value, index) => value === right[index])
}

/** Opens settings on the 外观 page, whatever the screen was showing. */
async function openAppearance(ctx) {
  const before = await read(ctx, probes.settings())
  if (!before.open) await key(ctx.cdp, 'Ctrl+,')
  await waitFor('the settings screen', async () => {
    const view = await read(ctx, probes.settings())
    return view.open ? view : undefined
  })
  await read(ctx, probes.clickSettingsNav('外观'))
  return waitFor('the 外观 page', async () => {
    const view = await read(ctx, probes.settings())
    return view.nav.find((entry) => entry.label === '外观')?.selected ? view : undefined
  })
}

/** Picks a theme through the pill dropdown, and waits for the paint to follow. */
async function chooseTheme(ctx, label, expected) {
  await read(ctx, probes.clickSettingsPill())
  const menu = await waitFor('the theme dropdown', async () => {
    const view = await read(ctx, probes.settingsMenu())
    return view.open ? view : undefined
  })
  if (!menu.labels.includes(label)) throw new Error(`the theme dropdown does not offer ${label}: ${menu.labels.join(',')}`)
  await read(ctx, probes.clickSettingsMenuItem(label))
  return waitFor(`the window to repaint as ${expected}`, async () => {
    const view = await read(ctx, probes.theme())
    return view.resolved === expected ? view : undefined
  })
}

/**
 * todo V9: the light palette has never been on a screen.
 *
 * The unit tests already pin the light block hard (`rendererStyleTokens.test.ts`
 * parses it and checks the overrides, the ladder and the contrast), so what is
 * missing is not another parse — it is a real window painting it. Three things
 * only a machine can answer: does the whole palette engage rather than half of
 * it, does `--shadow-float` still separate a floating panel from a white page,
 * and does `set-window-theme` reach the main process.
 *
 * **The native three buttons are not in evidence here.** They are painted by
 * Windows into chrome the document does not reach (`main.ts:92`), and
 * `Page.captureScreenshot` renders the page only — the same blind spot as a
 * native modal (`cdp.mjs` rule 4). The wire round trip below is as far as an
 * assertion can go; the pixels are a human's job.
 *
 * **Dark is forced first, deliberately.** The developer's own machine may sit in
 * light already (the preference is `system` by default), and then "every token
 * changed" would pass on nothing at all.
 *
 * The preference lives in `localStorage`, which `--cwd=` does *not* isolate
 * (`main.ts` never sets `userData`), so the restore is a safety requirement of
 * the same kind as the scratch project — hence the `finally`.
 */
async function step11(ctx) {
  const base = await read(ctx, probes.theme())
  ctx.note(`theme before: stored=${JSON.stringify(base.stored)} resolved=${base.resolved}`)

  try {
    await openAppearance(ctx)
    const dark = await chooseTheme(ctx, THEME_LABELS.dark, 'dark')
    const light = await chooseTheme(ctx, THEME_LABELS.light, 'light')

    // Both halves of the switch: the attribute the stylesheet reads, and the
    // preference that outlives the window (`app.ts:684-687` does the two together).
    ctx.eq('picking 浅色 resolves the document to the light theme', light.resolved, 'light')
    ctx.eq('and the preference is persisted', light.stored, 'light')

    // The palette, as three separate judgements — they fail separately.
    const changed = Object.keys(light.tokens).filter((name) => light.tokens[name] !== dark.tokens[name])
    ctx.eq(
      'every themed token took its light value',
      changed.sort(),
      Object.keys(light.tokens).sort(),
    )
    ctx.eq(
      'the theme-independent knob stayed put',
      light.fixed,
      dark.fixed,
    )
    // The tokens changing is not the same as a rule using them: a half-applied
    // palette is exactly what light-mode blindness produces.
    ctx.ok(
      'the canvas paints the light surface token',
      sameColour(light.canvas?.background, light.tokens['--surface-canvas']),
      `${light.canvas?.background} vs ${light.tokens['--surface-canvas']}`,
    )
    const text = brightness(light.body?.color)
    const surface = brightness(light.canvas?.background)
    ctx.ok(
      'and the text is dark on it, not light on light',
      text !== undefined && surface !== undefined && text < surface,
      `text ${light.body?.color} on canvas ${light.canvas?.background}`,
    )

    // The native overlay: the wire, not the pixels. What this pins is the main
    // process — `setTitleBarOverlay` neither threw nor blocked (a blocked main
    // process answers nothing at all). It does not pin the renderer's own
    // fire-and-forget call, which by construction has no reply to observe.
    const repaint = await app.shell(ctx.app, { type: 'set-window-theme', theme: 'light' })
    ctx.ok('the main process repaints its native chrome on request', repaint?.ok === true, JSON.stringify(repaint))

    // The float shadow, in the one place it was added for (D3) and the one place
    // it matters (a white page: on the dark canvas the border does the work).
    await read(ctx, probes.clickSettingsPill())
    const menu = await waitFor('the theme dropdown', async () => {
      const view = await read(ctx, probes.settingsMenu())
      return view.open ? view : undefined
    })
    ctx.ok('the dropdown still floats off the page in light mode', menu.shadow !== 'none' && menu.shadow !== '', menu.shadow)
    ctx.ok(
      'and it is a card, not the page',
      sameColour(menu.background, light.tokens['--surface-card']),
      `${menu.background} vs ${light.tokens['--surface-card']}`,
    )
    await ctx.shot('11b-light-settings-menu', 'the theme dropdown in light mode: does the shadow lift it off the white card under it')
    await read(ctx, probes.clickSettingsPill())
    await waitFor('the theme dropdown to close', async () => {
      const view = await read(ctx, probes.settingsMenu())
      return view.open ? undefined : view
    })

    await key(ctx.cdp, 'Escape')
    await waitFor('settings to close', async () => {
      const view = await read(ctx, probes.settings())
      return view.open === false ? view : undefined
    })
    await ctx.shot('11a-light-window', 'the whole window in light mode: the canvas hairline, the sidebar tiers, the conversation')

    await read(ctx, probes.clickChip())
    const popover = await waitFor('the chip popover', async () => {
      const view = await read(ctx, probes.chipMenu())
      return view.open ? view : undefined
    })
    ctx.ok('a composer popover floats in light mode too', popover.shadow !== 'none' && popover.shadow !== '', popover.shadow)
    await ctx.shot('11c-light-popover', 'the chip popover in light mode: does it read as a layer above the conversation')
    await read(ctx, probes.clickChip())
    await waitFor('the chip popover to close', async () => {
      const view = await read(ctx, probes.chipMenu())
      return view.open ? undefined : view
    })

    // Back to where the developer left it, through the same path a user would.
    await openAppearance(ctx)
    const restored = await chooseTheme(ctx, themeLabelFor(base.stored), base.resolved)
    // Against the *effective* preference, not the raw slot: a machine that never
    // set one reads `null` and means `system`, and clicking 跟随系统 writes the
    // word. The `finally` puts the slot itself back either way.
    ctx.eq('the run gives the theme back as it found it', restored.stored, base.stored ?? 'system')
    await key(ctx.cdp, 'Escape')
    await waitFor('settings to close again', async () => {
      const view = await read(ctx, probes.settings())
      return view.open === false ? view : undefined
    })
  } finally {
    // Not an assertion: this protects the developer's own window even when the
    // step threw halfway through the switch. `localStorage` is shared with the
    // real app — the scratch project never covered it.
    await read(ctx, probes.setStoredTheme(base.stored)).catch(() => {})
  }
}

// --- S1: the one paid turn ------------------------------------------------------

async function step1(ctx) {
  if (ctx.state.paidTurnSpent) throw new Error('the paid-turn latch already fired; this step must run once')
  ctx.state.paidTurnSpent = true

  const view = await read(ctx, probes.sidebar())
  const activeRow = view.rows.find((row) => row.active)
  const target = ctx.sessionsA.find((session) => session.id === activeRow?.sessionId)
  if (!target) throw new Error('no fixture session is active; cannot aim the paid turn')
  const topology = await lanes(ctx)
  const lane = topology.find((info) => info.paneId === target.id)?.lane
  const others = topology.filter((info) => info.lane !== lane)
  if (others.length === 0) throw new Error('need a second lane to switch away to')
  const otherSession = ctx.sessionsA.find((session) => session.id === others[0].paneId)

  console.log(
    `\n    PAID TURN: model ${ctx.opts.model}, one turn on ${target.marker}.` +
      '\n    The cost is the system prompt and tool schemas as much as the reply.\n',
  )
  const since = (await app.events(ctx.app, 0)).seq
  // Not awaited: `submit`'s reply lands only when the whole turn ends.
  const submitId = await app.post(ctx.app, lane, {
    type: 'submit',
    input: ctx.opts.paidPrompt,
    overrides: { modelKey: ctx.opts.model },
  })

  await waitFor(
    'the turn to start',
    async () => {
      const { entries } = await app.events(ctx.app, since)
      // The event is the whole test now: the status strip's 生成中 label used
      // to back it up, and that field is gone — and the readout that replaced
      // it is cumulative, so it is already non-empty from any earlier turn.
      return entries.some((entry) => entry.type === 'turn' && entry.turn === 'turn-start' && entry.lane === lane)
    },
    { timeout: 30000 },
  )
  await waitFor(
    'the first streamed text',
    async () => {
      const pane = await read(ctx, probes.paneByMarker(target.marker))
      return pane.found && pane.len > target.marker.length + 8
    },
    { timeout: 30000 },
  )
  const streaming = await read(ctx, probes.paneByMarker(target.marker))
  ctx.ok('the turn streams into the active pane', streaming.len > 0, `${streaming.len} chars`)

  await activate(ctx, otherSession)
  const away = await read(ctx, probes.sidebar())
  ctx.eq('the pane left behind shows 运行中', rowFor(away, target.id)?.badge, '运行中')
  ctx.ok('the switched-to row is the active one', rowFor(away, otherSession.id)?.active === true)
  await ctx.shot('01a-running-badge', 'the 运行中 badge on the background row while another session is in front')

  const frozen = await read(ctx, probes.paneByMarker(target.marker))
  await sleep(1500)
  const stillFrozen = await read(ctx, probes.paneByMarker(target.marker))
  // A background pane does not repaint at all (`paneSession.ts:224`), so the
  // frozen length *is* the design. What proves the turn kept running is the jump
  // on return, below.
  ctx.eq('a background pane does not repaint while it is away', stillFrozen.len, frozen.len)

  await activate(ctx, target)
  const caughtUp = await waitFor(
    'the pane to catch up with what streamed while away',
    async () => {
      const pane = await read(ctx, probes.paneByMarker(target.marker))
      return pane.len > frozen.len ? pane : undefined
    },
    { timeout: 30000 },
  )
  ctx.ok('coming back replays everything that streamed while away', caughtUp.len > frozen.len, `${frozen.len} → ${caughtUp.len} chars`)
  await ctx.shot('01b-back-and-streaming', 'the transcript after switching back mid-turn: no duplicated blocks, markdown intact')

  // Either still growing, or the turn finished after the switch back. Requiring
  // only the first would flake on a fast model.
  const live = await waitFor(
    'the turn to keep going or to end',
    async () => {
      const pane = await read(ctx, probes.paneByMarker(target.marker))
      if (pane.len > caughtUp.len) return 'still streaming'
      const { entries } = await app.events(ctx.app, since)
      if (entries.some((entry) => entry.type === 'turn' && entry.turn === 'turn-end' && entry.lane === lane)) return 'turn ended'
      return undefined
    },
    { timeout: ctx.opts.paidTurnTimeout },
  ).catch(() => undefined)
  if (live) {
    ctx.ok('the turn was still live after the switch back', true, live)
  } else {
    // Bounds the spend even when the endpoint misbehaves.
    await app.post(ctx.app, lane, { type: 'interrupt', reason: 'user-cancel' })
    ctx.ok('the turn was still live after the switch back', false, 'no progress and no turn-end; interrupted to bound the cost')
  }

  const ended = await waitFor(
    'the turn to end',
    async () => {
      const { entries } = await app.events(ctx.app, since)
      return entries.some((entry) => entry.type === 'turn' && entry.turn === 'turn-end' && entry.lane === lane)
    },
    { timeout: ctx.opts.paidTurnTimeout },
  ).catch(() => false)
  if (!ended) await app.post(ctx.app, lane, { type: 'interrupt', reason: 'user-cancel' })
  ctx.ok('the turn ended on its own', ended === true, ended ? 'turn-end observed' : 'interrupted')
  const status = await read(ctx, probes.status())
  ctx.note(`after the turn: usage "${status.usage}", cost "${status.cost}"`)
  ctx.ok('the submit itself was answered', await app.hasReply(ctx.app, submitId), `reply for ${submitId}`)
  await ctx.shot('01c-turn-end', 'the finished turn: status bar usage and cost, and the reply as rendered markdown')
}

// --- S8R: the settings survive a restart -----------------------------------------

async function step8Restart(ctx) {
  const rootA = (await lanes(ctx))[0].projectRoot
  const settings = await app.shell(ctx.app, { type: 'get-settings', projectRoot: rootA })
  const snapshot = settings.settings
  ctx.ok(
    'the endpoint survived the restart',
    snapshot.endpoints.some((entry) => entry.name === 'smoke-endpoint'),
    snapshot.endpoints.map((entry) => entry.name).join(','),
  )
  ctx.ok('the model survived', snapshot.models.some((entry) => entry.key === 'smoke-model'), snapshot.models.map((entry) => entry.key).join(','))
  ctx.eq('the routing survived', snapshot.routing.main, ctx.opts.model)
  ctx.eq('the startup permission mode survived', snapshot.permissions.mode, 'auto')
  ctx.eq('the local permission group survived', snapshot.permissions.groups.find((group) => group.behavior === 'ask')?.local ?? [], ['Write'])
  ctx.eq('the cache toggle survived', snapshot.general.cacheTtl1h, true)
  // The other half of 8c: the startup mode reaches a session only through a new
  // scope, which is what a restart is.
  // 5e: the mode lives on the composer's pill now, where 必要时询问 is `auto`.
  const status = await waitFor('the permission pill to show the restored mode', async () => {
    const view = await read(ctx, probes.status())
    return view.mode.includes('必要时询问') ? view : undefined
  }).catch(() => read(ctx, probes.status()))
  ctx.ok('the restored startup mode is now the session mode', status.mode.includes('必要时询问'), status.mode)

  const view = await read(ctx, probes.sidebar())
  const deleted = [...ctx.state.deleted]
  ctx.ok('the deleted sessions did not come back', deleted.every((id) => rowFor(view, id) === undefined), `${deleted.length} deleted`)
  // The sidebar lists every added project now, so the row set is wider than
  // this run's fixtures — count only the fixture ids this run created. Project
  // B's fixtures stay listed after S5 registered it, even after its runtime shut
  // down. A focused run that skipped S5 never added B to the private registry.
  const fixtures = [...ctx.sessionsA, ...(ctx.state.projectRootB ? ctx.sessionsB : [])]
  const fixtureIds = new Set(fixtures.map((session) => session.id))
  ctx.eq(
    'the surviving fixtures are still listed',
    view.rows.filter((row) => fixtureIds.has(row.sessionId)).length,
    fixtures.length - deleted.filter((id) => fixtureIds.has(id)).length,
  )
  await ctx.shot('08R-after-restart', 'after the restart: persisted settings and an intact history')
}

/** Native safe areas and host-platform chords, with real pointer hit testing. */
async function step27(ctx) {
  const chrome = () => read(ctx, probes.windowChrome())
  const initial = await waitFor('native title bar geometry', async () => {
    const value = await chrome()
    return value.overlay?.visible && value.overlay.width > 0 ? value : undefined
  })
  const modifier = initial.platform === 'darwin' ? 'Meta' : 'Ctrl'
  ctx.eq('preload exposes the actual host platform', initial.platform, process.platform)
  ctx.eq('the first window paint has its platform style', initial.styledPlatform, initial.platform)
  ctx.eq('the caption strip remains 40 CSS pixels high', initial.bar.height, 40)
  ctx.eq('the blank caption strip is draggable', initial.bar.region, 'drag')

  const assertSafe = (label, view) => {
    const area = view.overlay
    ctx.ok(`${label}: controls stay inside the native usable area`,
      area?.visible && view.controls.every((control) => control.x >= area.x - 1
        && control.x + control.width <= area.x + area.width + 1), JSON.stringify(view))
    ctx.ok(`${label}: caption buttons receive clicks`, view.controls.every((control) => control.region === 'no-drag'))
  }
  assertSafe('expanded/collapsed starting state', initial)

  const clickControl = async (index) => {
    const target = (await chrome()).controls[index]
    await mouseClick(ctx.cdp, target.x + target.width / 2, target.y + target.height / 2)
  }
  try {
    await clickControl(0)
    await waitFor('the rail toggle click', async () => (await chrome()).collapsed !== initial.collapsed)
    await settleAnimations(ctx)
    assertSafe('after the rail toggle', await chrome())
    await key(ctx.cdp, `${modifier}+b`)
    await waitFor('the platform sidebar chord', async () => (await chrome()).collapsed === initial.collapsed)

    await clickControl(1)
    const menu = await waitFor('the title bar file menu', async () => {
      const value = await chrome()
      return value.items.length === 3 ? value : undefined
    })
    ctx.eq('the entire dropdown receives pointer events', menu.menuRegion, 'no-drag')
    ctx.eq('menu hints match the host platform', menu.items.map((item) => item.text),
      initial.platform === 'darwin'
        ? ['新建会话⌘T', '打开项目…⇧⌘O', '设置⌘,']
        : ['新建会话Ctrl+T', '打开项目…Ctrl+Shift+O', '设置Ctrl+,'])
    await key(ctx.cdp, 'Escape')

    const before = await lanes(ctx)
    await key(ctx.cdp, `${modifier}+t`)
    const opened = await waitFor('a new session from the platform chord', async () => {
      const current = await lanes(ctx)
      return current.length === before.length + 1 ? current : undefined
    })
    const added = opened.find((lane) => !before.some((old) => old.lane === lane.lane))
    ctx.state.lanesSeen.add(Number(added.lane))
    await key(ctx.cdp, `${modifier}+w`)
    const remaining = await waitFor('closing the new session without closing the window', async () => {
      const current = await lanes(ctx)
      return current.length === before.length ? current : undefined
    })
    ctx.ok('the close chord removed only the new lane', !remaining.some((lane) => lane.lane === added.lane))
    await app.liveness(ctx.app)
    assertSafe('after opening and closing a session', await chrome())
    await ctx.shot('27-titlebar', 'platform shortcut labels and native exclusion space; native traffic-light pixels require a whole-window capture')
  } finally {
    if (!ctx.app.exited) {
      await key(ctx.cdp, 'Escape')
      if ((await chrome()).collapsed !== initial.collapsed) await key(ctx.cdp, `${modifier}+b`)
    }
  }
}

/**
 * The browser panel is a floating card, and its page is a native view laid over
 * the hole: the hole's rect must sit inside the card's frame (clear of the
 * rounded corners and the border) — at rest and after the panel is dragged wider. (The blank native
 * page does not answer a second CDP client, so its size is not read back; the
 * host sets its bounds to this rect, rounded.)
 */
async function step28(ctx) {
  const geometry = () => read(ctx, `(() => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const panel = document.getElementById('browser-panel')
    const hole = document.getElementById('browser-hole')
    if (!panel || !hole || panel.hidden) return null
    const style = getComputedStyle(panel)
    return { panel: box(panel), hole: box(hole), border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderTopLeftRadius),
      shadow: style.boxShadow, win: { width: innerWidth, height: innerHeight } }
  })()`)
  const button = (mode) => waitFor(`the ${mode} button`, async () => read(ctx, probes.centreOf(`.titlebar-side-button[data-mode="${mode}"]`)))
  const rail = await button('browser')
  await mouseClick(ctx.cdp, rail.x, rail.y)
  const first = await waitFor('the browser panel with a measured hole', async () => {
    const view = await geometry()
    return view && view.hole.width > 50 && view.hole.height > 50 ? view : undefined
  })
  const check = async (label, view) => {
    const { panel, hole, border, radius } = view
    ctx.ok(`${label}: the card floats 8px off the window's right and bottom`,
      Math.abs(view.win.width - panel.right - 8) < 0.5 && Math.abs(view.win.height - panel.bottom - 8) < 0.5,
      JSON.stringify(panel))
    ctx.ok(`${label}: the card has a border, a radius and no left shadow line`, border >= 1 && radius >= 8 && view.shadow === 'none', `border=${border} radius=${radius} shadow=${view.shadow}`)
    ctx.ok(`${label}: the hole is inside the card, clear of border and rounded corners`,
      hole.left >= panel.left + border && hole.right <= panel.right - border && hole.bottom <= panel.bottom - border - 4 && hole.top > panel.top,
      JSON.stringify({ panel, hole }))
  }
  await check('at rest', first)
  await ctx.shot('28-browser-mode', 'the floating card with the browser view in its hole (native view is not in a renderer capture)')
  const sash = await read(ctx, probes.centreOf('#browser-resizer'))
  await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sash.x, y: sash.y, button: 'none', buttons: 0 })
  await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sash.x, y: sash.y, button: 'left', buttons: 1, clickCount: 1 })
  await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sash.x - 80, y: sash.y, button: 'left', buttons: 1 })
  await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sash.x - 80, y: sash.y, button: 'left', buttons: 0, clickCount: 1 })
  const wider = await waitFor('the panel to widen', async () => {
    const view = await geometry()
    return view && view.panel.width > first.panel.width + 40 ? view : undefined
  })
  ctx.ok('dragging the sash widened the card', wider.panel.width > first.panel.width + 40, `${first.panel.width} -> ${wider.panel.width}`)
  await check('after a drag', wider)
  await ctx.shot('28-browser-wider', 'the card after being dragged wider')
  // Each title bar button swaps the page; pressing the one on screen closes the panel.
  const pageShown = (id) => waitFor(`#${id} on screen`, async () => read(ctx, `(() => { const node = document.getElementById(${JSON.stringify(id)}); return node && !node.hidden && !document.getElementById('browser-panel').hidden ? true : undefined })()`))
  const tasks = await button('tasks')
  await mouseClick(ctx.cdp, tasks.x, tasks.y)
  await pageShown('side-sections')
  await ctx.shot('28-tasks-page', 'the 任务 page and its pressed title bar button: the empty state, or plan / 命令 / 子代理 sections')
  const changes = await button('changes')
  await mouseClick(ctx.cdp, changes.x, changes.y)
  await pageShown('changes-view')
  await ctx.shot('28-changes-page', 'the 改动 page: the session\'s edited files, or 本会话还没有改动')
  // The title bar stops at the card's edge, so the buttons moved with the page's width.
  const again = await button('changes')
  await mouseClick(ctx.cdp, again.x, again.y)
  ctx.ok('pressing the page on screen closes the panel', await waitFor('the panel to close', async () => read(ctx, `document.getElementById('browser-panel').hidden || undefined`)) === true)
}

export const STEPS = [
  { id: 'S7', item: 7, name: 'Ctrl+B collapses and restores the sidebar', timeout: 30000, run: step7 },
  { id: 'S27', item: 8, name: 'native title bar space and platform shortcuts work together', timeout: 60000, run: step27 },
  { id: 'S2', item: 2, name: 'a parked permission prompt survives a switch', timeout: 60000, run: step2 },
  { id: 'S6', item: 6, name: 'the budget releases the coldest idle pane, never a pinned one', timeout: 150000, run: step6 },
  { id: 'S3', item: 3, name: 'deleting a closed session removes every artifact', timeout: 60000, run: step3 },
  { id: 'S4', item: 4, name: 'deleting the open session closes its lane and leaves no ghost', timeout: 60000, run: step4 },
  { id: 'S5', item: 5, name: 'a second project opens, shuts down, and re-bootstraps', timeout: 150000, run: step5 },
  { id: 'S8', item: 8, name: 'settings edit, fan out, and lay out inside the window', timeout: 180000, run: step8 },
  { id: 'S28', item: 8, name: 'the floating browser card and its native view sits inside the card, dragged or not', timeout: 90000, run: step28 },
  { id: 'S9', item: 9, name: 'the composer chip changes effort without persisting it', timeout: 45000, run: step9 },
  { id: 'S26', item: 2, name: 'image attachments import, strip, preview, gate, and isolate end to end', timeout: 240000, run: step26 },
  { id: 'S11', item: 8, name: 'the light theme paints, floats, and is given back', timeout: 90000, run: step11 },
  { id: 'S1', item: 1, name: 'a live turn keeps running in the background', timeout: 180000, run: step1, paid: true },
  { id: 'S4b', item: 4, name: 'deleting the last session leaves a draft, not a closed window', timeout: 60000, run: step4b },
]

export const RESTART_STEPS = [
  { id: 'S8R', item: 8, name: 'the settings survive a restart', timeout: 60000, run: step8Restart },
]
