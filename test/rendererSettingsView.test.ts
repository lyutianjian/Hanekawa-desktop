import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { cssBlocks, type Block } from './helpers/rendererCss.js'
import { createSettingsView } from '../src/desktop/renderer/dom/settingsView.js'
import {
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
      autoCompactReserveRatio: 0.083,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.9,
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

/** The nav or the body, which sit in the modal's card. */
const region = (root: StubView, className: string): StubView => child(child(root, 'settings-panel'), className)

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
  const nav = region(mount(t).view(), 'settings-nav')
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

test('the close button sits in the card, outside the replaced region', (t) => {
  const { view, render } = mount(t)
  const closeBefore = findOne(view(), 'settings-close').node
  assert.equal(child(view(), 'settings-panel').children.at(-1)?.node, closeBefore)
  // The column is what gets rebuilt; the close button is not.
  render(stateOf({ category: 'agent' }))
  assert.equal(findOne(view(), 'settings-close').node, closeBefore)
})

test('a press on the scrim closes settings; one inside the card does not', (t) => {
  const { view, stub, container, intents } = mount(t)
  stub.dispatch(child(view(), 'settings-panel').node, 'pointerdown')
  assert.ok(!intents.some((intent) => intent.kind === 'close'))
  stub.dispatch(container, 'pointerdown')
  assert.ok(intents.some((intent) => intent.kind === 'close'))
})

// --- the search box ----------------------------------------------------------

test('the search input is built once, so typing cannot lose the caret', (t) => {
  const { view, render } = mount(t)
  const before = findOne(region(view(), 'settings-nav'), 'settings-search').node
  render(stateOf({ query: 'MCP' }))
  const after = findOne(region(view(), 'settings-nav'), 'settings-search').node

  // Identity, not equality: the nav list around it is replaced on every render.
  assert.equal(after, before)
})

test('typing filters per keystroke, not on blur', (t) => {
  const { view, stub, intents } = mount(t)
  const search = findOne(region(view(), 'settings-nav'), 'settings-search')
  assert.equal(search.tagName, 'INPUT')
  assert.equal(search.attributes.get('aria-label'), '搜索设置')

  const node = search.node as { value: string }
  node.value = 'MC'
  stub.dispatch(search.node, 'input')
  assert.deepEqual(intents, [{ kind: 'search', query: 'MC' }])
})

test('the search box keeps its own editing keys, but not Escape', (t) => {
  const { view, stub, container, keys } = mount(t)
  const search = findOne(region(view(), 'settings-nav'), 'settings-search')

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
  const search = findOne(region(view(), 'settings-nav'), 'settings-search')
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
  const body = region(view(), 'settings-body')

  assert.equal(findAll(body, 'settings-card').length, 0)
  assert.match(findOne(body, 'settings-empty').text, /zzz-nothing/)
})

test('the body scrolls and the column inside it holds the reading measure', (t) => {
  // todo V7: the scroller has to stay full width or its scrollbar detaches from
  // the canvas edge, so the 880px measure lives on a node of its own — the same
  // split as `.transcript-column` inside the transcript's scroller.
  const { view, apply } = mount(t)
  const body = region(view(), 'settings-body')

  assert.deepEqual(
    body.children.map((node) => node.className),
    ['settings-column'],
    'the body holds exactly one child, the column; everything else is rebuilt inside it',
  )
  const column = body.children[0]!
  assert.ok(findAll(column, 'settings-header').length === 1)
  assert.ok(findAll(column, 'settings-card').length > 0, 'the cards render inside the column')

  // Still true with a form open: the form is a dialog, not part of the page.
  apply({ kind: 'edit-endpoint', name: 'main' })
  const after = region(view(), 'settings-body')
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
  // The second select: 默认模型 heads the card.
  const shells = findAll(region(view, 'settings-body'), 'settings-menu-shell')
  assert.ok(shells.length > 1, 'the provider page has row-level选择器')
  return shells[1]!
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
  assert.equal(findAll(findOne(region(view(), 'settings-body'), 'settings-header'), 'settings-project').length, 0)
  apply({ kind: 'select-category', category: 'general' })
  const header = findOne(region(view(), 'settings-body'), 'settings-header')
  assert.equal(findOne(header, 'settings-project').tagName, 'SELECT')
  apply({ kind: 'select-category', category: 'provider' })

  apply({ kind: 'edit-endpoint', name: 'main' })
  const form = dialogOf(view())
  const selects = findAll(form, 'settings-select')
  assert.ok(selects.length > 0, 'the provider dialog has choice fields')
  assert.deepEqual(new Set(selects.map((node) => node.tagName)), new Set(['SELECT']))
  assert.equal(findAll(form, 'settings-pill').length, 0)
})

test('an error sits in the open form, under its row, or pins to the screen', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'new-endpoint' })
  apply({ kind: 'submit-draft' })
  assert.equal(findAll(dialogOf(view()), 'settings-error').length, 1, 'the error is drawn away from its form')
  assert.equal(findAll(region(view(), 'settings-body'), 'settings-error').length, 0)

  const { view: anchored } = mount(t, stateOf({ category: 'general', error: '上下文窗口必须是数字。', errorRows: ['context:contextWindow'] }))
  const card = cardTitled(region(anchored(), 'settings-body'), '上下文管理')
  const at = card.children.findIndex((kid) => kid.classes.includes('settings-row-error'))
  assert.ok(at > 0, 'the error is not inside the card it is about')
  assert.match(card.children[at - 1]!.text, /上下文窗口/)
  assert.equal(findAll(region(anchored(), 'settings-body'), 'settings-error').length, 0)

  const { view: bare } = mount(t, stateOf({ error: '保存失败。' }))
  const banner = findAll(region(bare(), 'settings-body'), 'settings-error')
  assert.equal(banner.length, 1)
  assert.ok(banner[0]!.classes.includes('banner'), 'a formless error must stay in view however far the page is scrolled')
})

