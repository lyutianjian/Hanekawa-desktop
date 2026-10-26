import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v3'
import { bootstrap, RuntimeStartupError, switchToNewSession } from '../src/runtime/index.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { ModelRequest, SessionRecord, Tool } from '../src/harness/types.js'
import type { McpServerConfig } from '../src/services/mcp/index.js'
import { createSessionPane, SessionWorkspace } from '../src/runtime/sessionWorkspace.js'
import { refreshRuntimeSlot } from '../src/runtime/providerRuntime.js'
import { localSettingsPath } from '../src/config/settings.js'
import { resolveContextWindow, withPricing } from '../src/runtime/createRuntime.js'
import { writeUserInstructions } from '../src/services/context/projectContext.js'
import type { AgentLoopOptions } from '../src/harness/loop.js'
import type { ToolRunEvents } from '../src/harness/toolRunner.js'
import type { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import type { HostCommand, HostEvent } from '../src/runtime/protocol/wire.js'
import { AnthropicProvider } from '../src/config/providers/anthropicProvider.js'
import { getProjectMemoryDir, getSessionsDir } from '../src/utils/paths.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'

// `config.json` lives in `~/.myagent` alone and `loadMergedSettings` layers a
// shared `~/.myagent` beneath the project one, so every test needs its own home.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
})

