import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySettingsIntent,
  createSettingsState,
  draftToChange,
  draftToChanges,
  loadSettings,
  matchesQuery,
  pendingRowIds,
  projectSnapshot,
  routingOptions,
  runSettingsChanges,
  settingsChordToIntent,
  settingsKeyToIntent,
  settingsView,
  type SettingsClient,
  type SettingsDraft,
  type PendingMutation,
  type SettingsIntent,
  type SettingsState,
} from '../src/desktop/renderer/model/settings.js'
import type {
  SettingsChange,
  WireSettingsSnapshot,
  WireShellSettingsChangeResult,
  WireShellSettingsResult,
} from '../src/desktop/shellProtocol.js'

/**
 * The settings screen's decisions, all of which live in `model/settings.ts`.
 *
 * The DOM half (`dom/settingsView.ts`) is deliberately uncovered — there is no
 * jsdom in this runner, which is exactly why every decision is a pure function
 * here rather than a branch inside a view.
 *
 * The load-bearing case in this file is the API-key one. The key field is
 * seeded from a *masked* value, so anything that sends it unconditionally
 * writes `sk-a...ijkl` into the user's config as though it were the key.
 */

function snapshotOf(overrides: Partial<WireSettingsSnapshot> = {}): WireSettingsSnapshot {
  return {
    projectRoot: 'C:\\repo\\alpha',
    projectName: 'alpha',
    saveTarget: 'C:\\repo\\alpha\\.myagent\\config.json',
    endpoints: [
      { name: 'main', provider: 'anthropic', baseUrl: 'https://api.example', apiKeyMasked: 'sk-a...ijkl' },
    ],
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', contextWindow: 200_000, resolves: true },
      { key: 'broken', model: 'gone', endpoint: 'missing', resolves: false },
    ],
    routing: {
      main: 'big',
      plan: 'inherit',
      compact: 'inherit',
      subagent: [
        { type: 'general', value: 'inherit' },
        { type: 'explore', value: 'big' },
      ],
    },
    defaultModel: 'big',
    providers: ['anthropic', 'openai'],
    subagentTypes: ['general', 'explore'],
    permissions: {
      localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json',
      mode: 'default',
      modeIsLocal: false,
      groups: [
        { behavior: 'allow', local: ['Bash(git status:*)'], inherited: ['Read'] },
        { behavior: 'ask', local: [], inherited: [] },
        { behavior: 'deny', local: [], inherited: ['Bash(rm -rf:*)'] },
      ],
    },
    agents: [
      {
        type: 'general',
        description: 'General-purpose sub-agent.',
        builtIn: true,
        maxTurns: 30,
        isReadOnlyAgent: true,
        routing: 'inherit',
      },
      {
        type: 'reviewer',
        description: 'Reviews a diff.',
        builtIn: false,
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
        model: 'claude-big',
        maxTurns: 12,
        isReadOnlyAgent: true,
        routing: 'big',
      },
    ],
    skills: [
      {
        name: 'release',
        description: 'Cuts a release.',
        enabled: true,
        inclusion: 'manual',
        hasHooks: false,
      },
      {
        name: 'review',
        description: 'Reviews a diff.',
        enabled: false,
        inclusion: 'fileMatch',
        paths: ['src/**'],
        allowedTools: ['Read', 'Grep'],
        model: 'claude-big',
        effort: 'high',
        hasHooks: true,
        attachments: 2,
      },
    ],
    skillsDir: 'C:\\repo\\alpha\\.myagent\\skills',
    mcpServers: [
      {
        name: 'github',
        transport: 'stdio',
        target: 'npx github-mcp',
        trusted: true,
        trustEditable: true,
        status: 'connected',
        toolCount: 3,
      },
      {
        name: 'shared',
        transport: 'sse',
        target: 'https://mcp.example',
        trusted: true,
        trustEditable: false,
        status: 'failed',
        error: 'connect ECONNREFUSED',
      },
      {
        name: 'cold',
        transport: 'stdio',
        target: 'cold-server',
        trusted: false,
        trustEditable: true,
        status: 'failed',
        error: 'not trusted',
      },
    ],
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
    ...overrides,
  }
}

function openState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    ...createSettingsState(),
    open: true,
    projectRoot: 'C:\\repo\\alpha',
    snapshot: snapshotOf(),
    projects: [{ projectRoot: 'C:\\repo\\alpha', projectName: 'alpha' }],
    ...overrides,
  }
}

// --- the api key rule --------------------------------------------------------

test('an untouched key field is omitted from the change, never sent as its mask', () => {
  const state = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const draft = state.draft
  assert.ok(draft && draft.kind === 'endpoint')
  assert.equal(draft.keyTouched, false)

  // The user changes the base URL only.
  const edited = applySettingsIntent(state, {
    kind: 'draft-field',
    field: 'baseUrl',
    value: 'https://api.changed',
  }).state
  assert.ok(edited.draft)

  const change = draftToChange(edited.draft, snapshotOf())
  assert.ok(!('error' in change))
  assert.equal('apiKey' in change, false, 'an untouched key must not reach the wire at all')
  assert.deepEqual(change, {
    scope: 'provider',
    kind: 'set-endpoint',
    name: 'main',
    provider: 'anthropic',
    baseUrl: 'https://api.changed',
  })
})

test('typing in the key field is the only thing that arms it', () => {
  const opened = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const typed = applySettingsIntent(opened, {
    kind: 'draft-field',
    field: 'apiKey',
    value: 'sk-brand-new-key',
  }).state
  assert.ok(typed.draft && typed.draft.kind === 'endpoint')
  assert.equal(typed.draft.keyTouched, true)

  const change = draftToChange(typed.draft, snapshotOf())
  assert.ok(!('error' in change))
  assert.equal((change as Extract<SettingsChange, { kind: 'set-endpoint' }>).apiKey, 'sk-brand-new-key')
})

test('a key typed and then deleted leaves the saved key alone, as the placeholder promises', () => {
  const opened = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const typed = applySettingsIntent(opened, { kind: 'draft-field', field: 'apiKey', value: 'sk-x' }).state
  const emptied = applySettingsIntent(typed, { kind: 'draft-field', field: 'apiKey', value: '' }).state
  assert.ok(emptied.draft)
  const change = draftToChange(emptied.draft, snapshotOf())
  assert.ok(!('error' in change))
  assert.equal('apiKey' in change, false, 'an empty string would make the host drop the key')
})

test('an edited endpoint seeds its key field empty, not with the mask', () => {
  const state = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  assert.ok(state.draft && state.draft.kind === 'endpoint')
  assert.equal(state.draft.apiKey, '', 'the mask must never become the field value')
})

// --- routing options ---------------------------------------------------------

test('routing options put inherit first and keep unresolvable keys, labelled', () => {
  const options = routingOptions(snapshotOf())
  assert.equal(options[0]?.value, 'inherit')
  const broken = options.find((option) => option.value === 'broken')
  assert.ok(broken, 'a configured model that cannot resolve must still be selectable')
  assert.match(broken.label, /无法解析/)
  assert.equal(options.find((option) => option.value === 'big')?.label, 'big')
})

// --- keys --------------------------------------------------------------------

test('the global chord answers none unless ctrl or meta is held', () => {
  assert.deepEqual(settingsChordToIntent({ key: ',' }), { kind: 'none' })
  assert.deepEqual(settingsChordToIntent({ key: ',', shiftKey: true }), { kind: 'none' })
  assert.deepEqual(settingsChordToIntent({ key: ',', ctrlKey: true }), { kind: 'open' })
  assert.deepEqual(settingsChordToIntent({ key: ',', metaKey: true }), { kind: 'open' })
  assert.deepEqual(settingsChordToIntent({ key: 'a', ctrlKey: true }), { kind: 'none' })
})

test('the scoped handler ignores modified keys so the global chords still land', () => {
  const state = openState()
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape', ctrlKey: true }, state), { kind: 'none' })
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter', metaKey: true }, state), { kind: 'none' })
})

test('escape unwinds form, then confirmation, then the filter, then the screen — in that order', () => {
  const withDraft = applySettingsIntent(openState(), { kind: 'new-model' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, withDraft), { kind: 'cancel-draft' })

  const confirming = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, confirming), { kind: 'cancel-remove' })
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter' }, confirming), { kind: 'confirm-remove' })

  const searching = applySettingsIntent(openState(), { kind: 'search', query: 'MCP' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, searching), { kind: 'clear-search' })

  // The two inner layers outrank the filter: a filter is a state of the screen,
  // and dismissing it must not cost a half-typed form or an armed delete.
  const draftingAndSearching = applySettingsIntent(withDraft, { kind: 'search', query: 'MCP' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, draftingAndSearching), { kind: 'cancel-draft' })
  const confirmingAndSearching = applySettingsIntent(confirming, { kind: 'search', query: 'MCP' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, confirmingAndSearching), { kind: 'cancel-remove' })

  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, openState()), { kind: 'close' })
})

test('enter only confirms when something is actually pending', () => {
  assert.deepEqual(settingsKeyToIntent({ key: 'Enter' }, openState()), { kind: 'none' })
})

// --- the reducer -------------------------------------------------------------

test('at most one form is open at a time', () => {
  const first = applySettingsIntent(openState(), { kind: 'new-endpoint' }).state
  assert.equal(first.draft?.kind, 'endpoint')
  const second = applySettingsIntent(first, { kind: 'new-model' }).state
  assert.equal(second.draft?.kind, 'model', 'the second form replaces the first rather than stacking')
})

test('opening asks for a load; closing does not', () => {
  const opened = applySettingsIntent(createSettingsState(), { kind: 'open' })
  assert.equal(opened.state.open, true)
  assert.equal(opened.load, true)
  const closed = applySettingsIntent(opened.state, { kind: 'close' })
  assert.equal(closed.state.open, false)
  assert.equal(closed.load, undefined)
})

test('opening can name its page, which is how `/provider` reaches the editor', () => {
  // `/provider` used to be dropped on the floor by the renderer. It now opens
  // this screen, and it has to land on the provider page rather than on
  // whichever one the user last left open.
  const elsewhere = applySettingsIntent(openState(), { kind: 'select-category', category: 'general' }).state
  const closed = applySettingsIntent(elsewhere, { kind: 'close' }).state

  const named = applySettingsIntent(closed, { kind: 'open', category: 'provider' })
  assert.equal(named.state.open, true)
  assert.equal(named.state.category, 'provider')
  assert.equal(named.load, true)

  // `Ctrl+,` names nothing and keeps the last page.
  assert.equal(applySettingsIntent(closed, { kind: 'open' }).state.category, 'general')

  // Already open: the page moves, without a second load for the same config.
  const moved = applySettingsIntent(elsewhere, { kind: 'open', category: 'provider' })
  assert.equal(moved.state.category, 'provider')
  assert.equal(moved.load, undefined)
})

test('every category can be selected, and switching one drops an open form', () => {
  // Replaces "a disabled category cannot be selected": all four are built, and
  // `cardsFor` is now a `switch` with no `default`, so the compiler is what
  // stops a fifth from shipping empty.
  const drafting = applySettingsIntent(openState(), { kind: 'new-endpoint' })
  const next = applySettingsIntent(drafting.state, { kind: 'select-category', category: 'permissions' })
  assert.equal(next.state.category, 'permissions')
  assert.equal(next.state.draft, undefined, 'a provider form must not survive onto another page')
})

test('switching project drops the stale snapshot and reloads', () => {
  const next = applySettingsIntent(openState(), { kind: 'select-project', projectRoot: 'C:\\repo\\beta' })
  assert.equal(next.state.snapshot, undefined, 'another project’s config must not linger on screen')
  assert.equal(next.load, true)
})

test('a routing select emits exactly one change and marks the screen busy', () => {
  const outcome = applySettingsIntent(openState(), { kind: 'set-routing', role: 'plan', value: 'big' })
  assert.deepEqual(outcome.changes, [
    { scope: 'provider', kind: 'set-routing', role: 'plan', value: 'big' },
  ])
  assert.equal(outcome.state.busy, true)
})

