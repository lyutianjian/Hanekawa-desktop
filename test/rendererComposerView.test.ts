import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createComposerView, type ComposerView } from '../src/desktop/renderer/dom/composerView.js'
import { closeTopDismissable } from '../src/desktop/renderer/dom/dismiss.js'
import { createDockedCard } from '../src/desktop/renderer/dom/dockedCard.js'
import { createPlanCardView } from '../src/desktop/renderer/dom/planCardView.js'
import { createPlanPanelView } from '../src/desktop/renderer/dom/planPanelView.js'
import { createExitPlanState, enterPlanViewModel, exitPlanViewModel } from '../src/desktop/renderer/model/planDialogs.js'
import type { EnterPlanIntent, ExitPlanIntent } from '../src/desktop/renderer/model/planDialogs.js'
import { createQuestionCardView } from '../src/desktop/renderer/dom/questionCardView.js'
import { askViewModel, createAskState } from '../src/desktop/renderer/model/askUserQuestion.js'
import type { AskIntent, AskViewModel } from '../src/desktop/renderer/model/askUserQuestion.js'
import {
  createPermissionRequestView,
  permissionGlyphFor,
} from '../src/desktop/renderer/dom/permissionRequestView.js'
import type { OverlayAction } from '../src/desktop/renderer/model/dialogActions.js'
import type { PermissionViewModel } from '../src/desktop/renderer/model/permissionDialog.js'
import { EFFORT_LABELS, PERMISSION_MODE_LABELS } from '../src/desktop/renderer/model/composer.js'
import { runtimeMenuView, type RuntimeMenuView } from '../src/desktop/renderer/model/runtimeMenu.js'
import { CONTEXT_RATIO_VARIABLE, contextGaugeView } from '../src/desktop/renderer/model/usage.js'
import type { ContextBreakdown } from '../src/harness/contextBreakdown.js'

const SAMPLE_BREAKDOWN: ContextBreakdown = {
  usedTokens: 30_000,
  estimated: false,
  categories: [
    { key: 'system', tokens: 4_000 },
    { key: 'tools', tokens: 6_000 },
    { key: 'messages', tokens: 20_000 },
  ],
  deferred: [],
  mcpTools: [],
  memoryFiles: [{ path: '/repo/AGENTS.md', tokens: 1_000 }],
}
import type { SurfaceAction } from '../src/desktop/renderer/model/surfaces.js'
import type { PermissionMode } from '../src/harness/permissions.js'
import type { WireModelsResult, WireReadyRuntimeSnapshot } from '../src/runtime/protocol/wire.js'

/**
 * The composer's *nodes* — the half `rendererComposerChip.test.ts` cannot reach.
 *
 * Three things here are not model decisions and so have nowhere else to be
 * tested: the permission menu's open flag lives in this view (the composer is a
 * singleton with no reducer behind it), `focusout` has to tell "the user left"
 * from "this view repainted", and the send button's classes are recomputed on a
 * keystroke rather than on a render call.
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

const RENDERER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'desktop',
  'renderer',
)

function runtime(overrides: Partial<WireReadyRuntimeSnapshot> = {}): WireReadyRuntimeSnapshot {
  return {
    status: 'ready',
    modelKey: 'sonnet',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly composer: ComposerView
  /** The HTML group that puts the gauge beside, not inside, the runtime chip. */
  readonly runtimeShell: HTMLElement
  /** The bar the `+` lives in; its menu is drawn into it. */
  readonly attachShell: HTMLElement
  readonly els: Record<
    | 'input'
    | 'submit'
    | 'stop'
    | 'attach'
    | 'contextIndicator'
    | 'chipRuntime'
    | 'chipShell'
    | 'chipPermission'
    | 'permissionShell'
    | 'attachStrip',
    HTMLElement
  >
  readonly picked: PermissionMode[]
  readonly attaches: number[]
  /** Every `onOpenRuntimeMenu`, so "asked once" is assertable. */
  readonly menuRequests: number[]
  /** The `SurfaceAction`s a flyout row handed back. */
  readonly ran: SurfaceAction[]
  readonly pickedImages: number[]
  readonly removedDrafts: string[]
  readonly retriedDrafts: string[]
  readonly openedDrafts: string[]
  readonly previewedDrafts: string[]
  readonly pastedFiles: File[][]
  view(name: keyof Rendered['els']): StubView
  /** The permission menu's items, or an empty list when it is closed. */
  menuItems(): StubView[]
  /** The `+` menu's two items, or an empty list when it is closed. */
  attachMenuItems(): StubView[]
  /** The strip's rows, as views. */
  attachmentRows(): StubView[]
  /** One entry per breakdown fetch. */
  breakdownRequests: number[]
  /** The chip popover's two rows, or an empty list when it is shut. */
  chipRows(): StubView[]
  /** The open flyout's option items, or an empty list when none is open. */
  flyoutItems(): StubView[]
}

/** The textarea, typed for the one member a test writes. */
function input(r: Rendered): { value: string } {
  return r.els.input as unknown as { value: string }
}

function render(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())

  const els = {
    input: stub.createContainer(),
    submit: stub.createContainer(),
    stop: stub.createContainer(),
    attach: stub.createContainer(),
    contextIndicator: stub.createContainer(),
    chipRuntime: stub.createContainer(),
    chipShell: stub.createContainer(),
    chipPermission: stub.createContainer(),
    permissionShell: stub.createContainer(),
    attachStrip: stub.createContainer(),
  }
  els.permissionShell.appendChild(els.chipPermission)
  const attachShell = stub.createContainer()
  attachShell.appendChild(els.attach)
  const runtimeShell = stub.createContainer()
  runtimeShell.appendChild(els.contextIndicator)
  els.chipShell.appendChild(els.chipRuntime)
  runtimeShell.appendChild(els.chipShell)

  const picked: PermissionMode[] = []
  const attaches: number[] = []
  const menuRequests: number[] = []
  const ran: SurfaceAction[] = []
  const pickedImages: number[] = []
  const removedDrafts: string[] = []
  const retriedDrafts: string[] = []
  const openedDrafts: string[] = []
  const previewedDrafts: string[] = []
  const pastedFiles: File[][] = []
  const breakdownRequests: number[] = []
  const composer = createComposerView(
    {
      input: els.input as HTMLTextAreaElement,
      submit: els.submit as HTMLButtonElement,
      stop: els.stop as HTMLButtonElement,
      attach: els.attach as HTMLButtonElement,
      contextIndicator: els.contextIndicator,
      chipRuntime: els.chipRuntime as HTMLButtonElement,
      chipShell: els.chipShell,
      chipPermission: els.chipPermission as HTMLButtonElement,
      permissionShell: els.permissionShell,
      attachStrip: els.attachStrip,
    },
    {
      onOpenRuntimeMenu: () => menuRequests.push(1),
      onRuntimeAction: (action) => ran.push(action),
      onSelectPermissionMode: (mode) => picked.push(mode),
      onAttach: () => attaches.push(1),
      onPickImages: () => pickedImages.push(1),
      onRemoveAttachment: (draftId) => removedDrafts.push(draftId),
      onRemovePath: () => {},
      onRetryAttachment: (draftId) => retriedDrafts.push(draftId),
      onOpenAttachment: (draftId) => openedDrafts.push(draftId),
      onPreviewAttachment: (draftId) => previewedDrafts.push(draftId),
      onPasteImages: (files) => pastedFiles.push([...files]),
      onLoadContextBreakdown: async () => {
        breakdownRequests.push(1)
        return { breakdown: SAMPLE_BREAKDOWN }
      },
    },
  )

  const menu = (): StubView | undefined =>
    stub.inspect(els.permissionShell).children.find((child) => child.classes.includes('composer-menu') && child.attributes.get('aria-hidden') !== 'true')
  const attachMenu = (): StubView | undefined =>
    stub.inspect(attachShell).children.find((child) => child.classes.includes('composer-menu') && child.attributes.get('aria-hidden') !== 'true')
  const chipMenu = (): StubView | undefined =>
    stub.inspect(els.chipShell).children.find((child) => child.classes.includes('chip-menu') && child.attributes.get('aria-hidden') !== 'true')
  const flyout = (): StubView | undefined =>
    chipMenu()
      ?.children.flatMap((shell) => [...shell.children])
      .find((child) => child.classes.includes('chip-flyout') && child.attributes.get('aria-hidden') !== 'true')

  return {
    stub,
    composer,
    breakdownRequests,
    runtimeShell,
    attachShell,
    els,
    picked,
    attaches,
    menuRequests,
    ran,
    pickedImages,
    removedDrafts,
    retriedDrafts,
    openedDrafts,
    previewedDrafts,
    pastedFiles,
    view: (name) => stub.inspect(els[name]),
    menuItems: () => [...(menu()?.children ?? [])],
    attachMenuItems: () => [...(attachMenu()?.children ?? [])],
    attachmentRows: () => [...stub.inspect(els.attachStrip).children],
    // The row is the shell's first child; the flyout, when open, is its second.
    chipRows: () => (chipMenu()?.children ?? []).map((shell) => shell.children[0]!),
    flyoutItems: () =>
      (flyout()?.children ?? []).filter((child) => child.classes.includes('chip-flyout-item')),
  }
}