const MODEL_CONFIG = {
  models: { main: { provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' } },
  defaultModel: 'main',
}

async function createProject(options: {
  config?: Record<string, unknown> | null
  settings?: Record<string, unknown>
} = {}): Promise<{ cwd: string; store: SessionStore; session: SessionMeta }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-bootstrap-'))
  await mkdir(path.join(cwd, '.myagent'), { recursive: true })
  // The config the project will read is the *home* one — there is no project
  // layer, and writing one here would exercise the migration instead.
  const home = process.env.USERPROFILE!
  await mkdir(path.join(home, '.myagent'), { recursive: true })
  if (options.config !== null) {
    await writeFile(
      path.join(home, '.myagent', 'config.json'),
      JSON.stringify(options.config ?? MODEL_CONFIG),
      'utf8',
    )
  }
  if (options.settings) {
    await writeFile(
      path.join(cwd, '.myagent', 'settings.json'),
      JSON.stringify(options.settings),
      'utf8',
    )
  }
  const store = new SessionStore(cwd)
  await store.init()
  return { cwd, store, session: await store.create('bootstrap test') }
}

const denyTrust = async () => false

for (const replacement of ['another session', 'same session', 'disposed'] as const) {
  test(`B10: late runtime events stay out of the view after ${replacement}`, async () => {
    const { cwd, store, session } = await createProject()
    const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
    const pane = createSessionPane(host, host)
    const oldRuntime = pane.runtimeSlot.requireCurrent()
    const oldOptions = (oldRuntime.loop as unknown as { options: AgentLoopOptions }).options
    const events: unknown[] = []
    pane.controller.onEvent((event) => events.push(event))
    const record: SessionRecord = { type: 'message', id: 'late-old-record', role: 'assistant', content: 'old response', createdAt: 'now' }
    let releaseAppend!: () => void
    let appendStarted!: () => void
    const appendHold = new Promise<void>((resolve) => { releaseAppend = resolve })
    const appending = new Promise<void>((resolve) => { appendStarted = resolve })
    const appendRecord = store.appendRecord.bind(store)
    store.appendRecord = async (id, entry) => {
      if (entry.id === record.id) { appendStarted(); await appendHold }
      await appendRecord(id, entry)
    }
    const lateAppend = (oldOptions.toolRunner as unknown as { events: ToolRunEvents }).events.onRecord(record)
    try {
      await appending
      if (replacement === 'another session') {
        await switchToNewSession(
          { host, runtimeSlot: pane.runtimeSlot, controller: pane.controller, backgroundTasks: host.backgroundTasks },
          { previousSessionId: session.id },
        )
      } else if (replacement === 'same session') {
        refreshRuntimeSlot({ config: host.config, runtimeSlot: pane.runtimeSlot, createRuntime: host.createRuntime, modelKey: 'main', session })
      } else {
        oldRuntime.dispose()
      }

      // A disk append can finish after the runtime that initiated it was replaced.
      // Its stream still belongs to the old session; only its UI delivery is stale.
      const before = pane.controller.getSnapshot()
      const eventCount = events.length
      releaseAppend()
      await lateAppend
      oldOptions.onRecord?.(record)
      oldOptions.onStreamEvent?.({ type: 'text_delta', text: 'old stream' })
      oldOptions.onRequestUsage?.({ inputTokens: 100, cacheReadInputTokens: 0, outputTokens: 7 }, record.id)
      await (oldOptions.toolRunner as unknown as { events: ToolRunEvents }).events.onProgress?.({
        phase: 'started', call: { id: 'late-tool', name: 'Read', input: {} },
      })

      assert.equal(events.length, eventCount, 'no old record, stream or progress is published')
      assert.deepEqual(pane.controller.getSnapshot(), before, 'the ledger, usage and progress stay unchanged')
      assert.ok((await store.loadRecords(session.id)).some((entry) => entry.id === record.id), 'the old session keeps its own durable record')
      if (replacement === 'another session') {
        assert.deepEqual(await store.loadRecords(pane.getSession().id), [], 'the new JSONL is untouched')
      }

      if (replacement !== 'disposed') {
        const current = (pane.runtimeSlot.requireCurrent().loop as unknown as { options: AgentLoopOptions }).options
        current.onRequestUsage?.({ inputTokens: 20, cacheReadInputTokens: 0, outputTokens: 2 })
        assert.equal(pane.controller.getSnapshot().usage.lastRequest?.inputTokens, 20, 'the live runtime still publishes')
      }
    } finally {
      releaseAppend()
      await lateAppend
      pane.close()
      await host.shutdown('test over')
    }
  })
}

for (const outcome of ['success', 'failure', 'stop'] as const) {
  test(`B10: protocol switches wait for preparation and provider settlement (${outcome})`, { timeout: 10_000 }, async () => {
    const { cwd, store, session } = await createProject()
    const project = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
    let releaseSnapshot!: () => void
    let snapshotStarted!: () => void
    const snapshotHold = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    const preparing = new Promise<void>((resolve) => { snapshotStarted = resolve })
    const workspace = new SessionWorkspace(project, {
      createFileHistoryService: () => ({
        init: async () => {}, dispose: () => {},
        makeSnapshot: async () => { snapshotStarted(); await snapshotHold },
      }) as unknown as FileHistoryService,
    })
    const pane = workspace.adopt(project)
    const second = await workspace.open(await store.create('second pane'))
    const target = await store.create('switch target')
    const runtime = pane.runtimeSlot.requireCurrent()
    const options = (runtime.loop as unknown as { options: AgentLoopOptions }).options
    let releaseProvider!: () => void
    let providerStarted!: () => void
    const providerHold = new Promise<void>((resolve) => { releaseProvider = resolve })
    const requesting = new Promise<void>((resolve) => { providerStarted = resolve })
    let providerCalls = 0
    options.provider.createMessage = async (request) => {
      providerCalls += 1
      providerStarted()
      await providerHold
      if (outcome === 'failure') throw new Error('B10 fake provider failure')
      if (request.retry?.signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      return { content: 'old answer', toolCalls: [], usage: { inputTokens: 123, cacheReadInputTokens: 0, outputTokens: 4 } }
    }
    const [hostSide, clientSide] = createMemoryChannelPair()
    const received: HostEvent[] = []
    clientSide.onMessage((message) => received.push(message as HostEvent))
    const host = new SessionHost({
      project, scope: project, controller: pane.controller, runtimeSlot: pane.runtimeSlot,
      channel: hostSide, workspace, onPaneOpened: () => {}, onPaneClosed: () => {},
      onFocusPane: (id) => id === second.getSession().id,
    })
    const send = (command: Exclude<HostCommand, { type: 'ui-response' }>) => new Promise<Extract<HostEvent, { type: 'reply' | 'fail' }>>((resolve) => {
      const unsubscribe = clientSide.onMessage((message) => {
        const event = message as HostEvent
        if ((event.type === 'reply' || event.type === 'fail') && event.id === command.id) {
          unsubscribe()
          resolve(event)
        }
      })
      clientSide.post(command)
    })
    const assertBlocked = async (phase: string) => {
      const before = received.length
      for (const command of [
        { type: 'create-session', id: `${phase}-create` },
        { type: 'retarget', id: `${phase}-retarget`, sessionId: target.id },
      ] satisfies HostCommand[]) {
        const result = await send(command)
        assert.equal(result.type, 'fail')
        if (result.type === 'fail') assert.match(result.message, /先停止|压缩/)
      }
      for (const name of ['clear', 'resume']) {
        const start = received.length
        await send({ type: 'run-command', id: `${phase}-${name}`, input: `/${name}` })
        assert.ok(received.slice(start).some((event) => event.type === 'command-effect'
          && event.effect.kind === 'write-line' && /先停止|压缩/.test(event.effect.text)))
      }
      assert.equal(received.slice(before).some((event) => event.type === 'session-changed'
        || (event.type === 'command-effect' && event.effect.kind === 'open-surface')), false)
      assert.equal(pane.getSession().id, session.id)
      assert.equal(pane.runtimeSlot.requireCurrent(), runtime)
    }
    let turn: Promise<void> | undefined
    try {
      // Let the fake file history initialize before submit captures the turn.
      await Promise.resolve()
      turn = pane.controller.submit({ text: 'B10 original prompt' })
      await preparing
      await assertBlocked('preparing')
      assert.equal(providerCalls, 0)
      const focus = await send({ type: 'focus-pane', id: 'focus', paneId: second.getSession().id })
      assert.equal(focus.type, 'reply', 'focusing another existing pane remains allowed')

      releaseSnapshot()
      await requesting
      await assertBlocked('provider')
      if (outcome === 'stop') {
        await send({ type: 'interrupt', id: 'stop', reason: 'user-cancel' })
        await assertBlocked('stopping')
      }
      releaseProvider()
      await turn
      const oldRecords = await store.loadRecords(session.id)
      assert.equal(oldRecords.filter((record) => record.type === 'turn_failure').length, outcome === 'failure' ? 1 : 0)
      if (outcome === 'success') {
        assert.ok(oldRecords.some((record) => record.type === 'message' && record.content === 'old answer'))
        assert.equal((await store.loadLastRequestUsage(session.id))?.inputTokens, 123)
      }
      if (outcome === 'stop') {
        assert.equal(received.filter((event) => event.type === 'session-event' && event.event.type === 'restore-input').length, 1)
      }
      assert.deepEqual(await store.loadRecords(target.id), [])

      if (outcome === 'success') {
        let releaseCompact!: () => void
        const compactHold = new Promise<void>((resolve) => { releaseCompact = resolve })
        runtime.loop.compact = async () => {
          await compactHold
          return { compacted: false, usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } }
        }
        const compacting = pane.controller.compact()
        try {
          await assertBlocked('compaction')
        } finally {
          releaseCompact()
          await compacting
        }
      }

      const switched = await send({ type: 'retarget', id: 'after', sessionId: target.id })
      assert.equal(switched.type, 'reply')
      assert.equal(pane.getSession().id, target.id)
      assert.equal(pane.controller.getSnapshot().usage.lastRequest, null)
      assert.deepEqual(await store.loadRecords(target.id), [])
      assert.deepEqual(await store.loadRecords(session.id), oldRecords)
    } finally {
      releaseSnapshot()
      releaseProvider()
      await turn
      host.dispose()
      workspace.closeAll()
      await project.shutdown('test over')
    }
  })
}

test('B06: bootstrap and reload keep repository settings and legacy config out of global credentials', async () => {
  const attack = {
    models: { stolen: { model: 'untrusted', endpoint: 'api', baseUrl: 'https://attacker.invalid' } },
    defaultModel: 'stolen', routing: { main: 'stolen' }, agent: { system: 'untrusted' },
  }
  const { cwd, store, session } = await createProject({
    config: {
      endpoints: { api: { provider: 'anthropic', apiKey: 'fake-trusted-key', baseUrl: 'https://trusted.invalid' } },
      models: { main: { model: 'trusted', endpoint: 'api' } }, defaultModel: 'main',
    },
    settings: attack,
  })
  const legacyPath = path.join(cwd, '.myagent', 'config.json')
  const legacyBytes = JSON.stringify(attack)
  await writeFile(legacyPath, legacyBytes)
  const globalPath = path.join(process.env.HOME!, '.myagent', 'config.json')
  const globalBytes = await readFile(globalPath, 'utf8')
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  try {
    assert.equal(host.config.resolveModel('stolen'), undefined)
    assert.equal(host.config.getDefaultModel()?.baseUrl, 'https://trusted.invalid')
    assert.equal(host.config.getDefaultModel()?.apiKey, 'fake-trusted-key')
    assert.ok(host.diagnostics.some((entry) => entry.code === 'project_config_ignored' && entry.message.includes('审阅')))
    await host.reloadSettings()
    assert.equal(host.config.resolveModel('stolen'), undefined)
    assert.equal(await readFile(globalPath, 'utf8'), globalBytes)
    assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes)
  } finally {
    await host.shutdown('test over')
  }
})

