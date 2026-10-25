import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'

import { installDomStub } from './helpers/domStub.js'
import { createPaneSession, type PaneSessionDeps } from '../src/desktop/renderer/paneSession.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'
import type { PermissionRequestDto } from '../src/runtime/protocol/wire.js'
import type { ComposerView } from '../src/desktop/renderer/dom/composerView.js'
import type { StatusView } from '../src/desktop/renderer/dom/statusView.js'
import type { PermissionRequestView } from '../src/desktop/renderer/dom/permissionRequestView.js'
import type { RewindPanel } from '../src/desktop/renderer/dom/rewindView.js'
import type { SurfacePanel } from '../src/desktop/renderer/dom/surfaceView.js'
import type { SuggestionsView } from '../src/desktop/renderer/dom/suggestionsView.js'
import type { PlanCardView } from '../src/desktop/renderer/dom/planCardView.js'
import type { QuestionCardView } from '../src/desktop/renderer/dom/questionCardView.js'
import type { ProcessStripView } from '../src/desktop/renderer/dom/processStripView.js'
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
    processStrip: { render: () => {} } satisfies ProcessStripView,
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