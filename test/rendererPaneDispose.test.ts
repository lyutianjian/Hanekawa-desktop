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
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

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

function deliveryPane(t: { after(fn: () => void): void }) {
  const stub = installDomStub()
  const views = stubViews()
  const remote = fakeChannel()
  const errors: string[] = []
  let text = ''
  let attachments: Parameters<ComposerView['renderAttachments']>[0] | undefined
  views.composer.value = () => text
  views.composer.setValue = (value) => { text = value }
  views.composer.clear = () => { text = '' }
  views.composer.renderAttachments = (value) => { attachments = value }
  const pane = createPaneSession(depsOf('delivery', remote.channel, stub.createContainer(), views, {
    onActionError: (message) => errors.push(message),
  }))
  t.after(() => { pane.dispose(); stub.uninstall() })
  pane.activate()
  remote.deliver({ type: 'session-changed', session: { id: 's', shortId: 's', createdAt: 'now', updatedAt: 'now', messageCount: 0 } })
  return { stub, views, remote, pane, errors, attachments: () => attachments,
    draft: (value: string) => { text = value }, text: () => text }
}

test('withdrawing a queued message merges current text, paths and image refs after persistence succeeds', async (t) => {
  const { stub, remote, pane, draft, text, attachments } = deliveryPane(t)
  const images = [makeImageAttachmentRef({ ownerSessionId: 's' })]
  const message = { id: 'q1', content: '  原文  \n\n<attached-paths>\nfile: /tmp/original.txt\n</attached-paths>',
    priority: 'next', createdAt: new Date().toISOString(), images }
  draft('新草稿')
  pane.addDraftPaths([{ path: '/tmp/new.txt', kind: 'file' }])
  remote.deliver({ type: 'queued-messages', messages: [message] })
  const button = pane.paneEl.querySelector('.item-retract')!
  assert.ok(button)
  stub.click(button)
  stub.click(button)
  const commands = remote.posted.filter((entry) => entry.type === 'retract-message')
  assert.equal(commands.length, 1, 'repeat clicks do not restore twice')
  assert.equal(text(), '新草稿', 'the current draft stays intact until the host confirms')
  draft('等待期间继续输入')
  remote.deliver({ type: 'queued-messages', messages: [] })
  remote.deliver({ type: 'reply', id: commands[0]!.id, result: { message } })
  await tick()
  assert.equal(text(), '等待期间继续输入\n\n  原文  ')
  assert.deepEqual(pane.draftInput().paths.map((entry) => entry.path), ['/tmp/new.txt', '/tmp/original.txt'])
  assert.deepEqual(attachments()?.rows.map((entry) => entry.imageId), [images[0]!.id])
  assert.equal(pane.paneEl.querySelector('.item-retract'), null)
})

test('a refused withdrawal preserves both the queued message and current draft', async (t) => {
  const { stub, remote, pane, draft, text, errors } = deliveryPane(t)
  draft('保留草稿')
  remote.deliver({ type: 'queued-messages', messages: [{ id: 'q1', content: 'queued', priority: 'next', createdAt: new Date().toISOString() }] })
  stub.click(pane.paneEl.querySelector('.item-retract')!)
  const command = remote.posted.find((entry) => entry.type === 'retract-message')!
  remote.deliver({ type: 'fail', id: command.id, message: '消息正在发送，无法撤回。' })
  await tick()
  assert.equal(text(), '保留草稿')
  assert.ok(pane.paneEl.querySelector('.item-retract'))
  assert.match(errors[0]!, /消息正在发送/)
})

test('a staged image send can return to editing and a late import never sends it', async (t) => {
  const { stub, remote, pane, draft, text, attachments } = deliveryPane(t)
  draft('看这张图')
  const importing = pane.importImagesFromPaths(['/tmp/picture.png'])
  const command = remote.posted.find((entry) => entry.type === 'import-attachment')!
  assert.ok(command)
  await pane.queueMessage()
  assert.equal(text(), '')
  draft('正在输入')
  stub.click(pane.paneEl.querySelector('.item-retract')!)
  assert.equal(text(), '正在输入\n\n看这张图')
  assert.equal(attachments()?.rows[0]?.state, 'importing')
  remote.deliver({ type: 'reply', id: command.id, result: { ok: true, attachment: { ref: makeImageAttachmentRef({ ownerSessionId: 's' }) } } })
  await importing
  await tick()
  assert.equal(attachments()?.rows[0]?.state, 'ready')
  assert.equal(remote.posted.some((entry) => entry.type === 'submit' || entry.type === 'enqueue-message'), false)
  assert.equal(pane.paneEl.querySelector('.item-retract'), null)
})

