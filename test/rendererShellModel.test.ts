import test from 'node:test'
import assert from 'node:assert/strict'
import { completionAcceptMode, resolveKey, type ShellState, type WindowLayers } from '../src/desktop/renderer/model/keymap.js'
import {
  classifyInput,
  commandEffectToIntent,
  commandViewRows,
} from '../src/desktop/renderer/model/commandRouting.js'
import {
  NO_COMPLETIONS,
  acceptCompletion,
  commandCompletions,
  moveCompletion,
} from '../src/desktop/renderer/model/completion.js'
import {
  SUPPORTED_SURFACES,
  activateSurfaceRow,
  activateSurfaceRowById,
  backgroundTasksView,
  runningProcessCount,
  effortPickerView,
  initialSurfaceSelection,
  isSupportedSurface,
  modelPickerView,
  moveSurfaceSelection,
  resumePickerView,
} from '../src/desktop/renderer/model/surfaces.js'
import type { CommandSurface, WireCommandInfo, WireModelsResult } from '../src/runtime/protocol/wire.js'

/**
 * The keyboard, the composer's routing, and the four pickers.
 *
 * The first test is the one that matters most: Escape with a dialog open must
 * answer the dialog, never interrupt. Interrupting does not release a turn parked
 * on a permission prompt (`ToolRunner.run` never passes its signal into
 * `PermissionGate.approve`), so getting this backwards wedges the app.
 *
 * The dual-source completion state itself lives in `rendererCompletion.test.ts`;
 * what is here is how a keystroke is *routed* given that state.
 */

function shell(overrides: Partial<ShellState> = {}): ShellState {
  return {
    hasOverlay: false,
    hasRewind: false,
    hasSurface: false,
    hasCommandView: false,
    completions: 'none',
    isStreaming: false,
    inputEmpty: false,
    ...overrides,
  }
}

test('Escape answers an open dialog and never interrupts, even mid-turn', () => {
  assert.equal(resolveKey({ key: 'Escape' }, shell({ hasOverlay: true, isStreaming: true })), 'overlay')
  // Everything else defers too: the dialog owns the keyboard outright.
  assert.equal(resolveKey({ key: 'Enter' }, shell({ hasOverlay: true })), 'overlay')
  assert.equal(resolveKey({ key: 'y' }, shell({ hasOverlay: true })), 'overlay')
  assert.equal(resolveKey({ key: 'Tab' }, shell({ hasOverlay: true, completions: 'command' })), 'overlay')
})

test('Escape interrupts only when nothing is open and a turn is running', () => {
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: true })), 'interrupt')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: false })), 'none')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: true, hasSurface: true })), 'close-surface')
})

test('a blocking dialog outranks the rewind panel, which outranks everything else', () => {
  // The order between these two is the whole point. A permission prompt is
  // holding the agent loop and `interrupt()` will not release it, so it has to
  // win; the rewind panel is only holding the user, so it yields — but it beats
  // the composer, the dropdown and the dismissible panel, because every option on
  // its confirm screen destroys work.
  assert.equal(resolveKey({ key: 'Escape' }, shell({ hasOverlay: true, hasRewind: true })), 'overlay')
  assert.equal(resolveKey({ key: 'Enter' }, shell({ hasOverlay: true, hasRewind: true })), 'overlay')

  const open = shell({ hasRewind: true })
  assert.equal(resolveKey({ key: 'Escape' }, open), 'rewind')
  assert.equal(resolveKey({ key: 'Enter' }, open), 'rewind')
  assert.equal(resolveKey({ key: 'ArrowDown' }, open), 'rewind')
  assert.equal(resolveKey({ key: '1' }, open), 'rewind')
  assert.equal(resolveKey({ key: 'Tab' }, shell({ hasRewind: true, completions: 'command' })), 'rewind')
  assert.equal(resolveKey({ key: 'Enter' }, shell({ hasRewind: true, hasSurface: true, inputEmpty: true })), 'rewind')
})

const layers = (open: Partial<WindowLayers>): WindowLayers => ({ viewer: false, screen: false, popover: false, ...open })

