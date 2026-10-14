import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createWelcomeView } from '../src/desktop/renderer/dom/welcomeView.js'
import type { WireUsageDay } from '../src/desktop/shellProtocol.js'
import type { WelcomeView } from '../src/desktop/renderer/model/welcome.js'
import {
  branchPickerView,
  createBranchPickerState,
  type BranchPickerIntent,
  type BranchPickerState,
} from '../src/desktop/renderer/model/branchPicker.js'
import {
  createProjectPickerState,
  projectPickerView,
  type ProjectPickerIntent,
  type ProjectPickerState,
} from '../src/desktop/renderer/model/projectPicker.js'

/**
 * The renderer's first `dom/` unit test.
 *
 * Until this file, `dom/` and `paneSession.ts` were covered only by
 * `scripts/smoke-desktop.mjs` — a real Electron run needing a display and
 * credentials — which is why both bugs stage 4f fixed lived here. `test/helpers/domStub.ts`
 * is the smallest thing that makes a view renderable in `node --test`.
 *
 * This file is **not** in the base TypeScript program: the base `lib` is `ES2022`
 * only, and that absence is what stops host code from touching `document`. It is
 * excluded there and checked by `tsconfig.domtest.json` instead;
 * `test/rendererImports.test.ts` asserts those two lists agree.
 *
 * The stub is installed per test and removed in `t.after`. Contamination is
 * bounded anyway — `node --test` runs one process per file, and `dom.ts`,
 * `controls.ts` and `icons.ts` all read `document` inside function bodies rather
 * than capturing it at import time.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'desktop', 'renderer')

// A static import is safe — and is itself part of the claim in the header: none of
// the three helpers reads `document` at module scope, so importing the view before
// the stub is installed cannot capture a missing global.
const PICKER_STATE: BranchPickerState = createBranchPickerState({
  branches: ['master', 'topic', 'release'],
  current: 'master',
})

function pickerFixture(overrides: Partial<BranchPickerState> = {}) {
  return branchPickerView({ ...PICKER_STATE, ...overrides })
}

const PROJECT_STATE: ProjectPickerState = createProjectPickerState({
  projects: [
    { root: '/repos/hanekawa', name: 'Hanekawa-main' },
    { root: '/repos/side', name: 'side' },
  ],
  current: '/repos/hanekawa',
})

function projectFixture(overrides: Partial<ProjectPickerState> = {}) {
  return projectPickerView({ ...PROJECT_STATE, ...overrides })
}

function welcomeViewFixture(overrides: Partial<WelcomeView> = {}): WelcomeView {
  return {
    branchPicker: pickerFixture(),
    projectPicker: projectFixture(),
    visible: true,
    title: '接下来做什么？',
    pills: [
      { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: false },
      { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
    ],
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: BranchPickerIntent[]
  /** The project switcher's own intents, kept apart so neither list can hide the other. */
  readonly projectIntents: ProjectPickerIntent[]
  readonly loads: { count: number }
  view(): StubView
  rerender(next?: WelcomeView): void
  dispose(): void
}

function render(
  t: { after(fn: () => void): void },
  initial = welcomeViewFixture(),
  usage: Promise<readonly WireUsageDay[]> | (() => Promise<readonly WireUsageDay[]>) = new Promise(() => {}),
): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('welcome')
  const intents: BranchPickerIntent[] = []
  const projectIntents: ProjectPickerIntent[] = []
  const loads = { count: 0 }
  const dom = createWelcomeView(container, {
    onBranchIntent: (intent) => intents.push(intent),
    onBranchKey: () => false,
    onProjectIntent: (intent) => projectIntents.push(intent),
    onProjectKey: () => false,
    loadUsage: () => {
      loads.count += 1
      return typeof usage === 'function' ? usage() : usage
    },
  })
  dom.render(initial)
  return {
    stub,
    container,
    intents,
    projectIntents,
    loads,
    view: () => stub.inspect(container),
    rerender: (next = initial) => dom.render(next),
    dispose: () => dom.dispose(),
  }
}

/**
 * The first descendant carrying a class, in document order.
 *
 * Descendants rather than direct children since the Hero gained its own row and
 * the branch pill its own anchor: a test that asserts the *nesting* rather than
 * the content would fail every time that scaffolding moves.
 */
