import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { cssBlocks, type Block } from './helpers/rendererCss.js'
import { createSettingsView } from '../src/desktop/renderer/dom/settingsView.js'
import {
  EFFORT_MENU_ID,
  applySettingsIntent,
  createSettingsState,
  settingsView,
  type SettingsIntent,
  type SettingsState,
  type SettingsViewModel,
} from '../src/desktop/renderer/model/settings.js'
import type { WireSettingsSnapshot } from '../src/desktop/shellProtocol.js'

/**
 * The settings screen's *nodes* — the half `rendererSettingsModel.test.ts` calls
 * deliberately uncovered.
 *
 * Three things here cannot be model-tested, which is why this file exists at all:
 * the search box has to survive the nav column's `replace()` with its caret, the
 * pill dropdown's open key is derived in the DOM rather than in the view model,
 * and `focusout` has to tell "the user left" from "this view repainted".
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

function snapshotOf(): WireSettingsSnapshot {
  return {
    projectRoot: 'C:\\repo\\alpha',
    projectName: 'alpha',
    saveTarget: 'C:\\repo\\alpha\\.myagent\\config.json',
    endpoints: [{ name: 'main', provider: 'anthropic' }],
    models: [{ key: 'big', model: 'claude-big', endpoint: 'main', resolves: true }],
    routing: { main: 'big', plan: 'inherit', compact: 'inherit', subagent: [] },
    defaultModel: 'big',
    providers: ['anthropic'],
    subagentTypes: [],
    permissions: {
      localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json',
      mode: 'default',
      modeIsLocal: false,
      groups: [
        { behavior: 'allow', local: [], inherited: [] },
        { behavior: 'ask', local: [], inherited: [] },
        { behavior: 'deny', local: [], inherited: [] },
      ],
    },
    agents: [],
    skills: [],
    skillsDir: 'C:\\repo\\alpha\\.myagent\\skills',
    mcpServers: [],
    contextManagement: {
      contextWindow: 200_000,
      summaryOutputTokens: 20_000,
      autoCompactBufferTokens: 13_000,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.9,
      autoCompactThresholdRatio: 0.93,
    },
    coordination: { quietDays: 7, autoResolveDays: 14 },
    general: { localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json' },
    userInstructions: '',
  }
}

function stateOf(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    ...createSettingsState(),
    open: true,
    projectRoot: 'C:\\repo\\alpha',
    snapshot: snapshotOf(),
    projects: [
      { projectRoot: 'C:\\repo\\alpha', projectName: 'alpha' },
      { projectRoot: 'C:\\repo\\beta', projectName: 'beta' },
    ],
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: SettingsIntent[]
  readonly keys: string[]
  view(): StubView
  render(state: SettingsState): void
  /** Feeds the intent back through the reducer, as `app.ts` does. */
  apply(intent: SettingsIntent): void
}

function mount(t: { after(fn: () => void): void }, initial = stateOf()): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('settings')
  const intents: SettingsIntent[] = []
  const keys: string[] = []
  let state = initial
  const dom = createSettingsView(
    container,
    (intent) => intents.push(intent),
    (chord) => {
      keys.push(chord.key)
      return true
    },
  )
  const render = (next: SettingsState): void => {
    state = next
    dom.render(settingsView(next))
  }
  render(initial)
  return {
    stub,
    container,
    intents,
    keys,
    view: () => stub.inspect(container),
    render,
    apply: (intent) => render(applySettingsIntent(state, intent).state),
  }
}

const child = (view: StubView, className: string): StubView => {
  const found = view.children.find((node) => node.classes.includes(className))
  assert.ok(found, `no .${className} in ${view.children.map((c) => c.className).join(' | ')}`)
  return found
}

/** Every node with a class, anywhere in the subtree. */
function findAll(view: StubView, className: string): StubView[] {
  const found: StubView[] = []
  const walk = (node: StubView): void => {
    if (node.classes.includes(className)) found.push(node)
    for (const kid of node.children) walk(kid)
  }
  walk(view)
  return found
}

function findOne(view: StubView, className: string): StubView {
  const all = findAll(view, className)
  assert.equal(all.length, 1, `expected exactly one .${className}, found ${all.length}`)
  return all[0]!
}

/** The form dialog, which lives beside the page rather than in it. */
function dialogOf(root: StubView): StubView {
  return child(child(root, 'settings-dialog-layer'), 'settings-dialog')
}

// --- the nav column ----------------------------------------------------------

test('the nav draws one section per group, labelled, in order', (t) => {
  const nav = child(mount(t).view(), 'settings-nav')
  const groups = findAll(nav, 'settings-nav-group')

  assert.equal(groups.length, 3)
  assert.deepEqual(
    groups.map((group) => child(group, 'settings-nav-group-label').text),
    ['个人', '集成', '编码'],
  )
  assert.deepEqual(
    groups.map((group) => findAll(group, 'settings-nav-item').map((item) => item.text)),
    [['通用', '个性化', '外观'], ['模型与服务商', '技能和 MCP'], ['权限', 'Agent']],
  )
})

test('the close button leads the column, outside the replaced region', (t) => {
  const { view, render } = mount(t)
  const before = child(view(), 'settings-nav')
  const closeBefore = findOne(before, 'settings-nav-close').node
  // First, not last: this screen covers the whole window (the sidebar included),
  // so the way back has to be where the eye starts rather than under a list the
  // user may have scrolled.
  assert.equal(before.children[0]?.node, closeBefore)
  // The list is what gets rebuilt; the search box and the close button are not.
  render(stateOf({ category: 'agent' }))
  const after = child(view(), 'settings-nav')
  assert.equal(findOne(after, 'settings-nav-close').node, closeBefore)
  assert.equal(after.children[0]?.node, closeBefore)
})

