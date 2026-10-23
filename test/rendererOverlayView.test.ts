import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { cssBlocks } from './helpers/rendererCss.js'
import { actionBar } from '../src/desktop/renderer/dom/actionBar.js'
import { createRewindView } from '../src/desktop/renderer/dom/rewindView.js'
import { createSuggestionsView } from '../src/desktop/renderer/dom/suggestionsView.js'
import { createSurfacePanel } from '../src/desktop/renderer/dom/surfaceView.js'
import type { CompletionState } from '../src/desktop/renderer/model/completion.js'
import type { OverlayAction } from '../src/desktop/renderer/model/dialogActions.js'
import { beginRewindRun, createRewindState, rewindViewModel } from '../src/desktop/renderer/model/rewindPanel.js'

/**
 * The three modal views: the blocking dialog, the rewind panel and the completion
 * dropdown. The first and the last had **zero** event listeners before S4.
 *
 * They are covered in one file rather than three because the claim is the same
 * one — anything the keyboard can reach must be reachable with the mouse, by the
 * same slot — and each extra file is two more entries to keep in step across
 * `tsconfig.json`'s `exclude` and `tsconfig.domtest.json`'s `include`
 * (`test/rendererImports.test.ts` checks both).
 *
 * Everything about *what* a click means lives in `model/`; this file only asserts
 * that the action arrives, that the roles are on the nodes, and that nothing else
 * in the panel is clickable. See `rendererWelcomeView.test.ts` for why the stub
 * exists and why these files are outside the base program.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'desktop', 'renderer')

test('the button bar carries the keys, and the focused slot is marked', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const picked: OverlayAction[] = []
  const actions = [
    { label: '允许一次', shortcut: 'Y', role: 'primary', slot: 0 },
    { label: '拒绝', shortcut: 'N', role: 'secondary', slot: 1 },
  ] as const
  const bar = actionBar(actions, (action) => picked.push(action), 1)
  const [allow, deny] = stub.inspect(bar).children
  assert.equal(allow!.tagName, 'BUTTON')
  assert.equal(allow!.text, '允许一次Y', 'the label carries its key as a badge')
  assert.ok(allow!.classes.includes('primary'))
  assert.ok(deny!.classes.includes('secondary'))
  assert.equal(allow!.disabled, false, 'a disabled button would swallow the click')
  // Enter's target is the one the model focused — on a destructive request that
  // is deny, so this cannot be decoration.
  assert.equal(allow!.classes.includes('selected'), false)
  assert.ok(deny!.classes.includes('selected'))

  // A button carrying a slot answers that slot; one without answers by role.
  stub.click(deny!.node)
  stub.click(stub.inspect(actionBar([{ label: '关闭', role: 'primary' }], (action) => picked.push(action))).children[0]!.node)
  assert.deepEqual(picked, [{ kind: 'slot', index: 1 }, { kind: 'primary' }])

  // Danger is a class the stylesheet turns into an outline, never a fill.
  const danger = actionBar([{ label: '允许一次', role: 'primary', tone: 'danger', slot: 0 }], () => {})
  assert.ok(stub.inspect(danger).children[0]!.classes.includes('danger'))
})

// --- the rewind panel --------------------------------------------------------

test('the rewind panel ends with the same bar, and its decisions are its buttons', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('rewind')
  const panel = stub.createContainer('rewind-panel')
  const intents: unknown[] = []
  const view = createRewindView(container, panel, (intent) => intents.push(intent))

  // The list screen: rows, and one button that closes.
  const state = createRewindState([])
  view.render(rewindViewModel(state))
  const bar = () => {
    const found = stub.inspect(panel).children.find((child) => child.classes.includes('dialog-actions'))
    assert.ok(found, 'the panel ends with a button bar')
    return found.children
  }
  assert.equal(bar().length, 1)
  assert.equal(bar()[0]!.text, '关闭Esc')
  stub.click(bar()[0]!.node)
  assert.deepEqual(intents, [{ kind: 'close' }])

  // The confirm screen: no option rows at all, because a decision is an action.
  const confirming = rewindViewModel({ ...state, screen: 'confirm' })
  view.render(confirming)
  assert.equal(
    stub.inspect(panel).children.some((child) => child.classes.includes('options')),
    false,
  )
})

test('the rewind panel takes focus on open, keeps it across repaints and hands it back', (t) => {
  // It used to open with focus still in the composer behind the scrim: a screen
  // reader announced nothing and Tab walked the page under the modal. The keys
  // still arrive through the window keymap, which gives a layer the keys whose
  // target is inside it, so moving focus in does not change what a key does.
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('rewind')
  const panel = stub.createContainer('rewind-panel')
  const composer = stub.createContainer('input')
  const view = createRewindView(container, panel, () => {})
  stub.focus(composer)

  const checkpoint = (messageId: string, messageContent: string) => ({
    messageId,
    messageContent,
    timestamp: '2026-05-19T10:00:00.000Z',
    turnDiff: { fileCount: 0, additions: 0, deletions: 0, hasChanges: false },
    restoreDiff: { fileCount: 0, additions: 0, deletions: 0, hasChanges: false },
    isCurrent: false,
  })
  const state = createRewindState([checkpoint('m1', 'add the parser'), checkpoint('m2', 'fix the lexer')])
  view.render(rewindViewModel(state))

  // The title is a heading, and the list is the one stop, naming its cursor row.
  const panelView = stub.inspect(panel)
  assert.equal(panelView.children[0]!.tagName.toLowerCase(), 'h2')
  const list = panelView.children.find((child) => child.attributes.get('role') === 'listbox')
  assert.ok(list, 'the select screen has a listbox')
  assert.equal(stub.activeElement(), list.node, 'focus moved onto the list')
  const cursor = list.children.find((row) => row.classes.includes('selected'))
  assert.ok(cursor)
  assert.equal(list.attributes.get('aria-activedescendant'), cursor.attributes.get('id'))

  // A repaint rebuilds the list; focus lands on the new one, not on <body>.
  view.render(rewindViewModel(state))
  const again = stub.inspect(panel).children.find((child) => child.attributes.get('role') === 'listbox')
  assert.equal(stub.activeElement(), again!.node)

  // The confirm screen has no list: focus falls back to the panel itself.
  view.render(rewindViewModel({ ...state, screen: 'confirm' }))
  assert.equal(stub.activeElement(), panel)

  // Closing hands focus back to where it was before the panel opened.
  view.hide()
  assert.equal(stub.activeElement(), composer)
})

test('a press on the rewind scrim closes it, unless a decision is running', (t) => {
  // Escape with a mouse.
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('rewind')
  const panel = stub.createContainer('rewind-panel')
  const intents: unknown[] = []
  const view = createRewindView(container, panel, (intent) => intents.push(intent))

  const state = createRewindState([])
  view.render(rewindViewModel(state))

  // Started inside the card and bubbled out: not a press on the backdrop.
  stub.dispatch(container, 'pointerdown', { target: panel })
  assert.deepEqual(intents, [])

  stub.dispatch(container, 'pointerdown', { target: container })
  assert.deepEqual(intents, [{ kind: 'close' }])

  // Mid-restore the panel takes no input at all — the same guard
  // `rewindKeyToIntent` applies, so the backdrop cannot abandon a running git.
  // A checkpoint is needed for the confirm screen to exist at all: an empty list
  // is answered by the "nothing to restore" branch, busy or not.
  intents.length = 0
  const restoring = beginRewindRun({
    ...createRewindState([{
      messageId: 'm1',
      messageContent: 'add the parser',
      timestamp: '2026-05-19T10:00:00.000Z',
      turnDiff: { fileCount: 0, additions: 0, deletions: 0, hasChanges: false },
      restoreDiff: { fileCount: 0, additions: 0, deletions: 0, hasChanges: false },
      isCurrent: false,
    }]),
    screen: 'confirm' as const,
  })
  assert.ok(rewindViewModel(restoring).busyLabel, 'the fixture is actually mid-decision')
  view.render(rewindViewModel(restoring))
  stub.dispatch(container, 'pointerdown', { target: container })
  assert.deepEqual(intents, [])

  // And a closed panel answers nothing, however the press arrives.
  view.hide()
  stub.dispatch(container, 'pointerdown', { target: container })
  assert.deepEqual(intents, [])
})

// --- the completion dropdown -------------------------------------------------

function commandState(): CompletionState {
  const item = (name: string, description: string) => ({
    id: name,
    displayText: `/${name}`,
    description,
    metadata: { name, description },
  })
  return {
    kind: 'command',
    selectedIndex: 0,
    seq: 1,
    items: [item('model', '切换模型'), item('effort', '思考强度')],
  }
}

test('a completion row reports its slot on mousedown, with the default prevented', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('suggestions')
  const picked: number[] = []
  const view = createSuggestionsView(container, (index) => picked.push(index))

  view.render(commandState())
  const rows = stub.inspect(container).children
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.attributes.get('role'), 'option')

  // `click` is deliberately not the trigger: accepting splices over the `@…`
  // token at the caret, and the browser's default mousedown moves focus off the
  // textarea first. A regression to `click` fails right here.
  stub.dispatch(rows[1]!.node, 'click')
  assert.deepEqual(picked, [], 'click alone does nothing')

  const event = stub.dispatch(rows[1]!.node, 'mousedown')
  assert.deepEqual(picked, [1])
  assert.equal(event.defaultPrevented, true, 'the default is prevented so the caret survives')
})

test('an empty completion state leaves nothing to click', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('suggestions')
  const picked: number[] = []
  const view = createSuggestionsView(container, (index) => picked.push(index))

  view.render(commandState())
  view.render({ kind: 'none', seq: 2 })
  assert.equal(stub.inspect(container).attributes.has('inert'), true)
  stub.dispatch(container, 'transitionend', { propertyName: 'opacity' })
  assert.equal(stub.inspect(container).hidden, true)
  assert.equal(stub.inspect(container).children.length, 0)
  assert.deepEqual(picked, [])
})

test('the highlighted completion is scrolled into view and named on the field', (t) => {
  // The arrows move a highlight, not focus: without these two, arrowing past
  // the list's edge hid the highlight, and a screen reader heard nothing move.
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('suggestions')
  const field = stub.createContainer('input')
  const view = createSuggestionsView(container, () => {}, field)
  view.render(commandState())
  const proto = Object.getPrototypeOf(stub.inspect(container).children[0]!.node) as { scrollIntoView(options?: unknown): void }
  const scrolled: Array<[string, unknown]> = []
  t.mock.method(proto, 'scrollIntoView', function (this: HTMLElement, options?: unknown) {
    scrolled.push([this.id, options])
  })

  view.render({ ...commandState(), selectedIndex: 1, seq: 2 } as CompletionState)
  assert.deepEqual(scrolled, [['suggestion-1', { block: 'nearest' }]])
  assert.equal(stub.inspect(field).attributes.get('aria-activedescendant'), 'suggestion-1')

  view.render({ kind: 'none', seq: 3 })
  assert.equal(stub.inspect(field).attributes.has('aria-activedescendant'), false, 'a closed list names nothing')
})

// --- the picker's "in force" mark --------------------------------------------

test('the row in force is marked with a glyph, not with a terminal bullet', (t) => {
  // The last of the TUI transcriptions (todo V5): the label used to be built as
  // `'● ' + label` on the current row and `'  ' + label` on every other, which is
  // how a monospaced terminal keeps that column. Under the chrome font the two
  // spaces are not the bullet's width, so nothing lined up — and the bullet was
  // text, so it went into the accessible name of the row too.
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('surface')
  const view = createSurfacePanel(container, () => {})

  view.showSurface(
    {
      surface: 'effort-picker',
      title: '选择思考强度',
      emptyMessage: '没有可选项',
      rows: [
        { id: 'low', label: '低', detail: '', action: { kind: 'run-command', line: '/effort low' } },
        { id: 'high', label: '高', detail: '', current: true, action: { kind: 'run-command', line: '/effort high' } },
      ],
    },
    0,
  )

  const rows = stub.inspect(container).children.filter((child) => child.classes.includes('row'))
  assert.equal(rows.length, 2)
  for (const row of rows) {
    // The slot is on every row, marked or not: it is what keeps the labels on one
    // column, which is the only thing the two spaces were ever doing.
    assert.equal(row.children[0]?.className, 'row-mark')
    assert.equal(row.children[1]?.text, row === rows[0] ? '低' : '高')
  }
  assert.equal(rows[0]!.children[0]?.children.length, 0, 'an ordinary row carries an empty slot')
  assert.equal(rows[1]!.children[0]?.children[0]?.tagName, 'svg', 'the current row carries the glyph')
  assert.equal(stub.inspect(container).text.includes('●'), false, 'the panel still prints a terminal bullet')
})

// --- where the two modal layers live ---------------------------------------

/**
 * S6: a blocking request belongs to one lane, so its scrim covers that lane's
 * canvas rather than the whole window — the sidebar stays live, because
 * switching away from a parked pane is a supported move.
 *
 * Asserted against the page and the stylesheet because that is where the fact
 * lives: `domStub.ts` computes no layout and no cascade, so a test that built
 * the panel could not tell a `fixed` scrim from an `absolute` one.
 */

