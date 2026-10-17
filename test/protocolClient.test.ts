import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import type { HostCommand, HostEvent } from '../src/runtime/protocol/wire.js'
import type { SessionControllerSnapshot, SessionEvent } from '../src/runtime/sessionController.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'

/**
 * The client is the half a renderer holds. Its one hard requirement is the
 * `useSyncExternalStore` contract: `getSnapshot()` must keep returning the same
 * object while nothing has changed. In-process that falls out of
 * `SessionController.publish` comparing by reference, but every deserialized
 * message is a fresh object graph, so the client has to restore the invariant
 * itself or React re-renders forever.
 */

interface Harness {
  client: SessionClient
  hostSide: RuntimeChannel
  sent: HostCommand[]
  post: (event: HostEvent) => void
}

function createHarness(): Harness {
  const [hostSide, clientSide] = createMemoryChannelPair()
  const sent: HostCommand[] = []
  hostSide.onMessage((message) => sent.push(message as HostCommand))
  return {
    client: new SessionClient(clientSide),
    hostSide,
    sent,
    post: (event) => hostSide.post(event),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function snapshot(overrides: Partial<SessionControllerSnapshot> = {}): SessionControllerSnapshot {
  return {
    isStreaming: false,
    usage: { lastRequest: null, total: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 } },
    taskSnapshot: undefined,
    spinnerSubText: undefined,
    contextUsedTokens: undefined,
    turnOutputTokens: undefined,
    ...overrides,
  }
}

test('an identical snapshot message does not change getSnapshot identity', async () => {
  const harness = createHarness()
  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })

  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()
  const first = harness.client.getSnapshot()
  assert.equal(notifications, 1)

  // Structurally equal but a different object graph, as every IPC message is.
  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()

  assert.equal(harness.client.getSnapshot(), first,
    'useSyncExternalStore throws "getSnapshot should be cached" if this changes')
  assert.equal(notifications, 1, 'and no listener should be woken for nothing')
  harness.client.dispose()
})

test('a real change swaps the snapshot and notifies once', async () => {
  const harness = createHarness()
  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })

  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()
  const first = harness.client.getSnapshot()

  harness.post({ type: 'snapshot', snapshot: snapshot({ isStreaming: true }), subagentProgress: [] })
  await settle()

  assert.notEqual(harness.client.getSnapshot(), first)
  assert.equal(harness.client.getSnapshot().isStreaming, true)
  assert.equal(notifications, 2)
  harness.client.dispose()
})

test('usage is compared by value, so identical totals keep their identity', async () => {
  const harness = createHarness()
  harness.post({ type: 'snapshot', snapshot: snapshot(), subagentProgress: [] })
  await settle()
  const firstUsage = harness.client.getSnapshot().usage

  harness.post({
    type: 'snapshot',
    snapshot: snapshot({ spinnerSubText: 'Running Bash' }),
    subagentProgress: [],
  })
  await settle()

  assert.equal(harness.client.getSnapshot().usage, firstUsage,
    'an unrelated change must not hand consumers a new usage object')
  assert.equal(harness.client.getSnapshot().spinnerSubText, 'Running Bash')
  harness.client.dispose()
})

test('subagent progress is rehydrated into a Map', async () => {
  const harness = createHarness()
  harness.post({
    type: 'snapshot',
    snapshot: snapshot(),
    subagentProgress: [['agent-1', 'Reading'], ['agent-2', 'Searching']],
  })
  await settle()

  assert.equal(harness.client.getSubagentProgress().get('agent-2'), 'Searching')
  harness.client.dispose()
})

test('session events reach onEvent listeners untouched', async () => {
  const harness = createHarness()
  const seen: SessionEvent[] = []
  harness.client.onEvent((event) => seen.push(event))

  harness.post({
    type: 'session-event',
    event: { type: 'notice', level: 'error', content: 'boom' },
  })
  await settle()

  assert.deepEqual(seen, [{ type: 'notice', level: 'error', content: 'boom' }])
  harness.client.dispose()
})