test('Escape unwinds the window top-down: viewer, dialog, rewind, popover, screen, then the turn', () => {
  const everything = { hasOverlay: true, hasRewind: true, hasSurface: true, completions: 'command' as const, isStreaming: true }
  const all = layers({ viewer: true, popover: true, screen: true })
  assert.equal(resolveKey({ key: 'Escape' }, shell(everything), all), 'close-viewer')
  assert.equal(resolveKey({ key: 'Escape' }, shell(everything), layers({ popover: true, screen: true })), 'overlay')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ ...everything, hasOverlay: false }), layers({ popover: true })), 'rewind')
  assert.equal(
    resolveKey({ key: 'Escape' }, shell({ isStreaming: true, hasSurface: true, completions: 'command' }), layers({ popover: true, screen: true })),
    'close-popover',
    'a popover floating over a streaming composer is closed before the turn is interrupted',
  )
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: true }), layers({ screen: true })), 'close-screen')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ isStreaming: true }), layers({})), 'interrupt')
})

test('only Escape reads the window layers', () => {
  const open = layers({ viewer: true, popover: true, screen: true })
  assert.equal(resolveKey({ key: 'Enter' }, shell(), open), 'submit')
  assert.equal(resolveKey({ key: 'Enter' }, shell({ isStreaming: true }), open), 'enqueue')
  assert.equal(resolveKey({ key: 'ArrowDown' }, shell({ hasSurface: true, inputEmpty: true }), open), 'move-surface-down')
})

test('Escape while the rewind panel is open never interrupts the turn', () => {
  // Interrupting from here would leave the panel up with a half-run rewind behind
  // it; the panel's own key map is what decides between "back" and "close".
  assert.equal(resolveKey({ key: 'Escape' }, shell({ hasRewind: true, isStreaming: true })), 'rewind')
})

test('Enter submits when idle, queues mid-turn, and never fires on an empty composer', () => {
  assert.equal(resolveKey({ key: 'Enter' }, shell()), 'submit')
  assert.equal(resolveKey({ key: 'Enter', shiftKey: true }, shell()), 'newline')
  assert.equal(resolveKey({ key: 'Enter' }, shell({ inputEmpty: true })), 'none')
  // Queued rather than dropped, matching the terminal. Sending it outright would
  // overwrite the controller's live AbortController and leave the first turn
  // impossible to interrupt — which is why the kernel rejects a second submit
  // outright and this returns `enqueue` instead of `submit`.
  assert.equal(resolveKey({ key: 'Enter' }, shell({ isStreaming: true })), 'enqueue')
  // An empty composer still has nothing to queue.
  assert.equal(resolveKey({ key: 'Enter' }, shell({ isStreaming: true, inputEmpty: true })), 'none')
})

test('the completion dropdown owns Tab, the arrows and Enter while open', () => {
  const open = shell({ completions: 'command' })
  assert.equal(resolveKey({ key: 'Tab' }, open), 'accept-completion')
  // Enter accepts *and runs*, the way `useKeyboardShortcuts.ts:286-291` submits a
  // command suggestion. Tab is the accept-only affordance.
  assert.equal(resolveKey({ key: 'Enter' }, open), 'submit-completion')
  assert.equal(resolveKey({ key: 'ArrowDown' }, open), 'move-completion-down')
  assert.equal(resolveKey({ key: 'ArrowUp' }, open), 'move-completion-up')
  assert.equal(resolveKey({ key: 'Escape' }, open), 'close-completions')
  // Shift+Enter still inserts a newline rather than accepting.
  assert.equal(resolveKey({ key: 'Enter', shiftKey: true }, open), 'newline')
  // Mid-turn there is nothing to submit into, so Enter degrades to accepting.
  assert.equal(
    resolveKey({ key: 'Enter' }, shell({ completions: 'command', isStreaming: true })),
    'accept-completion',
  )
})

test('Enter on a file mention accepts without submitting', () => {
  // `@src/foo.ts` is a fragment of a sentence still being written. Submitting
  // there would send half a prompt — and cost a request to say so.
  assert.equal(resolveKey({ key: 'Enter' }, shell({ completions: 'file' })), 'accept-completion')
  // Everything else about the dropdown is unchanged.
  assert.equal(resolveKey({ key: 'Tab' }, shell({ completions: 'file' })), 'accept-completion')
  assert.equal(resolveKey({ key: 'ArrowDown' }, shell({ completions: 'file' })), 'move-completion-down')
  assert.equal(resolveKey({ key: 'Escape' }, shell({ completions: 'file' })), 'close-completions')
})