const find = (view: StubView, className: string): StubView | undefined => {
  for (const node of view.children) {
    if (node.classes.includes(className)) return node
    const nested = find(node, className)
    if (nested) return nested
  }
  return undefined
}

const child = (view: StubView, className: string): StubView => {
  const found = find(view, className)
  assert.ok(found, `no .${className} in ${view.children.map((c) => c.className).join(' | ')}`)
  return found
}

/** Every `<button>` in the subtree — what "no focusable node" is asserted on. */
const buttons = (view: StubView): StubView[] =>
  view.children.flatMap((node) => (node.tagName === 'BUTTON' ? [node] : buttons(node)))

test('the empty state draws the title, the usage card and the pills', (t) => {
  const { view } = render(t)
  const root = view()

  assert.equal(root.hidden, false)
  const title = child(root, 'welcome-title')
  assert.equal(title.tagName, 'H1')
  assert.equal(title.text, '接下来做什么？')
  assert.ok(find(root, 'welcome-mark'))
  assert.ok(find(root, 'usage-card'))
  assert.equal(find(root, 'welcome-wordmark'), undefined)
  assert.equal(find(root, 'welcome-hints'), undefined)
  assert.equal(child(root, 'welcome-pills').children.length, 2)
})

test('a pill the model calls read-only is a span, and the branch pill is a control', (t) => {
  const { view, stub, intents } = render(t)
  const pills = child(view(), 'welcome-pills').children

  // Two pills — the 「本地」one that used to sit between them named the one
  // runtime that has ever existed. The project pill is read-only in this
  // fixture, so it is a span; the switchable case is the test below.
  assert.equal(pills.length, 2)
  assert.equal(child(view(), 'welcome-project-slot').children[0]?.tagName, 'SPAN')
  assert.equal(pills[0]?.text, 'Hanekawa-main')

  const branch = child(view(), 'welcome-branch-slot')
  const trigger = branch.children[0]
  assert.ok(trigger)
  assert.equal(trigger.tagName, 'BUTTON')
  assert.equal(trigger.text, 'master')

  // The popover's own panel is not a Tab stop, so it is not a button either.
  assert.deepEqual(buttons(child(view(), 'welcome-pills')).map((node) => node.text), ['master'])

  stub.click(trigger.node)
  assert.deepEqual(intents, [{ kind: 'open' }])
})

test('a branch that cannot be switched is a plain span again', (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({
      pills: [
        { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: false },
        { kind: 'branch', label: 'master', icon: 'branch', interactive: false },
      ],
    }),
  )
  const trigger = child(view(), 'welcome-branch-slot').children[0]
  assert.ok(trigger)
  assert.equal(trigger.tagName, 'SPAN')
})