const MODELS: WireModelsResult = {
  models: [],
  pickerOptions: [
    { key: 'sonnet', label: 'Sonnet', modelKey: 'sonnet', modelId: 'claude-sonnet-5', isCurrent: true, isDefault: true },
    { key: 'opus', label: 'Opus', modelKey: 'opus', modelId: 'claude-opus-5', isCurrent: false, isDefault: false },
  ],
}

/** The chip popover's rows, built the way the pane builds them. */
function menuView(snapshot: WireReadyRuntimeSnapshot = runtime()): RuntimeMenuView {
  return runtimeMenuView({ runtime: snapshot, models: MODELS })
}

/** What the pane hands over before the first snapshot: nothing to switch. */
function inertMenuView(): RuntimeMenuView {
  return runtimeMenuView({ runtime: undefined, models: MODELS })
}

test('the pill is disabled and menuless until a snapshot arrives', (t) => {
  const r = render(t)
  assert.equal(r.view('chipPermission').disabled, true)

  // A click on an inert pill must not open anything: the menu would list four
  // modes with no current one and act on a runtime that does not exist yet.
  r.stub.click(r.els.chipPermission)
  assert.deepEqual(r.menuItems(), [])
})

test('the pill opens a menu of the four modes and marks the live one', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime({ permissionMode: 'auto' }))
  assert.equal(r.view('chipPermission').text, PERMISSION_MODE_LABELS.auto)

  r.stub.click(r.els.chipPermission)
  const items = r.menuItems()
  assert.deepEqual(items.map((item) => item.text), [
    PERMISSION_MODE_LABELS.default,
    PERMISSION_MODE_LABELS.plan,
    PERMISSION_MODE_LABELS.auto,
    PERMISSION_MODE_LABELS.bypass,
  ])
  assert.deepEqual(
    items.filter((item) => item.classes.includes('active')).map((item) => item.text),
    [PERMISSION_MODE_LABELS.auto],
  )
  assert.equal(r.view('chipPermission').attributes.get('aria-expanded'), 'true')
})

test('choosing a mode reports it once and closes the menu', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  r.stub.click(r.menuItems()[1]!.node)

  assert.deepEqual(r.picked, ['plan'])
  assert.deepEqual(r.menuItems(), [], 'the menu closes on its own, not on the snapshot coming back')
  // The label is *not* updated locally: the host posts a fresh runtime snapshot,
  // and guessing here would show a mode the gate may have refused.
  assert.equal(r.view('chipPermission').text, PERMISSION_MODE_LABELS.default)
})

test('Escape and focus leaving both close the menu; focus moving inside does not', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.stub.click(r.els.chipPermission)
  r.stub.dispatch(r.els.permissionShell, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.menuItems(), [])

  r.stub.click(r.els.chipPermission)
  // Focus moving between the trigger and an item is not "the user left" — the
  // browser fires `focusout` for that too, and closing there would make the menu
  // impossible to click.
  r.stub.dispatch(r.els.permissionShell, 'focusout', { relatedTarget: r.menuItems()[0]!.node })
  assert.equal(r.menuItems().length, 4)

  r.stub.dispatch(r.els.permissionShell, 'focusout', { relatedTarget: r.els.input })
  assert.deepEqual(r.menuItems(), [])
})

test('the permission menu opens on the mode in force and the arrows rove it', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime({ permissionMode: 'auto' }))

  r.stub.click(r.els.chipPermission)
  const items = r.menuItems()
  assert.equal(r.stub.activeElement(), items[2]!.node, 'the keyboard starts where the menu says it is')

  const arrow = (from: number, key: string) =>
    r.stub.dispatch(r.els.permissionShell, 'keydown', { key, target: items[from]!.node })
  assert.equal(arrow(2, 'ArrowDown').defaultPrevented, true)
  assert.equal(r.stub.activeElement(), items[3]!.node)
  arrow(3, 'ArrowDown')
  assert.equal(r.stub.activeElement(), items[0]!.node, 'wraps')
  arrow(0, 'End')
  assert.equal(r.stub.activeElement(), items[3]!.node)

  const menu = r.stub.inspect(r.els.permissionShell).children.find((child) => child.classes.includes('composer-menu'))!
  r.stub.dispatch(menu.node, 'mousemove', { target: items[1]!.node })
  assert.equal(r.stub.activeElement(), items[1]!.node, 'hover and keyboard share one row')
})

test('ArrowDown on the closed permission pill opens its menu', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.stub.dispatch(r.els.permissionShell, 'keydown', { key: 'ArrowDown', target: r.els.chipPermission })

  assert.equal(r.menuItems().length, 4)
})

test('Escape from the document closes whatever popover the composer has open', (t) => {
  // Focus falls to `<body>` when a repaint destroys the focused node, and then no
  // shell keydown listener hears the key.
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  assert.equal(closeTopDismissable(), true)
  assert.deepEqual(r.menuItems(), [])
})

test('a press outside the pill closes the permission menu; inside it does not', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  r.stub.dispatchDocument('pointerdown', { target: r.menuItems()[0]!.node })
  assert.equal(r.menuItems().length, 4, 'choosing a mode is not leaving')

  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.deepEqual(r.menuItems(), [])
})

test('a press outside the chip shell closes the runtime popover', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  r.stub.dispatchDocument('pointerdown', { target: r.chipRows()[0]!.node })
  assert.equal(r.chipRows().length, 2)

  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.deepEqual(r.chipRows(), [])
})

test('a background pane cannot leave its menu hanging over the next one', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)

  r.composer.closeMenus()

  assert.deepEqual(r.menuItems(), [])
})

// --- the chip's popover --------------------------------------------------------

test('the chip is one label carrying both fields, inert until a snapshot arrives', (t) => {
  const r = render(t)
  assert.equal(r.view('chipRuntime').disabled, true)

  r.composer.renderRuntime(runtime())
  assert.deepEqual(
    r.view('chipRuntime').children.map((child) => [child.className, child.text]),
    [
      // Drawn at every width; the stylesheet shows it instead of the two labels
      // once the row is too narrow for a name (`@container composer-bar`).
      ['icon chip-model-icon', ''],
      ['chip-model-label', 'sonnet'],
      ['chip-effort-label', EFFORT_LABELS.high],
    ],
  )
  assert.equal(r.view('chipRuntime').disabled, false)
})

