import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootstrap } from '../src/runtime/bootstrap.js'
import { SessionWorkspace } from '../src/runtime/sessionWorkspace.js'
import { SessionStore } from '../src/sessions/service.js'
import { MessageQueue } from '../src/runtime/messageQueue.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { AnthropicProvider } from '../src/config/providers/anthropicProvider.js'
import type { CommandEffect } from '../src/runtime/protocol/wire.js'
import type { ModelRequest, ModelResponse } from '../src/harness/types.js'

const response: ModelResponse = {
  content: 'Configured and ready.',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
}

/** The session's own turn requests, not the side ones (session title, tool-use summary). */
function turnRequests(provider: { mock: { calls: ReadonlyArray<{ arguments: readonly unknown[] }> } }): number {
  return provider.mock.calls.filter((call) => (call.arguments[0] as ModelRequest).cacheSource?.startsWith('agent:')).length
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(check(), 'the runtime did not settle')
}

async function setup(t: TestContext, queued = false) {
  const testHome = await mkdtemp(path.join(tmpdir(), 'hanekawa-setup-home-'))
  const cwd = await mkdtemp(path.join(tmpdir(), 'hanekawa-setup-project-'))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const store = new SessionStore(cwd)
  await store.init()
  const session = store.createDraft()
  if (queued) {
    const queue = new MessageQueue(session.id, [], (id, record) => store.appendRecord(id, record))
    await queue.enqueue({ text: 'saved before setup' })
  }
  const project = await bootstrap({ cwd, store, session, confirmMcpTrust: async () => false })
  const workspace = new SessionWorkspace(project)
  const pane = workspace.adopt(project)
  const [server, remote] = createMemoryChannelPair()
  const host = new SessionHost({
    channel: server,
    project,
    scope: project,
    workspace,
    controller: pane.controller,
    runtimeSlot: pane.runtimeSlot,
    onPaneOpened: () => {},
    onPaneClosed: () => {},
  })
  const client = new SessionClient(remote)
  t.after(async () => {
    host.dispose()
    client.dispose()
    pane.close()
    await project.shutdown('test over')
  })
  await client.hello()
  const save = async () => {
    await project.config.save()
    await project.reloadSettings()
    return host.refreshAfterConfigChange({ rebuild: true, scope: 'models' })
  }
  const configure = async () => {
    project.config.setModelConfig('first', { provider: 'anthropic', model: 'first-model', apiKey: 'test-key' })
    await save()
  }
  return { project, pane, host, client, store, save, configure }
}

test('an unconfigured protocol session can use commands, switch sessions and later send its saved queue', async (t) => {
  const provider = t.mock.method(AnthropicProvider.prototype, 'createMessage', async () => response)
  const h = await setup(t, true)
  assert.equal(h.client.getRuntimeSnapshot()?.status, 'needs_configuration')
  assert.equal(h.client.getQueuedMessages().length, 1)
  assert.equal(provider.mock.callCount(), 0)

  const effects: CommandEffect[] = []
  h.client.onCommandEffect((effect) => effects.push(effect))
  await h.client.runCommand('/provider')
  await h.client.runCommand('/help')
  assert.ok(effects.some((effect) => effect.kind === 'open-surface' && effect.surface === 'provider-panel'))
  await assert.rejects(() => h.client.submit('keep my draft'), /\/provider/)
  assert.equal(h.client.getSnapshot().isStreaming, false)

  const previousSession = h.client.getSession()!.id
  await h.client.createSession()
  assert.notEqual(h.client.getSession()!.id, previousSession)
  assert.equal(h.client.getRuntimeSnapshot()?.status, 'needs_configuration')
  assert.equal(h.client.getQueuedMessages().length, 1, 'switching preserves the queued prompt')

  await h.configure()
  await until(() => turnRequests(provider) === 1 && !h.client.getSnapshot().isStreaming)
  assert.equal(h.client.getQueuedMessages().length, 0)
  const records = await h.store.loadRecords(h.pane.getSession().id)
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === response.content))
  assert.equal(h.client.getRuntimeSnapshot()?.status, 'ready')
})

test('a message enqueued mid-turn is steered into that turn at its next step', async (t) => {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const turnRequests: ModelRequest[] = []
  t.mock.method(AnthropicProvider.prototype, 'createMessage', async (request: ModelRequest) => {
    // Side requests (session title, tool-use summary) are not the turn's own.
    if (!request.cacheSource?.startsWith('agent:')) return { content: 'Side', toolCalls: [] }
    turnRequests.push(request)
    if (turnRequests.length > 1) return response
    started()
    await released
    return { content: '', toolCalls: [{ id: 'glob-1', name: 'Glob', input: { pattern: '*.none' } }] }
  })
  const h = await setup(t)
  await h.configure()
  const turn = h.client.submit('look for files')
  await entered
  await h.client.enqueueMessage('only in src')
  release()
  await turn

  assert.equal(turnRequests.length, 2)
  assert.ok(JSON.stringify(turnRequests[1]!.messages).includes('only in src'))
  assert.equal(h.client.getQueuedMessages().length, 0)
  const records = await h.store.loadRecords(h.pane.getSession().id)
  const users = records.filter((record) => record.type === 'message' && record.role === 'user')
  assert.deepEqual(users.map((record) => record.type === 'message' && record.content), ['look for files', 'only in src'])
  assert.equal(new Set(users.map((record) => record.type === 'message' && record.turnId)).size, 1)
})

test('configuration refresh waits for the running turn and then installs the updated model', async (t) => {
  let finish!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  t.mock.method(AnthropicProvider.prototype, 'createMessage', async () => {
    started()
    await gate
    return response
  })
  const h = await setup(t)
  await h.configure()
  const current = h.pane.runtimeSlot.requireCurrent()
  const turn = h.client.submit('finish this turn')
  await entered
  try {
    h.project.config.setModelConfig('first', { provider: 'anthropic', model: 'updated-model', apiKey: 'test-key' })
    const result = await h.save()
    assert.equal(result.rebuilt, false)
    assert.equal(h.pane.runtimeSlot.current, current)
  } finally {
    finish()
  }
  await turn
  assert.notEqual(h.pane.runtimeSlot.current, current)
  assert.equal(h.pane.runtimeSlot.requireCurrent().modelConfig.model, 'updated-model')
})