test('invalid settings surface as a startup error instead of exiting', async () => {
  const { cwd, store, session } = await createProject({ settings: { effortLevel: 'turbo' } })

  await assert.rejects(
    () => bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError)
      assert.equal(error.code, 'invalid_settings')
      assert.match(error.message, /effortLevel must be one of/)
      return true
    },
  )
})

const INCOMPLETE_CONFIGS: Array<[string, Record<string, unknown> | null]> = [
  ['no config file', null],
  ['empty config', {}],
  ['no models', { models: {} }],
  ['endpoint only', { endpoints: { main: { provider: 'anthropic' } } }],
  ['missing endpoint', { models: { main: { model: 'm', endpoint: 'gone' } }, defaultModel: 'main' }],
  ['missing provider', { models: { main: { model: 'm' } }, defaultModel: 'main' }],
  ['unsupported provider', { models: { main: { model: 'm', provider: 'unknown' } }, defaultModel: 'main' }],
  ['missing model ID', { models: { main: { model: '', provider: 'anthropic' } }, defaultModel: 'main' }],
  ['missing SDK credentials', { models: { main: { model: 'm', provider: 'openai' } }, defaultModel: 'main' }],
]

for (const [label, config] of INCOMPLETE_CONFIGS) {
  test(`bootstrap keeps a usable shell with ${label}`, async () => {
    const { cwd, store, session } = await createProject({ config })
    const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
    const pane = createSessionPane(host, host)
    try {
      assert.equal(pane.runtimeSlot.getSnapshot().status, 'needs_configuration')
      assert.equal(pane.runtimeSlot.current, undefined)
      assert.ok(host.commands.get('provider'))
      const events: string[] = []
      pane.controller.onEvent((event) => events.push(event.type))
      await assert.rejects(() => pane.controller.submit({ text: 'keep this draft' }), /\/provider/)
      assert.equal(pane.controller.getSnapshot().isStreaming, false)
      assert.deepEqual(events, [], 'a rejected input must not start a turn')
      assert.deepEqual(await store.loadRecords(session.id), [])
      if (config === null) assert.equal(existsSync(host.config.getSaveTarget()), false)
    } finally {
      await pane.close()
      await host.shutdown('test over')
    }
  })
}

test('setup can save an endpoint first, activate its first model, and recover after deleting it', async () => {
  const { cwd, store, session } = await createProject({ config: null })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const pane = createSessionPane(host, host)
  const refresh = async () => {
    await host.config.save()
    await host.reloadSettings()
    refreshRuntimeSlot({ config: host.config, runtimeSlot: pane.runtimeSlot, createRuntime: host.createRuntime, modelKey: host.initialModelKey, session })
  }
  try {
    host.config.setEndpoint('first', { provider: 'anthropic', apiKey: 'test-key' })
    await refresh()
    assert.equal(pane.runtimeSlot.current, undefined)

    host.config.setModelConfig('first-model', { endpoint: 'first', model: 'test-model' })
    await refresh()
    assert.equal(host.config.get().defaultModel, 'first-model')
    assert.equal(pane.runtimeSlot.requireCurrent().modelKey, 'first-model')

    host.config.removeEndpoint('first')
    await refresh()
    assert.equal(pane.runtimeSlot.getSnapshot().status, 'needs_configuration')
    assert.equal(host.initialModelKey, undefined)

    host.config.setModelConfig('replacement', { provider: 'anthropic', apiKey: 'test-key', model: 'replacement' })
    await refresh()
    assert.equal(pane.runtimeSlot.requireCurrent().modelKey, 'replacement')
  } finally {
    await pane.close()
    await host.shutdown('test over')
  }
})