test('the context indicator is independent of the chip, and is absent when there is nothing to report', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  assert.equal(r.view('contextIndicator').hidden, true)
  assert.deepEqual(r.view('contextIndicator').children, [])
  assert.deepEqual(
    r.view('chipRuntime').children.map((child) => child.className),
    ['icon chip-model-icon', 'chip-model-label', 'chip-effort-label'],
    'the chip carries the two fields it opens and its own stand-in, and nothing else',
  )
  assert.deepEqual(
    r.stub.inspect(r.runtimeShell).children.map((child) => child.node),
    [r.els.contextIndicator, r.els.chipShell],
    'the indicator is the chip shell’s sibling, not its child',
  )

  r.composer.renderRuntime(
    runtime({ contextWindow: 200_000, usableContextWindow: 100_000 }),
    contextGaugeView(90_000, runtime({ usableContextWindow: 100_000 })),
  )
  assert.equal(r.view('contextIndicator').hidden, false)
  assert.deepEqual(
    r.stub.inspect(r.runtimeShell).children.map((child) => child.node),
    [r.els.contextIndicator, r.els.chipShell],
    'the visible indicator stays outside the chip',
  )
  const [trigger, tooltip] = r.view('contextIndicator').children
  // A real button holds the ring: the shell also holds the popover and its own
  // buttons, which a `role=button` shell would have nested inside a button.
  assert.equal(trigger?.tagName, 'BUTTON')
  assert.equal(r.view('contextIndicator').attributes.has('role'), false)
  const gauge = trigger?.children[0]
  assert.equal(gauge?.className, 'context-gauge warn')
  // The ring is decoration; the figures reach the reader through the indicator's
  // own accessible name, which is why the level may be a colour at all.
  assert.equal(gauge?.attributes.get('aria-hidden'), 'true')
  assert.equal(gauge?.styleProperties.get(CONTEXT_RATIO_VARIABLE), '0.9')
  assert.equal(trigger?.attributes.get('aria-expanded'), 'false')
  assert.match(trigger?.attributes.get('aria-label') ?? '', /90% 已用/)
  assert.equal((r.els.contextIndicator as { title: string }).title, '', 'the hover card is drawn by the renderer, not by the OS')

  assert.equal(tooltip?.classes.includes('hover-card'), true)
  assert.equal(tooltip?.attributes.get('role'), 'tooltip')
  assert.equal(tooltip?.attributes.get('aria-hidden'), 'true')
  assert.match(tooltip?.text ?? '', /已使用/)
  assert.match(tooltip?.text ?? '', /90% · 90k \/ 100k/)
})

test('clicking the context indicator opens the breakdown, and clicking again or Escape closes it', async (t) => {
  const r = render(t)
  const snapshot = runtime({ contextWindow: 200_000, usableContextWindow: 100_000 })
  r.composer.renderRuntime(snapshot, contextGaugeView(30_000, snapshot))
  const popover = () => r.view('contextIndicator').children.find((child) => child.classes.includes('context-popover'))
  const trigger = () => r.view('contextIndicator').children[0]!
  assert.equal(popover()?.hidden, true)

  r.stub.click(trigger().node)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(r.breakdownRequests, [1])
  assert.equal(trigger().attributes.get('aria-expanded'), 'true')
  assert.equal(popover()?.hidden, false)
  assert.match(popover()?.text ?? '', /已使用 30%/)
  assert.match(popover()?.text ?? '', /对话消息/)
  assert.match(popover()?.text ?? '', /压缩预留/)
  assert.equal(r.view('contextIndicator').children[1]?.hidden, true, 'the hover card stands down while the card is open')

  r.stub.click(trigger().node)
  assert.equal(trigger().attributes.get('aria-expanded'), 'false')

  r.stub.click(trigger().node)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(trigger().attributes.get('aria-expanded'), 'true')
  r.stub.dispatch(r.els.contextIndicator, 'keydown', { key: 'Escape' })
  assert.equal(trigger().attributes.get('aria-expanded'), 'false')
})

test('the context card offers 压缩上下文, which closes it and runs /compact', async (t) => {
  const r = render(t)
  const snapshot = runtime({ contextWindow: 200_000, usableContextWindow: 100_000 })
  r.composer.renderRuntime(snapshot, contextGaugeView(80_000, snapshot))
  const trigger = r.view('contextIndicator').children[0]!
  r.stub.click(trigger.node)
  await new Promise((resolve) => setImmediate(resolve))
  const popover = r.view('contextIndicator').children.find((child) => child.classes.includes('context-popover'))!
  const compact = popover.children.flatMap((child) => child.children).find((child) => child.classes.includes('ctx-compact'))
  assert.equal(compact?.text, '压缩上下文')

  r.stub.click(compact!.node)
  assert.deepEqual(r.ran, [{ kind: 'run-command', line: '/compact' }])
  assert.equal(r.view('contextIndicator').children[0]!.attributes.get('aria-expanded'), 'false')
})

test('clicking the chip asks the pane for the rows rather than opening anything', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.stub.click(r.els.chipRuntime)
  assert.deepEqual(r.menuRequests, [1])
  assert.deepEqual(r.chipRows(), [], 'nothing is drawn until the rows come back')

  r.composer.showRuntimeMenu(menuView())
  assert.deepEqual(r.chipRows().map((row) => row.text), [
    `模型sonnet`,
    `思考强度${EFFORT_LABELS.high}`,
  ])
  assert.equal(r.view('chipRuntime').attributes.get('aria-expanded'), 'true')
  // The popover opens as its two rows and nothing else. Focus lands on the first
  // one, and a flyout on focus would put the model list over the menu the user
  // has not read yet.
  assert.deepEqual(r.flyoutItems(), [])
  r.stub.dispatch(r.chipRows()[0]!.node, 'focus')
  assert.deepEqual(r.flyoutItems(), [])
})

test('an answer nobody asked for is dropped', (t) => {
  // The rows are a round trip, so one can land after the pane went to the
  // background — which would hang a menu over the *next* pane's runtime.
  const r = render(t)
  r.composer.renderRuntime(runtime())

  r.composer.showRuntimeMenu(menuView())
  assert.deepEqual(r.chipRows(), [])

  r.stub.click(r.els.chipRuntime)
  r.composer.closeMenus()
  r.composer.showRuntimeMenu(menuView())
  assert.deepEqual(r.chipRows(), [], 'closing the menus also withdraws the request')
})

test('a snapshotless menu refuses to open, and the next click asks again', (t) => {
  const r = render(t)
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(inertMenuView())

  assert.deepEqual(r.chipRows(), [])
  r.stub.click(r.els.chipRuntime)
  assert.deepEqual(r.menuRequests, [1, 1], 'the second click asks, it does not read as "close"')
})

test('hovering a row opens its flyout, and only one is open at a time', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  const [model, effort] = r.chipRows()
  r.stub.dispatch(effort!.node, 'mouseenter')
  assert.deepEqual(
    r.flyoutItems().map((item) => item.children[0]!.text),
    [EFFORT_LABELS.low, EFFORT_LABELS.medium, EFFORT_LABELS.high, EFFORT_LABELS.xhigh, EFFORT_LABELS.max],
  )
  // The level in force is marked, and the row it is on says so to a reader.
  assert.deepEqual(
    r.flyoutItems().filter((item) => item.classes.includes('active')).map((item) => item.children[0]!.text),
    [EFFORT_LABELS.high],
  )

  r.stub.dispatch(model!.node, 'mouseenter')
  assert.deepEqual(r.flyoutItems().map((item) => item.children[0]!.text), ['Sonnet', 'Opus'])
  assert.equal(r.chipRows().filter((row) => row.classes.includes('open')).length, 1)
})

test('re-entering the row a flyout already belongs to does not rebuild it', (t) => {
  // The rows are kept across a flyout change on purpose: rebuilding one under
  // the pointer fires `mouseenter` on the replacement, and the render loop that
  // follows has no exit.
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  const row = r.chipRows()[1]!
  r.stub.dispatch(row.node, 'mouseenter')
  const first = r.flyoutItems()[0]!.node
  r.stub.dispatch(row.node, 'mouseenter')

  assert.equal(r.flyoutItems()[0]!.node, first)
  assert.equal(r.chipRows()[1]!.node, row.node)
})

test('choosing a level runs its command once and shuts the popover', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())
  r.stub.dispatch(r.chipRows()[1]!.node, 'mouseenter')

  r.stub.click(r.flyoutItems()[0]!.node)

  // The slash command, not `set-effort`: that is what writes the choice back to
  // config (`model/surfaces.ts`).
  assert.deepEqual(r.ran, [{ kind: 'run-command', line: '/effort low' }])
  assert.deepEqual(r.chipRows(), [])
  assert.equal(r.view('chipRuntime').attributes.get('aria-expanded'), 'false')
})

test('a level the model does not support explains itself instead of being pickable', (t) => {
  const r = render(t)
  const snapshot = runtime({ effort: 'medium', supportedEfforts: ['low', 'medium', 'high'] })
  r.composer.renderRuntime(snapshot)
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView(snapshot))
  r.stub.dispatch(r.chipRows()[1]!.node, 'mouseenter')

  const over = r.flyoutItems().filter((item) => item.classes.includes('disabled'))
  assert.deepEqual(over.map((item) => item.children[0]!.text), [EFFORT_LABELS.xhigh, EFFORT_LABELS.max])
  assert.equal(over[0]!.disabled, true)
  r.stub.click(over[0]!.node)
  assert.deepEqual(r.ran, [], 'a disabled row is drawn to explain itself, not to be picked')
})