// --- the search box ----------------------------------------------------------

test('the search input is built once, so typing cannot lose the caret', (t) => {
  const { view, render } = mount(t)
  const before = findOne(child(view(), 'settings-nav'), 'settings-search').node
  render(stateOf({ query: 'MCP' }))
  const after = findOne(child(view(), 'settings-nav'), 'settings-search').node

  // Identity, not equality: the nav list around it is replaced on every render.
  assert.equal(after, before)
})

test('typing filters per keystroke, not on blur', (t) => {
  const { view, stub, intents } = mount(t)
  const search = findOne(child(view(), 'settings-nav'), 'settings-search')
  assert.equal(search.tagName, 'INPUT')
  assert.equal(search.attributes.get('aria-label'), '搜索设置')

  const node = search.node as { value: string }
  node.value = 'MC'
  stub.dispatch(search.node, 'input')
  assert.deepEqual(intents, [{ kind: 'search', query: 'MC' }])
})

test('the search box keeps its own editing keys, but not Escape', (t) => {
  const { view, stub, container, keys } = mount(t)
  const search = findOne(child(view(), 'settings-nav'), 'settings-search')

  for (const key of ['Backspace', 'ArrowLeft', 'a']) {
    stub.dispatch(container, 'keydown', { target: search.node, key })
  }
  assert.deepEqual(keys, [], 'the input owns text editing')

  // Escape must still reach the model, or 关闭设置（Esc） becomes a lie the moment
  // focus enters the box.
  stub.dispatch(container, 'keydown', { target: search.node, key: 'Escape' })
  assert.deepEqual(keys, ['Escape'])
})

test('the box is emptied when the model clears the query, and never otherwise', (t) => {
  const { view, render } = mount(t)
  const search = findOne(child(view(), 'settings-nav'), 'settings-search')
  const node = search.node as { value: string }

  node.value = 'MCP'
  render(stateOf({ query: 'MCP' }))
  assert.equal(node.value, 'MCP', 'a render must not fight the typist')

  render(stateOf({ query: '' }))
  assert.equal(node.value, '', 'Escape-cleared means the box is cleared too')
})

test('an unmatched page says so in the body', (t) => {
  const { view, render } = mount(t)
  render(stateOf({ category: 'general', query: 'zzz-nothing' }))
  const body = child(view(), 'settings-body')

  assert.equal(findAll(body, 'settings-card').length, 0)
  assert.match(findOne(body, 'settings-empty').text, /zzz-nothing/)
})

test('the body scrolls and the column inside it holds the reading measure', (t) => {
  // todo V7: the scroller has to stay full width or its scrollbar detaches from
  // the canvas edge, so the 880px measure lives on a node of its own — the same
  // split as `.transcript-column` inside the transcript's scroller.
  const { view, apply } = mount(t)
  const body = child(view(), 'settings-body')

  assert.deepEqual(
    body.children.map((node) => node.className),
    ['settings-column'],
    'the body holds exactly one child, the column; everything else is rebuilt inside it',
  )
  const column = body.children[0]!
  assert.ok(findAll(column, 'settings-header').length === 1)
  assert.ok(findAll(column, 'settings-card').length > 0, 'the cards render inside the column')

  // Still true with a form open: the form is a dialog, not part of the page.
  apply({ kind: 'new-model' })
  const after = child(view(), 'settings-body')
  assert.deepEqual(after.children.map((node) => node.className), ['settings-column'])
  assert.equal(findAll(after, 'settings-field').length, 0)

  // Non-vacuity: a class no rule ever mentions would make the node decorative.
  const widths = rulesFor('settings-column').flatMap((block) =>
    block.decls.filter((decl) => decl.prop === 'max-width'),
  )
  assert.equal(widths.length, 1, '.settings-column must carry exactly one max-width')
})

// --- the pill dropdown -------------------------------------------------------

/** The routing card's main-role row: a `select` control on the provider page. */
function mainRoutingPill(view: StubView): StubView {
  const shells = findAll(child(view, 'settings-body'), 'settings-menu-shell')
  assert.ok(shells.length > 0, 'the provider page has row-level选择器')
  return shells[0]!
}

test('a row-level select is a closed pill, not a native control', (t) => {
  const shell = mainRoutingPill(mount(t).view())
  const trigger = child(shell, 'settings-pill')

  assert.equal(trigger.tagName, 'BUTTON')
  assert.equal(trigger.attributes.get('aria-haspopup'), 'listbox')
  assert.equal(trigger.attributes.get('aria-expanded'), 'false')
  assert.equal(findAll(shell, 'settings-menu').length, 0, 'closed means the menu is absent')
  // The label is the selected choice's text, not its raw value.
  assert.match(trigger.text, /big/)

  // 「左图标 + 文本 + `⌵`」 (design_guidance 六). `button()` used to insert its
  // icon before the label unconditionally, which drew this as `⌵ big` (todo V4);
  // the caret is now an explicit `trailingIcon`. Verified by mutation: switching
  // it back to `icon` reds this and nothing else.
  assert.equal(trigger.children[0]?.className, 'btn-label')
  assert.equal(trigger.children.at(-1)?.tagName, 'svg')
})