test('a command resolves on reply and rejects on fail', async () => {
  const harness = createHarness()

  const pending = harness.client.setEffort('low')
  await settle()
  const command = harness.sent.find((entry) => entry.type === 'set-effort')
  assert.ok(command && command.type === 'set-effort')
  assert.equal(command.persist, undefined, 'persistence is opt-in')
  harness.post({ type: 'reply', id: command.id, result: { effort: 'low', persisted: false } })
  assert.deepEqual(await pending, { effort: 'low', persisted: false })

  const failing = harness.client.setModel('nope')
  await settle()
  const second = harness.sent.find((entry) => entry.type === 'set-model')
  assert.ok(second && second.type === 'set-model')
  harness.post({ type: 'fail', id: second.id, message: 'Unknown model' })
  await assert.rejects(failing, /Unknown model/)
  harness.client.dispose()
})

test('a dead host rejects every in-flight command instead of hanging the UI', async () => {
  const harness = createHarness()
  // Assertions are attached before the close so the rejections are never
  // momentarily unhandled.
  const first = assert.rejects(harness.client.reload(), /host disconnected/)
  const second = assert.rejects(harness.client.getCheckpoints(), /host disconnected/)
  await settle()

  harness.hostSide.close()

  await first
  await second
})

test('with no handler installed, UI requests answer the way a missing UI would', async () => {
  const harness = createHarness()

  harness.post({ type: 'ui-request', request: { kind: 'permission', requestId: 'r1', payload: {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: {},
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: false,
    destructiveWarnings: [],
  } } })
  harness.post({ type: 'ui-request', request: { kind: 'enter-plan', requestId: 'r2' } })
  await settle()
  await settle()

  const responses = harness.sent.filter((entry) => entry.type === 'ui-response')
  assert.equal(responses.length, 2, 'an unanswered request would hang the agent loop')

  const permission = responses.find((entry) =>
    entry.type === 'ui-response' && entry.requestId === 'r1')
  assert.ok(permission && permission.type === 'ui-response'
    && permission.response.kind === 'permission')
  assert.equal(permission.response.approved, false)

  const enterPlan = responses.find((entry) =>
    entry.type === 'ui-response' && entry.requestId === 'r2')
  assert.ok(enterPlan && enterPlan.type === 'ui-response'
    && enterPlan.response.kind === 'enter-plan')
  assert.equal(enterPlan.response.approved, true, 'same asymmetry as the host fallbacks')
  harness.client.dispose()
})

test('an installed permission handler can answer with alwaysAllow', async () => {
  const harness = createHarness()
  harness.client.setHandlers({
    permission: async () => ({ approved: true, alwaysAllow: true }),
  })

  harness.post({ type: 'ui-request', request: { kind: 'permission', requestId: 'r1', payload: {
    toolName: 'Read',
    riskLevel: 'safe',
    input: {},
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: true,
    destructiveWarnings: [],
  } } })
  await settle()
  await settle()

  const response = harness.sent.find((entry) => entry.type === 'ui-response')
  assert.ok(response && response.type === 'ui-response' && response.response.kind === 'permission')
  assert.deepEqual(response.response, { kind: 'permission', approved: true, alwaysAllow: true })
  harness.client.dispose()
})

test('an unchanged background task list keeps its identity', async () => {
  const harness = createHarness()
  const post = (outputBytes: number) => harness.post({
    type: 'background-tasks',
    tasks: [{ id: 't1', status: 'running', outputBytes, unreadBytes: 4 }],
  } as unknown as HostEvent)

  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })

  post(10)
  await settle()
  const first = harness.client.getBackgroundTasks()
  assert.equal(first.length, 1)
  assert.equal(notifications, 1)

  // The host re-sends the whole list on every change, so an identical payload
  // must not hand useSyncExternalStore a new array.
  post(10)
  await settle()
  assert.equal(harness.client.getBackgroundTasks(), first, 'identity must survive an identical list')
  assert.equal(notifications, 1, 'and it must not notify')

  post(11)
  await settle()
  assert.notEqual(harness.client.getBackgroundTasks(), first)
  assert.equal(notifications, 2)
  harness.client.dispose()
})

test('shutdown resolves even when the host dies before replying', async () => {
  const harness = createHarness()

  const closing = harness.client.shutdown('window closed')
  await settle()
  harness.hostSide.close()

  // The host going away is the success case; a window must not refuse to close
  // because the reply never arrived.
  await closing
  harness.client.dispose()
})