test('the keyboard walks the two rows, enters a flyout on the value in force and walks it', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'ArrowDown', target: r.els.chipRuntime })
  assert.deepEqual(r.menuRequests, [1], 'ArrowDown on the closed chip asks for the rows')
  r.composer.showRuntimeMenu(menuView())

  const [model, effort] = r.chipRows()
  r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'ArrowDown', target: model!.node })
  assert.equal(r.stub.activeElement(), effort!.node)

  // Enter and ArrowRight both open the flyout, and focus follows into it: the
  // level in force, so the arrows start from where the menu says it is.
  r.stub.dispatch(effort!.node, 'keydown', { key: 'Enter' })
  const levels = r.flyoutItems()
  assert.equal(r.stub.activeElement(), levels[2]!.node, 'high is the level in force')

  r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'ArrowDown', target: levels[2]!.node })
  assert.equal(r.stub.activeElement(), levels[3]!.node, 'the arrows walk the flyout, not the rows')
  r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'Home', target: levels[3]!.node })
  assert.equal(r.stub.activeElement(), levels[0]!.node)
})

test('Escape closes the flyout first and the popover second', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())
  r.stub.dispatch(r.chipRows()[1]!.node, 'mouseenter')

  const first = r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'Escape' })
  assert.equal(first.defaultPrevented, true, 'consumed here, or it also closes a surface behind the composer')
  assert.deepEqual(r.flyoutItems(), [])
  assert.equal(r.chipRows().length, 2, 'the popover itself is still open')

  r.stub.dispatch(r.els.chipShell, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.chipRows(), [])
  assert.equal(r.stub.activeElement(), r.els.chipRuntime)
})

test('focus leaving the chip shell closes the popover; moving inside it does not', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipRuntime)
  r.composer.showRuntimeMenu(menuView())

  r.stub.dispatch(r.els.chipShell, 'focusout', { relatedTarget: r.chipRows()[0]!.node })
  assert.equal(r.chipRows().length, 2)

  r.stub.dispatch(r.els.chipShell, 'focusout', { relatedTarget: r.els.input })
  assert.deepEqual(r.chipRows(), [])
})

test('the send button is idle when empty, ready when typed into', (t) => {
  const r = render(t)
  assert.deepEqual(r.view('submit').classes.includes('idle'), true)

  input(r).value = 'hello'
  // Through the event, not through a method: this is the path a keystroke takes.
  r.stub.dispatch(r.els.input, 'input')
  assert.deepEqual(r.view('submit').classes, ['ready'])

  input(r).value = '   '
  r.stub.dispatch(r.els.input, 'input')
  assert.deepEqual(r.view('submit').classes, ['idle'], 'whitespace is not a message')
})

test('a programmatic edit updates the button too', (t) => {
  // A restored draft (`restoreInput`) fires no `input` event, and a button left
  // reading "idle" would be the only thing on screen saying there is nothing to send.
  const r = render(t)
  r.composer.setValue('recovered draft', 5)
  assert.deepEqual(r.view('submit').classes, ['ready'])

  r.composer.clear()
  assert.deepEqual(r.view('submit').classes, ['idle'])
})

