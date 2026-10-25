import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { configTool } from '../src/tools/ConfigTool/ConfigTool.js'
import { ConfigService } from '../src/config/service.js'
import { createModelConfigPort } from '../src/runtime/modelConfigPort.js'

// Config writes are global even when its tool context points at a temp project.
// Isolate every test, including the successful value-coercion cases below.
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
let testHome: string | undefined
beforeEach(async () => {
  testHome = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-home-'))
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
})
afterEach(async () => {
  for (const name of ['HOME', 'USERPROFILE'] as const) {
    if (previousHome[name] === undefined) delete process.env[name]
    else process.env[name] = previousHome[name]
  }
  if (testHome) await rm(testHome, { recursive: true, force: true })
})

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>() }
}

// ── Tool registration ──────────────────────────────────────────────────────────

test('Config tool is registered with correct properties', () => {
  assert.equal(configTool.name, 'Config')
  assert.equal(configTool.riskLevel, 'safe')
  assert.equal(configTool.shouldDefer, true)
  assert.ok(configTool.description.length > 0)
})

// ── List action ────────────────────────────────────────────────────────────────

test('Config list returns all supported settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'list' }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /effortLevel/)
    assert.match(result.content, /autoCompact/)
    assert.match(result.content, /defaultModel/)
    assert.doesNotMatch(result.content, /permissions\.mode/)
    assert.ok(result.metadata?.display?.summary?.includes('settings available'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Get action ─────────────────────────────────────────────────────────────────

test('Config get returns current value for known key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    // The isolated home's merged defaults remain readable.
    const result = await configTool.execute({ action: 'get', key: 'effortLevel' }, context(dir))
    assert.equal(result.ok, true)
    assert.ok(result.content.startsWith('effortLevel:'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config get requires key parameter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'get' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config get rejects unknown key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'get', key: 'nonexistent' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /Unknown setting/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Set action ─────────────────────────────────────────────────────────────────

test('Config set validates enum values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'set', key: 'effortLevel', value: 'invalid' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /must be one of/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set validates boolean type', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'set', key: 'autoCompact', value: 'notabool' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set validates number range for autoCompactThreshold', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const tooHigh = await configTool.execute({ action: 'set', key: 'autoCompactThreshold', value: 1.5 }, context(dir))
    assert.equal(tooHigh.ok, false)
    assert.match(tooHigh.content, /between 0 and 1/)

    const tooLow = await configTool.execute({ action: 'set', key: 'autoCompactThreshold', value: -0.1 }, context(dir))
    assert.equal(tooLow.ok, false)
    assert.match(tooLow.content, /between 0 and 1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set requires value parameter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'set', key: 'effortLevel' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set requires key parameter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'set', value: 'test' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set rejects unknown key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'set', key: 'nonexistent', value: 'test' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set with coerced number string succeeds', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    // autoCompactThreshold accepts numbers — string "0.8" should be coerced
    const result = await configTool.execute({ action: 'set', key: 'autoCompactThreshold', value: '0.8' }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /0\.8/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Atomic write safety ────────────────────────────────────────────────────────

test('Config set writes atomically (tmp + rename)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'myagent-home-'))
  const origUserProfile = process.env.USERPROFILE
  const origHome = process.env.HOME
  try {
    // Point homedir() to our temp directory on Windows
    process.env.USERPROFILE = tmpHome
    process.env.HOME = tmpHome

    const setResult = await configTool.execute({ action: 'set', key: 'effortLevel', value: 'low' }, context(dir))
    assert.equal(setResult.ok, true)

    // Verify the file was created at the temp home
    const settingsPath = path.join(tmpHome, '.myagent', 'settings.json')
    const content = await readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(content)
    assert.equal(parsed.effortLevel, 'low')
  } finally {
    process.env.USERPROFILE = origUserProfile
    process.env.HOME = origHome
    await rm(tmpHome, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config set preserves existing settings in file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'myagent-home-'))
  const origUserProfile = process.env.USERPROFILE
  const origHome = process.env.HOME
  try {
    process.env.USERPROFILE = tmpHome
    process.env.HOME = tmpHome

    // Pre-create settings file with existing values
    await mkdir(path.join(tmpHome, '.myagent'), { recursive: true })
    await writeFile(
      path.join(tmpHome, '.myagent', 'settings.json'),
      JSON.stringify({ defaultModel: 'my-model', effortLevel: 'high' }, null, 2),
      'utf-8',
    )

    // Set a new value
    const setResult = await configTool.execute({ action: 'set', key: 'autoCompact', value: true }, context(dir))
    assert.equal(setResult.ok, true)

    // Verify existing values are preserved
    const settingsPath = path.join(tmpHome, '.myagent', 'settings.json')
    const content = await readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(content)
    assert.equal(parsed.defaultModel, 'my-model')
    assert.equal(parsed.effortLevel, 'high')
    assert.equal(parsed.autoCompact, true)
  } finally {
    process.env.USERPROFILE = origUserProfile
    process.env.HOME = origHome
    await rm(tmpHome, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('Config never replaces corrupted user settings and reports a safe failure for each action', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  const file = path.join(testHome!, '.myagent', 'settings.json')
  const bytes = '{ "apiKey": "fake-secret-do-not-report", broken'
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
    for (const action of ['get', 'list', 'set']) {
      const result = await configTool.execute({ action, key: 'effortLevel', value: 'low' }, context(dir))
      assert.equal(result.ok, false)
      assert.ok(result.content.includes(file))
      assert.doesNotMatch(result.content, /fake-secret-do-not-report/)
      assert.equal(await readFile(file, 'utf8'), bytes)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Unknown action ─────────────────────────────────────────────────────────────

test('Config rejects unknown action', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const result = await configTool.execute({ action: 'unknown' }, context(dir))
    assert.equal(result.ok, false)
    assert.match(result.content, /Unknown action/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Model references live in config.json (B26) ────────────────────────────────
//
// `defaultModel` and friends are owned by `ConfigService`, which outranks the
// settings layers. Writing them to settings.json reported a success that never
// took effect whenever config.json already had a value, so these tests drive the
// tool through the same port the runtime injects.

async function withConfig(models: Record<string, { provider: string; model: string }>, run: (dir: string, config: ConfigService) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-models-'))
  try {
    const configDir = path.join(testHome!, '.myagent')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ defaultModel: 'sonnet', models }),
    )
    const config = new ConfigService(dir)
    await config.load()
    await run(dir, config)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const MODELS = {
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4' },
  haiku: { provider: 'anthropic', model: 'claude-haiku-4' },
  opus: { provider: 'anthropic', model: 'claude-opus-4' },
}

function modelContext(dir: string, config: ConfigService) {
  return { ...context(dir), modelConfig: createModelConfigPort(config) }
}

test('Config get reads model references from config.json', async () => {
  await withConfig(MODELS, async (dir, config) => {
    const result = await configTool.execute({ action: 'get', key: 'defaultModel' }, modelContext(dir, config))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /^defaultModel: "sonnet"$/)

    // The unset ones say so instead of inventing a settings value.
    const fallback = await configTool.execute({ action: 'get', key: 'fallbackModel' }, modelContext(dir, config))
    assert.equal(fallback.ok, true, fallback.content)
    assert.match(fallback.content, /\(not set\)/)
  })
})

test('Config set writes the model reference to config.json, where it takes effect', async () => {
  await withConfig(MODELS, async (dir, config) => {
    const result = await configTool.execute({ action: 'set', key: 'fallbackModel', value: 'haiku' }, modelContext(dir, config))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /Set fallbackModel = "haiku" in config\.json/)
    assert.match(result.content, /current session keeps the model/)

    // Persisted, and effective without a restart: the port reads the same value
    // the runtime uses for `getFallbackModel()`.
    const onDisk = JSON.parse(await readFile(path.join(testHome!, '.myagent', 'config.json'), 'utf-8'))
    assert.equal(onDisk.fallbackModel, 'haiku')
    assert.equal(config.getFallbackModel()?.model, 'claude-haiku-4')

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    assert.equal(reloaded.getFallbackModel()?.model, 'claude-haiku-4')
  })
})

test('Config set refuses an unknown model instead of saving it', async () => {
  await withConfig(MODELS, async (dir, config) => {
    const result = await configTool.execute({ action: 'set', key: 'compactModel', value: 'gpt-nope' }, modelContext(dir, config))
    assert.equal(result.ok, false, result.content)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /Unknown model "gpt-nope" for compactModel/)
    assert.match(result.content, /sonnet, haiku, opus/)

    const onDisk = JSON.parse(await readFile(path.join(testHome!, '.myagent', 'config.json'), 'utf-8'))
    assert.equal(onDisk.compactModel, undefined)
  })
})

test('Config set reports a failed save and leaves the running config unchanged', async () => {
  await withConfig(MODELS, async (dir, config) => {
    // A directory where the config file should be: the atomic write cannot land.
    const configPath = path.join(testHome!, '.myagent', 'config.json')
    await rm(configPath, { force: true })
    await mkdir(configPath, { recursive: true })

    const result = await configTool.execute({ action: 'set', key: 'defaultModel', value: 'opus' }, modelContext(dir, config))
    assert.equal(result.ok, false, result.content)
    assert.equal(result.errorCode, 'execution_failed')
    assert.match(result.content, /Failed to save defaultModel/)
    assert.equal(config.getModelReference('defaultModel'), 'sonnet')
  })
})

test('Config list reports the model reference the config owns', async () => {
  await withConfig(MODELS, async (dir, config) => {
    const result = await configTool.execute({ action: 'list' }, modelContext(dir, config))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /defaultModel[^\n]*\n\s*Current: "sonnet"/)
  })
})

test('a context with no model configuration refuses the write instead of writing settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-models-'))
  try {
    const result = await configTool.execute({ action: 'set', key: 'defaultModel', value: 'anything' }, context(dir))
    assert.equal(result.ok, false, result.content)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /config\.json/)
    // Nothing was silently written to the settings layers.
    const settingsPath = path.join(testHome!, '.myagent', 'settings.json')
    await assert.rejects(readFile(settingsPath, 'utf-8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