test('a delete needs the confirmation; confirming emits the removal', () => {
  const armed = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'endpoint', name: 'main' },
  })
  assert.equal(armed.changes, undefined, 'asking must not delete')
  const confirmed = applySettingsIntent(armed.state, { kind: 'confirm-remove' })
  assert.deepEqual(confirmed.changes, [{ scope: 'provider', kind: 'remove-endpoint', name: 'main' }])

  const cancelled = applySettingsIntent(armed.state, { kind: 'cancel-remove' })
  assert.equal(cancelled.state.confirmingRemove, undefined)
  assert.equal(cancelled.changes, undefined)
})

test('confirming with nothing pending deletes nothing', () => {
  const outcome = applySettingsIntent(openState(), { kind: 'confirm-remove' })
  assert.equal(outcome.changes, undefined)
})

// --- form validation ---------------------------------------------------------

function endpointDraft(
  overrides: Partial<Extract<SettingsDraft, { kind: 'endpoint' }>> = {},
): SettingsDraft {
  return {
    kind: 'endpoint',
    name: 'main',
    isNew: true,
    provider: 'anthropic',
    baseUrl: '',
    apiKey: '',
    keyTouched: false,
    ...overrides,
  }
}

/** Wraps changes the way `applySettingsIntent` does, so `runSettingsChanges` takes them. */
function pendingOf(...changes: SettingsChange[]): PendingMutation[] {
  return changes.map((change, id) => ({ id, change }))
}

function modelDraft(overrides: Partial<Extract<SettingsDraft, { kind: 'model' }>> = {}): SettingsDraft {
  return {
    kind: 'model',
    key: 'new',
    isNew: true,
    model: 'claude-new',
    endpoint: 'main',
    provider: '',
    contextWindow: '',
    supportedEfforts: [],
    longContext1m: '',
    supportsImageInput: '',
    maxOutputTokens: '',
    ...overrides,
  }
}

test('a model form rejects an empty key, an empty id and a duplicate key', () => {
  assert.deepEqual(draftToChange(modelDraft({ key: '  ' }), snapshotOf()), { error: '键名不能为空。' })
  assert.deepEqual(draftToChange(modelDraft({ model: '' }), snapshotOf()), { error: '模型 id 不能为空。' })
  const duplicate = draftToChange(modelDraft({ key: 'big' }), snapshotOf())
  assert.ok('error' in duplicate && /已经有一个叫 big/.test(duplicate.error))
})

test('a model form rejects a non-numeric context window', () => {
  const result = draftToChange(modelDraft({ contextWindow: '200k' }), snapshotOf())
  assert.ok('error' in result && /必须是数字/.test(result.error))
  const negative = draftToChange(modelDraft({ maxOutputTokens: '-5' }), snapshotOf())
  assert.ok('error' in negative)
})

test('a model with neither endpoint nor provider is rejected rather than saved unusable', () => {
  const result = draftToChange(modelDraft({ endpoint: '', provider: '' }), snapshotOf())
  assert.ok('error' in result)
})

test('blank numeric fields are omitted, not sent as zero', () => {
  const change = draftToChange(modelDraft(), snapshotOf())
  assert.ok(!('error' in change))
  assert.equal('contextWindow' in change, false)
  assert.equal('maxOutputTokens' in change, false)
  // Off is absence, not `false`: `applyProviderChange` rebuilds the whole
  // `ModelConfig`, so an omitted field is how the switch gets removed.
  assert.equal('longContext1m' in change, false)
  assert.equal('supportsImageInput' in change, false)
})

test('the 1M header switch round-trips through the model form', () => {
  const snapshot = snapshotOf({
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', contextWindow: 1_000_000, longContext1m: true, resolves: true },
    ],
    defaultModel: 'big',
    routing: { main: 'big', plan: 'inherit', compact: 'inherit', subagent: [] },
  })

  // Seeded from the snapshot, or editing a model would silently switch it off.
  const opened = applySettingsIntent(
    openState({ category: 'provider', snapshot }),
    { kind: 'edit-model', key: 'big' },
  ).state
  assert.ok(opened.draft?.kind === 'model')
  assert.equal(opened.draft.longContext1m, 'on')

  const change = draftToChange(opened.draft, snapshot)
  assert.ok(!('error' in change) && change.kind === 'set-model')
  assert.equal(change.longContext1m, true)

  // Optimistic: the row must not blink back to off between save and refresh.
  const projected = projectSnapshot(snapshot, pendingOf(change))
  assert.equal(projected.models.find((model) => model.key === 'big')?.longContext1m, true)

  // And the model list says which models carry it.
  const card = settingsView(openState({ category: 'provider', snapshot })).cards
    .find((card) => card.id === 'models')
  const row = card?.rows.find((row) => row.id === 'model:big')
  assert.match(row?.detail ?? '', /1M 请求头/)
})

test('the image-input switch round-trips through the model form', () => {
  const snapshot = snapshotOf({
    models: [
      {
        key: 'big',
        model: 'claude-big',
        endpoint: 'main',
        supportsImageInput: true,
        imageCapable: true,
        resolves: true,
      },
    ],
    defaultModel: 'big',
    routing: { main: 'big', plan: 'inherit', compact: 'inherit', subagent: [] },
  })

  // Seeded from the snapshot, or editing another field would silently reset the
  // user's declaration — the carry used to do this job; the form owns it now.
  const opened = applySettingsIntent(
    openState({ category: 'provider', snapshot }),
    { kind: 'edit-model', key: 'big' },
  ).state
  assert.ok(opened.draft?.kind === 'model')
  assert.equal(opened.draft.supportsImageInput, 'on')

  const change = draftToChange(opened.draft, snapshot)
  assert.ok(!('error' in change) && change.kind === 'set-model')
  assert.equal(change.supportsImageInput, true)

  // Optimistic: the raw switch and a kept-alive marker must not blink off
  // between save and refresh. The marker cannot be recomputed renderer-side
  // (that is the host's registry call), so it survives only while the switch
  // the change sends stays on.
  const projected = projectSnapshot(snapshot, pendingOf(change))
  const row = projected.models.find((model) => model.key === 'big')
  assert.equal(row?.supportsImageInput, true)
  assert.equal(row?.imageCapable, true)

  // Switching it off omits the field, and the dropped marker is immediate —
  // the one direction that must never lag behind the host.
  const off = draftToChange({ ...opened.draft, supportsImageInput: '' }, snapshot)
  assert.ok(!('error' in off) && off.kind === 'set-model')
  assert.equal('supportsImageInput' in off, false)
  const projectedOff = projectSnapshot(snapshot, pendingOf(off))
  const offRow = projectedOff.models.find((model) => model.key === 'big')
  assert.equal(offRow?.supportsImageInput, undefined)
  assert.equal(offRow?.imageCapable, undefined)

  // The form offers the switch with its caveat, and the list marks capability
  // from the host-resolved field, never the raw switch.
  const form = settingsView(opened).form
  assert.ok(form && form.kind !== 'mcp-server')
  const field = form.fields.find((field) => field.id === 'supportsImageInput')
  assert.equal(field?.toggle, true)
  assert.equal(field?.note, '开启后，此模型可接收图片。请确认该模型及接入点支持当前协议的图像输入。')

  const card = settingsView(openState({ category: 'provider', snapshot })).cards
    .find((card) => card.id === 'models')
  assert.match(card?.rows.find((row) => row.id === 'model:big')?.detail ?? '', /支持图像/)
})

test("a new endpoint's models carry what the service reported about them", () => {
  const changes = draftToChanges(
    endpointDraft({
      name: 'fresh',
      step: 'models',
      listed: [{ id: 'claude-x', contextWindow: 200000, maxOutputTokens: 64000, imageInput: true }, { id: 'plain' }],
      picked: ['claude-x', 'typed-in'],
    }),
    snapshotOf({ defaultModel: undefined }),
  )
  assert.deepEqual(changes, [
    { scope: 'provider', kind: 'set-endpoint', name: 'fresh', provider: 'anthropic' },
    {
      scope: 'provider',
      kind: 'set-model',
      key: 'claude-x',
      model: 'claude-x',
      endpoint: 'fresh',
      contextWindow: 200000,
      maxOutputTokens: 64000,
      supportsImageInput: true,
    },
    // Typed in by hand, so nothing is known about it: every field stays at its default.
    { scope: 'provider', kind: 'set-model', key: 'typed-in', model: 'typed-in', endpoint: 'fresh' },
    { scope: 'provider', kind: 'set-default-model', key: 'claude-x' },
  ])
})

test('the supported effort levels round-trip through the model form', () => {
  const snapshot = snapshotOf({
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', supportedEfforts: ['low', 'high'], resolves: true },
    ],
    defaultModel: 'big',
    routing: { main: 'big', plan: 'inherit', compact: 'inherit', subagent: [] },
  })

  const opened = applySettingsIntent(
    openState({ category: 'provider', snapshot }),
    { kind: 'edit-model', key: 'big' },
  ).state
  assert.ok(opened.draft?.kind === 'model')
  assert.deepEqual(opened.draft.supportedEfforts, ['low', 'high'])

  // Checking `medium` fills the gap; the set stays in ladder order, not click order.
  const toggled = applySettingsIntent(opened, { kind: 'model-toggle-effort', level: 'medium' }).state
  assert.ok(toggled.draft?.kind === 'model')
  assert.deepEqual(toggled.draft.supportedEfforts, ['low', 'medium', 'high'])

  const change = draftToChange(toggled.draft, snapshot)
  assert.ok(!('error' in change) && change.kind === 'set-model')
  assert.deepEqual(change.supportedEfforts, ['low', 'medium', 'high'])

  const projected = projectSnapshot(snapshot, pendingOf(change))
  assert.deepEqual(
    projected.models.find((model) => model.key === 'big')?.supportedEfforts,
    ['low', 'medium', 'high'],
  )

  const card = settingsView(openState({ category: 'provider', snapshot })).cards
    .find((card) => card.id === 'models')
  assert.match(card?.rows.find((row) => row.id === 'model:big')?.detail ?? '', /思考等级 低、高/)
})