test('closing its own pane resolves even though the close takes the channel with it', async () => {
  const harness = createHarness()
  harness.post({ type: 'session-changed', session: { id: 's1', shortId: 's1', title: 'Draft', messageCount: 0, createdAt: 'now', updatedAt: 'now' } })
  await settle()

  const closing = harness.client.closePane('s1')
  const other = assert.rejects(harness.client.closePane('s2'), /host disconnected/)
  await settle()
  harness.hostSide.close()

  await closing
  await other
  harness.client.dispose()
})

test('the two rewind commands unwrap to the records the host wrote', async () => {
  const harness = createHarness()

  const truncating = harness.client.truncateSession('m3')
  await settle()
  const truncate = harness.sent.find((entry) => entry.type === 'truncate-session')
  assert.ok(truncate && truncate.type === 'truncate-session')
  assert.equal(truncate.messageId, 'm3')
  harness.post({ type: 'reply', id: truncate.id, result: { records: [{ id: 'm1' }] } })
  assert.deepEqual(await truncating, [{ id: 'm1' }])

  const summarizing = harness.client.summarizeRewind('m3', 'summarize-up-to-here')
  await settle()
  const summarize = harness.sent.find((entry) => entry.type === 'summarize-rewind')
  assert.ok(summarize && summarize.type === 'summarize-rewind')
  assert.equal(summarize.decision, 'summarize-up-to-here')
  harness.post({ type: 'reply', id: summarize.id, result: { records: [] } })
  assert.deepEqual(await summarizing, [])
  harness.client.dispose()
})

test('a rewind that cannot happen rejects rather than resolving empty', async () => {
  const harness = createHarness()
  const pending = assert.rejects(harness.client.truncateSession('gone'), /Message not found/)
  await settle()

  const sent = harness.sent.find((entry) => entry.type === 'truncate-session')
  assert.ok(sent)
  harness.post({ type: 'fail', id: sent.id, message: 'Message not found: gone' })
  await pending
  harness.client.dispose()
})

test('retarget returns the session alongside its records', async () => {
  const harness = createHarness()
  const pending = harness.client.retarget('s2')
  await settle()

  const sent = harness.sent.find((entry) => entry.type === 'retarget')
  assert.ok(sent && sent.type === 'retarget')
  harness.post({
    type: 'reply',
    id: sent.id,
    result: { session: { id: 's2' }, records: [], notices: [] },
  })

  const result = await pending
  assert.equal(result.session.id, 's2')
  assert.deepEqual(result.records, [])
  harness.client.dispose()
})

test('a handler that throws still answers, with its own kind\'s fallback', async () => {
  const harness = createHarness()
  harness.client.setHandlers({
    permission: async () => { throw new Error('the dialog blew up') },
    enterPlan: async () => { throw new Error('the dialog blew up') },
  })

  harness.post({ type: 'ui-request', request: { kind: 'permission', requestId: 'r1', payload: {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: {},
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: false,
    destructiveWarnings: [],
  } } })
  harness.post({ type: 'ui-request', request: { kind: 'enter-plan', requestId: 'r2' } })
  await settle()
  await settle()

  const responses = harness.sent.filter((entry) => entry.type === 'ui-response')
  // `handleMessage` calls `answer` as `void this.answer(...)`, so a throw used to
  // mean no response was ever posted -- and nothing else releases the host:
  // `PermissionGate.approve` has no timeout and `ToolRunner.run` does not pass
  // its abort signal into it, so even interrupting the turn would not free it.
  assert.equal(responses.length, 2, 'a throwing dialog must not park the agent loop')

  const permission = responses.find((entry) =>
    entry.type === 'ui-response' && entry.requestId === 'r1')
  assert.ok(permission && permission.type === 'ui-response'
    && permission.response.kind === 'permission')
  assert.equal(permission.response.approved, false)

  const enterPlan = responses.find((entry) =>
    entry.type === 'ui-response' && entry.requestId === 'r2')
  assert.ok(enterPlan && enterPlan.type === 'ui-response'
    && enterPlan.response.kind === 'enter-plan')
  assert.equal(enterPlan.response.approved, true, 'the fallback stays asymmetric')
  harness.client.dispose()
})