test('the header project picker and the single-choice form fields stay native selects', (t) => {
  // The deliberate scope limit of stage 5f: a native `<select>` is keyboard- and
  // screen-reader-complete for free, and a form is a keyboard flow.
  const { view, apply } = mount(t)
  // The provider page is all global, so it offers no project to choose.
  assert.equal(findAll(findOne(child(view(), 'settings-body'), 'settings-header'), 'settings-project').length, 0)
  apply({ kind: 'select-category', category: 'general' })
  const header = findOne(child(view(), 'settings-body'), 'settings-header')
  assert.equal(findOne(header, 'settings-project').tagName, 'SELECT')
  apply({ kind: 'select-category', category: 'provider' })

  apply({ kind: 'new-model' })
  const form = dialogOf(view())
  const selects = findAll(form, 'settings-select')
  assert.ok(selects.length > 0, 'the model form has choice fields')
  assert.deepEqual(new Set(selects.map((node) => node.tagName)), new Set(['SELECT']))
  // Exactly one pill: 思考等级 picks a *set*, and `<select multiple>` is a
  // scrolling box the size of its options. Everything else stays native.
  assert.equal(findAll(form, 'settings-pill').length, 1)
})

test('an error sits in the open form, under its row, or pins to the screen', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'new-model' })
  apply({ kind: 'submit-draft' })
  assert.equal(findAll(dialogOf(view()), 'settings-error').length, 1, 'the error is drawn away from its form')
  assert.equal(findAll(child(view(), 'settings-body'), 'settings-error').length, 0)

  const { view: anchored } = mount(t, stateOf({ category: 'general', error: '上下文窗口必须是数字。', errorRows: ['context:contextWindow'] }))
  const card = cardTitled(child(anchored(), 'settings-body'), '上下文管理')
  const at = card.children.findIndex((kid) => kid.classes.includes('settings-row-error'))
  assert.ok(at > 0, 'the error is not inside the card it is about')
  assert.match(card.children[at - 1]!.text, /上下文窗口/)
  assert.equal(findAll(child(anchored(), 'settings-body'), 'settings-error').length, 0)

  const { view: bare } = mount(t, stateOf({ error: '保存失败。' }))
  const banner = findAll(child(bare(), 'settings-body'), 'settings-error')
  assert.equal(banner.length, 1)
  assert.ok(banner[0]!.classes.includes('banner'), 'a formless error must stay in view however far the page is scrolled')
})

test('the effort field is a checkable listbox that stays open while picking', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'new-model' })
  const closed = dialogOf(view())
  const trigger = findOne(closed, 'settings-pill')
  assert.equal(trigger.attributes.get('aria-expanded'), 'false')
  assert.match(trigger.text, /全部/)

  stub.click(trigger.node)
  assert.deepEqual(intents, [{ kind: 'toggle-menu', menu: EFFORT_MENU_ID }])

  apply({ kind: 'toggle-menu', menu: EFFORT_MENU_ID })
  apply({ kind: 'model-toggle-effort', level: 'high' })
  const form = dialogOf(view())
  const menu = findOne(form, 'settings-menu')
  assert.equal(menu.attributes.get('role'), 'listbox')
  // The whole point of the control: more than one option may be marked, and the
  // menu is still up after the pick that marked it.
  assert.equal(menu.attributes.get('aria-multiselectable'), 'true')
  assert.equal(findOne(form, 'settings-pill').attributes.get('aria-expanded'), 'true')

  const items = findAll(menu, 'settings-menu-item')
  assert.deepEqual(items.map((item) => item.text), ['低', '中', '高', '极高', '最高'])
  assert.deepEqual(
    items.map((item) => item.attributes.get('aria-selected')),
    ['false', 'false', 'true', 'false', 'false'],
  )
  // The check is drawn, and only on the checked row.
  assert.equal(findAll(menu, 'settings-menu-check').length, 1)
  assert.ok(items[2]!.classes.includes('checked'))

  intents.length = 0
  stub.click(items[0]!.node)
  assert.deepEqual(intents, [{ kind: 'model-toggle-effort', level: 'low' }])
})

test('clicking the trigger asks to toggle that row, keyed by its row id', (t) => {
  const { view, stub, intents } = mount(t)
  const trigger = child(mainRoutingPill(view()), 'settings-pill')
  stub.click(trigger.node)

  assert.deepEqual(intents, [{ kind: 'toggle-menu', menu: 'row:routing:main' }])
})

test('an open dropdown is a listbox of options, with the current one marked', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const shell = mainRoutingPill(view())

  assert.equal(child(shell, 'settings-pill').attributes.get('aria-expanded'), 'true')
  const menu = child(shell, 'settings-menu')
  assert.equal(menu.attributes.get('role'), 'listbox')
  const items = findAll(menu, 'settings-menu-item')
  assert.ok(items.length >= 2, 'inherit plus every model key')
  assert.deepEqual(new Set(items.map((item) => item.attributes.get('role'))), new Set(['option']))
  const selected = items.filter((item) => item.attributes.get('aria-selected') === 'true')
  assert.equal(selected.length, 1)
  assert.match(selected[0]!.text, /big/)
})