test('picking nothing and picking everything both mean "no restriction"', () => {
  assert.equal('supportedEfforts' in draftToChange(modelDraft(), snapshotOf()), false)
  const all = draftToChange(
    modelDraft({ supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    snapshotOf(),
  )
  assert.ok(!('error' in all))
  // Writing the full ladder out would freeze today's five levels into the config
  // file, so it is omitted exactly like an empty selection.
  assert.equal('supportedEfforts' in all, false)
})

test('the effort field offers every level with the picked ones marked', () => {
  const state = applySettingsIntent(
    openState({ category: 'provider', snapshot: snapshotOf() }),
    { kind: 'new-model' },
  ).state
  const withPick = applySettingsIntent(state, { kind: 'model-toggle-effort', level: 'high' }).state
  const form = settingsView(withPick).form
  assert.ok(form && form.kind !== 'mcp-server')
  const field = form.fields.find((field) => field.id === 'supportedEfforts')
  assert.ok(field?.multi)
  assert.deepEqual(field.multi.options.map((option) => option.value), [
    'low', 'medium', 'high', 'xhigh', 'max',
  ])
  assert.deepEqual(field.multi.selected, ['high'])
  assert.equal(field.multi.summary, '高')
  assert.equal(field.multi.open, false, 'the menu is closed until its trigger is pressed')

  // Nothing picked reads as 全部 rather than an empty pill.
  const empty = settingsView(state).form
  assert.ok(empty && empty.kind !== 'mcp-server')
  assert.equal(empty.fields.find((field) => field.id === 'supportedEfforts')?.multi?.summary, '全部')
})

test('renaming a model emits the rename before the write', () => {
  const changes = draftToChanges(
    modelDraft({ key: 'huge', isNew: false, originalKey: 'big', model: 'claude-big' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.equal(changes.length, 2)
  assert.deepEqual(changes[0], { scope: 'provider', kind: 'rename-model', from: 'big', to: 'huge' })
  assert.equal(changes[1]?.kind, 'set-model')
})

test('renaming an endpoint emits the rename before the write, and moves its models', () => {
  const changes = draftToChanges(
    endpointDraft({ name: 'backup', isNew: false, originalName: 'main' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  // Never `set-endpoint` alone: that leaves the old endpoint behind with every
  // model still pointing at it, and deleting the leftover takes them with it.
  assert.deepEqual(changes[0], { scope: 'provider', kind: 'rename-endpoint', from: 'main', to: 'backup' })
  assert.equal(changes[1]?.kind, 'set-endpoint')

  const projected = projectSnapshot(snapshotOf(), pendingOf(changes[0]!))
  assert.deepEqual(projected.endpoints.map((endpoint) => endpoint.name), ['backup'])
  assert.equal(projected.models.find((model) => model.key === 'big')?.endpoint, 'backup')
})

test('the form for an existing endpoint is anchored by the name it was opened on', () => {
  // The anchor keys the form's kept nodes, so anchoring on the live `name`
  // rebuilt the form — and blurred the field — on every character typed.
  const opened = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const typed = applySettingsIntent(opened, { kind: 'draft-field', field: 'name', value: 'mai' }).state
  const form = settingsView(typed).form
  assert.ok(form)
  assert.deepEqual(form.anchor, { cardId: 'endpoints', rowId: 'endpoint:main' })
  assert.equal(form.title, '编辑接入点 main')
})

test('editing a model without renaming it emits one change', () => {
  const changes = draftToChanges(
    modelDraft({ key: 'big', isNew: false, originalKey: 'big', model: 'claude-big-2' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.equal(changes.length, 1)
})

test('a duplicate endpoint name is rejected only when creating', () => {
  const dup = draftToChange(
    endpointDraft({ name: 'main', isNew: true }),
    snapshotOf(),
  )
  assert.ok('error' in dup)
  const edit = draftToChange(
    endpointDraft({ name: 'main', isNew: false, originalName: 'main' }),
    snapshotOf(),
  )
  assert.ok(!('error' in edit))
  // A rename onto another endpoint's name is the same collision as a creation.
  const collide = draftToChange(
    endpointDraft({ name: 'main', isNew: false, originalName: 'backup' }),
    snapshotOf(),
  )
  assert.ok('error' in collide)
})

// --- the view model ----------------------------------------------------------

test('every category draws its own cards, and none draws a placeholder', () => {
  for (const category of ['provider', 'extensions', 'permissions', 'agent', 'general', 'personalization', 'appearance'] as const) {
    const view = settingsView(openState({ category }))
    assert.ok(view.cards.length > 0 || view.editor, `${category} has no cards`)
    assert.ok(
      view.cards.every((card) => card.id !== 'pending'),
      `${category} still draws the placeholder card`,
    )
  }
  assert.deepEqual(
    settingsView(openState()).navGroups.flatMap((group) => group.items.map((item) => item.category)),
    ['general', 'personalization', 'appearance', 'provider', 'extensions', 'permissions', 'agent'],
  )
})

test('the nav is three named sections, and every page lands in exactly one', () => {
  const groups = settingsView(openState()).navGroups
  assert.deepEqual(
    groups.map((group) => [group.group, group.label]),
    [
      ['personal', '个人'],
      ['integration', '集成'],
      ['coding', '编码'],
    ],
  )
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.category)),
    [['general', 'personalization', 'appearance'], ['provider', 'extensions'], ['permissions', 'agent']],
  )
  // Each item carries the section it was filed under, so the DOM never has to
  // re-derive the grouping (two views of one list is how they come to disagree).
  for (const group of groups) {
    assert.ok(group.items.length > 0, `${group.group} is an empty section`)
    for (const item of group.items) assert.equal(item.group, group.group)
  }
})

// --- the search box ----------------------------------------------------------

test('the query filters the nav to the pages that hold a match', () => {
  // 「MCP」 appears only on the extensions page (the MCP server card), so the
  // personal and coding sections drop out entirely.
  const view = settingsView(openState({ category: 'extensions', query: 'MCP' }))
  assert.deepEqual(
    view.navGroups.map((group) => group.items.map((item) => item.category)),
    [['extensions']],
  )
})

test('the selected page never leaves the nav, however unmatched it is', () => {
  // Otherwise a query can delete the row the user is standing on, and there is no
  // way back to it — which is also why the nav has no empty state.
  const view = settingsView(openState({ category: 'agent', query: 'MCP' }))
  const categories = view.navGroups.flatMap((group) => group.items.map((item) => item.category))
  assert.ok(categories.includes('agent'), 'the selected page survives its own filter')
  assert.ok(categories.includes('extensions'), 'and the page that actually matched is there too')
  const selected = view.navGroups.flatMap((group) => group.items).filter((item) => item.selected)
  assert.deepEqual(selected.map((item) => item.category), ['agent'])
})

test('a card that matches on its own title keeps all of its rows', () => {
  // Searching 「MCP」 must show the server list, not an empty MCP card.
  const view = settingsView(openState({ category: 'extensions', query: 'MCP' }))
  assert.deepEqual(view.cards.map((card) => card.id), ['mcp'])
  assert.equal(view.cards[0]?.rows.length, snapshotOf().mcpServers.length)
  assert.equal(view.searchEmpty, undefined)
})

test('a card that does not match itself keeps only its matching rows', () => {
  const view = settingsView(openState({ category: 'general', query: '压缩预留' }))
  assert.deepEqual(view.cards.map((card) => card.id), ['context'])
  assert.deepEqual(
    view.cards[0]?.rows.map((row) => row.id),
    ['context:autoCompactBufferTokens', 'context:manualCompactBufferTokens'],
  )
})

test('matching is case-insensitive and trimmed', () => {
  // Asserted on the matcher itself, in both directions: the screen's own text
  // happens to contain 「MCP」 in both cases, so a view-level assertion alone
  // passes even when the folding is gone.
  assert.equal(matchesQuery('MCP', 'npx github-mcp'), true)
  assert.equal(matchesQuery('mcp', 'MCP 服务器'), true)
  assert.equal(matchesQuery('  mcp  ', 'MCP 服务器'), true)
  assert.equal(matchesQuery('mcp', '上下文管理'), false)
  assert.equal(matchesQuery('mcp', undefined), false)
  // An empty query matches everything, so callers need no special case.
  assert.equal(matchesQuery('', undefined), true)
  assert.equal(matchesQuery('   ', '上下文管理'), true)

  const loud = settingsView(openState({ category: 'extensions', query: '  mcp  ' }))
  assert.deepEqual(loud.cards.map((card) => card.id), ['mcp'])
  assert.equal(
    loud.cards[0]?.rows.length,
    snapshotOf().mcpServers.length,
    'the folded query matched the card title, so the card keeps every row',
  )
  // A query of nothing but whitespace is not a query at all.
  const blank = settingsView(openState({ category: 'general', query: '   ' }))
  assert.deepEqual(blank.cards.map((card) => card.id), ['general', 'context'])
  assert.equal(blank.searchEmpty, undefined)
})

test('an unmatched page draws one line, not a screen of empty cards', () => {
  const view = settingsView(openState({ category: 'general', query: 'zzz-nothing' }))
  assert.deepEqual(view.cards, [])
  assert.match(view.searchEmpty ?? '', /zzz-nothing/)
})

test('a page that has not loaded says so by staying silent, not by claiming no matches', () => {
  // 「还没有加载」 and 「没有匹配」 are different facts. Conflating them would tell
  // the user their query failed when the truth is that no project is open yet.
  const view = settingsView(openState({ snapshot: undefined, projectRoot: undefined, query: 'MCP' }))
  assert.deepEqual(view.cards, [])
  assert.equal(view.searchEmpty, undefined)
})

test('typing does not disarm a pending delete or clear an error', () => {
  const confirming = applySettingsIntent(openState({ error: '写入失败' }), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  const typed = applySettingsIntent({ ...confirming, error: '写入失败' }, {
    kind: 'search',
    query: 'MCP',
  }).state
  assert.equal(typed.query, 'MCP')
  assert.deepEqual(typed.confirmingRemove, { kind: 'model', name: 'big' })
  assert.equal(typed.error, '写入失败')
})

test('clear-search empties the query and touches nothing else', () => {
  const searching = applySettingsIntent(openState({ category: 'agent' }), {
    kind: 'search',
    query: 'MCP',
  }).state
  const cleared = applySettingsIntent(searching, { kind: 'clear-search' })
  assert.equal(cleared.state.query, '')
  assert.equal(cleared.state.category, 'agent')
  assert.equal(cleared.changes, undefined, 'the filter is renderer-local')
  assert.equal(cleared.load, undefined)
})

test('reopening the screen starts with an empty query', () => {
  const searching = applySettingsIntent(openState(), { kind: 'search', query: 'MCP' }).state
  const closed = applySettingsIntent(searching, { kind: 'close' }).state
  assert.equal(closed.query, 'MCP', 'closing alone does not reset it')
  const reopened = applySettingsIntent(closed, { kind: 'open' }).state
  assert.equal(reopened.query, '', 'a freshly opened screen is not still filtered')
})

// --- the pill dropdowns ------------------------------------------------------

test('toggling a dropdown opens it, and toggling the same one closes it', () => {
  const opened = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(opened.state.openMenu, 'row:routing:main')
  assert.equal(opened.changes, undefined, 'expanding a picker is not a config write')
  const closed = applySettingsIntent(opened.state, { kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(closed.state.openMenu, undefined)
})

test('opening a second dropdown closes the first', () => {
  // One field rather than a set: two open menus can overlap, and the screen has a
  // dozen selects on it at once.
  const first = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' })
  const second = applySettingsIntent(first.state, { kind: 'toggle-menu', menu: 'row:routing:plan' })
  assert.equal(second.state.openMenu, 'row:routing:plan')
})

test('close-menu is idempotent, because focus loss and Escape both mean closed', () => {
  const open = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' }).state
  assert.equal(applySettingsIntent(open, { kind: 'close-menu' }).state.openMenu, undefined)
  const already = openState()
  assert.equal(applySettingsIntent(already, { kind: 'close-menu' }).state, already, 'no needless copy')
})

test('picking a value closes the dropdown, and so does anything else on screen', () => {
  const open = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' }).state
  // The intent a menu item emits goes through `cleared`, which is what makes
  // "picking dismisses the menu" free rather than something each row remembers.
  for (const intent of [
    { kind: 'set-routing', role: 'main', value: 'inherit' },
    { kind: 'select-category', category: 'general' },
    { kind: 'search', query: 'MCP' },
    { kind: 'clear-search' },
    { kind: 'request-remove', target: { kind: 'model', name: 'big' } },
    { kind: 'close' },
  ] as const satisfies readonly SettingsIntent[]) {
    assert.equal(
      applySettingsIntent(open, intent).state.openMenu,
      undefined,
      `${intent.kind} left a menu hanging open`,
    )
  }
  const armed = applySettingsIntent(open, {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  assert.equal(applySettingsIntent(armed, { kind: 'cancel-remove' }).state.openMenu, undefined)
})

test('expanding a picker does not throw away an unread error', () => {
  const failed = { ...openState(), error: '写入失败' }
  const opened = applySettingsIntent(failed, { kind: 'toggle-menu', menu: 'row:routing:main' })
  assert.equal(opened.state.error, '写入失败')
  assert.equal(opened.state.openMenu, 'row:routing:main')
})

test('escape closes an open dropdown before it touches the form', () => {
  const drafting = applySettingsIntent(openState(), { kind: 'new-model' }).state
  const withMenu = applySettingsIntent(drafting, { kind: 'toggle-menu', menu: 'row:x' }).state
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, withMenu), { kind: 'close-menu' })
  // A form field's menu is drawn on top of the form, so dismissing it must not
  // cost the half-typed form underneath.
  assert.ok(withMenu.draft, 'the form is still there to lose')
})

test('reopening the screen leaves no dropdown expanded', () => {
  const open = applySettingsIntent(openState(), { kind: 'toggle-menu', menu: 'row:routing:main' }).state
  const closed = applySettingsIntent(open, { kind: 'close' }).state
  assert.equal(applySettingsIntent(closed, { kind: 'open' }).state.openMenu, undefined)
})

test('appearance draws its card even with no project loaded', () => {
  // Theme is renderer-local, so the appearance page must render before (and
  // without) a host snapshot — the early return ahead of the snapshot guard.
  const view = settingsView(openState({ category: 'appearance', snapshot: undefined, projectRoot: undefined }))
  const card = view.cards.find((c) => c.id === 'appearance')
  assert.ok(card, 'appearance card is drawn without a snapshot')
  const row = card.rows.find((r) => r.id === 'appearance:theme')
  assert.ok(row && row.control.kind === 'select', 'theme is a select row')
  assert.equal(row.control.value, 'system', 'the select is seeded from state.themePref')
  assert.deepEqual(row.control.choices.map((c) => c.value), ['system', 'dark', 'light'])
  assert.deepEqual(row.control.intentOnChange('dark'), { kind: 'set-theme', preference: 'dark' })
})

test('the renderer-local appearance page is searchable on its own, without a snapshot', () => {
  const base = { category: 'appearance', snapshot: undefined, projectRoot: undefined } as const
  const hit = settingsView(openState({ ...base, query: '主题' }))
  assert.deepEqual(hit.cards.map((card) => card.id), ['appearance'])
  const miss = settingsView(openState({ ...base, query: 'zzz-nothing' }))
  assert.deepEqual(miss.cards, [])
  assert.match(miss.searchEmpty ?? '', /zzz-nothing/)
})

test('set-theme is a client-only write: it updates state but never touches the wire', () => {
  const outcome = applySettingsIntent(openState({ themePref: 'system' }), {
    kind: 'set-theme',
    preference: 'light',
  })
  assert.equal(outcome.state.themePref, 'light')
  assert.equal(outcome.themePreference, 'light')
  assert.equal(outcome.changes, undefined, 'the theme is not a SettingsChange')
  assert.equal(outcome.load, undefined, 'the theme needs no reload')
})

test('the view says where it saves in words, and keeps the path for the hover', () => {
  const view = settingsView(openState())
  assert.match(view.subtitle ?? '', /全局配置/)
  assert.doesNotMatch(view.subtitle ?? '', /config\.json/)
  assert.match(view.subtitleHint ?? '', /config\.json/)
})

test('no card note spells out a file path or an internal value', () => {
  for (const category of ['provider', 'extensions', 'permissions', 'agent', 'general'] as const) {
    for (const card of settingsView(openState({ category })).cards) {
      assert.doesNotMatch(card.note ?? '', /[\\/]\.myagent|\.json|inherit|MYAGENT_|主循环/, `${category}/${card.id}`)
    }
  }
})

test('an unresolvable model row carries a warning instead of being dropped', () => {
  const view = settingsView(openState())
  const models = view.cards.find((card) => card.id === 'models')
  const broken = models?.rows.find((row) => row.id === 'model:broken')
  assert.ok(broken, 'the row exists')
  assert.match(broken.warning ?? '', /无法解析/)
})

test('the default model row offers no redundant "set default" button', () => {
  const view = settingsView(openState())
  const models = view.cards.find((card) => card.id === 'models')
  const big = models?.rows.find((row) => row.id === 'model:big')
  assert.ok(big && big.control.kind === 'buttons')
  assert.ok(
    !big.control.buttons.some((button) => button.intent.kind === 'set-default-model'),
    'big is already the default',
  )
  const broken = models?.rows.find((row) => row.id === 'model:broken')
  assert.ok(broken && broken.control.kind === 'buttons')
  assert.ok(broken.control.buttons.some((button) => button.intent.kind === 'set-default-model'))
})

test('no endpoint row ever renders a raw key, only what the wire masked', () => {
  const view = settingsView(openState())
  const endpoints = view.cards.find((card) => card.id === 'endpoints')
  assert.match(endpoints?.rows[0]?.detail ?? '', /sk-a\.\.\.ijkl/)
})

test('a routing row has a select seeded with the current value', () => {
  const view = settingsView(openState())
  const routing = view.cards.find((card) => card.id === 'routing')
  const main = routing?.rows.find((row) => row.id === 'routing:main')
  assert.ok(main && main.control.kind === 'select')
  assert.equal(main.control.value, 'big')
  assert.deepEqual(main.control.intentOnChange('inherit'), {
    kind: 'set-routing',
    role: 'main',
    value: 'inherit',
  })
})

test('a routing.main that outranks the default model says so in both cards', () => {
  // `resolveModelKeyFor({ kind: 'main' })` reads routing first, so this config
  // starts new sessions on `broken`… except `broken` does not resolve, so the
  // one that actually wins here is the default. Both halves are the point.
  const overriding = snapshotOf({
    defaultModel: 'big',
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', resolves: true },
      { key: 'small', model: 'claude-small', endpoint: 'main', resolves: true },
    ],
    routing: { main: 'small', plan: 'inherit', compact: 'inherit', subagent: [] },
  })
  const view = settingsView(openState({ snapshot: overriding }))
  assert.match(view.cards.find((card) => card.id === 'models')?.note ?? '', /实际从 small 开始/)
  const main = view.cards.find((card) => card.id === 'routing')?.rows.find((row) => row.id === 'routing:main')
  assert.match(main?.detail ?? '', /覆盖默认模型 big/)

  // An unresolvable routing target degrades to the default, so nothing is
  // claimed to be overridden.
  const degraded = settingsView(openState({
    snapshot: snapshotOf({ routing: { main: 'broken', plan: 'inherit', compact: 'inherit', subagent: [] } }),
  }))
  assert.equal(degraded.cards.find((card) => card.id === 'models')?.note, '默认模型：big')
})

test('"设为默认" releases a routing.main that would outrank it', () => {
  const overriding = snapshotOf({
    defaultModel: 'big',
    models: [
      { key: 'big', model: 'claude-big', endpoint: 'main', resolves: true },
      { key: 'small', model: 'claude-small', endpoint: 'main', resolves: true },
    ],
    routing: { main: 'small', plan: 'inherit', compact: 'inherit', subagent: [] },
  })
  const outcome = applySettingsIntent(openState({ snapshot: overriding }), {
    kind: 'set-default-model',
    key: 'big',
  })
  assert.deepEqual(outcome.changes, [
    { scope: 'provider', kind: 'set-default-model', key: 'big' },
    { scope: 'provider', kind: 'set-routing', role: 'main', value: 'inherit' },
  ])

  // Nothing to release when routing already follows the main model: the extra
  // change would rewrite a role the user never touched.
  const plain = applySettingsIntent(
    openState({ snapshot: snapshotOf({ routing: { main: 'inherit', plan: 'inherit', compact: 'inherit', subagent: [] } }) }),
    { kind: 'set-default-model', key: 'broken' },
  )
  assert.deepEqual(plain.changes, [{ scope: 'provider', kind: 'set-default-model', key: 'broken' }])
})

test('every configured subagent type gets its own routing row', () => {
  const view = settingsView(openState())
  const routing = view.cards.find((card) => card.id === 'routing')
  assert.ok(routing?.rows.some((row) => row.id === 'routing:subagent:explore'))
})

test('with no snapshot yet the screen draws no cards rather than empty ones', () => {
  const view = settingsView({ ...openState(), snapshot: undefined })
  assert.deepEqual(view.cards, [])
})

// --- permissions --------------------------------------------------------------

function permissionsView(overrides: Partial<WireSettingsSnapshot> = {}) {
  return settingsView(openState({ category: 'permissions', snapshot: snapshotOf(overrides) }))
}

test('an inherited rule is drawn, labelled, and has no delete button', () => {
  // Drawn rather than hidden: it is being enforced. Hiding it would explain
  // neither why a tool is denied nor why deleting the rule you *can* see did
  // nothing.
  const allow = permissionsView().cards.find((card) => card.id === 'permissions:allow')
  const local = allow?.rows.find((row) => row.label === 'Bash(git status:*)')
  const inherited = allow?.rows.find((row) => row.label === 'Read')

  assert.ok(local && local.control.kind === 'buttons')
  assert.equal(local.control.buttons.length, 1, 'the local rule can be removed')
  assert.ok(inherited && inherited.control.kind === 'text')
  assert.equal(inherited.control.muted, true)
  assert.match(inherited.detail ?? '', /上层设置/)
})

test('adding a rule sends the whole local group, not just the new line', () => {
  const opened = applySettingsIntent(
    openState({ category: 'permissions' }),
    { kind: 'new-permission-rule', behavior: 'allow' },
  )
  const typed = applySettingsIntent(opened.state, { kind: 'draft-field', field: 'entry', value: 'Read' })
  const submitted = applySettingsIntent(typed.state, { kind: 'submit-draft' })

  assert.deepEqual(submitted.changes, [
    {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: 'allow',
      // The host rewrites the local layer outright: sending only `Read` would
      // delete the rule that was already there.
      entries: ['Bash(git status:*)', 'Read'],
    },
  ])
})

test('a rule already in the local layer is rejected instead of duplicated', () => {
  const opened = applySettingsIntent(
    openState({ category: 'permissions' }),
    { kind: 'new-permission-rule', behavior: 'allow' },
  )
  const typed = applySettingsIntent(opened.state, {
    kind: 'draft-field',
    field: 'entry',
    value: '  Bash(git status:*)  ',
  })
  const submitted = applySettingsIntent(typed.state, { kind: 'submit-draft' })

  assert.equal(submitted.changes, undefined)
  assert.match(submitted.state.error ?? '', /已经有这条规则/)
})

test('the new-rule form lands in the group whose button opened it', () => {
  const opened = applySettingsIntent(
    openState({ category: 'permissions' }),
    { kind: 'new-permission-rule', behavior: 'deny' },
  )
  assert.deepEqual(settingsView(opened.state).form?.fields.map((field) => field.id), ['entry'])
  const typed = applySettingsIntent(opened.state, { kind: 'draft-field', field: 'entry', value: 'Delete' })
  const submitted = applySettingsIntent(typed.state, { kind: 'submit-draft' })

  assert.deepEqual(submitted.changes, [
    // `deny` has an inherited entry and no local one, so the group written is
    // exactly the one new line — the inherited rule stays in its own file.
    { scope: 'permissions', kind: 'set-permission-entries', behavior: 'deny', entries: ['Delete'] },
  ])
})

test('removing a rule drops one copy, not every match', () => {
  const state = openState({
    category: 'permissions',
    snapshot: snapshotOf({
      permissions: {
        localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json',
        mode: 'default',
        modeIsLocal: true,
        groups: [
          { behavior: 'allow', local: ['Read', 'Read', 'Write'], inherited: [] },
          { behavior: 'ask', local: [], inherited: [] },
          { behavior: 'deny', local: [], inherited: [] },
        ],
      },
    }),
  })

  const outcome = applySettingsIntent(state, {
    kind: 'remove-permission-rule',
    behavior: 'allow',
    entry: 'Read',
  })
  assert.deepEqual(outcome.changes, [
    {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: 'allow',
      entries: ['Read', 'Write'],
    },
  ])
})

test('the startup mode row says it does not reach an open session', () => {
  const card = permissionsView().cards.find((card) => card.id === 'permission-mode')
  const row = card?.rows[0]
  assert.ok(row && row.control.kind === 'select')
  assert.equal(row.control.value, 'default')
  assert.match(row.detail ?? '', /已经打开的会话/)
  assert.deepEqual(row.control.intentOnChange('bypass'), {
    kind: 'set-startup-permission-mode',
    mode: 'bypass',
  })
  // The mode is last-writer-wins across layers and the local layer is last, so
  // an inherited mode is still editable — unlike the concatenated groups.
  assert.match(card?.noteHint ?? '', /settings\.local\.json/)
})

// --- agents -------------------------------------------------------------------

test('every agent definition gets a row, with its routing select', () => {
  const card = settingsView(openState({ category: 'agent' })).cards.find((card) => card.id === 'agents')
  const reviewer = card?.rows.find((row) => row.id === 'agent:reviewer')

  assert.deepEqual(card?.rows.map((row) => row.id), ['agent:general', 'agent:reviewer'])
  assert.ok(reviewer && reviewer.control.kind === 'select')
  assert.equal(reviewer.control.value, 'big')
  // Reuses the provider page's routing variant rather than inventing a second
  // path to the same config field.
  assert.deepEqual(reviewer.control.intentOnChange('inherit'), {
    kind: 'set-subagent-routing',
    type: 'reviewer',
    value: 'inherit',
  })
  assert.deepEqual(
    reviewer.control.choices,
    routingOptions(snapshotOf()),
    'the same choices the provider routing card offers',
  )
})

test('an agent with no tool list says "all tools", not "no tools"', () => {
  const card = settingsView(openState({ category: 'agent' })).cards.find((card) => card.id === 'agents')
  assert.match(card?.rows.find((row) => row.id === 'agent:general')?.detail ?? '', /工具：全部/)
  assert.match(card?.rows.find((row) => row.id === 'agent:reviewer')?.detail ?? '', /工具：Read、Grep/)
  assert.match(card?.rows.find((row) => row.id === 'agent:general')?.detail ?? '', /内置/)
  assert.match(card?.rows.find((row) => row.id === 'agent:reviewer')?.detail ?? '', /自定义/)
})

test('reloading definitions is one change and nothing else', () => {
  const outcome = applySettingsIntent(openState({ category: 'agent' }), {
    kind: 'reload-agent-definitions',
  })
  assert.deepEqual(outcome.changes, [{ scope: 'agent', kind: 'reload-agent-definitions' }])
  assert.equal(outcome.state.busy, true)
})

// --- general, MCP and the context budget --------------------------------------

test('an unset cache toggle reads as the on-by-default it is', () => {
  const view = settingsView(openState({ category: 'general' }))
  const row = view.cards.find((card) => card.id === 'general')?.rows.find((row) => row.id === 'general:cache-ttl')
  assert.ok(row && row.control.kind === 'toggle')
  assert.equal(row.control.value, true)
  // Unset is not the same as false: the 1h TTL is the default, and the row's
  // hover names the environment variable that turns it off.
  assert.match(row.detail ?? '', /默认开启/)
  assert.match(row.detailHint ?? '', /MYAGENT_PROMPT_CACHE_1H/)
  assert.deepEqual(row.control.intentOnChange(true), { kind: 'set-cache-ttl', enabled: true })
})

test('the thinking toggle reads unset as on and off as a real off', () => {
  const unset = settingsView(openState({ category: 'general' }))
    .cards.find((card) => card.id === 'general')
    ?.rows.find((row) => row.id === 'general:thinking')
  assert.ok(unset && unset.control.kind === 'toggle')
  // Absent means on: `createRuntime` only sends `disabled` for an explicit false.
  assert.equal(unset.control.value, true)
  assert.deepEqual(unset.control.intentOnChange(false), { kind: 'set-thinking', enabled: false })

  const off = settingsView(openState({
    category: 'general',
    snapshot: snapshotOf({
      general: { localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json', thinking: false },
    }),
  }))
    .cards.find((card) => card.id === 'general')
    ?.rows.find((row) => row.id === 'general:thinking')
  assert.ok(off && off.control.kind === 'toggle')
  assert.equal(off.control.value, false)
  assert.match(off.detail ?? '', /不带 thinking 参数/)

  const outcome = applySettingsIntent(openState({ category: 'general' }), {
    kind: 'set-thinking',
    enabled: false,
  })
  assert.deepEqual(outcome.changes, [{ scope: 'general', kind: 'set-thinking', enabled: false }])
})

test('a trust granted by an upper layer is drawn but not toggleable', () => {
  const card = settingsView(openState({ category: 'extensions' })).cards.find((card) => card.id === 'mcp')
  const shared = card?.rows.find((row) => row.id === 'mcp:shared')
  const github = card?.rows.find((row) => row.id === 'mcp:github')
  const cold = card?.rows.find((row) => row.id === 'mcp:cold')

  assert.ok(shared && shared.control.kind === 'toggle')
  assert.equal(shared.control.disabled, true, 'trust is unioned across layers; this one cannot be revoked here')
  assert.ok(github && github.control.kind === 'toggle')
  assert.equal(github.control.disabled, false)
  assert.match(github.detail ?? '', /已连接 · 3 个工具/)

  // `not trusted` is not a connection failure to warn about — it is the next
  // step, and the detail says so.
  assert.equal(cold?.warning, undefined)
  assert.match(cold?.detail ?? '', /未信任/)
  assert.match(shared.warning ?? '', /ECONNREFUSED/)
})

test('reconnecting and trusting are separate changes', () => {
  const trust = applySettingsIntent(openState({ category: 'extensions' }), {
    kind: 'set-mcp-trust',
    name: 'cold',
    trusted: true,
  })
  assert.deepEqual(trust.changes, [
    { scope: 'extensions', kind: 'set-mcp-trust', name: 'cold', trusted: true },
  ])
  const reconnect = applySettingsIntent(openState({ category: 'extensions' }), { kind: 'reconnect-mcp' })
  assert.deepEqual(reconnect.changes, [{ scope: 'extensions', kind: 'reconnect-mcp' }])
})

// --- skills -------------------------------------------------------------------

test('the skills card lists every skill, switched-off ones included', () => {
  const card = settingsView(openState({ category: 'extensions' })).cards.find(
    (card) => card.id === 'skills',
  )
  assert.match(card?.noteHint ?? '', /\.myagent\\skills/)
  assert.deepEqual(card?.rows.map((row) => row.id), ['skill:release', 'skill:review'])
  assert.equal(card?.rows[0]?.label, '/release')

  const release = card?.rows[0]
  assert.ok(release && release.control.kind === 'toggle')
  assert.equal(release.control.value, true)
  // Never disabled, unlike MCP trust: `skills.disabled` is replaced by the
  // merge rather than unioned, so the local layer can always switch one back on.
  assert.equal(release.control.disabled, undefined)
  assert.match(release.detail ?? '', /手动调用/)
  assert.match(release.detail ?? '', /工具：全部/)

  const review = card?.rows[1]
  assert.ok(review && review.control.kind === 'toggle')
  assert.equal(review.control.value, false)
  assert.match(review.detail ?? '', /按文件匹配/)
  assert.match(review.detail ?? '', /匹配 src\/\*\*/)
  assert.match(review.detail ?? '', /工具：Read、Grep/)
  assert.match(review.detail ?? '', /模型：claude-big/)
  assert.match(review.detail ?? '', /推理强度：high/)
  assert.match(review.detail ?? '', /带 hooks/)
  assert.match(review.detail ?? '', /2 个附件/)
  assert.match(review.detail ?? '', /已关闭/)
})

test('the skills card has an empty state and a reload button', () => {
  const card = settingsView(
    openState({ category: 'extensions', snapshot: snapshotOf({ skills: [] }) }),
  ).cards.find((card) => card.id === 'skills')
  assert.equal(card?.rows.length, 0)
  assert.match(card?.empty ?? '', /还没有技能/)
  // Import first: with no skills on disk it is the only useful action, and the
  // empty state points at it.
  assert.deepEqual(card?.footerButtons?.map((button) => button.intent), [
    { kind: 'import-skill' },
    { kind: 'reload-skills' },
  ])
})

test('a skill switch and a skill reload are each one change', () => {
  const card = settingsView(openState({ category: 'extensions' })).cards.find(
    (card) => card.id === 'skills',
  )
  const release = card?.rows[0]
  assert.ok(release && release.control.kind === 'toggle')
  assert.deepEqual(release.control.intentOnChange(false), {
    kind: 'set-skill-enabled',
    name: 'release',
    enabled: false,
  })

  const off = applySettingsIntent(openState({ category: 'extensions' }), {
    kind: 'set-skill-enabled',
    name: 'release',
    enabled: false,
  })
  assert.deepEqual(off.changes, [
    { scope: 'extensions', kind: 'set-skill-enabled', name: 'release', enabled: false },
  ])
  assert.equal(off.state.busy, true)

  const reload = applySettingsIntent(openState({ category: 'extensions' }), { kind: 'reload-skills' })
  assert.deepEqual(reload.changes, [{ scope: 'extensions', kind: 'reload-skills' }])
})

test('the extensions page is the skills card and the MCP card, in that order', () => {
  const view = settingsView(openState({ category: 'extensions' }))
  assert.deepEqual(view.cards.map((card) => card.id), ['skills', 'mcp'])
  // And the general page no longer carries MCP.
  const general = settingsView(openState({ category: 'general' }))
  assert.deepEqual(general.cards.map((card) => card.id), ['general', 'context'])
})

test('the context card names its file and says the numbers need a restart', () => {
  const card = settingsView(openState({ category: 'general' })).cards.find((card) => card.id === 'context')
  assert.match(card?.noteHint ?? '', /config\.json/)
  assert.match(card?.note ?? '', /重启后生效/)
  assert.deepEqual(
    card?.rows.map((row) => row.id),
    [
      'context:contextWindow',
      'context:summaryOutputTokens',
      'context:autoCompactBufferTokens',
      'context:manualCompactBufferTokens',
      'context:microCompactThresholdRatio',
      'context:autoCompactThresholdRatio',
    ],
  )
  const window = card?.rows[0]
  assert.ok(window && window.control.kind === 'input')
  assert.equal(window.control.value, '200,000')
  assert.equal(window.control.unit, 'tokens')
  const ratio = card?.rows.at(-1)
  assert.ok(ratio && ratio.control.kind === 'input')
  assert.equal(ratio.control.unit, '%')
  assert.deepEqual(window.control.intentOnCommit('400000'), {
    kind: 'set-context-value',
    field: 'contextWindow',
    value: '400000',
  })
})

test('a context number is validated here, so a typo is not a host error', () => {
  const state = openState({ category: 'general' })
  const cases: Array<{ field: 'contextWindow' | 'autoCompactThresholdRatio'; value: string; error: RegExp }> = [
    { field: 'contextWindow', value: '', error: /不能为空/ },
    { field: 'contextWindow', value: '2e5x', error: /必须是数字/ },
    { field: 'contextWindow', value: '0', error: /正整数/ },
    { field: 'contextWindow', value: '1.5', error: /正整数/ },
    { field: 'autoCompactThresholdRatio', value: '150', error: /百分比/ },
    { field: 'autoCompactThresholdRatio', value: '0', error: /百分比/ },
  ]
  for (const { field, value, error } of cases) {
    const outcome = applySettingsIntent(state, { kind: 'set-context-value', field, value })
    assert.equal(outcome.changes, undefined, `${field}=${value} must not be sent`)
    assert.match(outcome.state.error ?? '', error)
  }

  // A ratio is typed as a percentage; 100% is legitimate: compact only when the
  // window is full.
  const accepted = applySettingsIntent(state, {
    kind: 'set-context-value',
    field: 'autoCompactThresholdRatio',
    value: '100%',
  })
  assert.deepEqual(accepted.changes, [
    { scope: 'general', kind: 'set-context-management', field: 'autoCompactThresholdRatio', value: 1 },
  ])
  const ninety = applySettingsIntent(state, { kind: 'set-context-value', field: 'autoCompactThresholdRatio', value: '90' })
  assert.equal(ninety.changes?.[0] && 'value' in ninety.changes[0] ? ninety.changes[0].value : undefined, 0.9)

  // The separators the field is drawn with, and a `k`, read back as the number.
  for (const typed of ['200,000', '200k', '200 000']) {
    const outcome = applySettingsIntent(state, { kind: 'set-context-value', field: 'contextWindow', value: typed })
    assert.deepEqual(outcome.changes, [
      { scope: 'general', kind: 'set-context-management', field: 'contextWindow', value: 200000 },
    ], typed)
  }
})

test('the 项目调度 card maps selects and day inputs to coordination changes', () => {
  const state = openState({ category: 'agent', snapshot: snapshotOf({ coordination: { threadModel: 'a', quietDays: 7, autoResolveDays: 14 } }) })
  const card = settingsView(state).cards.find((c) => c.title === '项目调度')
  assert.ok(card)
  assert.deepEqual(card.rows.map((r) => r.id), [
    'agent:coordination-coordinator-model',
    'agent:coordination-coordinator-effort',
    'agent:coordination-thread-model',
    'agent:coordination-thread-effort',
    'agent:coordination-quietDays',
    'agent:coordination-autoResolveDays',
  ])
  const threadModel = card.rows[2]!.control
  assert.ok(threadModel.kind === 'select')
  assert.equal(threadModel.value, 'a')
  assert.equal(threadModel.choices[0]!.label, '跟随默认')

  const days = applySettingsIntent(state, { kind: 'set-coordination-days', field: 'quietDays', value: '0' })
  assert.deepEqual(days.changes, [{ scope: 'agent', kind: 'set-coordination-days', field: 'quietDays', value: 0 }])
  assert.deepEqual([...pendingRowIds([{ change: days.changes![0]! } as PendingMutation])], ['agent:coordination-quietDays'])
  for (const bad of ['', '-1', '1.5', 'x']) {
    const out = applySettingsIntent(state, { kind: 'set-coordination-days', field: 'quietDays', value: bad })
    assert.equal(out.changes, undefined, bad)
  }
  const effort = applySettingsIntent(state, { kind: 'set-coordination-effort', role: 'thread', value: 'inherit' })
  assert.deepEqual(effort.changes, [{ scope: 'agent', kind: 'set-coordination-effort', role: 'thread', value: 'inherit' }])
})

// --- effects -----------------------------------------------------------------

function fakeClient(overrides: Partial<SettingsClient> = {}): SettingsClient {
  return {
    getSettings: async () =>
      ({ settings: snapshotOf(), projects: [{ projectRoot: 'C:\\repo\\alpha', projectName: 'alpha' }] }) as WireShellSettingsResult,
    changeSettings: async () =>
      ({ settings: snapshotOf({ defaultModel: 'broken' }), rebuiltLanes: 2 }) as WireShellSettingsChangeResult,
    ...overrides,
  }
}

test('loading folds the snapshot and the project list in', async () => {
  const state = await loadSettings(fakeClient(), { ...createSettingsState(), open: true })
  assert.equal(state.snapshot?.projectName, 'alpha')
  assert.equal(state.projectRoot, 'C:\\repo\\alpha')
  assert.equal(state.busy, false)
})

test('late settings replies preserve navigation and closing while ignoring a superseded project', async () => {
  let current = openState()
  const loading = loadSettings(fakeClient(), current, () => current)
  current = { ...current, category: 'general', open: false }
  const loaded = await loading
  assert.equal(loaded.category, 'general')
  assert.equal(loaded.open, false, 'a load must not reopen a screen closed during entrance')
  assert.equal(loaded.snapshot?.projectName, 'alpha')

  current = openState()
  const saving = runSettingsChanges(fakeClient(), current,
    pendingOf({ scope: 'provider', kind: 'set-default-model', key: 'broken' }), () => current)
  current = { ...current, category: 'appearance', open: false }
  const saved = await saving
  assert.equal(saved.category, 'appearance')
  assert.equal(saved.open, false)
  assert.equal(saved.snapshot?.defaultModel, 'broken')

  const previousProject = loadSettings(fakeClient(), current, () => current)
  current = { ...current, projectRoot: 'C:\\repo\\beta' }
  assert.equal(await previousProject, current, 'an old project response cannot take over the new page')
})

test('a failed load surfaces the message rather than throwing', async () => {
  const state = await loadSettings(
    fakeClient({
      getSettings: async () => {
        throw new Error('No project is open.')
      },
    }),
    { ...createSettingsState(), open: true },
  )
  assert.equal(state.error, 'No project is open.')
  assert.equal(state.busy, false)
})

test('a failed change keeps the snapshot on screen', async () => {
  const before = openState()
  const state = await runSettingsChanges(
    fakeClient({
      changeSettings: async () => {
        throw new Error('Model big is still referenced by routing')
      },
    }),
    before,
    pendingOf({ scope: 'provider', kind: 'remove-model', key: 'big' }),
  )
  assert.match(state.error ?? '', /still referenced/)
  assert.equal(state.snapshot, before.snapshot, 'an error must not blank the screen')
  assert.equal(state.busy, false)
})

test('changes run in order and the last reply wins', async () => {
  const sent: SettingsChange[] = []
  const state = await runSettingsChanges(
    fakeClient({
      changeSettings: async (_root, change) => {
        sent.push(change)
        return { settings: snapshotOf({ defaultModel: change.kind }), rebuiltLanes: 1 }
      },
    }),
    openState(),
    pendingOf(
      { scope: 'provider', kind: 'rename-model', from: 'big', to: 'huge' },
      { scope: 'provider', kind: 'set-model', key: 'huge', model: 'claude-big' },
    ),
  )
  assert.deepEqual(
    sent.map((change) => change.kind),
    ['rename-model', 'set-model'],
    'the rename must land before the write, or the write creates a second model',
  )
  assert.equal(state.snapshot?.defaultModel, 'set-model')
})

test('a change with no project selected fails instead of guessing one', async () => {
  const state = await runSettingsChanges(
    fakeClient(),
    { ...createSettingsState(), open: true },
    pendingOf({ scope: 'provider', kind: 'set-default-model', key: 'big' }),
  )
  assert.ok(state.error)
})

test('a failed removal names the row it was about, so the error can sit under it', async () => {
  const state = await runSettingsChanges(
    fakeClient({
      changeSettings: async () => {
        throw new Error('still referenced')
      },
    }),
    openState(),
    pendingOf({ scope: 'provider', kind: 'remove-model', key: 'big' }),
  )
  assert.deepEqual(state.errorRows, ['model:big'])
})

test('a submitted form stays open until the host answers, and a refusal keeps what was typed', async () => {
  const opened = applySettingsIntent(openState(), { kind: 'new-model' }).state
  const typed = [
    { kind: 'draft-field', field: 'key', value: 'huge' },
    { kind: 'draft-field', field: 'model', value: 'claude-huge' },
  ].reduce((state, intent) => applySettingsIntent(state, intent as SettingsIntent).state, opened)
  const submitted = applySettingsIntent(typed, { kind: 'submit-draft' })
  assert.equal(submitted.state.draft?.kind, 'model', 'the form closed before the reply')
  assert.equal(submitted.state.draftSubmit, submitted.pending?.[0]?.id)
  assert.deepEqual(applySettingsIntent(submitted.state, { kind: 'submit-draft' }).changes, undefined, 'a second Enter sent it twice')

  const refused = await runSettingsChanges(
    fakeClient({
      changeSettings: async () => {
        throw new Error('disk full')
      },
    }),
    submitted.state,
    submitted.pending!,
  )
  assert.equal(refused.error, 'disk full')
  assert.equal(refused.draft?.kind === 'model' && refused.draft.key, 'huge')
  assert.equal(refused.draftSubmit, undefined, 'the form must be submittable again')

  const accepted = await runSettingsChanges(fakeClient(), submitted.state, submitted.pending!)
  assert.equal(accepted.draft, undefined)
  assert.equal(accepted.draftSubmit, undefined)
})

test('dismissing an edited form asks first; an untouched one just closes', () => {
  const opened = applySettingsIntent(openState(), { kind: 'new-model' }).state
  assert.equal(applySettingsIntent(opened, { kind: 'cancel-draft' }).state.draft, undefined)

  const edited = applySettingsIntent(opened, { kind: 'draft-field', field: 'key', value: 'h' }).state
  const asked = applySettingsIntent(edited, { kind: 'cancel-draft' }).state
  assert.equal(asked.draft?.kind, 'model')
  assert.equal(asked.discardArmed, true)
  assert.equal(settingsView(asked).form?.confirmDiscard, true)
  assert.deepEqual(settingsKeyToIntent({ key: 'Escape' }, asked), { kind: 'keep-editing' })

  const kept = applySettingsIntent(asked, { kind: 'keep-editing' }).state
  assert.equal(kept.discardArmed, undefined)
  assert.equal(kept.draft?.kind, 'model')
  assert.equal(applySettingsIntent(asked, { kind: 'discard-draft' }).state.draft, undefined)
})

// --- the optimistic projection ------------------------------------------------

test('a pending removal takes the row off screen before the host answers', () => {
  const armed = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  const outcome = applySettingsIntent(armed, { kind: 'confirm-remove' })

  assert.deepEqual(outcome.changes, [{ scope: 'provider', kind: 'remove-model', key: 'big' }])
  assert.equal(outcome.pending?.length, 1, 'the change is parked so the view can draw it')

  const view = settingsView(outcome.state)
  const models = view.cards.find((card) => card.id === 'models')
  assert.deepEqual(models?.rows.map((row) => row.id), ['model:broken'], 'no second click needed')
  // The snapshot itself is untouched, which is what makes the rollback free.
  assert.equal(outcome.state.snapshot?.models.length, 2)
})

test('removing an endpoint projects its models away too', () => {
  const state = openState()
  const projected = projectSnapshot(state.snapshot!, [
    { id: 0, change: { scope: 'provider', kind: 'remove-endpoint', name: 'main' } },
  ])
  assert.deepEqual(projected.endpoints, [])
  assert.deepEqual(projected.models.map((model) => model.key), ['broken'])
  // The promotion `ConfigService.removeModel` performs, mirrored.
  assert.equal(projected.defaultModel, 'broken')
})

test('a pending toggle keeps its row and marks it in flight', () => {
  const outcome = applySettingsIntent(openState({ category: 'extensions' }), {
    kind: 'set-skill-enabled',
    name: 'release',
    enabled: false,
  })
  const skills = settingsView(outcome.state).cards.find((card) => card.id === 'skills')
  const release = skills?.rows.find((row) => row.id === 'skill:release')
  assert.equal(release?.pending, true)
  assert.ok(release?.control.kind === 'toggle' && release.control.value === false)
  assert.deepEqual([...pendingRowIds(outcome.state.pending)], ['skill:release'])
})

test('an import in flight is drawn on the button that started it', () => {
  const outcome = applySettingsIntent(openState({ category: 'extensions' }), { kind: 'import-skill' })
  assert.deepEqual(outcome.changes, [{ scope: 'extensions', kind: 'import-skill' }])
  const skills = settingsView(outcome.state).cards.find((card) => card.id === 'skills')
  const importing = skills?.footerButtons?.find((button) => button.changeKind === 'import-skill')
  assert.equal(importing?.pending, true)
  assert.equal(
    skills?.footerButtons?.find((button) => button.changeKind === 'reload-skills')?.pending,
    undefined,
    'only the button whose change is in flight waits',
  )
})

test('a failed change retires its pending row so the real snapshot comes back', async () => {
  const armed = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'model', name: 'big' },
  }).state
  const outcome = applySettingsIntent(armed, { kind: 'confirm-remove' })

  const after = await runSettingsChanges(
    fakeClient({
      changeSettings: async () => {
        throw new Error('模型 big 上还有会话「x」在跑，先中断它再删。')
      },
    }),
    outcome.state,
    outcome.pending!,
  )
  assert.deepEqual(after.pending, [], 'the optimistic row is withdrawn')
  const models = settingsView(after).cards.find((card) => card.id === 'models')
  assert.ok(models?.rows.some((row) => row.id === 'model:big'), 'and the row is back')
  assert.match(after.error ?? '', /在跑/)
})

// --- forms in their own card --------------------------------------------------

test('a new-model form is anchored to the models card, an edit to its row', () => {
  const created = settingsView(applySettingsIntent(openState(), { kind: 'new-model' }).state)
  assert.deepEqual(created.form?.anchor, { cardId: 'models' })

  const edited = settingsView(
    applySettingsIntent(openState(), { kind: 'edit-model', key: 'big' }).state,
  )
  assert.deepEqual(edited.form?.anchor, { cardId: 'models', rowId: 'model:big' })
})

test('a delete confirmation is anchored to the row it is about, and names the cascade', () => {
  const view = settingsView(
    applySettingsIntent(openState(), {
      kind: 'request-remove',
      target: { kind: 'endpoint', name: 'main' },
    }).state,
  )
  assert.deepEqual(view.confirming?.anchor, { cardId: 'endpoints', rowId: 'endpoint:main' })
  assert.match(view.confirming?.message ?? '', /将同时删除模型 big/)
})

// --- an endpoint and its first model ------------------------------------------

test('a new endpoint needs a model, and a key already taken is scoped by its endpoint', () => {
  const snapshot = snapshotOf({ defaultModel: undefined })
  const none = draftToChanges(endpointDraft({ name: 'fresh', step: 'models' }), snapshot)
  assert.ok('error' in none)
  assert.match(none.error, /至少选择一个模型/)

  const changes = draftToChanges(endpointDraft({ name: 'fresh', step: 'models', picked: ['big'] }), snapshot)
  assert.ok(Array.isArray(changes))
  assert.deepEqual(changes.map((change) => change.kind), ['set-endpoint', 'set-model', 'set-default-model'])
  assert.equal((changes[1] as Extract<SettingsChange, { kind: 'set-model' }>).key, 'fresh/big')
})

test('adding an endpoint does not move an existing default model', () => {
  const changes = draftToChanges(endpointDraft({ name: 'fresh', step: 'models', picked: ['claude-other'] }), snapshotOf())
  assert.ok(Array.isArray(changes))
  assert.deepEqual(changes.map((change) => change.kind), ['set-endpoint', 'set-model'])
})

// --- the new-endpoint wizard ---------------------------------------------------

test('the wizard walks service, connection, models — testing the connection on the way', () => {
  let state = applySettingsIntent(openState({ category: 'provider' }), { kind: 'new-endpoint' }).state
  let form = settingsView(state).form
  assert.ok(form?.kind === 'endpoint-wizard' && form.step === 'preset')
  assert.ok(form.presets.length >= 8)

  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'deepseek' }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.equal(state.draft.step, 'connect')
  assert.equal(state.draft.provider, 'openai')
  assert.equal(state.draft.baseUrl, 'https://api.deepseek.com')
  assert.equal(state.draft.name, 'deepseek')

  state = applySettingsIntent(state, { kind: 'draft-field', field: 'apiKey', value: 'sk-1' }).state
  // 下一步 (or Enter) tests before it moves on.
  const next = applySettingsIntent(state, { kind: 'submit-draft' })
  assert.deepEqual(next.probe, { seq: 1, provider: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1' })
  assert.equal(next.changes, undefined)
  form = settingsView(next.state).form
  assert.ok(form?.kind === 'endpoint-wizard')
  assert.equal(form.probe.status, 'running')

  state = applySettingsIntent(next.state, {
    kind: 'probe-result',
    seq: 1,
    result: { ok: true, latencyMs: 120, models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] },
  }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.equal(state.draft.step, 'models', 'a success started by 下一步 moves on by itself')
  form = settingsView(state).form
  assert.ok(form?.kind === 'endpoint-wizard')
  assert.deepEqual(form.picker?.rows.map((row) => row.id), ['deepseek-chat', 'deepseek-reasoner'])

  state = applySettingsIntent(state, { kind: 'toggle-picked-model', id: 'deepseek-chat' }).state
  const done = applySettingsIntent(state, { kind: 'submit-draft' })
  assert.deepEqual(done.changes, [
    { scope: 'provider', kind: 'set-endpoint', name: 'deepseek', provider: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1' },
    { scope: 'provider', kind: 'set-model', key: 'deepseek-chat', model: 'deepseek-chat', endpoint: 'deepseek' },
  ])
})

test('a failed test stays on the page, says why in plain words, and can be skipped', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-endpoint' }).state
  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'openai' }).state
  state = applySettingsIntent(state, { kind: 'submit-draft' }).state
  state = applySettingsIntent(state, {
    kind: 'probe-result',
    seq: 1,
    result: { ok: false, reason: 'auth', status: 401, detail: 'bad key' },
  }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.equal(state.draft.step, 'connect')
  const form = settingsView(state).form
  assert.ok(form?.kind === 'endpoint-wizard')
  assert.equal(form.probe.status, 'failed')
  assert.equal(form.probe.message, 'API key 无效。（401）')
  assert.equal(form.probe.skippable, true)

  state = applySettingsIntent(state, { kind: 'skip-test' }).state
  const picker = settingsView(state).form
  assert.ok(picker?.kind === 'endpoint-wizard' && picker.step === 'models')
  assert.match(picker.picker?.empty ?? '', /没有拿到模型列表/)

  state = applySettingsIntent(state, { kind: 'draft-field', field: 'manualModel', value: ' gpt-5 ' }).state
  state = applySettingsIntent(state, { kind: 'add-manual-model' }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.deepEqual(state.draft.picked, ['gpt-5'])
  assert.equal(state.draft.manualModel, '')
})

test('a reply to a superseded test is ignored, and changing the address drops the result', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-endpoint' }).state
  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'openai-compatible' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'baseUrl', value: 'http://a' }).state
  state = applySettingsIntent(state, { kind: 'test-endpoint' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'baseUrl', value: 'http://b' }).state
  assert.equal(state.probe, undefined)
  const late = applySettingsIntent(state, {
    kind: 'probe-result',
    seq: 1,
    result: { ok: true, latencyMs: 5, models: [{ id: 'x' }] },
  }).state
  assert.equal(late, state)

  // An unchanged value committed on blur is not an edit.
  state = applySettingsIntent(state, { kind: 'test-endpoint' }).state
  state = applySettingsIntent(state, {
    kind: 'probe-result',
    seq: 2,
    result: { ok: true, latencyMs: 5, models: [], baseUrl: 'http://b/v1' },
  }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.equal(state.draft.baseUrl, 'http://b/v1', 'the address that answered replaces the one typed')
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'baseUrl', value: 'http://b/v1' }).state
  assert.equal(state.probe?.status, 'done')
})

test('an endpoint being edited is tested with its saved key until a new one is typed', () => {
  let state = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const form = settingsView(state).form
  assert.ok(form && form.kind === undefined)
  assert.equal(form.probe?.status, 'idle')
  assert.deepEqual(applySettingsIntent(state, { kind: 'test-endpoint' }).probe, {
    seq: 1,
    provider: 'anthropic',
    baseUrl: 'https://api.example',
    endpointName: 'main',
  })
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'apiKey', value: 'sk-new' }).state
  assert.deepEqual(applySettingsIntent(state, { kind: 'test-endpoint' }).probe, {
    seq: 1,
    provider: 'anthropic',
    baseUrl: 'https://api.example',
    apiKey: 'sk-new',
  })
})

test('a wizard batch that failed part-way retries as an edit of what it already made', async () => {
  let state = applySettingsIntent(openState({ snapshot: snapshotOf({ defaultModel: 'big' }) }), { kind: 'new-endpoint' }).state
  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'openai' }).state
  state = applySettingsIntent(state, { kind: 'skip-test' }).state
  for (const id of ['a', 'b']) {
    state = applySettingsIntent(state, { kind: 'draft-field', field: 'manualModel', value: id }).state
    state = applySettingsIntent(state, { kind: 'add-manual-model' }).state
  }
  const submitted = applySettingsIntent(state, { kind: 'submit-draft' })
  let current = submitted.state
  let after = snapshotOf({ defaultModel: 'big' })
  const client = fakeClient({
    changeSettings: async (_root, change) => {
      if (change.kind === 'set-model' && change.model === 'a') throw new Error('写入失败')
      if (change.kind === 'set-endpoint') after = { ...after, endpoints: [...after.endpoints, { name: change.name, provider: change.provider }] }
      if (change.kind === 'set-model') after = { ...after, models: [...after.models, { key: change.key, model: change.model, endpoint: change.endpoint, resolves: true }] }
      return { settings: after, rebuiltLanes: 0 } as WireShellSettingsChangeResult
    },
  })
  current = await runSettingsChanges(client, current, submitted.pending!, () => current)
  assert.match(current.error ?? '', /写入失败/)
  assert.ok(current.draft?.kind === 'endpoint')
  assert.equal(current.draft.originalName, 'openai')

  const retry = draftToChanges(current.draft, current.snapshot!)
  assert.ok(Array.isArray(retry), JSON.stringify(retry))
  // `b` went in before `a` failed, so only `a` is left to send.
  assert.deepEqual(retry.map((change) => change.kind === 'set-model' ? change.model : change.kind), ['set-endpoint', 'a'])
})

test('a field committing its unchanged value is not an edit', () => {
  const opened = applySettingsIntent(openState(), { kind: 'edit-endpoint', name: 'main' }).state
  const same = applySettingsIntent(opened, { kind: 'draft-field', field: 'name', value: 'main' }).state
  assert.equal(same, opened)
  assert.equal(applySettingsIntent(same, { kind: 'cancel-draft' }).state.draft, undefined, 'nothing to confirm')
})

test('a local server that needs no key is stored with a stand-in one', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-endpoint' }).state
  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'ollama' }).state
  assert.equal(applySettingsIntent(state, { kind: 'submit-draft' }).probe?.apiKey, 'ollama')
  assert.ok(state.draft)
  const change = draftToChange(state.draft, snapshotOf())
  assert.ok(!('error' in change) && change.kind === 'set-endpoint')
  assert.equal(change.apiKey, 'ollama')
})