test('listCommands unwraps to the metadata array', async () => {
  const harness = createHarness()
  const pending = harness.client.listCommands()
  await settle()

  const sent = harness.sent.find((entry) => entry.type === 'list-commands')
  assert.ok(sent)
  harness.post({
    type: 'reply',
    id: sent.id,
    result: { commands: [{ name: 'help', description: 'Show help' }] },
  })

  assert.deepEqual(await pending, [{ name: 'help', description: 'Show help' }])
  harness.client.dispose()
})

// --- the message queue ------------------------------------------------------

function queued(id: string, content: string) {
  return { id, content, priority: 'next' as const, createdAt: '2026-08-17T00:00:00.000Z' }
}

test('an unchanged queue keeps its identity and does not notify', async () => {
  const harness = createHarness()
  let notifications = 0
  let announcements = 0
  harness.client.subscribe(() => { notifications += 1 })
  harness.client.onQueueChanged(() => { announcements += 1 })

  harness.post({ type: 'queued-messages', messages: [queued('a', 'first')] })
  await settle()
  const first = harness.client.getQueuedMessages()
  assert.equal(first.length, 1)
  assert.equal(notifications, 1)
  assert.equal(announcements, 1)

  // The host re-announces the queue on every mutation *and* on every session
  // switch, so an identical payload must not repaint a strip that says the same
  // thing.
  harness.post({ type: 'queued-messages', messages: [queued('a', 'first')] })
  await settle()
  assert.equal(harness.client.getQueuedMessages(), first, 'identity must survive a re-announcement')
  assert.equal(notifications, 1)
  assert.equal(announcements, 1)

  harness.post({ type: 'queued-messages', messages: [queued('a', 'first'), queued('b', 'second')] })
  await settle()
  assert.notEqual(harness.client.getQueuedMessages(), first)
  assert.equal(notifications, 2)
  assert.equal(announcements, 2)
  harness.client.dispose()
})

test('the queue is compared positionally, because a queue is an order', async () => {
  const harness = createHarness()
  harness.post({ type: 'queued-messages', messages: [queued('a', 'first'), queued('b', 'second')] })
  await settle()
  const before = harness.client.getQueuedMessages()

  // Same membership, different order. A set comparison would call this unchanged
  // and the strip would keep claiming the wrong send order.
  harness.post({ type: 'queued-messages', messages: [queued('b', 'second'), queued('a', 'first')] })
  await settle()

  assert.notEqual(harness.client.getQueuedMessages(), before)
  assert.deepEqual(harness.client.getQueuedMessages().map((entry) => entry.id), ['b', 'a'])
  harness.client.dispose()
})

test('an emptied queue is reported as empty', async () => {
  const harness = createHarness()
  harness.post({ type: 'queued-messages', messages: [queued('a', 'first')] })
  await settle()

  harness.post({ type: 'queued-messages', messages: [] })
  await settle()
  assert.deepEqual(harness.client.getQueuedMessages(), [])
  harness.client.dispose()
})

// --- session cost -----------------------------------------------------------

test('a cost that moved notifies even when every token count is equal', async () => {
  const harness = createHarness()
  let notifications = 0
  harness.client.subscribe(() => { notifications += 1 })
  const priced = (amount: number) => snapshot({
    usage: { lastRequest: null, total: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3, cost: { amounts: { USD: amount } } } },
  })

  harness.post({ type: 'snapshot', snapshot: priced(1), subagentProgress: [] })
  await settle()
  assert.equal(notifications, 1)

  harness.post({ type: 'snapshot', snapshot: priced(1), subagentProgress: [] })
  await settle()
  assert.equal(notifications, 1, 'a re-sent cost must not wake subscribers')

  harness.post({ type: 'snapshot', snapshot: priced(2), subagentProgress: [] })
  await settle()
  assert.deepEqual(harness.client.getSnapshot().usage.total.cost, { amounts: { USD: 2 } })
  assert.equal(notifications, 2)
  harness.client.dispose()
})