test('only one dropdown is open at a time', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  apply({ kind: 'toggle-menu', menu: 'row:routing:plan' })

  const menus = findAll(child(view(), 'settings-body'), 'settings-menu')
  assert.equal(menus.filter((menu) => menu.attributes.get('aria-hidden') !== 'true').length, 1)
  const outgoing = menus.find((menu) => menu.classes.includes('presence-closing'))
  assert.ok(outgoing, 'the previous menu remains for its exit')
  assert.equal(outgoing.attributes.has('inert'), true, 'its choices stop accepting input immediately')
})

test('picking an option emits that row’s own change intent', (t) => {
  const { view, stub, intents, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  intents.length = 0
  const items = findAll(mainRoutingPill(view()), 'settings-menu-item')
  const inherit = items.find((item) => item.text.includes('跟随主模型'))
  assert.ok(inherit, items.map((item) => item.text).join(' | '))
  stub.click(inherit.node)

  assert.deepEqual(intents, [{ kind: 'set-routing', role: 'main', value: 'inherit' }])
})

test('the arrow keys walk an open menu and wrap', (t) => {
  const { view, stub, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const shell = mainRoutingPill(view())
  const trigger = child(shell, 'settings-pill')
  const items = findAll(shell, 'settings-menu-item')

  stub.dispatch(shell.node, 'keydown', { target: trigger.node, key: 'ArrowDown' })
  assert.equal(stub.activeElement(), items[0]!.node, 'from the trigger, down lands on the first')

  stub.dispatch(shell.node, 'keydown', { target: items[0]!.node, key: 'ArrowUp' })
  assert.equal(stub.activeElement(), items.at(-1)!.node, 'and up from the first wraps to the last')

  stub.dispatch(shell.node, 'keydown', { target: items.at(-1)!.node, key: 'Home' })
  assert.equal(stub.activeElement(), items[0]!.node)
})

test('a closed pill opens on ArrowDown rather than swallowing the key', (t) => {
  const { view, stub, intents } = mount(t)
  const shell = mainRoutingPill(view())
  stub.dispatch(shell.node, 'keydown', {
    target: child(shell, 'settings-pill').node,
    key: 'ArrowDown',
  })

  assert.deepEqual(intents, [{ kind: 'toggle-menu', menu: 'row:routing:main' }])
})

test('dropdown refresh keeps focus and closing can reverse without replacing the menu', (t) => {
  const { view, apply, stub } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const shell = mainRoutingPill(view())
  const menu = child(shell, 'settings-menu').node
  const option = child(shell, 'settings-menu').children[0]!.node
  ;(option as HTMLElement).focus()
  apply({ kind: 'model-toggle-effort', level: 'high' })
  assert.equal(child(mainRoutingPill(view()), 'settings-menu').node, menu)
  assert.equal(stub.activeElement(), option)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(stub.inspect(menu).classes.includes('presence-closing'), true)
  assert.equal(stub.activeElement(), child(mainRoutingPill(view()), 'settings-pill').node)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(child(mainRoutingPill(view()), 'settings-menu').node, menu)
  assert.equal(stub.inspect(menu).attributes.has('inert'), false)
})

for (const composite of [false, true]) {
  test(`M08 keeps the ${composite ? 'composite' : 'plain'} switch through pending, reload and rollback`, (t) => {
    const stub = installDomStub()
    t.after(() => stub.uninstall())
    const host = stub.createContainer('settings')
    const intents: SettingsIntent[] = []
    const dom = createSettingsView(host, (intent) => intents.push(intent), () => false)
    const base = settingsView(stateOf())
    const paint = (value: boolean, pending = false): void => {
      const toggle = { value, intentOnChange: (enabled: boolean): SettingsIntent => ({ kind: 'set-thinking', enabled }) }
      dom.render({ ...base, cards: [{ id: 'general', title: '通用', rows: [{
        id: 'thinking', label: '扩展思考', pending,
        control: composite ? { kind: 'toggle-and-buttons', toggle, buttons: [] } : { kind: 'toggle', ...toggle },
      }] }] })
    }
    paint(false)
    const toggle = findOne(stub.inspect(host), 'settings-toggle')
    const knob = toggle.children[0]!.node
    stub.click(toggle.node)
    assert.deepEqual(intents, [{ kind: 'set-thinking', enabled: true }])
    paint(true, true)
    assert.equal(findOne(stub.inspect(host), 'settings-toggle').disabled, true)
    stub.click(toggle.node)
    assert.equal(intents.length, 1, 'pending blocks another click')
    paint(true)
    assert.equal(findOne(stub.inspect(host), 'settings-toggle').node, toggle.node)
    stub.click(toggle.node)
    assert.deepEqual(intents.at(-1), { kind: 'set-thinking', enabled: false }, 'the listener reads the current value')
    paint(false)
    const reverted = findOne(stub.inspect(host), 'settings-toggle')
    assert.equal(reverted.node, toggle.node)
    assert.equal(reverted.children[0]!.node, knob)
    assert.equal(reverted.attributes.get('aria-checked'), 'false')
  })
}

test('the menu that just opened takes the focus its trigger lost to the repaint', (t) => {
  const { view, stub, apply, container } = mount(t)
  const shell = mainRoutingPill(view())
  stub.focus(child(shell, 'settings-pill').node)

  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })

  const items = findAll(mainRoutingPill(view()), 'settings-menu-item')
  assert.equal(
    stub.activeElement(),
    items[0]!.node,
    'the trigger was replaced by this paint, so focus had nowhere to go but <body>',
  )

  // An unrelated repaint rebuilds the shell, so the item the reader walked to is
  // gone. It must not drop them on `<body>`: the screen itself is the fallback,
  // and it is the node whose keydown answers Esc.
  stub.focus(items.at(-1)!.node)
  apply({ kind: 'search', query: 'A' })
  assert.equal(stub.activeElement(), container)
})