test('a picked service names the endpoint until the user names it', () => {
  const taken = openState({ snapshot: snapshotOf({ endpoints: [{ name: 'openai', provider: 'openai' }] }) })
  let state = applySettingsIntent(taken, { kind: 'new-endpoint' }).state
  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'openai' }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.equal(state.draft.name, 'openai-2')
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'name', value: 'work' }).state
  state = applySettingsIntent(state, { kind: 'wizard-back' }).state
  state = applySettingsIntent(state, { kind: 'pick-preset', preset: 'anthropic' }).state
  assert.ok(state.draft?.kind === 'endpoint')
  assert.equal(state.draft.name, 'work')
  assert.equal(state.draft.provider, 'anthropic')
})

test('first-run setup opens the wizard once the snapshot shows no endpoint', async () => {
  const opened = applySettingsIntent(createSettingsState(), { kind: 'open', category: 'provider', setup: true })
  assert.equal(opened.load, true)
  const empty = fakeClient({
    getSettings: async () =>
      ({ settings: snapshotOf({ endpoints: [], models: [] }), projects: [] }) as unknown as WireShellSettingsResult,
  })
  const loaded = await loadSettings(empty, opened.state)
  assert.ok(loaded.draft?.kind === 'endpoint')
  assert.equal(loaded.draft.step, 'preset')
  assert.equal(loaded.setupWizard, undefined)

  // With an endpoint already configured the page itself is the answer.
  const configured = await loadSettings(fakeClient(), opened.state)
  assert.equal(configured.draft, undefined)
})

