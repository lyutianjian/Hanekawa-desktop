import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'

import { installDomStub } from './helpers/domStub.js'
import { createPaneSession, type PaneSessionDeps } from '../src/desktop/renderer/paneSession.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'
import type { SessionRecord } from '../src/harness/types.js'
import type { PermissionRequestDto, WireCommandInfo, WireHelloResult } from '../src/runtime/protocol/wire.js'
import type { ComposerView } from '../src/desktop/renderer/dom/composerView.js'
import type { StatusView } from '../src/desktop/renderer/dom/statusView.js'
import type { PermissionRequestView } from '../src/desktop/renderer/dom/permissionRequestView.js'
import type { RewindPanel } from '../src/desktop/renderer/dom/rewindView.js'
import type { SurfacePanel } from '../src/desktop/renderer/dom/surfaceView.js'
import type { SuggestionsView } from '../src/desktop/renderer/dom/suggestionsView.js'
import type { PlanCardView } from '../src/desktop/renderer/dom/planCardView.js'
import type { QuestionCardView } from '../src/desktop/renderer/dom/questionCardView.js'
import type { ImageViewerView } from '../src/desktop/renderer/dom/imageViewerView.js'

/**
 * What closing a pane takes with it.
 *
 * The shell singletons — the permission card, the rewind panel, the surface
 * picker, the composer's popover, the image viewer — are painted by whichever
 * pane is *active*, and a pane that had been switched away from had already
 * `deactivate()`d them. The active pane had not: `dispose()` went straight to
 * disposing its own views, so closing the tab in front of you left its
 * permission card over whichever tab the shell activated next, answering into a
 * disposed client. Closing the last pane made it unmistakable, because there was
 * no next pane to repaint over it.
 *
 * The other half is the request: a parked `PermissionGate.approve` never times
 * out, and the promise the pane returned had no other way to settle once the
 * lane was gone.
 *
 * The views here are recorders, not paint: what is being pinned is *which*
 * singletons come down and *what* the still-waiting requests are answered with.
 */