/** The chain from the screen's root down to the first node carrying `className`. */
function pathTo(view: StubView, className: string): StubView[] {
  // `StubView` has no parent link, so the path is found on the way down.
  const walk = (node: StubView): StubView[] | undefined => {
    if (node.classes.includes(className)) return [node]
    for (const kid of node.children) {
      const below = walk(kid)
      if (below) return [node, ...below]
    }
    return undefined
  }
  const found = walk(view)
  assert.ok(found, `no .${className} anywhere in the screen`)
  return found
}

const CLIPPING = new Set(['hidden', 'clip'])

/** Rules whose whole selector is `.name` — the ones that apply to it unconditionally. */
function rulesFor(className: string): Block[] {
  return cssBlocks().filter((block) => block.selector === `.${className}`)
}

test('an open dropdown has no clipping ancestor inside the screen', (t) => {
  // D3: `.settings-card` used to carry `overflow: hidden`, and the 外观 page's
  // theme card is one row tall — every option of the menu below it was cut off.
  //
  // The judgement is selector-level because it has to be: `domStub` computes no
  // layout, so "is it visible" is not a question that can be asked here. What
  // this holds is the property the fix rests on — nothing between the menu and
  // the screen's root clips its overflow. `.settings-body` scrolls (`overflow-y:
  // auto`), which *extends* rather than cuts, and is the documented trade-off in
  // `styles.css`. The real proof is smoke step 8's `elementFromPoint` probe.
  const { view, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const chain = pathTo(view(), 'settings-menu')

  // Non-vacuity, twice: the menu must really be inside the card (or this asserts
  // over a chain that never contained the offender), and that card must really
  // have rules in the sheet (or a rename turns the loop below into a no-op).
  const ancestors = chain.slice(0, -1)
  assert.ok(
    ancestors.some((node) => node.classes.includes('settings-card')),
    `the dropdown is not inside a card: ${ancestors.map((node) => node.className).join(' > ')}`,
  )
  assert.ok(rulesFor('settings-card').length > 0, 'styles.css has no `.settings-card` rule')

  for (const ancestor of ancestors) {
    for (const name of ancestor.classes) {
      for (const block of rulesFor(name)) {
        for (const decl of block.decls) {
          if (!['overflow', 'overflow-x', 'overflow-y'].includes(decl.prop)) continue
          assert.ok(
            !CLIPPING.has(decl.value),
            `.${name} { ${decl.prop}: ${decl.value} } clips the open dropdown below it`,
          )
        }
      }
    }
  }
})

// --- focus loss --------------------------------------------------------------

test('focus leaving the screen closes the menu; the view’s own repaint does not', (t) => {
  const { stub, container, intents } = mount(t)
  const outside = stub.createContainer('elsewhere')

  // `relatedTarget === null` is what this view's own `replace()` looks like, and
  // it happens on every single render.
  stub.dispatch(container, 'focusout', { relatedTarget: null })
  assert.deepEqual(intents, [])

  stub.dispatch(container, 'focusout', { relatedTarget: outside })
  assert.deepEqual(intents, [{ kind: 'close-menu' }])
})

test('moving focus from a trigger to its own item is not a departure', (t) => {
  const { view, stub, container, intents, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  intents.length = 0
  const item = findAll(mainRoutingPill(view()), 'settings-menu-item')[0]!

  stub.dispatch(container, 'focusout', { relatedTarget: item.node })
  assert.deepEqual(intents, [], 'the menu must survive being operated')
})

test('a press on the page closes an open pill; nothing open costs nothing', (t) => {
  // The hole `focusout` alone leaves here: this screen is mostly cards and
  // labels, none of which take focus, so pressing one moved no focus, fired no
  // `focusout`, and left the dropdown hanging over the row being read.
  const { view, stub, intents, apply } = mount(t)
  const elsewhere = stub.createContainer('settings-card')

  stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(intents, [], 'a press with no pill open must not cost a repaint')

  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  intents.length = 0

  // The pill's own menu is inside it: the press that picks a choice must reach it.
  const item = findAll(mainRoutingPill(view()), 'settings-menu-item')[0]!
  stub.dispatchDocument('pointerdown', { target: item.node })
  assert.deepEqual(intents, [], 'a press on the menu is the user using it')

  stub.dispatchDocument('pointerdown', { target: elsewhere })
  assert.deepEqual(intents, [{ kind: 'close-menu' }])
})

test('a dropdown open when the screen closed stops claiming presses', (t) => {
  const { stub, intents, render } = mount(t, stateOf({ openMenu: 'row:routing:main' }))
  render(stateOf({ open: false, openMenu: 'row:routing:main' }))
  stub.dispatchDocument('pointerdown', { target: stub.createContainer('transcript') })
  assert.deepEqual(intents, [], 'the press belongs to the window behind, not a menu nobody can see')
})

test('a closing settings page is inert and can reverse before it is hidden', (t) => {
  const { view, render, stub, container } = mount(t)
  render(stateOf({ open: false }))
  assert.equal(view().hidden, false)
  assert.equal(view().attributes.has('inert'), true)
  assert.equal(view().classes.includes('presence-closing'), true)
  render(stateOf({ open: true }))
  assert.equal(view().classes.includes('presence-entering'), true)
  render(stateOf({ open: false }))
  stub.dispatch(container, 'transitionend', { propertyName: 'opacity' })
  assert.equal(view().hidden, true)
})

// --- the view model this file renders ----------------------------------------

test('every view model field this file relies on is really produced', (t) => {
  // Non-vacuity: the assertions above read `openMenu`, `query` and `searchEmpty`
  // off the view model, so a rename that quietly dropped one would make several
  // of them pass against `undefined`.
  const view: SettingsViewModel = settingsView(
    stateOf({ category: 'general', query: 'zzz', openMenu: 'row:x' }),
  )
  assert.equal(view.query, 'zzz')
  assert.equal(view.openMenu, 'row:x')
  assert.ok(view.searchEmpty)
  assert.ok(view.navGroups.length > 0)
  void t
})

// --- kept nodes ---------------------------------------------------------------

/** The `.settings-card` whose title node reads `title`. */
function cardTitled(view: StubView, title: string): StubView {
  const found = findAll(view, 'settings-card').find(
    (card) => card.children.some((kid) => kid.classes.includes('settings-card-title') && kid.text === title),
  )
  assert.ok(found, `no card titled ${title}`)
  return found
}

test('a repaint keeps the card and row nodes rather than rebuilding them', (t) => {
  const { view, render } = mount(t)
  const models = cardTitled(child(view(), 'settings-body'), '模型')
  const row = findOne(models, 'settings-row')
  const control = findAll(models, 'settings-row-control')[0]
  assert.ok(control)

  // Nothing about the model changed; only the query the nav column filters on.
  render(stateOf({ query: '模' }))

  const after = cardTitled(child(view(), 'settings-body'), '模型')
  assert.equal(after.node, models.node, 'the card left the page and came back')
  assert.equal(
    findOne(after, 'settings-row').node,
    row.node,
    'a rebuilt row loses the scroll anchor and the node under the pointer',
  )
  assert.equal(
    findAll(after, 'settings-row-control')[0]?.node,
    control.node,
    'a rebuilt control cell re-parents whatever it holds, which blurs it',
  )
})

test('typing in a form field keeps that input node, so the caret survives', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'new-model' })
  const first = findAll(dialogOf(view()), 'settings-input')[0]
  assert.ok(first)

  // Exactly what `live` commit does, once per keystroke.
  apply({ kind: 'draft-field', field: 'key', value: 'b' })
  apply({ kind: 'draft-field', field: 'key', value: 'bi' })

  assert.equal(
    findAll(dialogOf(view()), 'settings-input')[0]?.node,
    first.node,
    'a rebuilt input drops the caret on every character typed',
  )
})