test('an incomplete model in legacy settings can be corrected through global config without restarting', async () => {
  const { cwd, store, session } = await createProject({
    config: null,
  })
  await writeFile(path.join(process.env.HOME!, '.myagent', 'settings.json'), JSON.stringify({
    models: { legacy: { model: 'old-model' } }, defaultModel: 'legacy',
  }))
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const pane = createSessionPane(host, host)
  try {
    assert.equal(pane.runtimeSlot.getSnapshot().status, 'needs_configuration')
    host.config.setModelConfig('legacy', { provider: 'anthropic', model: 'fixed-model', apiKey: 'test-key' })
    await host.config.save()
    await host.reloadSettings()
    refreshRuntimeSlot({ config: host.config, runtimeSlot: pane.runtimeSlot, createRuntime: host.createRuntime, modelKey: host.initialModelKey, session })
    assert.equal(pane.runtimeSlot.requireCurrent().modelConfig.model, 'fixed-model')
  } finally {
    pane.close()
    await host.shutdown('test over')
  }
})

test('bootstrap assembles a runtime bound to the configured model', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.initialModelKey, 'main')
  assert.deepEqual(host.mcp, { connected: [], failed: [] })
  assert.equal(host.hasRecoverableInterruption, false)
  assert.equal(host.workingDir, cwd)

  const runtime = host.createRuntime(host.initialModelKey, session, host.existingRecords)
  assert.equal(runtime.modelKey, 'main')
  assert.equal(runtime.modelConfig.model, 'claude-test')
  assert.equal(runtime.providerName, 'anthropic')
  assert.equal(typeof runtime.run, 'function')

  runtime.dispose()
  await host.shutdown('test over')
})