// --- MCP server drafts and operations -----------------------------------------

function mcpDraft(
  overrides: Partial<Extract<SettingsDraft, { kind: 'mcp-server' }>> = {},
): SettingsDraft {
  return {
    kind: 'mcp-server',
    isNew: true,
    name: 'test-mcp',
    transport: 'stdio',
    command: 'npx test-mcp',
    args: [],
    env: [],
    envPassthrough: [],
    cwd: '',
    url: '',
    headers: [],
    ...overrides,
  }
}

test('a new-mcp-server form initializes an empty stdio draft anchored to mcp card', () => {
  const state = applySettingsIntent(openState(), { kind: 'new-mcp-server' }).state
  assert.equal(state.draft?.kind, 'mcp-server')
  if (state.draft?.kind === 'mcp-server') {
    assert.equal(state.draft.isNew, true)
    assert.equal(state.draft.name, '')
    assert.equal(state.draft.transport, 'stdio')
    assert.equal(state.draft.command, '')
    assert.deepEqual(state.draft.args, [])
    assert.deepEqual(state.draft.env, [])
    assert.deepEqual(state.draft.envPassthrough, [])
    assert.equal(state.draft.cwd, '')
  }
  const view = settingsView(state)
  assert.deepEqual(view.form?.anchor, { cardId: 'mcp' })
  assert.equal(view.form?.title, '连接至自定义 MCP')
})