/** A channel with no peer: enough for `SessionClient` to subscribe, and to deliver a `ui-request`. */
function fakeChannel(): {
  channel: RuntimeChannel
  posted: Array<Record<string, unknown>>
  deliver: (message: unknown) => void
} {
  let handler: ((message: unknown) => void) | undefined
  const posted: Array<Record<string, unknown>> = []
  const channel: RuntimeChannel = {
    post: (message) => {
      posted.push(message as Record<string, unknown>)
    },
    onMessage: (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
    onClose: () => () => {},
    close: () => {},
  }
  return {
    channel,
    posted,
    deliver: (message) => handler?.(message),
  }
}

test('slash routing preserves unknown messages, queues them mid-turn and keeps matched commands host-side', async (t) => {
  const stub = installDomStub()
  const views = stubViews()
  const remote = fakeChannel()
  let draft = ''
  views.composer.value = () => draft
  views.composer.setValue = (text) => { draft = text }
  views.composer.clear = () => { draft = '' }
  const pane = createPaneSession(depsOf('slash-lane', remote.channel, stub.createContainer(), views))
  t.after(() => { pane.dispose(); stub.uninstall() })
  pane.activate()
  const reply = (type: string, result: unknown) => {
    const command = remote.posted.filter((entry) => entry.type === type).at(-1)
    assert.ok(command, `${type} was posted`)
    remote.deliver({ type: 'reply', id: command.id, result })
    return command
  }
  pane.refreshCommands()
  reply('list-commands', { commands: [
    { name: 'model', description: 'Choose model' },
    { name: 'template-creator', description: 'Create templates', isSkill: true },
  ] })
  await tick()

  const raw = '  /tmp/example\n请检查  '
  draft = raw
  const send = pane.send()
  assert.equal(reply('submit', {}).input, raw)
  await send
  assert.equal(remote.posted.some((entry) => entry.type === 'run-command'), false)
  assert.equal(draft, '')

  draft = raw
  const queue = pane.queueMessage()
  assert.equal(reply('enqueue-message', { message: { id: 'q1', content: raw, priority: 'next', createdAt: 'now' } }).content, raw)
  await queue

  const paths = [{ path: '/tmp/reference.txt', kind: 'file' as const }]
  pane.addDraftPaths(paths)
  for (const raw of ['/model main', '/template-creator 参数']) {
    draft = raw
    const command = pane.queueMessage()
    assert.equal(reply('run-command', { handled: true }).input, raw)
    await command
    assert.deepEqual(pane.draftInput().paths, paths, 'matched commands preserve draft attachments')
  }

  // A skill removed after the list was read still returns the whole draft to
  // the ordinary submit path when the host reports it unhandled.
  draft = '/template-creator 参数'
  const stale = pane.send()
  reply('run-command', { handled: false })
  await tick()
  assert.equal(reply('submit', {}).input, '/template-creator 参数\n\n<attached-paths>\nfile: /tmp/reference.txt\n</attached-paths>')
  await stale
  assert.deepEqual(pane.draftInput().paths, [])
})

/** Every singleton view the active pane drives, recording what it is asked to do. */
function stubViews(): {
  permissionRequest: PermissionRequestView & { calls: string[] }
  rewindPanel: RewindPanel & { calls: string[] }
  surface: SurfacePanel & { calls: string[] }
  suggestions: SuggestionsView & { calls: string[] }
  composer: ComposerView & { calls: string[] }
  imageViewer: ImageViewerView & { calls: string[] }
  status: StatusView & { calls: string[] }
} {
  const calls = {
    permissionRequest: [] as string[],
    rewindPanel: [] as string[],
    surface: [] as string[],
    suggestions: [] as string[],
    composer: [] as string[],
    imageViewer: [] as string[],
    status: [] as string[],
  }
  const attached = document.createElement('div')

  const permissionRequest: PermissionRequestView & { calls: string[] } = {
    calls: calls.permissionRequest,
    show: () => calls.permissionRequest.push('show'),
    hide: (immediate) => calls.permissionRequest.push(immediate ? 'hide-immediate' : 'hide'),
    finishMotion: () => {},
    focus: () => calls.permissionRequest.push('focus'),
  }
  const rewindPanel: RewindPanel & { calls: string[] } = {
    calls: calls.rewindPanel,
    render: () => calls.rewindPanel.push('render'),
    hide: () => calls.rewindPanel.push('hide'),
    isOpen: () => false,
  }
  const surface: SurfacePanel & { calls: string[] } = {
    calls: calls.surface,
    showSurface: () => calls.surface.push('show-surface'),
    showCommandView: () => calls.surface.push('show-command'),
    hide: () => calls.surface.push('hide'),
    isOpen: () => false,
  }
  const suggestions: SuggestionsView & { calls: string[] } = {
    calls: calls.suggestions,
    render: (state) => calls.suggestions.push(`render:${state.kind}`),
  }
  const composer: ComposerView & { calls: string[] } = {
    calls: calls.composer,
    value: () => '',
    cursorPos: () => 0,
    setValue: () => {},
    setCommands: () => {},
    clear: () => calls.composer.push('clear'),
    focus: () => calls.composer.push('focus'),
    setStreaming: () => {},
    renderRuntime: () => {},
    showRuntimeMenu: () => {},
    refreshSubmit: () => {},
    closeMenus: () => calls.composer.push('close-menus'),
    renderAttachments: () => calls.composer.push('render-attachments'),
    setSendBlockNote: () => {},
    attachStripEl: () => attached,
    autosize: () => {},
    setLocked: () => {},
  }
  const imageViewer: ImageViewerView & { calls: string[] } = {
    calls: calls.imageViewer,
    show: () => calls.imageViewer.push('show'),
    close: () => calls.imageViewer.push('close'),
    stageSize: () => undefined,
  }
  const status: StatusView & { calls: string[] } = {
    calls: calls.status,
    render: () => calls.status.push('render'),
    renderSession: () => calls.status.push('render-session'),
  }

  return { permissionRequest, rewindPanel, surface, suggestions, composer, imageViewer, status }
}

type Views = ReturnType<typeof stubViews>

function depsOf(
  lane: string,
  channel: RuntimeChannel,
  mount: HTMLElement,
  views: Views,
  extra: Partial<PaneSessionDeps> = {},
): PaneSessionDeps {
  return {
    lane,
    platform: 'win32',
    channel,
    mount,
    permissionRequest: views.permissionRequest,
    questionCard: { show: () => {} } satisfies QuestionCardView,
    planCard: { showEnter: () => {}, showExit: () => {} } satisfies PlanCardView,
    rewindPanel: views.rewindPanel,
    surface: views.surface,
    suggestions: views.suggestions,
    status: views.status,
    composer: views.composer,
    imageViewer: views.imageViewer,
    loadUsage: async () => [],
    onExit: () => {},
    ...extra,
  }
}

function permissionRequest(requestId: string): Record<string, unknown> {
  const payload: PermissionRequestDto = {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: { command: 'rm -rf build' },
    reason: 'shell command',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: false,
    destructiveWarnings: [],
  }
  return { type: 'ui-request', request: { kind: 'permission', requestId, payload } }
}

test('the status waits only while a real permission card is pending, never during automatic approval', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1_700_000_000_000 })
  const stub = installDomStub()
  const remote = fakeChannel()
  const pane = createPaneSession(depsOf('status-lane', remote.channel, stub.createContainer(), stubViews()))
  t.after(() => { pane.dispose(); stub.uninstall() })
  pane.activate()
  remote.deliver({ type: 'snapshot', snapshot: { ...pane.client.getSnapshot(), isStreaming: true }, subagentProgress: [] })
  const record = (record: SessionRecord): void => remote.deliver({ type: 'session-event', event: { type: 'record', record } })
  const label = (): string => pane.paneEl.querySelector('.run')?.querySelector('.line-text')?.textContent ?? ''
  record({ type: 'message', id: 'user', role: 'user', content: 'go', turnId: 't1', createdAt: new Date().toISOString() })
  record({ type: 'tool_use', id: 'automatic', tool: 'Bash', input: { command: 'npm test', description: '跑测试' }, turnId: 't1', createdAt: new Date().toISOString() })
  t.mock.timers.tick(40)
  assert.doesNotMatch(label(), /等待你确认/, 'the first tool paint, before any approval record')
  record({ type: 'tool_approval', id: 'approved', tool: 'Bash', input: {}, approved: true, riskLevel: 'confirm', turnId: 't1', createdAt: new Date().toISOString() })
  await tick()
  t.mock.timers.tick(200)
  assert.equal(label(), '跑测试')
  assert.equal(pane.shellState().hasOverlay, false)

  record({ type: 'tool_use', id: 'manual', tool: 'Bash', input: { command: 'npm run build', description: '构建' }, turnId: 't1', createdAt: new Date().toISOString() })
  await tick()
  remote.deliver({ type: 'ui-request', request: { kind: 'permission', requestId: 'request-manual', payload: {
    toolName: 'Bash', toolUseId: 'manual', input: { command: 'npm run build' }, riskLevel: 'confirm',
    reason: 'shell command', source: 'mode', denialStreak: 0, canAlwaysAllow: false, destructiveWarnings: [],
  } } })
  assert.equal(label(), '等待你确认 · 构建', 'only the actual request names the waiting call')
  assert.equal(pane.shellState().hasOverlay, true)
  pane.handleOverlayAction({ kind: 'slot', index: 0 })
  await tick()
  t.mock.timers.tick(200)
  assert.equal(label(), '构建', 'answering removes the user wait before its approval record is sent')
  assert.equal(pane.shellState().hasOverlay, false)
})