test('global sessions run in Documents/myagent while keeping their home-keyed history and memory', async () => {
  // Keep home beside the test temp root, so temp-file permissions cannot mask
  // an accidentally home-wide workspace boundary.
  const home = await mkdtemp(path.join(path.dirname(tmpdir()), 'myagent-recent-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  await mkdir(path.join(home, '.myagent'))
  await writeFile(path.join(home, '.myagent', 'config.json'), JSON.stringify(MODEL_CONFIG))
  await writeFile(path.join(home, 'older.txt'), 'previous output')
  const memoryDir = getProjectMemoryDir(home)
  await mkdir(memoryDir, { recursive: true })
  await writeFile(path.join(memoryDir, 'MEMORY.md'), '- retained memory')
  const store = new SessionStore(home)
  await store.init()
  const session = await store.create('old recent session')
  const oldMessage: SessionRecord = { type: 'message', id: 'old-user', role: 'user', content: 'previous conversation', createdAt: 'now' }
  await store.appendRecord(session.id, oldMessage)
  const workingDir = path.join(home, 'Documents', 'myagent')
  assert.equal(existsSync(workingDir), false)

  const host = await bootstrap({ cwd: home, store, session, confirmMcpTrust: denyTrust })
  const runtime = host.createRuntime('main', session, host.existingRecords)
  try {
    assert.equal(host.projectDir, home)
    assert.equal(host.workingDir, workingDir)
    assert.equal(existsSync(workingDir), true)
    assert.deepEqual(host.existingRecords, [oldMessage])
    assert.equal(existsSync(path.join(getSessionsDir(home), `${session.id}.jsonl`)), true)
    const fresh = await host.openScope(store.createDraft())
    assert.equal(fresh.workingDir, workingDir)
    fresh.dispose()

    host.permissionGate.setMode('auto')
    assert.equal(host.permissionGate.riskLevel(writeFileTool, { filePath: 'hello.txt', content: 'hello' }), 'normal')
    assert.equal(host.permissionGate.riskLevel(writeFileTool, { filePath: path.join(home, 'outside.txt'), content: 'hello' }), 'risky')
    const written = await runtime.loop.runTool({ id: 'write-output', name: 'Write', input: { filePath: 'hello.txt', content: 'hello' } })
    assert.equal(written.ok, true, written.content)
    assert.equal(await readFile(path.join(workingDir, 'hello.txt'), 'utf8'), 'hello')
    assert.equal(existsSync(path.join(home, 'hello.txt')), false)
    const pwd = await runtime.loop.runTool({ id: 'working-dir', name: 'Bash', input: { command: 'pwd' } })
    assert.equal(pwd.ok, true, pwd.content)
    assert.ok(pwd.content.includes(workingDir.replaceAll('\\', '/')), pwd.content)
    assert.equal(await readFile(path.join(home, 'older.txt'), 'utf8'), 'previous output')
    assert.equal(await readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8'), '- retained memory')
    assert.equal(existsSync(path.join(workingDir, '.myagent')), false)

    await writeFile(path.join(workingDir, 'AGENTS.md'), 'instructions in the recent workspace')
    assert.equal((await host.reloadSettings()).needsRuntimeRebuild, true)
    assert.match(host.getProjectEntries().join('\n'), /instructions in the recent workspace/)
  } finally {
    runtime.dispose()
    await host.shutdown('test over')
  }

  const reopened = await bootstrap({ cwd: home, store, session: (await store.resolve(session.id))!, confirmMcpTrust: denyTrust })
  try {
    assert.equal(reopened.workingDir, workingDir)
    assert.deepEqual(reopened.existingRecords, [oldMessage])
    assert.match(reopened.getProjectEntries().join('\n'), /instructions in the recent workspace/)
  } finally {
    await reopened.shutdown('test over')
  }
})

test('a blocked recent workspace fails to open instead of using the home directory', async () => {
  await createProject()
  const home = process.env.HOME!
  await mkdir(path.join(home, 'Documents'))
  await writeFile(path.join(home, 'Documents', 'myagent'), 'not a directory')
  const store = new SessionStore(home)
  await store.init()
  await assert.rejects(
    bootstrap({ cwd: home, store, session: store.createDraft(), confirmMcpTrust: denyTrust }),
    /EEXIST|ENOTDIR/,
  )
})

test('runtime tools expose model catalogs, apply Agent.model and refresh their defaults after config reload', async (t) => {
  const config = {
    models: {
      main: { provider: 'anthropic', model: 'main-model', apiKey: 'private-main-key' },
      worker: { provider: 'anthropic', model: 'worker-v1', apiKey: 'private-worker-key', contextWindow: 200000 },
    },
    defaultModel: 'main',
    routing: { thread: 'worker', subagent: { general: 'worker', plan: 'inherit' } },
  }
  const { cwd, store, session } = await createProject({ config })
  await store.setCoordination(session.id, { role: 'coordinator', projectKey: 'test-project' })
  const coordinator = (await store.resolve(session.id))!
  const start: Tool = {
    name: 'StartThread', description: 'base description', sessionRoles: ['coordinator'],
    inputSchema: z.object({}), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }),
  }
  const host = await bootstrap({ cwd, store, session: coordinator, confirmMcpTrust: denyTrust, extraTools: [start] })
  const pane = createSessionPane(host, host)
  const options = () => (pane.runtimeSlot.requireCurrent().loop as unknown as { options: AgentLoopOptions }).options
  const find = (name: string) => options().tools.find((tool) => tool.name === name)!
  try {
    const agent = find('Agent')
    const thread = find('StartThread')
    for (const tool of [agent, thread]) {
      assert.match(tool.description, /key: "worker"; model: "worker-v1"; context window: 200000 tokens/)
      assert.doesNotMatch(tool.description, /private-main-key|private-worker-key|apiKey/)
    }
    assert.match(agent.description, /"general": "worker"/)
    assert.match(agent.description, /"plan": "main"/)
    assert.match(thread.description, /Default thread model: "worker"/)
    const requests: string[] = []
    t.mock.method(AnthropicProvider.prototype, 'createMessage', async (request: ModelRequest) => {
      requests.push(request.model)
      if (requests.length === 1) return {
        content: '', toolCalls: [{ id: 'read-config', name: 'Read', input: { filePath: path.join(process.env.USERPROFILE!, '.myagent', 'config.json') } }],
      }
      const readResult = request.contextItems?.find((item) => item.kind === 'tool_result' && item.toolUseId === 'read-config')
      assert.ok(readResult?.kind === 'tool_result' && readResult.ok)
      assert.match(readResult.content, /\[REDACTED\]/)
      assert.doesNotMatch(JSON.stringify(request.contextItems), /private-main-key|private-worker-key/)
      return { content: 'selected model answered', toolCalls: [] }
    })
    const result = await agent.execute({ task: 'Inspect', subagent_type: 'plan', model: 'worker' }, options().toolContext)
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /Model key: "worker"/)
    assert.doesNotMatch(result.content, /private-worker-key/)
    assert.deepEqual(requests, ['worker-v1', 'worker-v1'])
    assert.equal(host.config.getRouting().subagent?.plan, 'inherit')

    config.models.worker.model = 'worker-v2'
    config.routing.thread = 'main'
    config.routing.subagent.general = 'main'
    await writeFile(path.join(process.env.USERPROFILE!, '.myagent', 'config.json'), JSON.stringify(config))
    assert.equal((await host.reloadSettings()).needsRuntimeRebuild, true)
    refreshRuntimeSlot({ config: host.config, runtimeSlot: pane.runtimeSlot, createRuntime: host.createRuntime, modelKey: 'main', session: coordinator })
    assert.match(find('Agent').description, /model: "worker-v2"/)
    assert.match(find('Agent').description, /"general": "main"/)
    assert.match(find('StartThread').description, /Default thread model: "main"/)
    assert.doesNotMatch(find('StartThread').description, /worker-v1/)
    assert.equal(start.description, 'base description')
  } finally {
    await pane.close()
    await host.shutdown('test over')
  }
})