test('a switchable project pill opens its own popover and lists the added projects', (t) => {
  const pills = [
    { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: true },
    { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
  ] as const
  const { view, stub, intents, projectIntents, rerender } = render(t, welcomeViewFixture({ pills }))

  const trigger = child(view(), 'welcome-project-slot').children[0]
  assert.ok(trigger)
  assert.equal(trigger.tagName, 'BUTTON')
  stub.click(trigger.node)
  // Each pill opens *its* switcher: the two triggers sit side by side, so a
  // shared handler would be a project click asking for the branch list.
  assert.deepEqual(projectIntents, [{ kind: 'open' }])
  assert.deepEqual(intents, [])

  rerender(welcomeViewFixture({ pills, projectPicker: projectFixture({ open: true }) }))
  const rows = child(view(), 'project-picker-body').children
  assert.deepEqual(rows.map((row) => row.text), ['Hanekawa-main', 'side'])
  assert.deepEqual(rows.map((row) => row.classes.includes('current')), [true, false])

  stub.click(rows[1]!.node)
  stub.click(rows[0]!.node)
  assert.deepEqual(projectIntents.slice(1), [
    { kind: 'pick', root: '/repos/side' },
    // The project this pane is already in is not a destination.
    { kind: 'close' },
  ])
})

test('a pill whose popover is open collapses it when pressed again', (t) => {
  const pills = [
    { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: true },
    { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
  ] as const
  const { view, stub, intents, projectIntents } = render(
    t,
    welcomeViewFixture({ pills, branchPicker: pickerFixture({ open: true }), projectPicker: projectFixture({ open: true }) }),
  )

  const project = child(view(), 'welcome-project-slot').children[0]!
  const branch = child(view(), 'welcome-branch-slot').children[0]!
  assert.equal(project.attributes.get('aria-expanded'), 'true')
  assert.equal(branch.attributes.get('aria-expanded'), 'true')

  stub.click(project.node)
  stub.click(branch.node)

  assert.deepEqual(projectIntents, [{ kind: 'close' }])
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('the two popovers are separate anchors: a press in one closes only an open other', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pills = [
    { kind: 'project', label: 'Hanekawa-main', icon: 'folder', interactive: true },
    { kind: 'branch', label: 'master', icon: 'branch', interactive: true },
  ] as const
  const { view, stub, intents, projectIntents, rerender } = render(
    t,
    welcomeViewFixture({ pills, projectPicker: projectFixture({ open: true }) }),
  )

  // The branch popover is shut, so a press in the project anchor has nothing to
  // close there and is not eaten.
  const closed = stub.dispatchDocument('pointerdown', { target: child(view(), 'project-picker-row').node })
  assert.deepEqual(projectIntents, [])
  assert.deepEqual(intents, [])
  assert.equal(closed.propagationStopped, false)

  // With both open, a press in the project anchor is outside the branch one: that
  // hears a close, the project picker does not, and the press is eaten.
  rerender(
    welcomeViewFixture({ pills, branchPicker: pickerFixture({ open: true }), projectPicker: projectFixture({ open: true }) }),
  )
  const open = stub.dispatchDocument('pointerdown', { target: child(view(), 'project-picker-row').node })
  assert.deepEqual(projectIntents, [])
  assert.deepEqual(intents, [{ kind: 'close' }])
  assert.equal(open.propagationStopped, true)
  stub.dispatchDocument('pointerup')
  t.mock.timers.tick(1)
})

test('an invisible screen is hidden and holds no focusable node', (t) => {
  const { view } = render(t, welcomeViewFixture({ visible: false }))
  const root = view()

  assert.equal(root.hidden, true)
  // Dropped, not merely hidden: a leftover button is still a Tab stop out of the
  // composer.
  assert.equal(root.children.length, 0)
})

test('a screen that goes invisible keeps its scaffolding and drops every button', (t) => {
  const { view, rerender } = render(t)
  assert.ok(buttons(view()).length > 0)

  rerender(welcomeViewFixture({ visible: false }))
  const root = view()

  assert.equal(root.hidden, true)
  assert.ok(root.children.length > 0, 'the scaffolding survives')
  assert.deepEqual(buttons(root), [])
})

test('a closed popover is hidden and lists nothing', (t) => {
  const { view } = render(t)
  const picker = child(view(), 'branch-picker')

  assert.equal(picker.hidden, true)
  assert.equal(find(picker, 'branch-picker-row'), undefined)
})

test('an open popover lists the branches and ticks the current one', (t) => {
  const { view } = render(t, welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }))
  const picker = child(view(), 'branch-picker')

  assert.equal(picker.hidden, false)
  const rows = child(picker, 'branch-picker-body').children.filter((node) =>
    node.classes.includes('branch-picker-row'),
  )
  assert.deepEqual(rows.map((row) => row.text), ['master', 'topic', 'release'])
  assert.deepEqual(rows.map((row) => row.classes.includes('current')), [true, false, false])
})

test('a loading popover says so instead of drawing an empty list', (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true, loading: true, branches: [] }) }),
  )
  const picker = child(view(), 'branch-picker')

  assert.equal(child(picker, 'branch-picker-empty').text, '正在读取分支…')
  assert.equal(find(picker, 'branch-picker-row'), undefined)
})

test("git's refusal is drawn under the rows the user was choosing from", (t) => {
  const { view } = render(
    t,
    welcomeViewFixture({
      branchPicker: pickerFixture({ open: true, error: 'error: Your local changes…' }),
    }),
  )
  const picker = child(view(), 'branch-picker')

  assert.equal(child(picker, 'branch-picker-error').text, 'error: Your local changes…')
  // The list stays: a popover that replaced its rows with the error would leave
  // the user nothing to retry with.
  assert.ok(find(picker, 'branch-picker-row'))
})