test('mid-turn one button: stop while empty, lit send once something is typed', (t) => {
  const r = render(t)
  r.composer.setStreaming(true)
  assert.equal(r.view('stop').hidden, false)
  assert.equal(r.view('submit').hidden, true, 'stop takes the send button’s place')
  // Icon-only, so the name is all a screen reader or a hover has to go on.
  assert.equal(r.view('stop').attributes.get('aria-label'), '停止（Esc）')

  input(r).value = 'next message'
  r.stub.dispatch(r.els.input, 'input')
  assert.equal(r.view('stop').hidden, true)
  assert.equal(r.view('submit').hidden, false)
  assert.deepEqual(r.view('submit').classes, ['ready'])
  // Enabled in every state: `requestSubmit()` ignores a disabled button, so the
  // click would vanish with no error anywhere.
  assert.equal(r.view('submit').disabled, false)
  assert.equal(r.view('submit').attributes.get('aria-label'), '发送到当前轮次')

  r.composer.setStreaming(false)
  assert.deepEqual(r.view('submit').classes, ['ready'])
  assert.equal(r.view('stop').hidden, true)
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const r = render(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'composerView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  assert.ok(members.size >= 4, [...members].join(', '))
  for (const member of members) {
    assert.equal(r.stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})

// --- the inline permission request -------------------------------------------

/**
 * The permission request moved out of the modal layer and into the capsule
 * (`dom/permissionRequestView.ts`) and, with the question and plan cards, shares
 * one dock that transforms the composer.
 *
 * What it *says* is still `model/permissionDialog.ts`'s view model, so nothing
 * about the options is asserted here — only that the card hands back the same
 * `OverlayAction` the modal did, and that showing and hiding leave the composer
 * in the two states it has: a card with no textarea, or a textarea with no card.
 */

function permissionFixture(
  overrides: Partial<PermissionViewModel> = {},
): PermissionViewModel {
  return {
    title: 'Bash 命令',
    subtitle: '需确认 · 权限模式',
    reason: '当前权限模式要求确认。',
    tone: 'normal',
    inputBlock: { kind: 'bash', label: '命令', content: 'rm -rf ./tmp' },
    warnings: [],
    denialStreakNote: undefined,
    options: [
      { label: '允许一次', hotkey: 'y', action: 'allow' },
      { label: '拒绝', hotkey: 'n', action: 'deny' },
    ],
    selectedIndex: 0,
    preview: undefined,
    alsoWaiting: [],
    actions: [
      { label: '允许一次', shortcut: 'Y', role: 'primary', slot: 0 },
      { label: '拒绝', shortcut: 'N', role: 'secondary', slot: 1 },
    ],
    ...overrides,
  }
}

interface Card {
  readonly stub: DomStub
  readonly composer: HTMLElement
  readonly container: HTMLElement
  readonly view: ReturnType<typeof createPermissionRequestView>
  readonly picked: OverlayAction[]
  buttons(): StubView[]
}

function card(t: { after(fn: () => void): void }): Card {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const composer = stub.createContainer('composer')
  const container = stub.createContainer('composer-request')
  const picked: OverlayAction[] = []
  const view = createPermissionRequestView(createDockedCard(composer, container), container, (action) => picked.push(action))
  const buttons = () => {
    const bar = stub.inspect(container).children.find((child) =>
      child.classes.includes('dialog-actions'))
    assert.ok(bar, 'the card ends with the shared button bar')
    return [...bar.children]
  }
  return { stub, composer, container, view, picked, buttons }
}

test('the request transforms the composer rather than covering the lane', (t) => {
  const c = card(t)
  assert.equal(c.stub.inspect(c.container).hidden, true, 'nothing is drawn at rest')

  c.view.show(permissionFixture())

  // The class is what the stylesheet hangs `display: none` for the textarea and
  // the action bar on. Without it the request would be drawn *above* a live
  // composer, which is the modal it replaced with an extra step.
  assert.ok(c.stub.inspect(c.composer).classes.includes('request-open'))
  assert.equal(c.stub.inspect(c.container).hidden, false)
  // The tone is on the card, never on the capsule: the composer's border is a
  // focus affordance, and recolouring it would read as a validation error.
  assert.ok(c.stub.inspect(c.container).classes.includes('tone-normal'))
  assert.equal(c.stub.inspect(c.composer).classes.includes('tone-normal'), false)

  c.view.hide()
  assert.equal(c.stub.inspect(c.composer).classes.includes('request-open'), false)
  assert.equal(c.stub.inspect(c.container).attributes.has('inert'), true)
  assert.equal(c.stub.inspect(c.container).classes.includes('presence-closing'), true)
  c.stub.dispatch(c.container, 'transitionend', { propertyName: 'opacity' })
  assert.equal(c.stub.inspect(c.container).hidden, true)
  // Emptied, not merely hidden: a stale button answers a settled request, and a
  // hidden one is still a Tab stop in some engines.
  assert.equal(c.stub.inspect(c.container).children.length, 0)
})

test('M16 permission replies precede exit and typing during the handoff stays in the original input', (t) => {
  const r = render(t)
  const capsule = r.stub.createContainer()
  const request = r.stub.createContainer()
  capsule.appendChild(request)
  capsule.appendChild(r.els.input)
  let layouts = 0
  const replies: OverlayAction[] = []
  const dock = createDockedCard(capsule, request, { onLayoutChange: () => { layouts += 1 }, onReturnFocus: () => r.composer.focus() })
  const card = createPermissionRequestView(dock, request, (action) => {
    assert.equal(request.classList.contains('presence-closing'), false, 'business receives the intent before exit')
    replies.push(action)
    card.hide()
  })
  r.stub.onLayout((node) => node.node === capsule
    ? { top: 0, bottom: capsule.classList.contains('request-open') ? 220 : 90 } : undefined)
  card.show(permissionFixture({ selectedIndex: 1 }))
  const action = r.stub.inspect(request).children.find((node) => node.classes.includes('dialog-actions'))!.children[1]!
  assert.equal(r.stub.activeElement(), action.node)
  r.stub.click(action.node)
  assert.deepEqual(replies, [{ kind: 'slot', index: 1 }])
  assert.equal(r.stub.activeElement(), r.els.input)
  assert.equal(request.classList.contains('presence-closing'), true)
  assert.equal(capsule.classList.contains('request-changing'), true)
  input(r).value = '在退出时继续输入'
  r.stub.dispatch(r.els.input, 'input')
  r.stub.dispatch(request, 'transitionend', { propertyName: 'opacity' })
  r.stub.dispatch(capsule, 'transitionend', { propertyName: 'height' })
  assert.equal(input(r).value, '在退出时继续输入')
  assert.equal(r.els.input.parentElement, capsule)
  assert.equal(layouts, 2, 'both directions notify the viewport before changing shape')
  assert.equal(capsule.classList.contains('request-changing'), false)
  card.show(permissionFixture())
  card.hide(true)
  assert.equal(request.hidden, true, 'a pane switch leaves no outgoing request')
})

test('M19 a preference change releases the composer height and new reduced requests settle in 1ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const c = card(t)
  c.stub.onLayout((node) => node.node === c.composer ? { top: 0, bottom: 140 } : undefined)
  c.view.show(permissionFixture())
  assert.equal(c.composer.classList.contains('request-changing'), true)
  ;(c.stub.documentElement() as HTMLElement).dataset.reducedMotion = 'true'
  c.view.finishMotion()
  assert.equal(c.composer.style.height, '')
  assert.equal(c.composer.classList.contains('request-changing'), false)
  c.view.hide()
  t.mock.timers.tick(1)
  assert.equal(c.container.hidden, true)
  c.view.show(permissionFixture())
  assert.equal(c.composer.classList.contains('request-changing'), false)
  c.view.hide()
  t.mock.timers.tick(1)
  assert.equal(c.stub.inspect(c.container).children.length, 0)
})

test('the card answers by slot, exactly as the modal did', (t) => {
  const c = card(t)
  c.view.show(permissionFixture({ selectedIndex: 1 }))

  const [allow, deny] = c.buttons()
  assert.equal(allow!.text, '允许一次Y', 'the label carries its key as a badge')
  assert.ok(allow!.classes.includes('primary'))
  // Where Enter is aimed — on a destructive request the model focuses deny, so
  // this mark is the answer about to be given rather than decoration.
  assert.equal(allow!.classes.includes('selected'), false)
  assert.ok(deny!.classes.includes('selected'))

  c.stub.click(deny!.node)
  c.stub.click(allow!.node)
  assert.deepEqual(c.picked, [{ kind: 'slot', index: 1 }, { kind: 'slot', index: 0 }])
})

test('nothing in the card is a target except its buttons', (t) => {
  const c = card(t)
  c.view.show(permissionFixture({
    denialStreakNote: '已拒绝过一次。',
    alsoWaiting: ['Write'],
  }))

  // The request is holding the agent loop, so there is no dismissing it by
  // clicking beside it — the same rule the modal's backdrop follows.
  for (const child of c.stub.inspect(c.container).children) {
    if (child.classes.includes('dialog-actions')) continue
    c.stub.click(child.node)
  }
  c.stub.click(c.container)
  c.stub.click(c.composer)
  assert.deepEqual(c.picked, [])
})

test('the glyph names what is being asked for, and comes off the input block', (t) => {
  // Read off the block rather than off a tool name: the block is already the
  // projection that knows a Bash request carries a command and a file tool
  // carries a path, and a second list of tool names here would drift from it.
  assert.equal(permissionGlyphFor('bash'), 'terminal')
  assert.equal(permissionGlyphFor('file'), 'file')
  assert.equal(permissionGlyphFor('json'), 'shield')
  assert.equal(permissionGlyphFor('none'), 'shield')
})

test('the capsule holds the card, and the page still has somewhere to put it', () => {
  // Asserted against the page for the reason the composer popovers are: `app.ts`
  // finds both by `getElementById`, so nothing in the renderer would notice the
  // card drifting out of the capsule — only the shape on screen would.
  const html = readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  const start = html.indexOf('<div id="composer">')
  assert.ok(start !== -1, 'the page still has the composer capsule')
  const end = html.indexOf('<div id="status">', start)
  assert.ok(end !== -1, 'the status line still follows the capsule')
  const capsule = html.slice(start, end)

  const request = capsule.indexOf('id="composer-request"')
  assert.ok(request !== -1, 'the request card left the capsule')
  // Before the textarea it replaces, so the request reads top-down where the
  // message being typed used to be.
  assert.ok(request < capsule.indexOf('id="input"'))
  assert.ok(request < capsule.indexOf('id="composer-bar"'))
})

test('an unchanged runtime snapshot rebuilds neither the chip nor the pill', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  const chipBefore = r.view('chipRuntime').children.map((child) => child.node)
  const pillBefore = r.view('chipPermission').children.map((child) => child.node)

  // `renderRuntime` is reached from the snapshot tick, which during a turn fires
  // once per streamed chunk. Identity, not equality: rebuilding a control under
  // the pointer at that rate is what this guard exists to stop.
  for (let tick = 0; tick < 5; tick += 1) r.composer.renderRuntime(runtime())
  assert.deepEqual(r.view('chipRuntime').children.map((child) => child.node), chipBefore)
  assert.deepEqual(r.view('chipPermission').children.map((child) => child.node), pillBefore)

  // A snapshot that moved still repaints, or the guard would be a freeze.
  r.composer.renderRuntime(runtime({ modelKey: 'opus', model: 'claude-opus-5', permissionMode: 'plan' }))
  assert.notDeepEqual(r.view('chipRuntime').children.map((child) => child.node), chipBefore)
  assert.equal(r.view('chipRuntime').children[1]!.text, 'opus')
  assert.equal(r.view('chipPermission').children[0]!.text, PERMISSION_MODE_LABELS.plan)
})

test('an unchanged context gauge does not rebuild the hover card', (t) => {
  const r = render(t)
  const runtimeSnapshot = runtime({ contextWindow: 200_000, usableContextWindow: 100_000 })
  const gauge = contextGaugeView(90_000, runtimeSnapshot)
  r.composer.renderRuntime(runtimeSnapshot, gauge)
  const before = r.view('contextIndicator').children.map((child) => child.node)

  for (let tick = 0; tick < 5; tick += 1) r.composer.renderRuntime(runtimeSnapshot, gauge)
  assert.deepEqual(
    r.view('contextIndicator').children.map((child) => child.node),
    before,
    'streaming snapshots must not replace a tooltip the pointer is over',
  )

  r.composer.renderRuntime(runtimeSnapshot, contextGaugeView(95_000, runtimeSnapshot))
  assert.deepEqual(
    r.view('contextIndicator').children.map((child) => child.node),
    before,
  )
  assert.match(r.view('contextIndicator').text, /95%/)
  assert.equal(r.view('contextIndicator').children[0]?.children[0]?.className, 'context-gauge critical')
})

test('the guard does not swallow the click that opens the permission menu', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  assert.equal(r.menuItems().length, 0)

  // The open flag is part of the pill's signature for the same reason
  // `menuOpen` is part of `sidebarRenderSignature`.
  r.stub.click(r.els.chipPermission)
  assert.ok(r.menuItems().length > 0, 'the menu opened')
  r.stub.click(r.els.chipPermission)
  assert.equal(r.menuItems().length, 0, 'and closed again')
})