test('typing in a form field keeps the caret, because the cell around it is kept too', (t) => {
  const { view, apply, stub } = mount(t)
  apply({ kind: 'new-model' })
  const form = dialogOf(view())
  const input = findAll(form, 'settings-input')[0]
  const cell = findAll(form, 'settings-field')[0]
  assert.ok(input && cell)
  stub.focus(input.node)

  apply({ kind: 'draft-field', field: 'key', value: 'b' })
  apply({ kind: 'draft-field', field: 'key', value: 'bi' })

  assert.equal(
    findAll(dialogOf(view()), 'settings-field')[0]?.node,
    cell.node,
    'a rebuilt cell re-parents the kept input, and re-parenting detaches it',
  )
  assert.equal(
    stub.activeElement(),
    input.node,
    'the field was blurred mid-word: one character per click was all the user got',
  )
})

test('typing a new name for an existing endpoint keeps the field, and the form', (t) => {
  const { view, apply, stub } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
  const name = findAll(dialogOf(view()), 'settings-input')[0]
  assert.ok(name)
  stub.focus(name.node)

  // The form used to be keyed by the *live* name, so each of these rebuilt it.
  apply({ kind: 'draft-field', field: 'name', value: 'mai' })
  apply({ kind: 'draft-field', field: 'name', value: 'ma' })

  assert.equal(findAll(dialogOf(view()), 'settings-input')[0]?.node, name.node, 'the field was rebuilt mid-word')
  assert.equal(stub.activeElement(), name.node, 'the caret was thrown out of the field')
})

test('a live field commits on input alone, so a blur cannot fire a second one', (t) => {
  const { view, apply, intents, stub } = mount(t)
  apply({ kind: 'new-model' })
  const input = findAll(dialogOf(view()), 'settings-input')[0]
  assert.ok(input)
  ;(input.node as { value: string }).value = 'b'

  stub.dispatch(input.node, 'input')
  assert.deepEqual(intents, [{ kind: 'draft-field', field: 'key', value: 'b' }])

  // The blur that a click on 保存 begins. A second commit here re-renders the
  // form between `mousedown` and `mouseup` and the click never lands.
  stub.dispatch(input.node, 'change')
  assert.equal(intents.length, 1, 'the blur committed a second time')
})

