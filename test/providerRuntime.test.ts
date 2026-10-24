import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { ConfigService } from '../src/config/service.js'
import { resolveRuntimeSelectionAfterConfigChange } from '../src/runtime/providerRuntime.js'
import type { SessionCoordination } from '../src/sessions/service.js'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

// ConfigService layers a shared `~/.myagent/config.json` under the project one.
// A fresh home per test keeps these off the developer's config and stops a
// save() in one test (which targets the shared layer when no project config
// exists) from leaking models into the next.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

async function createConfig(): Promise<ConfigService> {
  const cwd = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-provider-runtime-'))
  const config = new ConfigService(cwd)
  await config.load()
  config.setModelConfig('fast-a', { provider: 'openai', model: 'fast-a' })
  config.setModelConfig('main-a', { provider: 'openai', model: 'main-a' })
  config.setModelConfig('main-b', { provider: 'anthropic', model: 'main-b' })
  config.setDefaultModel('main-a')
  return config
}

const plain = {}

function coordinated(role: 'coordinator' | 'thread', extra: Partial<SessionCoordination> = {}): {
  coordination: SessionCoordination
} {
  return { coordination: { role, projectKey: 'k', ...extra } }
}

function resolve(
  config: ConfigService,
  currentModelKey: string | undefined,
  scope: 'endpoints' | 'models' | 'routing',
  session: ReturnType<typeof coordinated> | typeof plain = plain,
): string | undefined {
  return resolveRuntimeSelectionAfterConfigChange({
    config,
    currentModelKey,
    scope,
    session,
    defaultEffort: 'high',
  }).modelKey
}

test('endpoint and model config changes keep the current model selected', async () => {
  const config = await createConfig()

  assert.equal(resolve(config, 'fast-a', 'endpoints'), 'fast-a')
  assert.equal(resolve(config, 'fast-a', 'models'), 'fast-a')
})

test('routing config changes immediately re-resolve the main runtime model', async () => {
  const config = await createConfig()
  config.setRouting({ main: 'fast-a' })

  assert.equal(resolve(config, 'main-a', 'routing'), 'fast-a')
})

test('routing back to inherit re-resolves to the model in hand', async () => {
  const config = await createConfig()
  config.setRouting({ main: 'inherit' })

  assert.equal(resolve(config, 'main-b', 'routing'), 'main-b')
})

test('removing the selected model falls back to the configured main model', async () => {
  const config = await createConfig()
  config.setModelConfig('manual', { provider: 'openai', model: 'manual' })
  config.removeModel('manual')

  assert.equal(resolve(config, 'manual', 'models'), 'main-a')
})

// T03: a thread on its own model must not be dragged onto a new main model.
test('a routing refresh leaves a thread that chose its own model alone', async () => {
  const config = await createConfig()
  config.setRouting({ main: 'main-b' })

  assert.equal(resolve(config, 'fast-a', 'routing', coordinated('thread', { modelOverride: 'fast-a' })), 'fast-a')
})

// T03: a thread following the global thread model ignores a main-model edit.
test('a routing refresh keeps a thread on the global thread model', async () => {
  const config = await createConfig()
  config.setCoordinationRouting('thread', 'fast-a')
  config.setRouting({ ...config.getRouting(), main: 'main-b' })

  assert.equal(resolve(config, 'fast-a', 'routing', coordinated('thread')), 'fast-a')
})

test('a main-model edit still moves an inheriting thread', async () => {
  const config = await createConfig()
  config.setCoordinationRouting('thread', 'inherit')
  config.setRouting({ main: 'fast-a' })

  assert.equal(resolve(config, 'main-a', 'routing', coordinated('thread')), 'fast-a')
})

test('a deleted model the thread explicitly picked is reported, not replaced', async () => {
  const config = await createConfig()
  config.setModelConfig('picked', { provider: 'openai', model: 'picked' })
  config.removeModel('picked')

  const selection = resolveRuntimeSelectionAfterConfigChange({
    config,
    currentModelKey: 'picked',
    scope: 'routing',
    session: coordinated('thread', { modelOverride: 'picked' }),
    defaultEffort: 'high',
  })
  assert.equal(selection.modelKey, undefined)
  assert.equal(selection.issue?.code, 'unknown_model')
  assert.match(selection.issue?.message ?? '', /picked/)
})

test('a broken role reference is reported instead of silently inheriting', async () => {
  const config = await createConfig()
  config.setCoordinationRouting('coordinator', 'ghost', { allowUnknown: true })

  const selection = resolveRuntimeSelectionAfterConfigChange({
    config,
    currentModelKey: undefined,
    scope: 'routing',
    session: coordinated('coordinator'),
    defaultEffort: 'high',
  })
  assert.equal(selection.modelKey, undefined)
  assert.match(selection.issue?.message ?? '', /routing\.coordinator/)
})

test('the thread effort overrides the caller default and is clamped to the model', async () => {
  const config = await createConfig()
  config.setModelConfig('narrow', { provider: 'openai', model: 'narrow', supportedEfforts: ['low', 'medium'] })
  config.setCoordinationRouting('thread', 'narrow')
  config.setCoordination({ threadEffort: 'max' })

  const selection = resolveRuntimeSelectionAfterConfigChange({
    config,
    currentModelKey: 'narrow',
    scope: 'routing',
    session: coordinated('thread'),
    defaultEffort: 'high',
  })
  assert.equal(selection.effort, 'medium')
  // The global preference is untouched by the clamp.
  assert.equal(config.getCoordination().threadEffort, 'max')
})

test('a session effort override wins over the role setting', async () => {
  const config = await createConfig()
  config.setCoordination({ threadEffort: 'low' })

  const selection = resolveRuntimeSelectionAfterConfigChange({
    config,
    currentModelKey: 'main-a',
    scope: 'routing',
    session: coordinated('thread', { effortOverride: 'xhigh' }),
    defaultEffort: 'high',
  })
  assert.equal(selection.effort, 'xhigh')
})