test('permission menu exit is inert and reverses on the same node', (t) => {
  const r = render(t)
  r.composer.renderRuntime(runtime())
  r.stub.click(r.els.chipPermission)
  const menu = r.view('permissionShell').children.find((node) => node.classes.includes('permission-menu'))!.node
  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.equal(r.stub.inspect(menu).classes.includes('presence-closing'), true)
  assert.equal(r.stub.inspect(menu).attributes.has('inert'), true)
  assert.equal(r.stub.activeElement(), r.els.chipPermission)
  r.stub.click(r.els.chipPermission)
  assert.equal(r.view('permissionShell').children.find((node) => node.classes.includes('permission-menu'))!.node, menu)
  assert.equal(r.stub.inspect(menu).classes.includes('presence-entering'), true)
  assert.equal(r.stub.inspect(menu).attributes.has('inert'), false)
  r.composer.closeMenus()
  assert.equal(r.stub.inspect(menu).hidden, true, 'pane deactivation settles visual exits')
})

test('tooltip Escape exits while the indicator stays hovered and values retain identity', (t) => {
  const r = render(t)
  const snapshot = runtime({ usableContextWindow: 100_000 })
  r.composer.renderRuntime(snapshot, contextGaugeView(40_000, snapshot))
  r.stub.dispatch(r.els.contextIndicator, 'mouseenter')
  const tooltip = r.view('contextIndicator').children[1]!.node
  r.stub.dispatch(tooltip, 'transitionend', { propertyName: 'opacity' })
  r.composer.renderRuntime(snapshot, contextGaugeView(45_000, snapshot))
  assert.equal(r.view('contextIndicator').children[1]!.node, tooltip)
  assert.equal(r.stub.inspect(tooltip).classes.includes('presence-open'), true)
  r.stub.dispatch(r.els.contextIndicator, 'keydown', { key: 'Escape' })
  assert.equal(r.stub.inspect(tooltip).classes.includes('presence-closing'), true)
  r.stub.dispatch(tooltip, 'transitionend', { propertyName: 'opacity' })
  assert.equal(r.stub.inspect(tooltip).hidden, true)
})

// --- the attachment control (S11) -------------------------------------------------

import type { AttachmentStripView } from '../src/desktop/renderer/model/composerAttachments.js'

/** A grid the pane would paint: one ready, one importing, one failed. */
function stripView(overrides: Partial<AttachmentStripView> = {}): AttachmentStripView {
  return {
    rows: [
      { draftId: 'd1', state: 'ready', label: '图片 1：shot.png，1920×1080，动画首帧', name: 'shot.png' },
      { draftId: 'd2', state: 'importing', label: '图片 2：waiting.png', name: 'waiting.png', detail: '导入中…' },
      { draftId: 'd3', state: 'failed', label: '图片 3：bad.png', name: 'bad.png', detail: '失败：not decodable' },
    ],
    readyCount: 1,
    ...overrides,
  }
}

test('the + menu offers both entrances and keeps the @ path intact', (t) => {
  const r = render(t)
  r.stub.click(r.els.attach)
  assert.deepEqual(r.attachMenuItems().map((item) => item.text), ['选择图片', '引用项目文件（@）'])
  // Two commands, so a menu: a listbox made each read as an unselected option.
  assert.equal(r.view('attach').attributes.get('aria-haspopup'), 'menu')
  assert.equal(r.view('attach').attributes.get('aria-expanded'), 'true')
  assert.deepEqual(r.attachMenuItems().map((item) => item.attributes.get('role')), ['menuitem', 'menuitem'])
  assert.ok(r.attachMenuItems().every((item) => !item.attributes.has('aria-selected')))

  r.stub.click(r.attachMenuItems()[1]!.node)
  assert.deepEqual(r.attaches, [1], 'the mention path still asks the pane to recompute completions')
  assert.equal(input(r).value, '@')
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.stub.click(r.attachMenuItems()[0]!.node)
  assert.deepEqual(r.pickedImages, [1])
})

test('the + menu closes three ways and never while clicking inside it', (t) => {
  const r = render(t)
  r.stub.click(r.els.attach)

  r.stub.dispatch(r.attachShell, 'keydown', { key: 'Escape' })
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.stub.dispatchDocument('pointerdown', { target: r.attachMenuItems()[0]!.node })
  assert.equal(r.attachMenuItems().length, 2, 'a press on an item is not leaving')

  r.stub.dispatchDocument('pointerdown', { target: r.els.input })
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.stub.dispatch(r.attachShell, 'focusout', { relatedTarget: r.els.input })
  assert.deepEqual(r.attachMenuItems(), [])

  r.stub.click(r.els.attach)
  r.composer.closeMenus()
  assert.deepEqual(r.attachMenuItems(), [], 'a background pane cannot leave it hanging over the next one')
})

test('the + menu opens on its first entrance and the arrows rove it', (t) => {
  const r = render(t)
  r.stub.dispatch(r.attachShell, 'keydown', { key: 'ArrowDown', target: r.els.attach })
  assert.equal(r.attachMenuItems().length, 2, 'ArrowDown on the closed trigger opens it')

  const [pick, mention] = r.attachMenuItems()
  assert.equal(r.stub.activeElement(), pick!.node)
  r.stub.dispatch(r.attachShell, 'keydown', { key: 'ArrowDown', target: pick!.node })
  assert.equal(r.stub.activeElement(), mention!.node)
  r.stub.dispatch(r.attachShell, 'keydown', { key: 'ArrowDown', target: mention!.node })
  assert.equal(r.stub.activeElement(), pick!.node, 'wraps')
})

test('the grid draws every state, with remove and retry wired per tile', (t) => {
  const r = render(t)
  r.composer.renderAttachments(stripView())
  const tiles = r.attachmentRows()
  assert.deepEqual(tiles.map((tile) => tile.classes.includes('attachment-tile')), [true, true, true])
  // The name is not drawn — at 64px it would be truncated to nothing — so the
  // whole fact rides the tile's `title` instead.
  assert.deepEqual(tiles.map((tile) => tile.attributes.get('title')), [
    '图片 1：shot.png，1920×1080，动画首帧',
    '图片 2：waiting.png（导入中…）',
    '图片 3：bad.png（失败：not decodable）',
  ])

  // Ready: [thumbnail, remove]. The thumbnail opens the viewer; nothing else
  // in the tile is a control.
  const ready = tiles[0]!
  assert.equal(ready.children[0]?.classes.includes('attachment-thumb'), true)
  assert.equal(ready.children[1]?.classes.includes('attachment-remove'), true)
  r.stub.click(ready.children[0]!.node)
  assert.deepEqual(r.previewedDrafts, ['d1'])

  // Failed: the 64px box with its controls, and the reason beside it in words
  // — a hover tooltip is not where a refusal should live.
  const failed = tiles[2]!
  const picture = failed.children[0]!
  assert.equal(picture.classes.includes('attachment-picture'), true)
  assert.equal(picture.children[0]?.classes.includes('attachment-placeholder'), true, 'a failed tile has no picture to show')
  const retry = picture.children.find((child) => child.classes.includes('attachment-retry'))
  assert.ok(retry, 'a failed tile offers 重试')
  r.stub.click(retry.node)
  assert.deepEqual(r.retriedDrafts, ['d3'])
  r.stub.click(picture.children.find((child) => child.classes.includes('attachment-remove'))!.node)
  assert.deepEqual(r.removedDrafts, ['d3'])
  assert.equal(failed.children[1]?.classes.includes('attachment-reason'), true)
  assert.equal(failed.children[1]?.text, '失败：not decodable')
  assert.equal(
    tiles.flatMap((tile) => tile.children.filter((child) => child.classes.includes('attachment-reason'))).length,
    1,
    'only a failed tile draws a reason',
  )

  const importing = tiles[1]!
  assert.equal(importing.children.find((child) => child.classes.includes('attachment-retry')), undefined)
  r.stub.click(importing.children.find((child) => child.classes.includes('attachment-remove'))!.node)
  assert.deepEqual(r.removedDrafts, ['d3', 'd2'])
})

test('an unchanged strip is not rebuilt; the send note rides the submit button', (t) => {
  const r = render(t)
  const view = stripView({ sendBlockNote: '当前模型不支持图像输入。' })
  r.composer.renderAttachments(view)
  const before = r.attachmentRows().map((row) => row.node)

  for (let tick = 0; tick < 5; tick += 1) r.composer.renderAttachments(view)
  assert.deepEqual(r.attachmentRows().map((row) => row.node), before, 'streaming-rate repaints must not rebuild a row under the pointer')
  assert.match((r.els.submit as { title: string }).title, /当前模型不支持图像输入/)

  // The note leaves with the state that caused it.
  r.composer.renderAttachments(stripView())
  assert.equal((r.els.submit as { title: string }).title, '发送')

  // A changed strip still repaints, or the signature guard would be a freeze.
  const changed = stripView({ rows: stripView().rows.slice(0, 1) })
  r.composer.renderAttachments(changed)
  assert.equal(r.attachmentRows().length, 1)

  // Empty repaints clear the host, and do not paint an empty list.
  r.composer.renderAttachments({ rows: [], readyCount: 0 })
  assert.deepEqual(r.attachmentRows(), [])
})