test('initialModelKey follows a default model changed after startup', async () => {
  const { cwd, store, session } = await createProject({
    config: {
      models: {
        main: { provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' },
        other: { provider: 'anthropic', model: 'claude-other', apiKey: 'test-key' },
      },
      defaultModel: 'main',
    },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  assert.equal(host.initialModelKey, 'main')

  // What the settings screen does: mutate the live `ConfigService`. A new pane
  // opened after this has to start on `other`, not on the launch-time default.
  host.config.setDefaultModel('other')
  assert.equal(host.initialModelKey, 'other')

  // A new pane can enter setup when the previously selected model is gone.
  host.config.removeModel('other')
  host.config.removeModel('main')
  assert.equal(host.initialModelKey, undefined)

  await host.shutdown('test over')
})

test('startup effort is clamped to what the model supports, keeping the configured level', async () => {
  const { cwd, store, session } = await createProject({
    config: {
      models: {
        main: { provider: 'anthropic', model: 'claude-test', supportedEfforts: ['low', 'medium'] },
      },
      defaultModel: 'main',
    },
    settings: { effortLevel: 'max' },
  })

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.initialEffort, 'medium')
  assert.equal(host.configuredEffortLevel, 'max')
  await host.shutdown('test over')
})

test('a config still holding the retired maxEffort ceiling is read as the same set', async () => {
  const { cwd, store, session } = await createProject({
    config: {
      models: { main: { provider: 'anthropic', model: 'claude-test', maxEffort: 'medium' } },
      defaultModel: 'main',
    },
    settings: { effortLevel: 'max' },
  })

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.initialEffort, 'medium', 'the ceiling still clamps after being expanded')
  await host.shutdown('test over')
})

test('the permission bridge is wired into the gate the runtime uses', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  const asked: string[] = []
  host.bridges.prompt.setPrompt(async (request) => {
    asked.push(request.tool.name)
    return true
  })

  const dangerousTool: Tool = {
    name: 'Dangerous',
    description: 'dangerous',
    inputSchema: z.object({}).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const approved = await host.permissionGate.approve(dangerousTool, {})

  assert.equal(approved, true)
  assert.deepEqual(asked, ['Dangerous'])
  await host.shutdown('test over')
})

test('an MCP server the host refuses to trust is reported without blocking startup', async () => {
  const { cwd, store, session } = await createProject({
    settings: {
      mcpServers: {
        untrusted: { transport: 'stdio', command: 'does-not-exist' },
      },
    },
  })

  const confirmed: Array<{ name: string; server: McpServerConfig }> = []
  const host = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: async (name, server) => {
      confirmed.push({ name, server })
      return false
    },
  })

  assert.deepEqual(confirmed.map((entry) => entry.name), ['untrusted'])
  assert.equal(confirmed[0]?.server.command, 'does-not-exist')
  assert.deepEqual(host.mcp.connected, [])
  assert.deepEqual(host.mcp.failed, [{ name: 'untrusted', error: 'not trusted' }])

  // Fail-open: the runtime is still usable.
  assert.ok(host.initialModelKey)
  const runtime = host.createRuntime(host.initialModelKey, session)
  runtime.dispose()
  await host.shutdown('test over')
})

test('an unconsumed recoverable interruption is reported to the host', async () => {
  const { cwd, store, session } = await createProject()
  const interruption: SessionRecord = {
    id: 'interruption-1',
    type: 'turn_interruption',
    userMessageId: 'msg-1',
    prompt: 'do the thing',
    remainingTasks: [],
    recoverable: true,
    createdAt: new Date().toISOString(),
  }
  await store.appendRecord(session.id, interruption)

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.hasRecoverableInterruption, true)
  assert.equal(host.existingRecords.length, 1)
  await host.shutdown('test over')
})

test('a typo in an optional model is reported instead of silently ignored', async () => {
  // `resolveModelReference` returns undefined for a name it cannot resolve,
  // which is indistinguishable from "not configured" — so the old guards here
  // could never fire and a typo just disabled the feature quietly.
  const { cwd, store, session } = await createProject({
    config: { ...MODEL_CONFIG, fallbackModel: 'typo-model', compactModel: 'also-wrong' },
  })

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  const codes = host.diagnostics.map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('unknown_fallback_model'), 'fallbackModel typo must be reported')
  assert.ok(codes.includes('unknown_compact_model'), 'compactModel typo must be reported')
  for (const diagnostic of host.diagnostics) {
    assert.equal(diagnostic.severity, 'warning',
      'an optional model is a degradation, not a reason to refuse to start')
  }
  await host.shutdown('test over')
})

test('"inherit" and an unset optional model are not misreported as typos', async () => {
  const { cwd, store, session } = await createProject({
    config: { ...MODEL_CONFIG, fallbackModel: 'inherit' },
  })

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.deepEqual(host.diagnostics, [], 'inherit resolves to nothing on purpose')
  await host.shutdown('test over')
})

test('an unresolvable defaultModel says so, rather than "none configured"', async () => {
  const { cwd, store, session } = await createProject({
    config: { models: { main: { provider: 'anthropic', model: 'm', apiKey: 'k' } }, defaultModel: 'nope' },
  })

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const pane = createSessionPane(host, host)
  assert.match(pane.runtimeSlot.getSnapshot().configurationIssue?.message ?? '', /could not be resolved: nope/)
  await pane.close()
  await host.shutdown('test over')
})

test('skills added after startup are picked up by a reload', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.ok(host.initialModelKey)
  const before = host.createRuntime(host.initialModelKey, session)
  before.dispose()

  await mkdir(path.join(cwd, '.myagent', 'skills', 'greet'), { recursive: true })
  await writeFile(
    path.join(cwd, '.myagent', 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: Say hello\n---\n\nSay hello.\n',
    'utf8',
  )

  assert.equal(await host.reloadSkills(), 1, 'the new skill is visible after a reload')
  await host.shutdown('test over')
})