test('an open picker takes the arrows and Enter, but only while the composer is empty', () => {
  const browsing = shell({ hasSurface: true, inputEmpty: true })
  assert.equal(resolveKey({ key: 'ArrowDown' }, browsing), 'move-surface-down')
  assert.equal(resolveKey({ key: 'ArrowUp' }, browsing), 'move-surface-up')
  assert.equal(resolveKey({ key: 'Enter' }, browsing), 'activate-surface')
  assert.equal(resolveKey({ key: 'Escape' }, browsing), 'close-surface')

  // The panel does not block. A user who opened `/model`, then typed a message,
  // means "send it" — silently switching models instead would be indefensible.
  const typing = shell({ hasSurface: true, inputEmpty: false })
  assert.equal(resolveKey({ key: 'Enter' }, typing), 'submit')
  assert.equal(resolveKey({ key: 'ArrowDown' }, typing), 'none')
  // Escape still closes it, though: dismissing is not picking.
  assert.equal(resolveKey({ key: 'Escape' }, typing), 'close-surface')

  // Shift+Enter is still a newline, not an activation.
  assert.equal(resolveKey({ key: 'Enter', shiftKey: true }, browsing), 'newline')
})

test('a command view closes on Escape but never takes the arrows or Enter', () => {
  // `/session` and friends paint a table of facts with no pickable row. They
  // used to be tracked by nothing at all, which left Escape and the press-outside
  // handler unable to see them — the panel could only be dismissed by switching
  // panes.
  const viewing = shell({ hasCommandView: true, inputEmpty: true })
  assert.equal(resolveKey({ key: 'Escape' }, viewing), 'close-surface')
  assert.equal(resolveKey({ key: 'ArrowDown' }, viewing), 'none')
  assert.equal(resolveKey({ key: 'ArrowUp' }, viewing), 'none')
  // Nothing to activate, so Enter stays the composer's — 'none' only because the
  // composer is empty here.
  assert.equal(resolveKey({ key: 'Enter' }, viewing), 'none')
  assert.equal(resolveKey({ key: 'Enter' }, shell({ hasCommandView: true, inputEmpty: false })), 'submit')
})

test('a picker and the dropdown can never contend, and the dropdown wins if they do', () => {
  // Completions require a typed `/` or `@`, so `inputEmpty` is false whenever
  // they are open — the two are mutually exclusive by construction. Pinned
  // anyway, because the ordering in `resolveKey` is what guarantees it.
  const both = shell({ hasSurface: true, completions: 'command', inputEmpty: true })
  assert.equal(resolveKey({ key: 'ArrowDown' }, both), 'move-completion-down')
  assert.equal(resolveKey({ key: 'Enter' }, both), 'submit-completion')
  assert.equal(resolveKey({ key: 'Escape' }, both), 'close-completions')
})

test('a leading slash is a command, never prose', () => {
  assert.deepEqual(classifyInput('/model sonnet'), { kind: 'command', line: '/model sonnet' })
  assert.deepEqual(classifyInput('  /help  '), { kind: 'command', line: '/help' })
  assert.deepEqual(classifyInput('what is /model'), { kind: 'prompt', text: 'what is /model' })
  assert.deepEqual(classifyInput('   '), { kind: 'empty' })
})

const COMMANDS: WireCommandInfo[] = [
  { name: 'model', description: 'Switch model', aliases: ['m'] },
  { name: 'clear', description: 'Clear session' },
  { name: 'cost', description: 'Show usage' },
]

test('completions rank exact and prefix matches, and stop once args are typed', () => {
  const rows = (raw: string) => {
    const state = commandCompletions(NO_COMPLETIONS, raw, COMMANDS)
    return state.kind === 'none' ? [] : state.items.map((item) => item.displayText)
  }

  assert.deepEqual(rows('/'), ['/clear', '/cost', '/model'])
  assert.equal(rows('/mo')[0], '/model')
  assert.equal(rows('/m')[0], '/model', 'alias wins')
  assert.equal(commandCompletions(NO_COMPLETIONS, '/model sonnet', COMMANDS).kind, 'none')
  assert.equal(commandCompletions(NO_COMPLETIONS, 'hello', COMMANDS).kind, 'none')
  assert.equal(commandCompletions(NO_COMPLETIONS, '/zzz', COMMANDS).kind, 'none')
})