test('an edit-mcp-server form populates existing config anchored to its row', () => {
  const snapshot = snapshotOf({
    mcpServers: [
      {
        name: 'sqlite',
        transport: 'stdio',
        target: 'sqlite-mcp',
        trusted: true,
        trustEditable: true,
        status: 'connected',
        isLocal: true,
        config: {
          transport: 'stdio',
          command: 'sqlite-mcp',
          args: ['--db', 'my.db'],
          env: { KEY: 'val' },
          envPassthrough: ['PATH'],
          cwd: '/workspace',
        },
      },
    ],
  })
  const base = openState({ snapshot })
  const state = applySettingsIntent(base, { kind: 'edit-mcp-server', name: 'sqlite' }).state
  assert.equal(state.draft?.kind, 'mcp-server')
  if (state.draft?.kind === 'mcp-server') {
    assert.equal(state.draft.isNew, false)
    assert.equal(state.draft.name, 'sqlite')
    assert.equal(state.draft.originalName, 'sqlite')
    assert.equal(state.draft.transport, 'stdio')
    assert.equal(state.draft.command, 'sqlite-mcp')
    assert.deepEqual(state.draft.args, ['--db', 'my.db'])
    assert.deepEqual(state.draft.env, [{ key: 'KEY', value: 'val' }])
    assert.deepEqual(state.draft.envPassthrough, ['PATH'])
    assert.equal(state.draft.cwd, '/workspace')
  }
  const view = settingsView(state)
  assert.deepEqual(view.form?.anchor, { cardId: 'mcp', rowId: 'mcp:sqlite' })
})