// --- pane topology ------------------------------------------------------------

test('a re-announced pane list keeps its identity and does not notify', async () => {
  // The host re-announces on every open / close, and the tab bar rebuilds every
  // node it is handed — so an identical list must be a no-op.
  const harness = createHarness()
  const panes = [
    { paneId: 'a', sessionId: 'a', projectRoot: 'c:/repo/one', projectName: 'one', sessionTitle: 'A' },
  ]
  let announcements = 0
  harness.client.onPanesChanged(() => { announcements += 1 })

  harness.post({ type: 'pane-list', panes })
  await settle()
  const first = harness.client.getPanes()
  assert.equal(announcements, 1)

  // A fresh object graph with the same content: this is what every deserialized
  // message looks like.
  harness.post({ type: 'pane-list', panes: panes.map((pane) => ({ ...pane })) })
  await settle()
  assert.equal(harness.client.getPanes(), first, 'identity must survive a re-announcement')
  assert.equal(announcements, 1)
})

test('a pane list that only changed project changes identity', async () => {
  // `projectRoot` decides which group a row is drawn under and whether it gets a
  // close button, so ignoring it here would leave a stale bar on screen.
  const harness = createHarness()
  const base = { paneId: 'a', sessionId: 'a', projectName: 'one' }
  let announcements = 0
  harness.client.onPanesChanged(() => { announcements += 1 })

  harness.post({ type: 'pane-list', panes: [{ ...base, projectRoot: 'c:/repo/one' }] })
  await settle()
  assert.equal(announcements, 1)

  harness.post({ type: 'pane-list', panes: [{ ...base, projectRoot: 'c:/repo/two' }] })
  await settle()
  assert.equal(announcements, 2, 'a moved pane must repaint the bar')
  assert.equal(harness.client.getPanes()[0]?.projectRoot, 'c:/repo/two')

  // Same for the display name, which is the group heading.
  harness.post({
    type: 'pane-list',
    panes: [{ ...base, projectRoot: 'c:/repo/two', projectName: 'renamed' }],
  })
  await settle()
  assert.equal(announcements, 3)
})

test('focusPane asks the shell and returns its answer; openProject omits an absent path', async () => {
  const harness = createHarness()

  const focusing = harness.client.focusPane('pane-7')
  await settle()
  const focus = harness.sent.find((command) => command.type === 'focus-pane')
  assert.ok(focus && focus.type === 'focus-pane')
  assert.equal(focus.paneId, 'pane-7')
  harness.post({ type: 'reply', id: focus.id, result: { ok: false } })
  assert.equal(await focusing, false, 'a stale tab must come back as false, not a rejection')

  const opening = harness.client.openProject()
  await settle()
  const open = harness.sent.find((command) => command.type === 'open-project')
  assert.ok(open && open.type === 'open-project')
  // The key must be absent rather than undefined: the schema is `.strict()` and
  // Electron IPC clones what it is given.
  assert.equal('path' in open, false)
  harness.post({ type: 'reply', id: open.id, result: { ok: true } })
  await opening
})

test('hello seeds the bound session, so the first paint knows which pane is its own', async () => {
  // `getSession()` used to stay undefined until the first `session-changed`,
  // which meant the desktop tab bar marked no row active for the whole first
  // session — and the row it marks active is how a window says "this one is mine".
  const harness = createHarness()
  assert.equal(harness.client.getSession(), undefined)

  const pending = harness.client.hello()
  await settle()
  const sent = harness.sent.find((command) => command.type === 'hello')
  assert.ok(sent && sent.type === 'hello')
  harness.post({
    type: 'reply',
    id: sent.id,
    result: {
      sessionId: 's1',
      session: { id: 's1', shortId: 's1', title: 'First', messageCount: 0, updatedAt: 0 },
      cwd: 'C:/repo',
      projectRoot: 'c:/repo',
      records: [],
      notices: [],
      hasRecoverableInterruption: false,
      queuedMessages: [],
      configuredEffortLevel: 'high',
    },
  })

  const hello = await pending
  assert.equal(hello.projectRoot, 'c:/repo')
  assert.equal(harness.client.getSession()?.id, 's1')
})