test('the dropdown wraps, and accepting rewrites the composer', () => {
  const state = commandCompletions(NO_COMPLETIONS, '/', COMMANDS)
  assert.equal(state.kind, 'command')
  assert.ok(state.kind === 'command')
  assert.equal(state.selectedIndex, 0)
  const moved = moveCompletion(state, 'up')
  assert.ok(moved.kind === 'command')
  assert.equal(moved.selectedIndex, 2, 'up from the top wraps')
  const down = moveCompletion(state, 'down')
  assert.ok(down.kind === 'command')
  assert.equal(down.selectedIndex, 1)

  // A command replaces the whole line, so the text and caret passed in are ignored.
  assert.deepEqual(acceptCompletion(state, '/', 1), { text: '/clear ', cursorPos: 7 })
  assert.equal(acceptCompletion(NO_COMPLETIONS, '', 0), undefined)
})

test('all three command effects map to something the view can do', () => {
  assert.deepEqual(commandEffectToIntent({ kind: 'write-line', text: 'hi' }), { kind: 'write-line', text: 'hi' })
  // A failure keeps its tone, so the transcript draws it as one.
  assert.deepEqual(commandEffectToIntent({ kind: 'write-line', text: 'no', tone: 'error' }), { kind: 'write-line', text: 'no', tone: 'error' })
  assert.deepEqual(commandEffectToIntent({ kind: 'open-surface', surface: 'model-picker' }),
    { kind: 'open-surface', surface: 'model-picker' })

  const view = commandEffectToIntent({
    kind: 'open-command-view',
    view: { kind: 'list', title: 'Commands', items: [{ id: 'help', label: '/help', description: 'Show help' }] },
  })
  assert.equal(view.kind, 'show-view')
  assert.ok(view.kind === 'show-view')
  assert.deepEqual(view.rows, [{ label: '/help', value: 'Show help', tone: 'normal' }])

  // A fourth effect kind must be a compile error, not a silent drop.
  assert.throws(() => commandEffectToIntent({ kind: 'invented' } as never), /Unhandled command effect/)
})

test('an info view flattens sections into headed rows with their tones', () => {
  const rows = commandViewRows({
    kind: 'info',
    title: 'Cost',
    sections: [
      { title: 'Tokens', rows: [{ label: 'in', value: '10' }, { label: 'out', value: '5', tone: 'success' }] },
      { rows: [{ label: 'errors', value: '1', tone: 'error' }] },
    ],
  })

  assert.deepEqual(rows, [
    { label: 'Tokens', value: '', tone: 'normal', heading: true },
    { label: 'in', value: '10', tone: 'normal' },
    { label: 'out', value: '5', tone: 'success' },
    { label: 'errors', value: '1', tone: 'error' },
  ])
})

const MODELS: WireModelsResult = {
  models: [],
  defaultModelKey: 'sonnet',
  pickerOptions: [
    { key: 'haiku', label: 'haiku', modelKey: 'haiku', modelId: 'claude-haiku', providerName: 'anthropic', isCurrent: false, isDefault: false },
    { key: 'sonnet', label: 'sonnet', modelKey: 'sonnet', modelId: 'claude-sonnet', providerName: 'anthropic', supportsImageInput: true, isCurrent: true, isDefault: true },
    { key: 'broken', label: 'broken', disabledReason: 'no model configured', isCurrent: false, isDefault: false },
  ],
}

test('the model picker marks the current model and explains a disabled one', () => {
  const view = modelPickerView(MODELS)

  assert.deepEqual(view.rows.map((row) => row.id), ['haiku', 'sonnet', 'broken'])
  assert.equal(view.rows[1]?.current, true)
  assert.match(view.rows[1]?.detail ?? '', /默认/)
  // The capability marker rides in the detail, host-resolved — the row answers
  // "can I send images to this one", which is why a user opens this picker.
  assert.match(view.rows[1]?.detail ?? '', /视觉/)
  assert.doesNotMatch(view.rows[0]?.detail ?? '', /视觉/)
  assert.equal(view.rows[2]?.disabled, true)
  assert.equal(view.rows[2]?.disabledReason, 'no model configured')

  // Parity with the host test: nothing derived from a ModelConfig may leak a key.
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('apiKey'), false)
  assert.equal(serialized.includes('baseUrl'), false)
})