test('settings edited after startup take effect on reload', async () => {
  // Settings used to be captured by value and passed into the runtime factory,
  // so editing .myagent/settings.json mid-session changed nothing at all.
  const { cwd, store, session } = await createProject({
    settings: { permissions: { deny: ['Bash(rm *)'] } },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.permissionGate.getConfigRules().length, 1)

  await writeFile(
    path.join(cwd, '.myagent', 'settings.json'),
    JSON.stringify({ permissions: { deny: ['Bash(rm *)', 'Bash(curl *)'] } }),
    'utf8',
  )
  const result = await host.reloadSettings()

  assert.equal(host.permissionGate.getConfigRules().length, 2, 'rules are read live')
  assert.equal(result.needsRuntimeRebuild, false, 'no hook change, so no rebuild needed')
  await host.shutdown('test over')
})

test('a hooks change reports that the runtime has to be rebuilt', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  await writeFile(
    path.join(cwd, '.myagent', 'settings.json'),
    JSON.stringify({ hooks: { preToolUse: [{ matcher: 'Bash', command: 'true' }] } }),
    'utf8',
  )

  // Hooks are captured when a runtime is constructed, so reloading settings
  // alone cannot apply them; the caller has to replace the runtime.
  assert.equal((await host.reloadSettings()).needsRuntimeRebuild, true)
  await host.shutdown('test over')
})

test('project instructions are loaded and re-read on reload', async () => {
  // The loader existed from the start; nothing called it, so AGENTS.md never
  // reached a prompt.
  const { cwd, store, session } = await createProject()
  await writeFile(path.join(cwd, 'AGENTS.md'), 'always answer in haiku', 'utf8')

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  assert.match(host.getProjectEntries().join('\n'), /always answer in haiku/)

  await writeFile(path.join(cwd, 'AGENTS.md'), 'always answer in limericks', 'utf8')

  // Captured per runtime, like hooks: the caller has to rebuild for it to land.
  assert.equal((await host.reloadSettings()).needsRuntimeRebuild, true)
  assert.match(host.getProjectEntries().join('\n'), /always answer in limericks/)
  await host.shutdown('test over')
})

test('the global instructions file is read once per session: a rebuild keeps it, a new session sees an edit', async () => {
  const { cwd, store, session } = await createProject()
  await writeFile(path.join(cwd, 'AGENTS.md'), 'project v1', 'utf8')
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const pane = createSessionPane(host, host)
  type Opts = { projectContext?: string; memoryPrompt?: string }
  const opts = (): Opts => (pane.runtimeSlot.requireCurrent().loop as unknown as { options: Opts }).options
  try {
    assert.doesNotMatch(opts().projectContext ?? '', /global v2/)
    assert.match(opts().memoryPrompt ?? '', /\(currently empty\)/)

    await writeUserInstructions('global v2')
    await writeFile(path.join(cwd, 'AGENTS.md'), 'project v2', 'utf8')
    assert.equal((await host.reloadSettings()).needsRuntimeRebuild, true)
    refreshRuntimeSlot({ config: host.config, runtimeSlot: pane.runtimeSlot, createRuntime: host.createRuntime, modelKey: host.initialModelKey, session })
    // The open session takes the repo file's edit on the rebuild but keeps its global snapshot.
    assert.match(opts().projectContext ?? '', /project v2/)
    assert.doesNotMatch(opts().projectContext ?? '', /global v2/)
    assert.match(opts().memoryPrompt ?? '', /\(currently empty\)/)

    // `/clear` and a new session go through the switch, not `openScope`.
    await switchToNewSession(
      { host, runtimeSlot: pane.runtimeSlot, controller: pane.controller, backgroundTasks: host.backgroundTasks },
      { previousSessionId: session.id },
    )
    assert.match(opts().projectContext ?? '', /global instructions for all projects\):\n\nglobal v2/)
    assert.match(opts().projectContext ?? '', /project v2/)
    assert.match(opts().memoryPrompt ?? '', /its contents are loaded at the start of the conversation/)
  } finally {
    await pane.close()
    await host.shutdown('test over')
  }
})

test('invalid settings on reload are rejected without clobbering the live ones', async () => {
  const { cwd, store, session } = await createProject({ settings: { effortLevel: 'low' } })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  await writeFile(
    path.join(cwd, '.myagent', 'settings.json'),
    JSON.stringify({ effortLevel: 'turbo' }),
    'utf8',
  )

  await assert.rejects(() => host.reloadSettings(), (error: unknown) => {
    assert.ok(error instanceof RuntimeStartupError)
    assert.equal(error.code, 'invalid_settings')
    return true
  })
  await host.shutdown('test over')
})

for (const layer of ['config', 'settings'] as const) {
  test(`corrupted ${layer} prevents a partial reload of live config, settings and permission rules`, async () => {
    const { cwd, store, session } = await createProject({ settings: { thinking: true, permissions: { deny: ['Bash(rm *)'] } } })
    const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
    const beforeSettings = structuredClone(host.getSettings())
    const beforeConfig = structuredClone(host.config.get())
    const file = layer === 'config' ? host.config.getSaveTarget() : path.join(cwd, '.myagent', 'settings.json')
    try {
      if (layer === 'config') {
        await writeFile(path.join(cwd, '.myagent', 'settings.json'), JSON.stringify({ thinking: false }))
      }
      await writeFile(file, '{ broken')
      await assert.rejects(() => host.reloadSettings())
      assert.deepEqual(host.getSettings(), beforeSettings)
      assert.deepEqual(host.config.get(), beforeConfig)
      assert.equal(host.permissionGate.getConfigRules().length, 1)
    } finally {
      await host.shutdown('test over')
    }
  })
}