test('mcp draft-field updates string properties and switches transport', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-mcp-server' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'name', value: 'my-srv' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'command', value: 'run-srv' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'cwd', value: '~/code' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'transport', value: 'sse' }).state
  state = applySettingsIntent(state, { kind: 'draft-field', field: 'url', value: 'http://localhost:8000/sse' }).state

  assert.equal(state.draft?.kind, 'mcp-server')
  if (state.draft?.kind === 'mcp-server') {
    assert.equal(state.draft.name, 'my-srv')
    assert.equal(state.draft.command, 'run-srv')
    assert.equal(state.draft.cwd, '~/code')
    assert.equal(state.draft.transport, 'sse')
    assert.equal(state.draft.url, 'http://localhost:8000/sse')
  }
})

test('mcp args can be added, updated, and removed', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-mcp-server' }).state
  state = applySettingsIntent(state, { kind: 'mcp-add-arg' }).state
  state = applySettingsIntent(state, { kind: 'mcp-add-arg' }).state
  state = applySettingsIntent(state, { kind: 'mcp-update-arg', index: 0, value: '--port' }).state
  state = applySettingsIntent(state, { kind: 'mcp-update-arg', index: 1, value: '8080' }).state

  assert.equal(state.draft?.kind, 'mcp-server')
  if (state.draft?.kind === 'mcp-server') {
    assert.deepEqual(state.draft.args, ['--port', '8080'])
  }

  state = applySettingsIntent(state, { kind: 'mcp-remove-arg', index: 0 }).state
  if (state.draft?.kind === 'mcp-server') {
    assert.deepEqual(state.draft.args, ['8080'])
  }
})