test('choosing a branch asks to switch; choosing the current one only closes', (t) => {
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }),
  )
  const rows = child(view(), 'branch-picker-body').children

  stub.click(rows[1]!.node)
  stub.click(rows[0]!.node)

  assert.deepEqual(intents, [{ kind: 'pick', branch: 'topic' }, { kind: 'close' }])
})

test('rows stop responding while a switch is in flight', (t) => {
  // `git switch` moves the working tree; a second one queued behind the first
  // would run against a tree the user never saw.
  const { view } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true, switching: true }) }),
  )
  const rows = child(view(), 'branch-picker-body').children
  assert.deepEqual(rows.map((row) => row.disabled), [true, true, true])
})

test('a press outside the branch anchor closes the popover; inside it does not', (t) => {
  // The popover hangs over the transcript, and the transcript is unfocusable
  // scenery: without this it could only be closed with Escape or by picking.
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }),
  )

  stub.dispatchDocument('pointerdown', { target: child(view(), 'branch-picker-row').node })
  assert.deepEqual(intents, [], 'a press on a row is the user choosing from it')

  // The pill is what opens this and sits *inside* the anchor beside the popover:
  // a press there must reach its own toggle, or the click that follows would
  // re-open what the user just shut.
  stub.dispatchDocument('pointerdown', { target: child(view(), 'welcome-branch-slot').children[0]!.node })
  assert.deepEqual(intents, [])

  stub.dispatchDocument('pointerdown', { target: stub.createContainer('transcript-area') })
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('a disposed welcome page leaves presses alone, even with a popover drawn open', (t) => {
  const { stub, intents, dispose } = render(t, welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }))
  dispose()
  stub.dispatchDocument('pointerdown', { target: stub.createContainer('transcript-area') })
  assert.deepEqual(intents, [])
})

test('focus leaving the popover closes it, but a repaint does not', (t) => {
  const { view, stub, intents } = render(
    t,
    welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }),
  )
  const anchor = child(view(), 'welcome-branch-anchor')

  // `relatedTarget === null` is this view's own repaint, not the user leaving —
  // answering it with a close would shut the popover on the paint that drew it.
  stub.dispatch(anchor.node, 'focusout', { relatedTarget: null })
  assert.deepEqual(intents, [])

  // Inside the anchor is still inside the popover: moving from a row to the pill
  // is not leaving.
  stub.dispatch(anchor.node, 'focusout', { relatedTarget: child(view(), 'branch-picker-row').node })
  assert.deepEqual(intents, [])

  stub.dispatch(anchor.node, 'focusout', { relatedTarget: stub.createContainer('composer') })
  assert.deepEqual(intents, [{ kind: 'close' }])
})

test('the branch pill keeps its popover across an open and a close', (t) => {
  const { view, rerender, stub } = render(t)
  const before = child(view(), 'branch-picker').node

  rerender(welcomeViewFixture({ branchPicker: pickerFixture({ open: true }) }))
  const during = child(view(), 'branch-picker').node
  rerender()
  const after = child(view(), 'branch-picker').node

  // Identity: the panel is the node that takes focus when the popover opens, so
  // rebuilding it would blur itself and fire the `focusout` that closes it.
  assert.equal(during, before)
  assert.equal(after, before)
  assert.equal(stub.inspect(after).classes.includes('presence-closing'), true)
  assert.equal(stub.inspect(after).attributes.has('inert'), true)
  assert.ok(find(stub.inspect(after), 'branch-picker-row'), 'rows remain through exit')
  stub.dispatch(after, 'transitionend', { propertyName: 'opacity' })
  assert.equal(stub.inspect(after).hidden, true)
  assert.equal(find(stub.inspect(after), 'branch-picker-row'), undefined)
})