test('a form opens as a dialog over the screen, and the page behind it goes inert', (t) => {
  const { view, apply } = mount(t)
  assert.equal(child(view(), 'settings-dialog-layer').hidden, true)
  apply({ kind: 'new-model' })
  assert.equal(child(view(), 'settings-dialog-layer').hidden, false)
  assert.equal(dialogOf(view()).attributes.get('aria-modal'), 'true')
  assert.equal(findOne(dialogOf(view()), 'settings-dialog-title').text, '新增模型')
  for (const region of ['settings-nav', 'settings-body']) {
    assert.ok(child(view(), region).attributes.has('inert'), `.${region} is still reachable behind the dialog`)
  }
  apply({ kind: 'cancel-draft' })
  for (const region of ['settings-nav', 'settings-body']) {
    assert.equal(child(view(), region).attributes.has('inert'), false)
  }
})

test('the dialog takes focus on its first field and hands it back to the button that opened it', (t) => {
  const { view, apply, stub } = mount(t)
  const opener = findAll(child(view(), 'settings-body'), 'settings-btn').find((btn) => btn.text === '新增模型')
  assert.ok(opener)
  stub.focus(opener.node)
  apply({ kind: 'new-model' })
  assert.equal(stub.activeElement(), findAll(dialogOf(view()), 'settings-input')[0]?.node)

  apply({ kind: 'cancel-draft' })
  const back = stub.activeElement() as { getAttribute(name: string): string | null } | undefined
  assert.equal(back?.getAttribute('aria-label'), opener.attributes.get('aria-label'))
})

test('Enter in a field submits; the backdrop dismisses; a press inside does not', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'new-model' })
  const input = findAll(dialogOf(view()), 'settings-input')[0]!
  stub.dispatch(input.node, 'keydown', { key: 'Enter' })
  assert.deepEqual(intents.map((intent) => intent.kind), ['draft-field', 'submit-draft'])

  intents.length = 0
  const layer = child(view(), 'settings-dialog-layer')
  stub.dispatch(layer.node, 'pointerdown', { target: dialogOf(view()).node })
  assert.deepEqual(intents, [], 'a press inside the dialog dismissed it')
  stub.dispatch(layer.node, 'pointerdown', { target: layer.node })
  assert.deepEqual(intents, [{ kind: 'cancel-draft' }])
})

test('an edited form asks before it is discarded, with the safe answer focused', (t) => {
  const { view, apply, stub } = mount(t)
  apply({ kind: 'new-model' })
  apply({ kind: 'draft-field', field: 'key', value: 'h' })
  apply({ kind: 'cancel-draft' })
  const foot = findOne(dialogOf(view()), 'settings-dialog-foot')
  assert.match(foot.text, /放弃未保存的修改/)
  const keep = findAll(foot, 'settings-btn').find((btn) => btn.text === '继续编辑')
  assert.equal(stub.activeElement(), keep?.node)
})

test('on/off fields are switches and the key field is a password box', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
  const inputs = findAll(dialogOf(view()), 'settings-input')
  const key = inputs.find((input) => input.attributes.get('aria-label') === 'API key')
  assert.equal((key?.node as { type: string } | undefined)?.type, 'password')

  apply({ kind: 'cancel-draft' })
  apply({ kind: 'new-model' })
  const toggle = findAll(dialogOf(view()), 'settings-toggle')[0]!
  stub.click(toggle.node)
  assert.deepEqual(intents.at(-1), { kind: 'draft-field', field: 'longContext1m', value: 'on' })
})

test('the wizard draws service cards, then the connection with its test line, then a model list', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'new-endpoint' })
  const cards = findAll(dialogOf(view()), 'settings-preset')
  assert.ok(cards.length >= 8)
  assert.equal(stub.activeElement(), cards[0]!.node, 'the first card takes focus')
  const foot = (): string[] => findAll(findOne(dialogOf(view()), 'settings-dialog-foot'), 'settings-btn').map((btn) => btn.text)
  assert.deepEqual(foot(), ['取消'])
  stub.click(cards[2]!.node)
  assert.deepEqual(intents.at(-1), { kind: 'pick-preset', preset: 'deepseek' })

  apply({ kind: 'pick-preset', preset: 'deepseek' })
  assert.equal(findOne(dialogOf(view()), 'settings-dialog-title').text, '连接 DeepSeek')
  const address = findAll(dialogOf(view()), 'settings-input')[0]!
  assert.equal(stub.activeElement(), address.node, 'a new page focuses its first field')
  assert.deepEqual(foot(), ['上一步', '下一步'])

  apply({ kind: 'submit-draft' })
  assert.deepEqual(foot(), ['上一步', '连接中…'])
  assert.equal(findOne(dialogOf(view()), 'settings-probe').attributes.get('role'), 'status')

  apply({ kind: 'probe-result', seq: 1, result: { ok: false, reason: 'unreachable', detail: 'x' } })
  const line = findOne(dialogOf(view()), 'settings-probe')
  assert.ok(line.classes.includes('failed'))
  assert.match(line.text, /连不上这个地址/)
  stub.click(findOne(line, 'settings-probe-skip').node)
  assert.deepEqual(intents.at(-1), { kind: 'skip-test' })

  apply({ kind: 'submit-draft' })
  apply({ kind: 'probe-result', seq: 2, result: { ok: true, latencyMs: 80, models: [{ id: 'deepseek-chat', contextWindow: 128000 }] } })
  assert.equal(findOne(dialogOf(view()), 'settings-dialog-title').text, '选择模型')
  const row = findOne(dialogOf(view()), 'settings-model-row')
  assert.equal(row.attributes.get('role'), 'checkbox')
  assert.equal(row.attributes.get('aria-checked'), 'false')
  assert.match(row.text, /128k 上下文/)
  apply({ kind: 'toggle-picked-model', id: 'deepseek-chat' })
  assert.equal(findOne(dialogOf(view()), 'settings-model-row').attributes.get('aria-checked'), 'true')
  assert.deepEqual(foot(), ['上一步', '完成'])
})