/** The markup between `<main id="canvas">` and its closing tag. */
function canvasMarkup(): string {
  const html = readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  const start = html.indexOf('<main id="canvas">')
  assert.ok(start !== -1, 'the page still has a #canvas')
  const end = html.indexOf('</main>', start)
  assert.ok(end !== -1, '#canvas is still closed')
  return html.slice(start, end)
}

test('the modal layer is a child of the canvas, not of the body', () => {
  const canvas = canvasMarkup()

  assert.ok(canvas.includes('id="rewind"'), '#rewind left the canvas')
  // The scrim is what dims; the panel must travel with it.
  assert.ok(canvas.includes('id="rewind-panel"'))
  // A slice that accidentally matched the whole document would pass all of the
  // above: the sidebar is the canvas's *sibling* and must not be in here.
  assert.equal(canvas.includes('id="sidebar"'), false, 'the slice is not the whole page')
  // Last, so DOM order and stacking order say the same thing.
  assert.ok(canvas.indexOf('id="settings"') < canvas.indexOf('id="rewind"'))
})

test('the three composer panels hang off the composer, not off the canvas', () => {
  // todo V3 / S9. Asserted against the page for the same reason the scrim
  // above are: `domStub.ts` computes no layout, and `app.ts` finds all three by
  // `getElementById`, so nothing in the renderer would notice them drifting back
  // out to the canvas — only the shape on screen would.
  const html = readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  const start = html.indexOf('<form id="input-row">')
  assert.ok(start !== -1, 'the page still has the composer form')
  const end = html.indexOf('</form>', start)
  assert.ok(end !== -1, 'the composer form is still closed')
  const form = html.slice(start, end)

  const shell = form.indexOf('id="composer-popovers"')
  const composer = form.indexOf('id="composer"')
  assert.ok(shell !== -1, 'the positioning shell left the composer column')
  assert.ok(composer !== -1 && shell < composer, 'the stack is drawn before the capsule it floats over')
  for (const id of ['surface', 'suggestions']) {
    const at = form.indexOf(`id="${id}"`)
    assert.ok(at !== -1, `#${id} is not in the composer form`)
    assert.ok(shell < at && at < composer, `#${id} is outside #composer-popovers`)
  }
  // A slice that had accidentally matched the whole document would pass all of
  // the above: the transcript is the form's *sibling* and must not be in here.
  assert.equal(form.includes('id="transcript-area"'), false, 'the slice is not the whole canvas')
})