test('the dialog is named by its title, an error is announced, and the nav says where you are', (t) => {
  // A screen reader entering the dialog heard 「对话框」 and nothing else, a
  // refused save was silent until the reader happened on it, and the selected
  // category was only a fill.
  const { view, apply } = mount(t)
  const current = findAll(region(view(), 'settings-nav'), 'settings-nav-item')
    .filter((item) => item.attributes.get('aria-current') === 'page')
  assert.equal(current.length, 1)

  apply({ kind: 'new-endpoint' })
  const dialog = dialogOf(view())
  const title = findOne(dialog, 'settings-dialog-title')
  assert.equal(dialog.attributes.get('aria-labelledby'), title.attributes.get('id'))
  assert.equal(dialog.attributes.has('aria-describedby'), false)

  apply({ kind: 'submit-draft' })
  const error = findOne(dialogOf(view()), 'settings-error')
  assert.equal(error.attributes.get('role'), 'alert')
  assert.equal(dialogOf(view()).attributes.get('aria-describedby'), error.attributes.get('id'))

  const { view: anchored } = mount(t, stateOf({ category: 'general', error: '上下文窗口必须是数字。', errorRows: ['context:contextWindow'] }))
  assert.equal(findOne(region(anchored(), 'settings-body'), 'settings-row-error').attributes.get('role'), 'alert')
})

test('a saved row says 已保存, and a repaint does not restart the receipt', (t) => {
  // Keyed by the batch: the receipt fades once, then a later save is a new node.
  const { view, render } = mount(t, stateOf({ category: 'general', savedRows: { seq: 3, ids: ['context:contextWindow'] } }))
  const receipts = () => findAll(region(view(), 'settings-body'), 'settings-saved')
  assert.equal(receipts().length, 1)
  assert.equal(receipts()[0]!.text, '已保存')
  assert.equal(receipts()[0]!.attributes.get('role'), 'status')
  const first = receipts()[0]!.node
  render(stateOf({ category: 'general', savedRows: { seq: 3, ids: ['context:contextWindow'] }, query: '' }))
  assert.equal(receipts()[0]!.node, first, 'the same batch keeps the same node')
  render(stateOf({ category: 'general', savedRows: { seq: 4, ids: ['context:contextWindow'] } }))
  assert.notEqual(receipts()[0]!.node, first, 'a new save is a new receipt')
})