test('a newly attached background pane stays out of the canvas layout until activated', (t) => {
  const stub = installDomStub()
  const mount = stub.createContainer('transcript-area')
  const views = stubViews()
  const current = createPaneSession(depsOf('current', fakeChannel().channel, mount, views))
  current.activate()
  const next = createPaneSession(depsOf('next', fakeChannel().channel, mount, views))
  t.after(() => { current.dispose(); next.dispose(); stub.uninstall() })

  assert.equal(current.paneEl.hidden, false)
  assert.equal(next.isActive(), false)
  assert.equal(next.paneEl.hidden, true)
  assert.equal(stub.inspect(mount).children.filter((node) => !node.hidden).length, 1)
  current.deactivate()
  next.activate()
  assert.equal(stub.inspect(mount).children.filter((node) => !node.hidden).length, 1)
})

test('startup can be awaited again before revealing the initialized project and carried draft', async (t) => {
  const stub = installDomStub()
  const views = stubViews()
  const remote = fakeChannel()
  const pane = createPaneSession(depsOf('next', remote.channel, stub.createContainer(), views))
  t.after(() => { pane.dispose(); stub.uninstall() })
  let text = ''
  let commands: readonly WireCommandInfo[] = []
  views.composer.value = () => text
  views.composer.setValue = (value, _cursorPos, nextCommands) => {
    text = value
    if (nextCommands !== undefined) commands = nextCommands
  }
  views.composer.setCommands = (value) => { commands = value }
  const starting = pane.start()
  assert.equal(pane.start(), starting, 'attachment and the new-session action await the same startup')
  assert.equal(remote.posted.filter((entry) => entry.type === 'hello').length, 1)
  const reply = (type: string, result: unknown) => {
    const command = remote.posted.find((entry) => entry.type === type)
    assert.ok(command, `${type} was posted`)
    remote.deliver({ type: 'reply', id: command.id, result })
  }
  reply('hello', {
    sessionId: 'next-session',
    session: { id: 'next-session', shortId: 'next', createdAt: 'now', updatedAt: 'now', messageCount: 0 },
    cwd: '/next',
    projectRoot: '/next',
    projectName: 'ssh密钥（重要！）',
    projectIsGlobal: false,
    gitBranch: 'main',
    records: [],
    notices: [],
    hasRecoverableInterruption: false,
    queuedMessages: [],
    configuredEffortLevel: 'high',
  } satisfies WireHelloResult)
  await tick()
  assert.equal(pane.paneEl.hidden, true, 'initialization does not reveal the pane')
  reply('list-commands', { commands: [{ name: 'review', description: 'Review code', isSkill: true }] })
  await tick()
  reply('list-panes', { panes: [] })
  await starting

  const draft = { text: '保留正在输入的内容', paths: [{ path: '/reference.txt', kind: 'file' as const }], images: [] }
  pane.restoreDraft(draft)
  assert.equal(commands.length, 0, 'a background pane does not replace the active command registry')
  pane.activate()
  assert.equal(pane.ownProjectRoot, '/next')
  assert.deepEqual(pane.draftInput(), draft)
  assert.deepEqual(commands.map((command) => command.name), ['review'])
  const welcome = stub.inspect(pane.paneEl).children.find((node) => node.classes.includes('welcome'))
  assert.ok(welcome?.text.includes('ssh密钥（重要！）'))
  assert.ok(welcome?.text.includes('main'))
  assert.equal(welcome?.text.includes('当前项目'), false, 'the first visible paint has the real project name')
})