test('an image paste becomes attachments; a text paste stays the textarea\'s', (t) => {
  const r = render(t)
  const image = { name: 'shot.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) }
  const text = { name: 'notes.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) }

  const imagePaste = r.stub.dispatch(r.els.input, 'paste', {
    clipboardData: { files: [image] },
  })
  assert.equal(imagePaste.defaultPrevented, true, 'an image paste must not also insert text')
  assert.equal(r.pastedFiles.length, 1)
  assert.deepEqual(r.pastedFiles[0]!.map((file) => file.name), ['shot.png'])

  const textPaste = r.stub.dispatch(r.els.input, 'paste', {
    clipboardData: { files: [text] },
  })
  assert.equal(textPaste.defaultPrevented, false)
  assert.equal(r.pastedFiles.length, 1, 'a text paste is none of this view\'s business')

  const emptyPaste = r.stub.dispatch(r.els.input, 'paste', {})
  assert.equal(emptyPaste.defaultPrevented, false)
  assert.equal(r.pastedFiles.length, 1)
})

// --- thumbnails (S12) --------------------------------------------------------
//
// The preview popover this section used to cover is gone: a tile's click opens
// the window's fullscreen viewer now, which is `test/rendererImageViewer*`'s
// business. What is left here is the tile's half — the URL it paints, and the
// repaint discipline around the URL arriving.

test('a ready tile paints a thumbnail whose click opens the viewer', (t) => {
  const r = render(t)
  r.composer.renderAttachments(stripView({ rows: [
    { draftId: 'd1', state: 'ready', label: '图片 1：shot.png，1920×1080', name: 'shot.png', imageId: 'img-1', thumbUrl: 'data:image/png;base64,AA' },
  ] }))
  const tile = r.attachmentRows()[0]!
  const thumb = tile.children.find((child) => child.classes.includes('attachment-thumb'))
  assert.ok(thumb, 'a ready tile paints a thumbnail')
  assert.equal(thumb.attributes.get('src'), 'data:image/png;base64,AA')
  assert.equal(thumb.attributes.get('alt'), '图片 1：shot.png，1920×1080')

  r.stub.click(thumb.node)
  assert.deepEqual(r.previewedDrafts, ['d1'])
  assert.deepEqual(r.openedDrafts, [], 'the tile opens the viewer, not the system image viewer')
  // The keyboard's two presses for a `role="button"`, each with its default
  // taken so neither reaches the viewer's close button or scrolls the page.
  assert.equal(r.stub.dispatch(thumb.node, 'keydown', { key: 'Enter' }).defaultPrevented, true)
  assert.equal(r.stub.dispatch(thumb.node, 'keydown', { key: ' ' }).defaultPrevented, true)
  assert.deepEqual(r.previewedDrafts, ['d1', 'd1', 'd1'])

  // A ready tile without a URL yet paints the thumbnail without a src — the
  // alt text carries the facts until the on-demand load settles.
  r.composer.renderAttachments(stripView())
  const pending = r.attachmentRows()[0]!.children.find((child) => child.classes.includes('attachment-thumb'))
  assert.ok(pending)
  assert.equal(pending.attributes.has('src'), false)
  assert.equal(pending.attributes.get('alt'), '图片 1：shot.png，1920×1080，动画首帧')
})

test('a thumbnail arriving later repaints the tile once; an unchanged grid does not', (t) => {
  const r = render(t)
  r.composer.renderAttachments(stripView())
  const before = r.attachmentRows()[0]!.node
  for (let tick = 0; tick < 5; tick += 1) r.composer.renderAttachments(stripView())
  assert.equal(r.attachmentRows()[0]!.node, before, 'no URL, no rebuild — the frame budget holds')

  r.composer.renderAttachments(stripView({ rows: [
    { draftId: 'd1', state: 'ready', label: '图片 1：shot.png，1920×1080', name: 'shot.png', imageId: 'img-1', thumbUrl: 'data:image/png;base64,BB' },
  ] }))
  const after = r.attachmentRows()[0]!.node
  assert.notEqual(after, before, 'a gained URL is real content change')
  assert.equal(
    r.attachmentRows()[0]!.children.find((child) => child.classes.includes('attachment-thumb'))?.attributes.get('src'),
    'data:image/png;base64,BB',
  )
})

// --- the docked question card ---------------------------------------------------

function askModel(overrides: Partial<{ multiSelect: boolean; questions: number }> = {}): AskViewModel {
  const question = (index: number) => ({
    question: `问题 ${index}？`,
    header: `头${index}`,
    multiSelect: overrides.multiSelect ?? false,
    options: [{ label: '甲', description: '第一个' }, { label: '乙', description: '第二个' }],
  })
  const view = askViewModel(createAskState({
    questions: Array.from({ length: overrides.questions ?? 1 }, (_, index) => question(index + 1)),
  }))
  assert.ok(view)
  return view
}

function questionCard(t: { after(fn: () => void): void }) {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const composer = stub.createContainer('composer')
  const container = stub.createContainer('composer-request')
  const intents: AskIntent[] = []
  const view = createQuestionCardView(createDockedCard(composer, container), container, (intent) => intents.push(intent), 'darwin')
  const card = () => stub.inspect(container).children[0]!
  const find = (cls: string) => stub.inspect(container).children[0]!.children.find((child) => child.classes.includes(cls))!
  return { stub, composer, container, view, intents, card, find }
}

test('the question card docks in the composer with rows, digit hints and an Other input', (t) => {
  const q = questionCard(t)
  q.view.show(askModel())

  assert.ok(q.stub.inspect(q.composer).classes.includes('request-open'))
  const rows = q.find('ask-options').children
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((row) => row.children.find((c) => c.classes.includes('kbd'))?.text), ['1', '2', '3'])
  const input = rows[2]!.children[0]!.children.find((c) => c.classes.includes('ask-other-input'))
  assert.equal(input?.attributes.get('placeholder'), '输入你自己的答案')

  const footer = q.find('ask-footer')
  const submit = footer.children.find((c) => c.text.startsWith('提交'))!
  assert.equal(submit.disabled, true, 'nothing selected yet')
  assert.equal(q.find('ask-head').children.some((c) => c.classes.includes('ask-chip')), false, 'one question has no number chip')
  assert.equal(submit.children.find((c) => c.classes.includes('kbd'))?.text, '⌘⏎')

  q.stub.click(rows[1]!.node)
  assert.deepEqual(q.intents, [{ kind: 'select', index: 1 }])
})

test('the card reports skip from the close button and the footer, and submit from the bar', (t) => {
  const q = questionCard(t)
  const model = askModel({ questions: 2 })
  q.view.show({ ...model, canSubmit: true })

  const head = q.find('ask-head')
  q.stub.click(head.children.find((c) => c.attributes.get('aria-label') === '跳过')!.node)
  q.stub.click(head.children.find((c) => c.attributes.get('aria-label') === '收起')!.node)
  const footer = q.find('ask-footer')
  assert.equal(head.children.find((c) => c.classes.includes('ask-chip'))?.text, '1/2')
  q.stub.click(footer.children.find((c) => c.text === '跳过')!.node)
  q.stub.click(footer.children.find((c) => c.text.startsWith('下一个'))!.node)

  assert.deepEqual(q.intents, [{ kind: 'skip' }, { kind: 'toggle-collapse' }, { kind: 'skip' }, { kind: 'commit' }])
})

test('the question card takes focus like the other cards, and keeps it across a rebuild', (t) => {
  // It used to be the one docked card that left focus in the textarea, so a
  // screen reader never heard the question. The options are a single stop that
  // names the cursor row; they cannot be buttons, since 「其他」 holds an input.
  const q = questionCard(t)
  const fresh = askModel()
  const model = { ...fresh, rows: fresh.rows.map((row, index) => ({ ...row, selected: index === 0 })) }
  q.view.show(model)
  const options = () => q.find('ask-options')
  assert.equal(q.stub.activeElement(), options().node, 'opening focuses the options')
  assert.equal(options().attributes.get('role'), 'listbox')
  assert.equal(options().attributes.get('aria-multiselectable'), undefined)
  const cursor = options().children.find((row) => row.classes.includes('selected'))!
  assert.equal(options().attributes.get('aria-activedescendant'), cursor.attributes.get('id'))

  // Tabbed to 跳过, then a repaint that rebuilds the card: focus stays on 跳过.
  q.stub.focus(q.find('ask-footer').children.find((c) => c.text === '跳过')!.node)
  q.view.show({ ...model, rows: model.rows.map((row, index) => ({ ...row, selected: index === 1 })) })
  assert.equal(q.stub.activeElement(), q.find('ask-footer').children.find((c) => c.text === '跳过')!.node)

  // Folded, the button that unfolds it is where focus goes.
  q.view.show({ ...model, collapsed: true })
  const collapse = q.find('ask-head').children.find((c) => c.attributes.get('aria-label') === '展开')!
  assert.equal(q.stub.activeElement(), collapse.node)
})

test('a multi-select question says so, and its ticks are what is selected', (t) => {
  const q = questionCard(t)
  const model = askModel({ multiSelect: true })
  q.view.show({ ...model, rows: model.rows.map((row, index) => ({ ...row, toggled: index === 1 })) })
  const options = q.find('ask-options')
  assert.equal(options.attributes.get('aria-multiselectable'), 'true')
  assert.deepEqual(options.children.slice(0, 2).map((row) => row.attributes.get('aria-selected')), ['false', 'true'])
})

test('collapsed, the card is just its title row', (t) => {
  const q = questionCard(t)
  q.view.show({ ...askModel(), collapsed: true })

  assert.ok(q.card().classes.includes('collapsed'))
  assert.deepEqual(q.card().children.map((c) => c.classes[0]), ['ask-head'])
})

test('typing in Other only updates the submit button; the input is never rebuilt', (t) => {
  const q = questionCard(t)
  const model = { ...askModel(), otherMode: true }
  q.view.show(model)
  const card = q.card().node
  const input = q.stub.inspect(q.container).children[0]!
    .children.find((c) => c.classes.includes('ask-options'))!.children[2]!.children[0]!.children
    .find((c) => c.classes.includes('ask-other-input'))!
  assert.equal(q.stub.activeElement(), input.node, 'moving onto Other focuses the field')

  ;(input.node as unknown as { value: string }).value = '自己的'
  q.stub.dispatch(input.node, 'input')
  assert.deepEqual(q.intents.at(-1), { kind: 'other-set', text: '自己的' })

  q.view.show({ ...model, otherText: '自己的', canSubmit: true })
  assert.equal(q.card().node, card, 'only the text changed, so nothing is rebuilt')
  const submit = q.find('ask-footer').children.find((c) => c.text.startsWith('提交'))!
  assert.equal(submit.disabled, false)
  assert.equal(q.stub.activeElement(), input.node)
})

// --- the docked plan card and the plan panel -----------------------------------

function planCard(t: { after(fn: () => void): void }) {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const composer = stub.createContainer('composer')
  const container = stub.createContainer('composer-request')
  const enter: EnterPlanIntent[] = []
  const exit: ExitPlanIntent[] = []
  let opened = 0
  const view = createPlanCardView(createDockedCard(composer, container), container, {
    onEnterIntent: (intent) => enter.push(intent),
    onExitIntent: (intent) => exit.push(intent),
    onOpenPlan: () => { opened += 1 },
  })
  const find = (cls: string) => {
    const found = stub.inspect(container).children[0]!.children.find((c) => c.classes.includes(cls))
    assert.ok(found, `the card has .${cls}`)
    return found
  }
  const buttons = () => find('dialog-actions').children.flatMap((group) => group.children)
  return { stub, composer, container, view, enter, exit, opened: () => opened, find, buttons }
}

const planState = () => createExitPlanState({ planContent: '# 计划\n- 做事', planFilePath: '/tmp/plan.md' })

test('the enter-plan card is one question with 拒绝 and 允许', (t) => {
  const p = planCard(t)
  p.view.showEnter(enterPlanViewModel('darwin'))

  assert.ok(p.stub.inspect(p.composer).classes.includes('request-open'))
  assert.equal(p.find('request-question').text, '先读代码、出方案，你确认前不会修改文件')
  assert.deepEqual(p.buttons().map((b) => b.text), ['拒绝Esc', '允许⏎'])
  assert.equal(p.stub.activeElement(), p.buttons()[1]!.node, 'the primary takes focus on open')
  p.stub.click(p.buttons()[0]!.node)
  p.stub.click(p.buttons()[1]!.node)
  assert.deepEqual(p.enter, [{ kind: 'answer', approved: false }, { kind: 'answer', approved: true }])
})

test('the exit-plan card reports every button as the intent its key produces', (t) => {
  const p = planCard(t)
  p.view.showExit(exitPlanViewModel(planState(), 'darwin'))

  const head = p.find('request-head')
  assert.equal(head.children.find((c) => c.classes.includes('request-title'))?.text, '助手提出了一个计划')
  p.stub.click(head.children.find((c) => c.text === '打开计划')!.node)
  assert.equal(p.opened(), 1)

  assert.deepEqual(p.buttons().map((b) => b.text), ['拒绝', '修改…Esc', '接受⇧⌘⏎', '接受并自动执行⌘⏎'])
  for (const button of p.buttons()) p.stub.click(button.node)
  assert.deepEqual(p.exit, [
    { kind: 'reject' },
    { kind: 'modify' },
    { kind: 'approve', slot: 1 },
    { kind: 'approve', slot: 0 },
  ])
})

test('修改… swaps the buttons, focuses the field, and typing only touches 发送', (t) => {
  const p = planCard(t)
  p.view.showExit(exitPlanViewModel(planState(), 'darwin'))
  const modifying = { ...planState(), modifying: true }
  p.view.showExit(exitPlanViewModel(modifying, 'darwin'))

  const input = p.stub.inspect(p.container).children[0]!.children.find((c) => c.classes.includes('plan-feedback-input'))!
  assert.equal(input.attributes.get('placeholder'), '告诉助手要怎么改')
  assert.equal(p.stub.activeElement(), input.node)
  const card = p.stub.inspect(p.container).children[0]!.node
  assert.equal(p.buttons().find((b) => b.text.startsWith('发送'))!.disabled, true)

  ;(input.node as unknown as { value: string }).value = '先补测试'
  p.stub.dispatch(input.node, 'input')
  assert.deepEqual(p.exit.at(-1), { kind: 'feedback-set', text: '先补测试' })

  p.view.showExit(exitPlanViewModel({ ...modifying, feedback: '先补测试' }, 'darwin'))
  assert.equal(p.stub.inspect(p.container).children[0]!.node, card, 'nothing is rebuilt while typing')
  assert.equal(p.buttons().find((b) => b.text.startsWith('发送'))!.disabled, false)
  assert.equal(p.stub.activeElement(), input.node)
})

test('an empty plan card has only 拒绝 and 接受', (t) => {
  const p = planCard(t)
  p.view.showExit(exitPlanViewModel(createExitPlanState({ planContent: ' ', planFilePath: '/tmp/plan.md' }), 'darwin'))
  assert.deepEqual(p.buttons().map((b) => b.text), ['拒绝Esc', '接受⏎'])
})

test('the plan panel draws the whole plan with its path, and only when it changed', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('plan-view')
  const view = createPlanPanelView(container)
  const long = Array.from({ length: 80 }, (_, i) => `- 步骤 ${i + 1}`).join('\n')

  view.render({ planContent: long, planFilePath: '/tmp/plan.md' })
  const [body, foot] = stub.inspect(container).children
  assert.ok(body!.classes.includes('plan-panel-body'))
  assert.ok(body!.text.includes('步骤 80'), 'not the truncated preview')
  assert.equal(foot!.children[0]!.text, '/tmp/plan.md')
  assert.equal(foot!.children[1]!.text, '复制')

  const first = body!.node
  view.render({ planContent: long, planFilePath: '/tmp/plan.md' })
  assert.equal(stub.inspect(container).children[0]!.node, first, 'an unchanged plan is not rebuilt')

  view.render(undefined)
  assert.equal(stub.inspect(container).text, '还没有计划')
})