test('a model row opens to its switches, and the effort levels are one switch each', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
  const item = (): StubView => findOne(dialogOf(view()), 'settings-model-item')
  assert.equal(findAll(item(), 'settings-model-detail').length, 0, 'closed means no detail')
  stub.click(findOne(item(), 'settings-model-expand').node)
  assert.deepEqual(intents.at(-1), { kind: 'toggle-model-row', rowId: 'saved-0' })

  apply({ kind: 'toggle-model-row', rowId: 'saved-0' })
  const switches = findAll(findOne(item(), 'settings-model-detail'), 'settings-model-switch')
  assert.deepEqual(switches.map((line) => line.text), ['支持扩展思考', '支持图片输入'])
  stub.click(findOne(switches[1]!, 'settings-toggle').node)
  assert.deepEqual(intents.at(-1), { kind: 'model-row-switch', rowId: 'saved-0', field: 'imageInput', value: true })

  const trigger = findOne(findOne(item(), 'settings-model-levels'), 'settings-levels-trigger')
  assert.equal(trigger.attributes.get('aria-expanded'), 'false')
  assert.match(trigger.text, /思考档位全部/)
  apply({ kind: 'toggle-row-efforts', rowId: 'saved-0' })
  const levels = findAll(findOne(item(), 'settings-model-levels'), 'settings-model-switch')
  assert.deepEqual(levels.map((line) => line.text), ['低', '中', '高', '极高', '最高'])
  intents.length = 0
  stub.click(findOne(levels[2]!, 'settings-toggle').node)
  assert.deepEqual(intents, [{ kind: 'model-row-effort', rowId: 'saved-0', level: 'high' }])

  // Thinking off: there are no levels left to pick.
  apply({ kind: 'model-row-switch', rowId: 'saved-0', field: 'thinking', value: false })
  assert.equal(findAll(item(), 'settings-model-levels').length, 0)

  // The prices fold the same way, with four boxes and a currency once open.
  const prices = (): StubView => findOne(item(), 'settings-model-prices')
  assert.match(prices().text, /价格未设置/)
  assert.equal(findAll(prices(), 'settings-input').length, 0, 'closed means no boxes')
  apply({ kind: 'toggle-row-prices', rowId: 'saved-0' })
  assert.equal(findAll(prices(), 'settings-input').length, 4)
  assert.equal(findAll(prices(), 'settings-select').length, 1)
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

  const menus = findAll(region(view(), 'settings-body'), 'settings-menu')
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
  apply({ kind: 'none' })
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
  // `styles.css`.
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
  // The scrim follows the card's transition, not its own.
  stub.dispatch(child(view(), 'settings-panel').node, 'transitionend', { propertyName: 'opacity' })
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
  const models = cardTitled(region(view(), 'settings-body'), '服务商')
  const row = findOne(models, 'settings-row')
  const control = findAll(models, 'settings-row-control')[0]
  assert.ok(control)

  // Nothing about the provider changed; only the query the nav column filters on.
  render(stateOf({ query: '模' }))

  const after = cardTitled(region(view(), 'settings-body'), '服务商')
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
  apply({ kind: 'new-endpoint' })
  const first = findAll(dialogOf(view()), 'settings-input')[0]
  assert.ok(first)

  // Exactly what `live` commit does, once per keystroke.
  apply({ kind: 'draft-field', field: 'name', value: 'b' })
  apply({ kind: 'draft-field', field: 'name', value: 'bi' })

  assert.equal(
    findAll(dialogOf(view()), 'settings-input')[0]?.node,
    first.node,
    'a rebuilt input drops the caret on every character typed',
  )
})