test('closing the active pane takes the shell singletons down with it', async (t) => {
  const stub = installDomStub()
  const mount = stub.createContainer('transcript-area')
  const views = stubViews()
  const remote = fakeChannel()
  const pane = createPaneSession(depsOf('lane-a', remote.channel, mount, views, {
    onShellChanged: () => {},
    onAttentionNeeded: () => {},
  }))
  let disposed = false
  const kill = (): void => {
    if (disposed) return
    disposed = true
    pane.dispose()
  }
  t.after(() => {
    kill()
    stub.uninstall()
  })

  pane.activate()
  assert.deepEqual(views.permissionRequest.calls, ['hide'], 'a fresh pane clears the card on activate')

  // A destructive shell command parks the gate until it is answered.
  remote.deliver(permissionRequest('req-1'))
  await tick()
  assert.deepEqual(views.permissionRequest.calls, ['hide', 'show'], 'the card is up, waiting')

  kill()
  await tick()

  // `deactivate()` is what knows the list; `hide-immediate` is the "it is gone
  // now, do not animate over the next pane's paint" form.
  assert.ok(views.permissionRequest.calls.includes('hide-immediate'), 'the card came down with the pane')
  assert.ok(views.composer.calls.includes('close-menus'), 'the composer popover did not outlive its pane')
  assert.ok(views.composer.calls.includes('render-attachments'), 'the attachment strip was cleared')
  assert.ok(views.rewindPanel.calls.includes('hide'), 'the rewind panel was closed')
  assert.ok(views.surface.calls.includes('hide'), 'the surface picker was closed')
  assert.ok(
    views.suggestions.calls.at(-1) === 'render:none',
    'completions were cleared rather than left over the next pane',
  )

  // The gate, answered: a pane going away denies rather than parking the loop.
  const answered = remote.posted.filter((message) => message.type === 'ui-response')
  assert.equal(answered.length, 1, 'exactly one answer for one request')
  assert.equal(answered[0]!.requestId, 'req-1', 'answered against the host request id')
  assert.deepEqual(answered[0]!.response, { kind: 'permission', approved: false })
})