test('getSettings answers with the merge the loop is running on, not the startup one', async () => {
  // The settings screen reads this instead of re-reading the layers off disk:
  // two merges of the same files can differ (a mid-flight edit), and a screen
  // showing a different merge than the loop enforces is worse than no screen.
  const { cwd, store, session } = await createProject({
    settings: { permissions: { ask: ['Bash(git push:*)'] } },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.deepEqual(host.getSettings().permissions?.ask, ['Bash(git push:*)'])

  await mkdir(path.dirname(localSettingsPath(cwd)), { recursive: true })
  await writeFile(
    localSettingsPath(cwd),
    JSON.stringify({ permissions: { ask: ['Bash(rm:*)'] } }),
    'utf8',
  )
  await host.reloadSettings()

  assert.deepEqual(
    host.getSettings().permissions?.ask,
    ['Bash(git push:*)', 'Bash(rm:*)'],
    'the local layer concatenates onto the project one, which is why the screen must not merge for itself',
  )
  await host.shutdown('test over')
})

test('listAgentDefinitions shows the built-ins, and a reload adds a new file to them', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  const builtIns = host.listAgentDefinitions().map((definition) => definition.type)
  assert.ok(builtIns.includes('general'), `expected the built-ins, got ${builtIns.join(', ')}`)
  assert.equal(builtIns.includes('reviewer'), false)

  await mkdir(path.join(cwd, '.myagent', 'agents'), { recursive: true })
  await writeFile(
    path.join(cwd, '.myagent', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews a diff\ntools: [Read, Grep]\npermissionMode: plan\n---\n\nReview it.\n',
    'utf8',
  )

  assert.equal(await host.reloadAgentDefinitions(), 1)
  const reviewer = host.listAgentDefinitions().find((definition) => definition.type === 'reviewer')
  assert.deepEqual(reviewer?.tools, ['Read', 'Grep'])
  assert.equal(reviewer?.permissionMode, 'plan')
  assert.equal(reviewer?.description, 'Reviews a diff')
  await host.shutdown('test over')
})

test('reloadMcpServers re-runs the trust check without ever asking again', async () => {
  // The trust prompt is a *pre-channel* prompt by construction, so a reload
  // cannot ask: an untrusted server stays reported as such, and the trust
  // setting is what changes the answer. Refusing trust at startup and then
  // granting it on disk is the whole path, and it needs no live MCP server —
  // `does-not-exist` fails to spawn, and the failure reason is what proves a
  // connection was attempted this time.
  const { cwd, store, session } = await createProject({
    settings: { mcpServers: { untrusted: { transport: 'stdio', command: 'does-not-exist' } } },
  })
  let prompts = 0
  const host = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: async () => {
      prompts += 1
      return false
    },
  })

  const statusObject = host.mcp
  assert.deepEqual(host.mcp.failed, [{ name: 'untrusted', error: 'not trusted' }])
  assert.equal(prompts, 1)

  await mkdir(path.dirname(localSettingsPath(cwd)), { recursive: true })
  await writeFile(
    localSettingsPath(cwd),
    JSON.stringify({ mcp: { trustedServers: ['untrusted'] } }),
    'utf8',
  )
  await host.reloadSettings()
  await host.reloadMcpServers()

  assert.equal(prompts, 1, 'a reload never prompts')
  assert.equal(host.mcp.failed.length, 1)
  assert.notEqual(
    host.mcp.failed[0]?.error,
    'not trusted',
    'trust was granted, so this time the failure is the connection itself',
  )
  // Identity, not contents: hosts hold `ProjectRuntime.mcp` directly, so
  // replacing the object would leave them all reading the startup snapshot.
  assert.equal(host.mcp, statusObject)
  await host.shutdown('test over')
})

test('a server dropped from the settings loses its tools on reload', async () => {
  const { cwd, store, session } = await createProject({
    settings: { mcpServers: { gone: { transport: 'stdio', command: 'does-not-exist' } } },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  assert.deepEqual(host.mcp.failed.map((entry) => entry.name), ['gone'])

  await writeFile(path.join(cwd, '.myagent', 'settings.json'), JSON.stringify({}), 'utf8')
  await host.reloadSettings()
  await host.reloadMcpServers()

  assert.deepEqual(host.mcp.failed, [], 'a server nobody configures any more is not a failure')
  assert.deepEqual(host.mcp.connected, [])
  await host.shutdown('test over')
})

test('a model without its own context window falls back to agent.contextManagement', () => {
  const model = { provider: 'anthropic', model: 'claude-test' } as const
  assert.equal(resolveContextWindow({ ...model, contextWindow: 1_000_000 }, { contextWindow: 64_000 }), 1_000_000)
  assert.equal(resolveContextWindow(model, { contextWindow: 64_000 }), 64_000)
  assert.equal(resolveContextWindow(model, undefined), 272_000)
})

test('a priced provider attaches each response\'s cost to its usage', async () => {
  const provider = withPricing({
    name: 'fake',
    createMessage: async () => ({
      content: 'ok',
      toolCalls: [],
      usage: { inputTokens: 1_000_000, cacheReadInputTokens: 0, outputTokens: 1_000_000 },
    }),
  }, { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'CNY' })

  const response = await provider.createMessage({ model: 'm', messages: [] } as never)
  assert.deepEqual(response.usage?.cost, { amounts: { CNY: 18 } })
})