test('typing in a form field keeps the caret, because the cell around it is kept too', (t) => {
  const { view, apply, stub } = mount(t)
  apply({ kind: 'new-endpoint' })
  const form = dialogOf(view())
  const input = findAll(form, 'settings-input')[0]
  const cell = findAll(form, 'settings-field')[0]
  assert.ok(input && cell)
  stub.focus(input.node)

  apply({ kind: 'draft-field', field: 'name', value: 'b' })
  apply({ kind: 'draft-field', field: 'name', value: 'bi' })

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
  apply({ kind: 'edit-endpoint', name: 'main' })
  const input = findAll(dialogOf(view()), 'settings-input')[0]
  assert.ok(input)
  ;(input.node as { value: string }).value = 'b'

  stub.dispatch(input.node, 'input')
  assert.deepEqual(intents, [{ kind: 'draft-field', field: 'name', value: 'b' }])

  // The blur that a click on 保存 begins. A second commit here re-renders the
  // form between `mousedown` and `mouseup` and the click never lands.
  stub.dispatch(input.node, 'change')
  assert.equal(intents.length, 1, 'the blur committed a second time')
})

test('a form opens as a dialog over the screen, and the page behind it goes inert', (t) => {
  const { view, apply } = mount(t)
  assert.equal(child(view(), 'settings-dialog-layer').hidden, true)
  apply({ kind: 'new-endpoint' })
  assert.equal(child(view(), 'settings-dialog-layer').hidden, false)
  assert.equal(dialogOf(view()).attributes.get('aria-modal'), 'true')
  assert.equal(findOne(dialogOf(view()), 'settings-dialog-title').text, '新服务商')
  for (const name of ['settings-nav', 'settings-body']) {
    assert.ok(region(view(), name).attributes.has('inert'), `.${name} is still reachable behind the dialog`)
  }
  assert.ok(findOne(view(), 'settings-close').attributes.has('inert'))
  apply({ kind: 'cancel-draft' })
  for (const name of ['settings-nav', 'settings-body']) {
    assert.equal(region(view(), name).attributes.has('inert'), false)
  }
})

test('the dialog takes focus on its first field and hands it back to the button that opened it', (t) => {
  const { view, apply, stub } = mount(t)
  const opener = findAll(region(view(), 'settings-body'), 'settings-btn').find((btn) => btn.text === '编辑')
  assert.ok(opener)
  stub.focus(opener.node)
  apply({ kind: 'edit-endpoint', name: 'main' })
  assert.equal(stub.activeElement(), findAll(dialogOf(view()), 'settings-input')[0]?.node)

  apply({ kind: 'cancel-draft' })
  const back = stub.activeElement() as { getAttribute(name: string): string | null } | undefined
  assert.equal(back?.getAttribute('aria-label'), opener.attributes.get('aria-label'))
})

test('Enter in a field submits; the backdrop dismisses; a press inside does not', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
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
  apply({ kind: 'edit-endpoint', name: 'main' })
  apply({ kind: 'draft-field', field: 'name', value: 'h' })
  apply({ kind: 'cancel-draft' })
  const foot = findOne(dialogOf(view()), 'settings-dialog-foot')
  assert.match(foot.text, /放弃未保存的修改/)
  const keep = findAll(foot, 'settings-btn').find((btn) => btn.text === '继续编辑')
  assert.equal(stub.activeElement(), keep?.node)
})

test('the key field is a password box with a show switch', (t) => {
  const { view, apply, stub, intents } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
  const keyOf = (): StubView | undefined =>
    findAll(dialogOf(view()), 'settings-input').find((input) => input.attributes.get('aria-label') === 'API Key')
  assert.equal((keyOf()?.node as { type: string } | undefined)?.type, 'password')
  stub.click(findOne(dialogOf(view()), 'settings-secret-toggle').node)
  assert.deepEqual(intents.at(-1), { kind: 'toggle-key-visible' })
  apply({ kind: 'toggle-key-visible' })
  assert.equal((keyOf()?.node as { type: string } | undefined)?.type, 'text')
})