test('each waiting kind gets its own fallback answer, not one blanket denial', async (t) => {
  const stub = installDomStub()
  const mount = stub.createContainer('transcript-area')
  const views = stubViews()
  const remote = fakeChannel()
  const pane = createPaneSession(depsOf('lane-a', remote.channel, mount, views))
  let disposed = false
  const kill = (): void => {
    if (disposed) return
    disposed = true
    pane.dispose()
  }
  t.after(() => {
    kill()
    stub.uninstall()
  })

  pane.activate()
  remote.deliver(permissionRequest('req-perm'))
  remote.deliver({ type: 'ui-request', request: { kind: 'enter-plan', requestId: 'req-enter' } })
  remote.deliver({
    type: 'ui-request',
    request: {
      kind: 'exit-plan',
      requestId: 'req-exit',
      payload: { planContent: '# plan', isBypassAvailable: false, currentMode: 'plan' },
    },
  })
  await tick()

  kill()
  await tick()

  const answers = new Map(
    remote.posted
      .filter((message) => message.type === 'ui-response')
      .map((message) => [message.requestId as string, message.response]),
  )
  assert.deepEqual(answers.get('req-perm'), { kind: 'permission', approved: false }, 'a tool is never approved on the way out')
  assert.deepEqual(
    answers.get('req-enter'),
    { kind: 'enter-plan', approved: true },
    'entering plan mode only restricts, so its fallback approves',
  )
  assert.deepEqual(answers.get('req-exit'), { kind: 'exit-plan', decision: { kind: 'reject', feedback: '' } })
  assert.equal(answers.size, 3, 'nothing left parked')
})

test('closing a background pane leaves the active pane\'s panels alone', async (t) => {
  const stub = installDomStub()
  const mount = stub.createContainer('transcript-area')
  // One set of singletons, as the shell has: the active pane drives them.
  const views = stubViews()
  const front = fakeChannel()
  const back = fakeChannel()
  const active = createPaneSession(depsOf('lane-a', front.channel, mount, views))
  const background = createPaneSession(depsOf('lane-b', back.channel, mount, views))
  t.after(() => {
    active.dispose()
    background.dispose()
    stub.uninstall()
  })

  active.activate()
  front.deliver(permissionRequest('req-1'))
  await tick()
  assert.deepEqual(views.permissionRequest.calls, ['hide', 'show'])

  // A background pane is evicted, or its lane closed elsewhere, while the
  // active pane's card is on screen for the user to answer.
  background.dispose()
  await tick()

  assert.deepEqual(
    views.permissionRequest.calls,
    ['hide', 'show'],
    'the background pane must not clear a card it does not own',
  )
  assert.equal(views.imageViewer.calls.length, 0, 'nor close a viewer another pane opened')
  assert.equal(views.composer.calls.filter((call) => call === 'close-menus').length, 0)
})