test('an edited endpoint offers 测试连接 at the foot and reports beside the fields', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
  const foot = findOne(dialogOf(view()), 'settings-dialog-foot')
  const test = findAll(foot, 'settings-btn').find((btn) => btn.text === '测试连接')
  assert.ok(test?.classes.includes('lead'))
  assert.equal(findAll(dialogOf(view()), 'settings-probe').length, 0, 'nothing to report before a test')
  apply({ kind: 'test-endpoint' })
  apply({ kind: 'probe-result', seq: 1, result: { ok: true, latencyMs: 42, models: [{ id: 'a' }] } })
  assert.match(findOne(dialogOf(view()), 'settings-probe').text, /已连接 · 42 ms · 找到 1 个模型/)
})

test('a delete confirmation is drawn under the row it is about', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'request-remove', target: { kind: 'model', name: 'big' } })
  const models = cardTitled(child(view(), 'settings-body'), '模型')

  const at = models.children.findIndex((kid) => kid.classes.includes('settings-confirm'))
  assert.ok(at > 0, 'the confirmation is inside the card')
  assert.ok(
    models.children[at - 1]?.classes.includes('settings-row'),
    'and directly under the row it is asking about',
  )
})

test('an mcp-server form renders in the MCP card with custom cards, doc link and inputs', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'select-category', category: 'extensions' })
  apply({ kind: 'new-mcp-server' })
  const form = dialogOf(view())
  assert.equal(findOne(form, 'settings-dialog-title').text, '连接至自定义 MCP')

  // Header doc link
  const docLink = findOne(form, 'mcp-form-doc-link')
  assert.equal(docLink.text, '文档')
  assert.equal((docLink.node as { href?: string }).href, 'https://modelcontextprotocol.io')

  // Segmented control
  const segBtns = findAll(form, 'mcp-segmented-btn')
  assert.equal(segBtns.length, 2)
  assert.equal(segBtns[0]?.text, 'STDIO')
  assert.ok(segBtns[0]?.classes.includes('active'))
  assert.equal(segBtns[1]?.text, '流式 HTTP')
  assert.ok(!segBtns[1]?.classes.includes('active'))

  // Inputs and buttons
  const inputs = findAll(form, 'settings-input')
  const placeholders = inputs.map((inp) => (inp.node as any).placeholder ?? inp.attributes.get('placeholder'))
  assert.ok(placeholders.includes('例如 sqlite'))
  assert.ok(placeholders.includes('npx -y @modelcontextprotocol/server-sqlite'))
  assert.ok(placeholders.includes('~/code'))

  const addBtns = findAll(form, 'mcp-form-add-btn')
  const addBtnLabels = addBtns.map((b) => b.text)
  assert.ok(addBtnLabels.includes('添加参数'))
  assert.ok(addBtnLabels.includes('添加环境变量'))
  assert.ok(addBtnLabels.includes('添加变量'))
})

test('switching transport in mcp form toggles between command and url cards', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'select-category', category: 'extensions' })
  apply({ kind: 'new-mcp-server' })

  let form = dialogOf(view())
  const sseBtn = findAll(form, 'mcp-segmented-btn')[1]
  assert.ok(sseBtn)
  stub.dispatch(sseBtn.node, 'click')
  assert.deepEqual(intents, [{ kind: 'draft-field', field: 'transport', value: 'sse' }])
  apply(intents.pop()!)

  form = dialogOf(view())
  const segBtns = findAll(form, 'mcp-segmented-btn')
  assert.ok(segBtns[1]?.classes.includes('active'), 'SSE button is now active')
  assert.ok(!segBtns[0]?.classes.includes('active'), 'STDIO button is now inactive')

  const inputs = findAll(form, 'settings-input')
  const placeholders = inputs.map((inp) => (inp.node as any).placeholder ?? inp.attributes.get('placeholder'))
  assert.ok(placeholders.includes('http://localhost:3000/sse'), 'URL input is rendered')
  assert.ok(!placeholders.includes('npx -y @modelcontextprotocol/server-sqlite'), 'Command input is gone')
  assert.ok(!placeholders.includes('~/code'), 'CWD input is gone')

  // Headers replace the environment: nothing this process puts in an environment
  // can follow an HTTP request, so offering `env` here would collect dead values.
  const addBtnLabels = findAll(form, 'mcp-form-add-btn').map((btn) => btn.text)
  assert.ok(addBtnLabels.includes('添加请求头'))
  assert.ok(!addBtnLabels.includes('添加环境变量'))
  assert.ok(!addBtnLabels.includes('添加变量'), 'passthrough is stdio-only too')
})

test('typing in mcp form fields keeps input nodes, preserving carets', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'select-category', category: 'extensions' })
  apply({ kind: 'new-mcp-server' })

  const form = dialogOf(view())
  const nameInput = findAll(form, 'settings-input')[0]
  assert.ok(nameInput)

  apply({ kind: 'draft-field', field: 'name', value: 's' })
  apply({ kind: 'draft-field', field: 'name', value: 'sq' })

  const after = dialogOf(view())
  const afterName = findAll(after, 'settings-input')[0]
  assert.equal(afterName?.node, nameInput.node, 'the name input element was kept across typing')
})