test('the effort picker shows levels the model does not support as unavailable', () => {
  const view = effortPickerView({
    current: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    configured: 'max',
  })

  assert.deepEqual(view.rows.map((row) => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(view.rows.find((row) => row.id === 'high')?.current, true)
  assert.equal(view.rows.find((row) => row.id === 'xhigh')?.disabled, true)
  assert.match(view.rows.find((row) => row.id === 'max')?.disabledReason ?? '', /不支持/)
  // A configured level the active model cannot honour is still visible.
  assert.equal(view.rows.find((row) => row.id === 'max')?.detail, '已配置')

  const unclamped = effortPickerView({ current: 'low' })
  assert.equal(unclamped.rows.some((row) => row.disabled), false)
})

test('background tasks and sessions render with their status and counts', () => {
  const tasks = backgroundTasksView([
    { id: 't2', sessionId: 's', kind: 'agent', status: 'completed', agentType: 'explore', description: 'find it', startedAt: 5_000, finishedAt: 8_000, exitCode: 0, outputBytes: 0, unreadBytes: 0 },
    { id: 't1', sessionId: 's', kind: 'shell', status: 'running', command: 'npm test', startedAt: 0, outputBytes: 10, unreadBytes: 4 },
  ], 75_000)
  // Running first, whatever the start order.
  assert.equal(tasks.rows[0]?.label, 'npm test')
  assert.equal(tasks.rows[0]?.detail, '运行中 · 1m15s · 4 字节新输出')
  assert.equal(tasks.rows[1]?.label, 'explore: find it')
  assert.equal(tasks.rows[1]?.detail, '已完成 · 3s · exit 0')
  assert.equal(tasks.rows[1]?.secondary, undefined, 'a finished task has nothing to stop')
  assert.equal(backgroundTasksView([], 0).rows.length, 0)
  assert.equal(backgroundTasksView([], 0).emptyMessage, '没有后台任务。')

  const sessions = resumePickerView({
    sessions: [
      { id: 'a', shortId: 'a1', createdAt: 'x', updatedAt: 'y', title: 'First', messageCount: 1 },
      { id: 'b', shortId: 'b2', createdAt: 'x', updatedAt: 'y', messageCount: 4 },
    ],
    currentSessionId: 'a',
  })
  assert.equal(sessions.rows[0]?.current, true)
  assert.match(sessions.rows[0]?.detail ?? '', /1 条消息/)
  assert.equal(sessions.rows[1]?.label, 'b2', 'an untitled session falls back to its short id')
  assert.match(sessions.rows[1]?.detail ?? '', /4 条消息/)
})

test('the provider panel is outside SUPPORTED_SURFACES but is still reachable', () => {
  // Typed as `CommandSurface` because `isSupportedSurface` is a predicate that
  // narrows *away* from this value — passing the literal would not compile.
  //
  // `false` here means "not a row list", not "dropped": `paneSession.ts` routes
  // it by name to the settings screen's provider page, the same way it routes
  // `rewind-panel` below. It *was* dropped, and `/provider` did nothing at all
  // in this shell as a result.
  const providerPanel: CommandSurface = 'provider-panel'
  assert.equal(isSupportedSurface(providerPanel), false)
  assert.equal((SUPPORTED_SURFACES as readonly CommandSurface[]).includes(providerPanel), false)
  for (const surface of ['model-picker', 'effort-picker', 'background-tasks', 'resume-picker'] as const) {
    assert.equal(isSupportedSurface(surface), true)
  }
})

test('the rewind panel is outside SUPPORTED_SURFACES but is still drawn', () => {
  // Not an oversight and not an ignored surface: `SUPPORTED_SURFACES` is the set
  // that becomes a `SurfaceView` row list, and rewind is a two-screen modal with
  // its own state. `paneSession.ts` resolves it by name *before* consulting this
  // predicate — so a reader must not conclude from `false` here that the desktop
  // shell drops `/rewind`.
  const rewindPanel: CommandSurface = 'rewind-panel'
  assert.equal(isSupportedSurface(rewindPanel), false)
  assert.equal((SUPPORTED_SURFACES as readonly CommandSurface[]).includes(rewindPanel), false)
})

// --- picking a row ----------------------------------------------------------

test('picking a model or an effort runs the slash command, never the wire setter', () => {
  // Load-bearing, not roundabout. `set-model` only points the current runtime
  // elsewhere; `/model` is the user expressing a preference and is what writes
  // the choice back to config. Calling `client.setModel` from a picker row would
  // silently drop that persistence.
  const models = modelPickerView(MODELS)
  assert.deepEqual(activateSurfaceRowById(models, 'sonnet'), {
    kind: 'run-command',
    line: '/model sonnet',
  })

  const effort = effortPickerView({ current: 'high' })
  assert.deepEqual(activateSurfaceRowById(effort, 'low'), { kind: 'run-command', line: '/effort low' })
})

test('a disabled row explains itself and cannot be picked', () => {
  const models = modelPickerView(MODELS)
  const broken = models.rows.find((row) => row.id === 'broken')
  assert.equal(broken?.disabled, true)
  assert.equal(broken?.action, undefined)
  assert.equal(activateSurfaceRowById(models, 'broken'), undefined)
  assert.equal(activateSurfaceRowById(models, 'nonexistent'), undefined)
})

test('resuming opens the pane that owns the session; a task row peeks its output', () => {
  // `/resume` takes no argument — it exists only to open this panel — and the
  // tab bar already defines switching as `open-pane`, one pane per session.
  const sessions = resumePickerView({
    sessions: [{ id: 'a', shortId: 'a1', createdAt: 'x', updatedAt: 'y', messageCount: 1 }],
  })
  assert.deepEqual(activateSurfaceRowById(sessions, 'a'), { kind: 'open-pane', sessionId: 'a' })

  // The row peeks; stopping is a separate button that takes two presses.
  const running = [
    { id: 't1', sessionId: 's', kind: 'shell', status: 'running', command: 'npm test', startedAt: 0, outputBytes: 10, unreadBytes: 4 },
    { id: 't3', sessionId: 's', kind: 'shell', status: 'killed', command: 'sleep 9', startedAt: 0, finishedAt: 1, outputBytes: 0, unreadBytes: 0 },
  ] as const
  const tasks = backgroundTasksView(running, 0)
  assert.deepEqual(activateSurfaceRowById(tasks, 't1'), { kind: 'peek-task', taskId: 't1' })
  assert.deepEqual(tasks.rows[0]?.secondary?.action, { kind: 'arm-kill', taskId: 't1' })
  assert.deepEqual(backgroundTasksView(running, 0, 't1').rows[0]?.secondary?.action, { kind: 'kill-task', taskId: 't1' })
  assert.equal(runningProcessCount(running), 1)
})

test('moving through a picker skips the rows that cannot be picked', () => {
  const view = effortPickerView({ current: 'low', supportedEfforts: ['low', 'medium'] })
  // low, medium are selectable; high, xhigh, max are not supported.
  assert.deepEqual(view.rows.map((row) => row.action !== undefined), [true, true, false, false, false])

  assert.equal(moveSurfaceSelection(view, 0, 'down'), 1)
  // Down from the last selectable row wraps past the three disabled ones.
  assert.equal(moveSurfaceSelection(view, 1, 'down'), 0)
  assert.equal(moveSurfaceSelection(view, 0, 'up'), 1, 'up from the top wraps to the last selectable')
})

test('a picker with nothing selectable is inert rather than looping', () => {
  const view = effortPickerView({ current: 'low', supportedEfforts: undefined })
  const allDisabled = { ...view, rows: view.rows.map((row) => ({ ...row, action: undefined })) }
  assert.equal(moveSurfaceSelection(allDisabled, 2, 'down'), 2)
  assert.equal(activateSurfaceRow(allDisabled, 2), undefined)

  assert.equal(moveSurfaceSelection({ ...view, rows: [] }, 0, 'down'), 0)
})

test('a freshly opened picker starts on the current row when it is pickable', () => {
  const models = modelPickerView(MODELS)
  assert.equal(models.rows[1]?.current, true)
  assert.equal(initialSurfaceSelection(models), 1)

  // With no current row, the first pickable one. The disabled row is skipped
  // even when it comes first.
  const noCurrent = {
    ...models,
    rows: models.rows.map((row) => ({ ...row, current: false })).reverse(),
  }
  assert.equal(noCurrent.rows[0]?.disabled, true)
  assert.equal(initialSurfaceSelection(noCurrent), 1)
})

test('a clicked completion accepts or submits exactly where Enter does', () => {
  const cases: ShellState[] = [
    shell({ completions: 'command' }),
    shell({ completions: 'file' }),
    shell({ completions: 'command', isStreaming: true }),
    shell({ completions: 'file', isStreaming: true }),
  ]

  for (const state of cases) {
    const typed = resolveKey({ key: 'Enter' }, state)
    // The mouse has no second rule of its own: `#suggestions` and the Enter
    // branch both read `completionAcceptMode`, so a click can never submit where
    // Enter would only fill in.
    assert.equal(`${completionAcceptMode(state)}-completion`, typed, JSON.stringify(state))
  }
})