test('rendering the same view twice rebuilds nothing', (t) => {
  const { view, rerender } = render(t)
  const before = child(view(), 'welcome-pills').children.map((pill) => pill.node)
  rerender()
  const after = child(view(), 'welcome-pills').children.map((pill) => pill.node)

  // Identity, not equality: this view repaints once per streamed token, so the
  // signature guard is load-bearing rather than tidiness.
  assert.deepEqual(after, before)
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const { stub } = render(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'branchPickerView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  // Non-vacuity first: a regex that matched nothing would make this test a
  // decoration rather than the thing that keeps the fake honest.
  assert.ok(members.size >= 4, [...members].join(', '))
  for (const member of members) {
    assert.equal(stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})

// --- the usage card ------------------------------------------------------------

const today = new Date()
const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
const DAYS: WireUsageDay[] = [
  { day: key, sessions: 3, turns: 12, tokens: 25_000, hours: new Array<number>(24).fill(0).map((_, h) => (h === 21 ? 12 : 0)), models: { alpha: 20_000, beta: 5_000 } },
]
const cellValues = (view: StubView): string[] => child(view, 'usage-cells').children.map((cell) => cell.children[0]!.text)
const segment = (view: StubView, label: string): StubView => {
  const found = buttons(view).find((node) => node.text === label)
  assert.ok(found, label)
  return found
}

test('the card shows a skeleton until the stats arrive, then the numbers', async (t) => {
  let resolve!: (days: WireUsageDay[]) => void
  const { view } = render(t, welcomeViewFixture(), new Promise((r) => { resolve = r }))

  assert.ok(child(view(), 'usage-card').classes.includes('loading'))
  resolve(DAYS)
  await Promise.resolve()
  await Promise.resolve()
  const card = child(view(), 'usage-card')
  assert.equal(card.classes.includes('loading'), false)
  assert.deepEqual(cellValues(card), ['2.5 万', '3', '1'])
  assert.equal(child(card, 'usage-footnote').text, '你用掉的 token 大约相当于 0.1 本《三体》')
})

test('a failed read says so and offers 重试; it never draws zeros for a history it could not read', async (t) => {
  let attempt = 0
  const { view, stub, loads } = render(t, welcomeViewFixture(), () => (++attempt === 1 ? Promise.reject(new Error('disk')) : Promise.resolve(DAYS)))
  await Promise.resolve()
  await Promise.resolve()

  const card = child(view(), 'usage-card')
  assert.equal(card.classes.includes('loading'), false)
  assert.equal(find(card, 'usage-cells'), undefined, 'no figures')
  assert.ok(child(card, 'usage-empty').text.includes('无法读取使用统计'))

  stub.click(child(view(), 'usage-retry').node)
  assert.ok(child(view(), 'usage-card').classes.includes('loading'), 'the retry shows the skeleton again')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(loads.count, 2)
  assert.deepEqual(cellValues(child(view(), 'usage-card')), ['2.5 万', '3', '1'])
})

test('an empty history draws zeros and dashes', async (t) => {
  const { view } = render(t, welcomeViewFixture(), Promise.resolve([]))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(cellValues(child(view(), 'usage-card')), ['0', '0', '0'])
})

test('the segments switch the tab and the range locally', async (t) => {
  const { view, stub, loads } = render(t, welcomeViewFixture(), Promise.resolve(DAYS))
  await Promise.resolve()
  await Promise.resolve()

  stub.click(segment(view(), '模型').node)
  const shares = child(view(), 'usage-shares').children
  assert.deepEqual(shares.map((share) => share.text), ['alpha2 万 · 80%', 'beta5,000 · 20%'])
  assert.equal(segment(view(), '模型').attributes.get('aria-pressed'), 'true')
  assert.deepEqual(
    child(view(), 'usage-facts').children.map((fact) => fact.children[0]!.text),
    ['21 时', 'alpha'],
  )

  stub.click(segment(view(), '概览').node)
  stub.click(segment(view(), '7 天').node)
  assert.equal(segment(view(), '7 天').attributes.get('aria-pressed'), 'true')
  assert.equal(child(view(), 'usage-cells').children[1]!.children[0]!.text, '3')
  assert.equal(loads.count, 1)
})

test('the stats are asked for once per showing, not per repaint', (t) => {
  const { rerender, loads } = render(t)
  rerender(welcomeViewFixture({ pills: [{ kind: 'project', label: 'x', icon: 'folder', interactive: false }] }))
  assert.equal(loads.count, 1)
  rerender(welcomeViewFixture({ visible: false }))
  rerender(welcomeViewFixture())
  assert.equal(loads.count, 2)
})