test('the scrims are positioned against the canvas and stack above every popover', () => {
  const blocks = cssBlocks()
  const decl = (selector: string, prop: string) =>
    blocks.find((block) => block.selector === selector)?.decls.find((d) => d.prop === prop)?.value

  // `fixed` would resolve against the viewport again, whatever the markup says.
  assert.equal(decl('#canvas', 'position'), 'relative', '#canvas is the containing block')
  assert.equal(decl('#rewind', 'position'), 'absolute', '#rewind is not absolute')
  assert.equal(decl('#rewind', 'inset'), '0', '#rewind does not fill the canvas')
  const fixed = blocks.filter((block) => block.decls.some((d) => d.prop === 'position' && d.value === 'fixed'))
  // The five that resolve against the viewport, and the reason each does: the
  // settings page replaces the window's work area, its form dialog's scrim
  // covers the title bar above that area too, the image viewer covers the
  // window because a picture at full size belongs to no single lane, and a
  // project heading's menu hangs off a row inside the sidebar's scroller, whose
  // `overflow` would crop an absolutely positioned popover, and a thread row's
  // menu does the same inside the side panel's thread list.
  assert.deepEqual(
    fixed.map((block) => block.selector).sort(),
    ['#lightbox', '#settings', '.project-menu', '.settings-dialog-layer', '.thread-menu'],
    'only the window-wide screens use the viewport',
  )

  // The ordering is these numbers now: before S6 the two scrims won by being
  // last in the body, and every popover in the app sits at 5–6. Each layer is
  // a rung of the `--z-` ladder in `:root`, so a value resolves through it.
  const root = blocks.find((block) => block.selector === ':root')
  const rung = (value: string) => {
    const name = /^var\((--z-[a-z]+)\)$/.exec(value)?.[1]
    return Number(name === undefined ? value : root?.decls.find((d) => d.prop === name)?.value)
  }
  const layers = blocks.flatMap((block) =>
    block.decls
      .filter((d) => d.prop === 'z-index')
      .map((d) => ({ selector: block.selector, value: rung(d.value) })),
  )
  assert.ok(layers.length >= 3, `the sheet still declares layers: ${layers.length}`)
  const at = (selector: string) => layers.find((layer) => layer.selector === selector)?.value
  const rewind = at('#rewind')
  assert.ok(rewind !== undefined, JSON.stringify(layers))
  // The image viewer is the one thing above it, and the exception is a
  // decision: it holds nothing, it is opened by a deliberate act and closed by
  // three of them, so it cannot trap anyone.
  const lightbox = at('#lightbox')
  assert.ok(lightbox !== undefined && lightbox > rewind, `#lightbox ${lightbox} must sit over #rewind ${rewind}`)
  // The toast stack is the other exception: an error must not be hidden by the
  // dialog that caused it, and the viewer still covers it.
  const toasts = at('#toasts')
  assert.ok(toasts !== undefined && toasts > rewind && toasts < lightbox, `#toasts ${toasts} sits between #rewind and #lightbox`)
  for (const layer of layers) {
    if (layer.selector === '#rewind' || layer.selector === '#lightbox' || layer.selector === '#toasts') continue
    assert.ok(layer.value < rewind, `${layer.selector} (${layer.value}) would draw over a modal`)
  }
  // `#canvas` deliberately declares no z-index: that would make it a stacking
  // context and trap the scrim under the sidebar's own popovers.
  assert.equal(at('#canvas'), undefined)
})

test('the stub carries every document member these views reach for', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  // The files a dialog is built out of. `suggestionsView.ts` calls
  // `document.createTextNode` directly rather than going through `dom.ts`, which
  // is exactly the kind of thing this scan exists to catch — see
  // `rendererWelcomeView.test.ts`, which scans the three helpers.
  const sources = ['actionBar.ts', 'rewindView.ts', 'suggestionsView.ts', 'surfaceView.ts', 'diffView.ts', 'markdownView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  // Non-vacuity: a regex that matched nothing would make this a decoration.
  assert.ok(members.size >= 1, [...members].join(', '))
  for (const member of members) {
    assert.equal(stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})