test('a new provider opens on one form with the model table', (t) => {
  const { view, apply, stub } = mount(t)
  apply({ kind: 'new-endpoint' })
  apply({ kind: 'draft-field', field: 'name', value: 'deepseek' })
  assert.equal(findOne(dialogOf(view()), 'settings-dialog-title').text, 'deepseek')
  assert.equal(findOne(dialogOf(view()), 'settings-provider-avatar').text, 'D')
  const name = findAll(dialogOf(view()), 'settings-input')[0]!
  assert.equal(stub.activeElement(), name.node, 'a new form focuses its first field')
  const foot = (): string[] => findAll(findOne(dialogOf(view()), 'settings-dialog-foot'), 'settings-btn').map((btn) => btn.text)
  assert.deepEqual(foot(), ['取消', '保存'])
  assert.match(findOne(dialogOf(view()), 'settings-model-empty').text, /还没有模型/)

  const fetch = findAll(findOne(dialogOf(view()), 'settings-models-head'), 'settings-btn')[0]!
  assert.equal(fetch.text, '获取模型列表')
  apply({ kind: 'test-endpoint' })
  assert.equal(findOne(dialogOf(view()), 'settings-probe').attributes.get('role'), 'status')

  apply({ kind: 'probe-result', seq: 1, result: { ok: true, latencyMs: 80, models: [{ id: 'deepseek-chat', contextWindow: 128000 }] } })
  const picked = (): StubView => findOne(findOne(dialogOf(view()), 'settings-model-picker'), 'settings-model-row')
  assert.equal(picked().attributes.get('role'), 'checkbox')
  assert.equal(picked().attributes.get('aria-checked'), 'false')
  assert.match(picked().text, /128k 上下文/)

  // Added rows land in the table; a row 添加模型 made takes the caret.
  apply({ kind: 'toggle-picked-model', id: 'deepseek-chat' })
  assert.equal(picked().attributes.get('aria-checked'), 'true')
  apply({ kind: 'add-model-row' })
  const items = findAll(dialogOf(view()), 'settings-model-item')
  assert.equal(items.length, 2)
  assert.equal(stub.activeElement(), findAll(items[1]!, 'settings-input')[0]?.node)
})

test('a failed listing says why beside the table', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'edit-endpoint', name: 'main' })
  assert.equal(findAll(dialogOf(view()), 'settings-probe').length, 0, 'nothing to report before a fetch')
  apply({ kind: 'test-endpoint' })
  apply({ kind: 'probe-result', seq: 1, result: { ok: false, reason: 'unreachable', detail: 'x' } })
  const line = findOne(dialogOf(view()), 'settings-probe')
  assert.ok(line.classes.includes('failed'))
  assert.match(line.text, /连不上这个地址/)
})

test('a delete confirmation is drawn under the row it is about', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'request-remove', target: { kind: 'endpoint', name: 'main' } })
  const models = cardTitled(region(view(), 'settings-body'), '服务商')

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


test('the nav keeps its buttons across renders and moves the selection on them', (t) => {
  // Every keystroke in a field renders the screen, and the nav used to be
  // rebuilt each time — the button just pressed was replaced under focus.
  const { view, apply } = mount(t)
  const items = () => findAll(region(view(), 'settings-nav'), 'settings-nav-item')
  const selectedAt = () => items().findIndex((item) => item.attributes.get('aria-current') === 'page')
  apply({ kind: 'select-category', category: 'general' })
  const before = items().map((item) => item.node)
  const was = selectedAt()

  apply({ kind: 'select-category', category: 'provider' })
  const after = items()
  assert.deepEqual(after.map((item) => item.node), before, 'the buttons are kept')
  assert.notEqual(selectedAt(), was)
  assert.equal(after.filter((item) => item.attributes.get('aria-current') === 'page').length, 1)
  assert.equal(after.filter((item) => item.classes.includes('selected')).length, 1)
  assert.ok(after[selectedAt()]!.classes.includes('selected'))
})
