import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v3'
import { bootstrap, RuntimeStartupError, switchToNewSession } from '../src/runtime/index.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'
import type { McpServerConfig } from '../src/services/mcp/index.js'
import { createSessionPane } from '../src/runtime/sessionWorkspace.js'
import { refreshRuntimeSlot } from '../src/runtime/providerRuntime.js'
import { localSettingsPath } from '../src/config/settings.js'
import { resolveContextWindow, withPricing } from '../src/runtime/createRuntime.js'
import { writeUserInstructions } from '../src/services/context/projectContext.js'

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
    settings: { models: { legacy: { model: 'old-model' } }, defaultModel: 'legacy' },
  })
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

  const runtime = host.createRuntime(host.initialModelKey, session, host.existingRecords)
  assert.equal(runtime.modelKey, 'main')
  assert.equal(runtime.modelConfig.model, 'claude-test')
  assert.equal(runtime.providerName, 'anthropic')
  assert.equal(typeof runtime.run, 'function')

  runtime.dispose()
  await host.shutdown('test over')
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