test('mcp env can be added, updated, and removed', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-mcp-server' }).state
  state = applySettingsIntent(state, { kind: 'mcp-add-env' }).state
  state = applySettingsIntent(state, { kind: 'mcp-update-env', index: 0, key: 'API_KEY', value: 'secret' }).state

  assert.equal(state.draft?.kind, 'mcp-server')
  if (state.draft?.kind === 'mcp-server') {
    assert.deepEqual(state.draft.env, [{ key: 'API_KEY', value: 'secret' }])
  }

  state = applySettingsIntent(state, { kind: 'mcp-remove-env', index: 0 }).state
  if (state.draft?.kind === 'mcp-server') {
    assert.deepEqual(state.draft.env, [])
  }
})

test('mcp envPassthrough can be added, updated, and removed', () => {
  let state = applySettingsIntent(openState(), { kind: 'new-mcp-server' }).state
  state = applySettingsIntent(state, { kind: 'mcp-add-env-passthrough' }).state
  state = applySettingsIntent(state, { kind: 'mcp-update-env-passthrough', index: 0, value: 'TOKEN' }).state

  assert.equal(state.draft?.kind, 'mcp-server')
  if (state.draft?.kind === 'mcp-server') {
    assert.deepEqual(state.draft.envPassthrough, ['TOKEN'])
  }

  state = applySettingsIntent(state, { kind: 'mcp-remove-env-passthrough', index: 0 }).state
  if (state.draft?.kind === 'mcp-server') {
    assert.deepEqual(state.draft.envPassthrough, [])
  }
})

test('mcp draft validation enforces required fields and valid urls', () => {
  const snapshot = snapshotOf({
    mcpServers: [{ name: 'existing', transport: 'stdio', target: 'cmd', trusted: true, trustEditable: true, status: 'connected' }],
  })

  // Empty name
  const emptyName = draftToChanges(mcpDraft({ name: '  ' }), snapshot)
  assert.ok('error' in emptyName)
  assert.equal(emptyName.error, '名称不能为空。')

  // Duplicate name on new
  const duplicate = draftToChanges(mcpDraft({ name: 'existing', isNew: true }), snapshot)
  assert.ok('error' in duplicate)
  assert.equal(duplicate.error, '已经有一个叫 existing 的 MCP 服务器。')

  // Stdio without command
  const noCmd = draftToChanges(mcpDraft({ name: 'new', command: '' }), snapshot)
  assert.ok('error' in noCmd)
  assert.equal(noCmd.error, '启动命令不能为空。')

  // SSE without URL
  const noUrl = draftToChanges(mcpDraft({ name: 'new', transport: 'sse', url: '' }), snapshot)
  assert.ok('error' in noUrl)
  assert.equal(noUrl.error, 'URL 不能为空。')

  // SSE with invalid URL
  const badUrl = draftToChanges(mcpDraft({ name: 'new', transport: 'sse', url: 'invalid-url' }), snapshot)
  assert.ok('error' in badUrl)
  assert.equal(badUrl.error, '请输入有效的 HTTP 或 HTTPS URL。')
})

test('submitting a valid mcp draft creates set-mcp-server change', () => {
  const snapshot = snapshotOf()
  const valid = draftToChanges(
    mcpDraft({
      name: 'srv',
      command: 'run',
      args: ['a', 'b'],
      env: [{ key: 'K', value: 'V' }],
      envPassthrough: ['HOME'],
      cwd: '/home',
    }),
    snapshot,
  )
  assert.ok(Array.isArray(valid))
  assert.equal(valid.length, 1)
  assert.deepEqual(valid[0], {
    scope: 'extensions',
    kind: 'set-mcp-server',
    name: 'srv',
    server: {
      transport: 'stdio',
      command: 'run',
      args: ['a', 'b'],
      env: { K: 'V' },
      envPassthrough: ['HOME'],
      cwd: '/home',
    },
  })
})

test('renaming an mcp server onto a name already in use is refused', () => {
  const snapshot = snapshotOf()
  const collision = draftToChanges(
    mcpDraft({ isNew: false, originalName: 'github', name: 'shared' }),
    snapshot,
  )
  assert.ok('error' in collision, 'the rename would have overwritten the other server')
  assert.equal(collision.error, '已经有一个叫 shared 的 MCP 服务器。')

  // Saving an edit under the same name is not a collision with itself.
  const kept = draftToChanges(mcpDraft({ isNew: false, originalName: 'github', name: 'github' }), snapshot)
  assert.ok(Array.isArray(kept))
})

test('a rename travels as one set-mcp-server carrying previousName', () => {
  const changes = draftToChanges(
    mcpDraft({ isNew: false, originalName: 'github', name: 'gh', command: 'run' }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.equal(changes.length, 1, 'no separate remove: the host moves the trust entry with the config')
  assert.deepEqual(changes[0], {
    scope: 'extensions',
    kind: 'set-mcp-server',
    name: 'gh',
    server: { transport: 'stdio', command: 'run' },
    previousName: 'github',
  })
})

test('a remote mcp draft saves request headers and no env', () => {
  const changes = draftToChanges(
    mcpDraft({
      name: 'remote',
      transport: 'sse',
      url: 'https://mcp.example/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer t' }],
      env: [{ key: 'API_KEY', value: 'secret' }],
    }),
    snapshotOf(),
  )
  assert.ok(Array.isArray(changes))
  assert.deepEqual(changes[0], {
    scope: 'extensions',
    kind: 'set-mcp-server',
    name: 'remote',
    server: {
      transport: 'sse',
      url: 'https://mcp.example/mcp',
      headers: { Authorization: 'Bearer t' },
    },
  })
})

test('a pending edit keeps the trust the row already had', () => {
  const projected = projectSnapshot(snapshotOf(), [
    {
      id: 0,
      change: {
        scope: 'extensions',
        kind: 'set-mcp-server',
        name: 'cold',
        server: { transport: 'stdio', command: 'cold-server' },
      },
    },
  ])
  assert.equal(
    projected.mcpServers.find((server) => server.name === 'cold')?.trusted,
    false,
    'editing an untrusted server must not draw it as trusted',
  )
})

test('deleting a server that only overrides an inherited one keeps its row', () => {
  const snapshot = snapshotOf({
    mcpServers: [
      {
        name: 'github',
        transport: 'stdio',
        target: 'npx github-mcp',
        trusted: true,
        trustEditable: true,
        status: 'connected',
        isLocal: true,
        shadowsInherited: true,
      },
    ],
  })
  const projected = projectSnapshot(snapshot, [
    { id: 0, change: { scope: 'extensions', kind: 'remove-mcp-server', name: 'github' } },
  ])
  assert.deepEqual(
    projected.mcpServers.map((server) => server.name),
    ['github'],
    'the inherited server takes over, so the row must not flicker away',
  )
})

test('deleting an mcp server emits remove-mcp-server change', () => {
  const state = applySettingsIntent(openState(), {
    kind: 'request-remove',
    target: { kind: 'mcp-server', name: 'sqlite' },
  }).state
  const outcome = applySettingsIntent(state, { kind: 'confirm-remove' })
  assert.deepEqual(outcome.changes, [
    { scope: 'extensions', kind: 'remove-mcp-server', name: 'sqlite' },
  ])
})


test('the instructions editor is dirty only when the draft differs, and save sends the draft', () => {
  let state = openState({ category: 'personalization', snapshot: snapshotOf({ userInstructions: 'old' }) })
  assert.equal(settingsView(state).editor?.dirty, false)
  state = applySettingsIntent(state, { kind: 'edit-instructions', value: 'new' }).state
  assert.equal(settingsView(state).editor?.dirty, true)
  assert.equal(settingsView(state).editor?.value, 'new')
  const saved = applySettingsIntent(state, { kind: 'save-instructions' })
  assert.deepEqual(saved.changes, [{ scope: 'personalization', kind: 'set-user-instructions', content: 'new' }])
  assert.equal(settingsView(saved.state).editor?.saving, true)
  state = applySettingsIntent(state, { kind: 'cancel-instructions' }).state
  assert.equal(settingsView(state).editor?.value, 'old')
})