test('an image quota conflict leaves the queued message and existing drafts untouched', async (t) => {
  const { stub, remote, pane, draft, text, attachments, errors } = deliveryPane(t)
  draft('保留草稿')
  void pane.importImagesFromPaths(Array.from({ length: 10 }, (_, index) => `/tmp/${index}.png`)).catch(() => {})
  const message = { id: 'q1', content: '待发送', priority: 'next', createdAt: new Date().toISOString(), images: [makeImageAttachmentRef()] }
  remote.deliver({ type: 'queued-messages', messages: [message] })
  stub.click(pane.paneEl.querySelector('.item-retract')!)
  assert.equal(remote.posted.some((entry) => entry.type === 'retract-message'), false)
  assert.equal(text(), '保留草稿')
  assert.equal(attachments()?.rows.length, 10)
  assert.match(errors[0]!, /超过 10 张/)
})

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
    insertText: () => {},
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
    questionCard: { show: () => {}, focus: () => {} } satisfies QuestionCardView,
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
  const views = stubViews()
  let questionFocus = 0
  const pane = createPaneSession(depsOf('status-lane', remote.channel, stub.createContainer(), views, {
    questionCard: { show: () => {}, focus: () => { questionFocus += 1 } },
  }))
  t.after(() => { pane.dispose(); stub.uninstall() })
  pane.activate()
  remote.deliver({ type: 'snapshot', snapshot: { ...pane.client.getSnapshot(), isStreaming: true }, subagentProgress: [] })
  const record = (record: SessionRecord): void => remote.deliver({ type: 'session-event', event: { type: 'record', record } })
  const label = (): string => (pane.paneEl.querySelector('.activity-line') ?? pane.paneEl.querySelector('.waiting'))?.querySelector('.line-text')?.textContent ?? ''
  record({ type: 'message', id: 'user', role: 'user', content: 'go', turnId: 't1', createdAt: new Date().toISOString() })
  record({ type: 'tool_use', id: 'automatic', tool: 'Bash', input: { command: 'npm test', description: '跑测试' }, riskLevel: 'safe', turnId: 't1', createdAt: new Date().toISOString() })
  t.mock.timers.tick(40)
  assert.doesNotMatch(label(), /等待你确认/, 'the first tool paint, before any approval record')
  record({ type: 'tool_approval', id: 'approved', tool: 'Bash', input: {}, approved: true, riskLevel: 'confirm', turnId: 't1', createdAt: new Date().toISOString() })
  await tick()
  t.mock.timers.tick(700)
  assert.equal(label(), '跑测试')
  assert.equal(pane.shellState().hasOverlay, false)

  record({ type: 'tool_use', id: 'manual', tool: 'Bash', input: { command: 'npm run build', description: '构建' }, riskLevel: 'confirm', turnId: 't1', createdAt: new Date().toISOString() })
  await tick()
  remote.deliver({ type: 'ui-request', request: { kind: 'permission', requestId: 'request-manual', payload: {
    toolName: 'Bash', toolUseId: 'manual', input: { command: 'npm run build' }, riskLevel: 'confirm',
    reason: 'shell command', source: 'mode', denialStreak: 0, canAlwaysAllow: false, destructiveWarnings: [],
  } } })
  assert.equal(label(), '等待你确认 · 构建', 'only the actual request names the waiting call')
  assert.equal(pane.shellState().hasOverlay, true)
  const statusButton = pane.paneEl.querySelector('.waiting-main')!
  stub.click(statusButton)
  assert.equal(views.permissionRequest.calls.at(-1), 'focus', 'status clicks focus the existing approval card')
  assert.equal(remote.posted.some((message) => message.type === 'ui-response'), false, 'focusing does not answer the request')
  pane.handleOverlayAction({ kind: 'slot', index: 0 })
  await tick()
  t.mock.timers.tick(700)
  assert.equal(label(), '构建', 'answering replaces the user wait on the label clock, before its approval record is sent')
  assert.equal(pane.shellState().hasOverlay, false)

  remote.deliver({ type: 'ui-request', request: { kind: 'ask-user-question', requestId: 'request-question', payload: {
    questions: [{ question: '选哪个？', header: '选择', multiSelect: false, options: [{ label: 'A', description: '第一个' }] }],
  } } })
  const questionButton = pane.paneEl.querySelector('.waiting-main')!
  stub.click(questionButton)
  assert.equal(questionFocus, 1, 'the current status button focuses the question card')
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

test('thought disclosure survives pane activation and stays with its session across rebinds', (t) => {
  const stub = installDomStub()
  const remote = fakeChannel()
  const pane = createPaneSession(depsOf('thought-memory', remote.channel, stub.createContainer(), stubViews()))
  t.after(() => { pane.dispose(); stub.uninstall() })
  pane.activate()
  const records: SessionRecord[] = [{ type: 'message', id: 'a1', role: 'assistant', content: '',
    thinkingBlocks: [{ type: 'thinking', thinking: '首句。正文。' }], createdAt: '2026-10-30T00:00:00.000Z' }]
  const bind = (id: string): void => {
    remote.deliver({ type: 'session-changed', session: { id, shortId: id, createdAt: 'now', updatedAt: 'now', messageCount: 1 } })
    remote.deliver({ type: 'session-event', event: { type: 'transcript-reset', records, systemMessages: [], bumpGeneration: true } })
  }
  const head = (): HTMLElement => pane.paneEl.querySelector('.thinking')!.querySelector<HTMLElement>('.run-line')!
  bind('session-a')
  assert.equal(head().getAttribute('aria-expanded'), 'false')
  stub.click(head())
  assert.equal(head().getAttribute('aria-expanded'), 'true')
  assert.equal(head().getAttribute('aria-label'), '首句。')
  pane.deactivate()
  pane.activate()
  assert.equal(head().getAttribute('aria-expanded'), 'true', 'switching away does not forget the manual expansion')
  bind('session-b')
  assert.equal(head().getAttribute('aria-expanded'), 'false', 'reused thinking ids cannot inherit another session’s expansion')
  bind('session-a')
  assert.equal(head().getAttribute('aria-expanded'), 'true', 'returning restores that session’s answer')
  bind('session-b')
  assert.equal(head().getAttribute('aria-expanded'), 'false', 'the other session keeps its own default')
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
