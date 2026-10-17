import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { ConfigService, carryJsonOnlyModelFields, type ModelConfig } from '../src/config/service.js'
import {
  loadMergedSettings,
  localSettingsPath,
  trustMcpServerLocally,
  validateSettings,
} from '../src/config/settings.js'
import { loadMcpConfig } from '../src/services/mcp/config.js'
import {
  AnthropicProvider,
  OpenAIProvider,
  ProviderRegistry,
  buildAnthropicMessages,
  buildAnthropicPayload,
  buildAnthropicTools,
  getAnthropicBetaHeaders,
  collectCacheControlTelemetry,
  enforceAnthropicCacheControlLimit,
  assertAnthropicCacheControlLimit,
  buildOpenAIMessages,
  buildOpenAIPayload,
  buildOpenAIPromptCacheKey,
  buildOpenAITools,
  createProvider,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  providerSupportsImageInput,
  resolveImageCapability,
} from '../src/config/providers.js'
import { cacheHitRate, promptTokens } from '../src/harness/usage.js'
import { getAllTools, getBuiltinTools } from '../src/tools/index.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { resetCacheTTLEvaluation, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/harness/cacheControl.js'
import type { ModelRequest } from '../src/harness/types.js'
import { tmpdir } from 'node:os'
import { mkdtempSync, existsSync } from 'node:fs'

// `config.json` is global-only: one `~/.myagent/config.json` for every project.
// A fresh home per test keeps these off the developer's own config and stops a
// save() in one test from leaking models into the next.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

function countCacheControlMarkers(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControlMarkers(item), 0)
  }
  if (typeof value !== 'object' || value === null) return 0
  const record = value as Record<string, unknown>
  return (Object.hasOwn(record, 'cache_control') ? 1 : 0)
    + Object.values(record).reduce<number>((sum, item) => sum + countCacheControlMarkers(item), 0)
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key as keyof typeof process.env]
  } else {
    process.env[key] = value
  }
}

test('ConfigService loads defaults and saves config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    const config = service.get()
    assert.ok(config.models)
    assert.ok(config.agent)
    assert.deepEqual(config.models, {})
    assert.equal(config.defaultModel, undefined)
    assert.equal(config.fallbackModel, undefined)
    assert.equal(config.compactModel, undefined)

    service.addModel('test', { provider: 'anthropic', model: 'test-model' })
    assert.ok(service.getModel('test'))
    assert.equal(service.getModel('test')?.model, 'test-model')

    service.setDefaultModel('test')
    assert.equal(service.getDefaultModel()?.model, 'test-model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService persists endpoint caching defaults and model overrides', async () => {
  const service = new ConfigService(process.cwd())
  service.setEndpoint('proxy', { provider: 'anthropic', baseUrl: 'https://proxy.example/v1', promptCaching: 'off' })
  service.addModel('inherited', { model: 'claude-sonnet', endpoint: 'proxy' })
  service.addModel('override', { model: 'claude-opus', endpoint: 'proxy', promptCaching: 'auto' })
  await service.save()

  const reloaded = new ConfigService(process.cwd())
  await reloaded.load()
  assert.equal(reloaded.resolveModel('inherited')?.promptCaching, 'off')
  assert.equal(reloaded.resolveModel('override')?.promptCaching, 'auto')
})

test('a hand-written endpoint thinkingFormat reaches the resolved model', () => {
  const service = new ConfigService(process.cwd())
  service.setEndpoint('relay', { provider: 'openai', baseUrl: 'https://relay.example/v1', thinkingFormat: 'deepseek' })
  service.addModel('r1', { model: 'deepseek-v4', endpoint: 'relay' })
  assert.equal(service.resolveModel('r1')?.thinkingFormat, 'deepseek')
})

test('ConfigService loads fallbackModel config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    service.addModel('small', { provider: 'anthropic', model: 'claude-small' })
    service.get().fallbackModel = 'small'
    await service.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    const config = reloaded.get()
    assert.equal(config.fallbackModel, 'small')
    assert.equal(reloaded.getFallbackModel()?.model, 'claude-small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService loads compactModel config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    service.addModel('small', { provider: 'anthropic', model: 'claude-small' })
    service.get().compactModel = 'small'
    await service.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    const config = reloaded.get()
    assert.equal(config.compactModel, 'small')
    assert.equal(reloaded.getCompactModel()?.model, 'claude-small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService accepts model pricing config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    service.addModel('priced', {
      provider: 'openai',
      model: 'gpt-test',
      pricing: {
        cacheReadInputPerMillionTokens: 0.1,
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        currency: 'USD',
      },
    })

    assert.deepEqual(service.getModel('priced')?.pricing, {
      cacheReadInputPerMillionTokens: 0.1,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      currency: 'USD',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService loads model and agent defaults from merged settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load({
      models: {
        local: {
          provider: 'openai',
          model: 'gpt-local',
          baseUrl: 'https://example.test/v1',
        },
      },
      defaultModel: 'local',
      fallbackModel: 'local',
      compactModel: 'local',
      agent: {
        system: 'settings system',
        contextManagement: {
          contextWindow: 12345,
        },
      },
    })

    const config = service.get()
    assert.equal(config.defaultModel, 'local')
    assert.equal(config.fallbackModel, 'local')
    assert.equal(config.compactModel, 'local')
    assert.deepEqual(Object.keys(config.models), ['local'])
    assert.equal(config.models.local?.model, 'gpt-local')
    assert.equal(config.agent.system, 'settings system')
    assert.equal(config.agent.contextManagement?.contextWindow, 12345)
    assert.equal(config.agent.contextManagement?.summaryOutputTokens, 20_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService gives config.json priority over settings config fields', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(process.env.USERPROFILE!, '.myagent'), { recursive: true })
    await writeFile(path.join(process.env.USERPROFILE!, '.myagent', 'config.json'), JSON.stringify({
      models: {
        configModel: {
          provider: 'anthropic',
          model: 'claude-config',
        },
      },
      defaultModel: 'configModel',
      fallbackModel: 'settingsModel',
      compactModel: 'settingsModel',
      agent: {
        system: 'config system',
        contextManagement: {
          contextWindow: 999,
        },
      },
    }), 'utf8')

    const service = new ConfigService(dir)
    await service.load({
      models: {
        settingsModel: {
          provider: 'openai',
          model: 'gpt-settings',
        },
      },
      defaultModel: 'settingsModel',
      fallbackModel: 'settingsModel',
      compactModel: 'settingsModel',
      agent: {
        system: 'settings system',
        contextManagement: {
          contextWindow: 12345,
          summaryOutputTokens: 111,
        },
      },
    })

    const config = service.get()
    assert.equal(config.defaultModel, 'configModel')
    assert.equal(config.fallbackModel, 'settingsModel')
    assert.equal(config.compactModel, 'settingsModel')
    assert.equal(config.models.settingsModel?.model, 'gpt-settings')
    assert.equal(config.models.configModel?.model, 'claude-config')
    assert.deepEqual(Object.keys(config.models).sort(), ['configModel', 'settingsModel'])
    assert.equal(config.agent.system, 'config system')
    assert.equal(config.agent.contextManagement?.contextWindow, 999)
    assert.equal(config.agent.contextManagement?.summaryOutputTokens, 111)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService reads the global config layer from any working directory', async () => {
  const home = process.env.USERPROFILE!
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(home, '.myagent'), { recursive: true })
    await writeFile(path.join(home, '.myagent', 'config.json'), JSON.stringify({
      models: { globalModel: { provider: 'anthropic', model: 'claude-global' } },
      defaultModel: 'globalModel',
    }), 'utf8')

    // No project config.json in `dir` at all.
    const service = new ConfigService(dir)
    await service.load()

    assert.equal(service.get().defaultModel, 'globalModel')
    assert.equal(service.getDefaultModel()?.model, 'claude-global')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService does not read a project config.json — there is no project layer', async () => {
  const home = process.env.USERPROFILE!
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(home, '.myagent'), { recursive: true })
    await writeFile(path.join(home, '.myagent', 'config.json'), JSON.stringify({
      models: { globalModel: { provider: 'anthropic', model: 'claude-global' } },
      defaultModel: 'globalModel',
    }), 'utf8')
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'config.json'), JSON.stringify({
      models: { projectModel: { provider: 'anthropic', model: 'claude-project' } },
      defaultModel: 'projectModel',
    }), 'utf8')

    const service = new ConfigService(dir)
    await service.load()

    // The file is still on disk; `bootstrap` migrates it once (see
    // `configMigration.test.ts`). The service itself never looks at it.
    const config = service.get()
    assert.equal(config.defaultModel, 'globalModel')
    assert.deepEqual(Object.keys(config.models), ['globalModel'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService always saves to the global layer, project file or not', async () => {
  const home = process.env.USERPROFILE!
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const globalPath = path.join(home, '.myagent', 'config.json')
    const projectPath = path.join(dir, '.myagent', 'config.json')

    // Writes go to the one shared file rather than scattering API keys into
    // every directory the agent is launched from.
    const service = new ConfigService(dir)
    await service.load()
    service.addModel('added', { provider: 'anthropic', model: 'claude-added' })
    assert.equal(service.getSaveTarget(), globalPath)
    await service.save()
    assert.equal(existsSync(projectPath), false)
    assert.equal(JSON.parse(await readFile(globalPath, 'utf8')).models.added.model, 'claude-added')

    // A project file left over from the layered era does not take the write
    // back: that is what made one repo's `config.json` own the user's keys.
    await mkdir(path.dirname(projectPath), { recursive: true })
    await writeFile(projectPath, JSON.stringify({ models: {} }), 'utf8')
    const scoped = new ConfigService(dir)
    await scoped.load()
    assert.equal(scoped.getSaveTarget(), globalPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService ignores legacy conversation snip context settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(process.env.USERPROFILE!, '.myagent'), { recursive: true })
    await writeFile(path.join(process.env.USERPROFILE!, '.myagent', 'config.json'), JSON.stringify({
      models: {},
      agent: {
        contextManagement: {
          contextWindow: 12345,
          snipThresholdRatio: 0.8,
          snipHeadTurns: 2,
          snipTailTurns: 3,
          snipMaxTurns: 6,
        },
      },
    }), 'utf8')

    const service = new ConfigService(dir)
    await service.load({
      agent: {
        contextManagement: {
          snipThresholdRatio: 1,
        } as never,
      },
    })

    const contextManagement = service.get().agent.contextManagement as Record<string, unknown>
    assert.equal(contextManagement.contextWindow, 12345)
    assert.equal(contextManagement.snipThresholdRatio, undefined)
    assert.equal(contextManagement.snipHeadTurns, undefined)
    assert.equal(contextManagement.snipTailTurns, undefined)
    assert.equal(contextManagement.snipMaxTurns, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService does not inject built-in Anthropic model when models are configured', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(process.env.USERPROFILE!, '.myagent'), { recursive: true })
    const configPath = path.join(process.env.USERPROFILE!, '.myagent', 'config.json')
    await writeFile(configPath, JSON.stringify({
      models: {
        local: {
          provider: 'openai',
          model: 'gpt-local',
        },
      },
      defaultModel: 'local',
    }), 'utf8')

    const service = new ConfigService(dir)
    await service.load()

    assert.deepEqual(Object.keys(service.get().models), ['local'])
    assert.equal(service.get().models.anthropic, undefined)

    await service.save()
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as { models?: Record<string, unknown> }
    assert.deepEqual(Object.keys(saved.models ?? {}), ['local'])
    assert.equal(saved.models?.anthropic, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService renameModel moves config and cascades references', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    service.addModel('old-name', { provider: 'anthropic', model: 'claude-x' })
    service.setModelConfig('old-name', { provider: 'anthropic', model: 'claude-x' })
    service.get().defaultModel = 'old-name'
    service.get().fallbackModel = 'old-name'
    service.get().compactModel = 'old-name'
    service.setRouting({ plan: 'old-name', subagent: { explore: 'old-name' } })

    service.renameModel('old-name', 'new-name')

    const cfg = service.get()
    assert.equal(cfg.models['old-name'], undefined)
    assert.equal(cfg.models['new-name']?.model, 'claude-x')
    assert.equal(cfg.defaultModel, 'new-name')
    assert.equal(cfg.fallbackModel, 'new-name')
    assert.equal(cfg.compactModel, 'new-name')
    assert.equal(cfg.routing?.plan, 'new-name')
    assert.equal(cfg.routing?.subagent?.explore, 'new-name')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService renameEndpoint carries its models over instead of dropping them', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    service.setEndpoint('old', { provider: 'anthropic', baseUrl: 'https://api.example' })
    service.setEndpoint('other', { provider: 'anthropic' })
    service.setModelConfig('big', { endpoint: 'old', model: 'claude-x' })
    service.setModelConfig('elsewhere', { endpoint: 'other', model: 'claude-y' })

    service.renameEndpoint('old', 'new')

    const cfg = service.get()
    assert.equal(cfg.endpoints?.old, undefined)
    assert.equal(cfg.endpoints?.new?.baseUrl, 'https://api.example')
    // The half a remove-plus-add would have lost: `removeEndpoint` deletes the
    // models that resolve through the endpoint it takes away.
    assert.equal(cfg.models.big?.endpoint, 'new')
    assert.equal(cfg.models.elsewhere?.endpoint, 'other')

    assert.throws(() => service.renameEndpoint('missing', 'x'), /not found/)
    assert.throws(() => service.renameEndpoint('new', 'other'), /already exists/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService renameModel throws on missing source or existing target', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    service.addModel('a', { provider: 'anthropic', model: 'm1' })
    service.addModel('b', { provider: 'anthropic', model: 'm2' })

    assert.throws(() => service.renameModel('missing', 'x'), /not found/)
    assert.throws(() => service.renameModel('a', 'b'), /already exists/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService renameModel is no-op when keys are equal', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    service.addModel('same', { provider: 'openai', model: 'gpt' })
    service.renameModel('same', 'same')
    assert.equal(service.get().models['same']?.model, 'gpt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validateSettings accepts hook settings', () => {
  const result = validateSettings({
    hooks: {
      userPromptSubmit: [
        { command: 'node scripts/prompt-context.js', timeoutMs: 1000 },
      ],
      preToolUse: [
        { matcher: 'Bash', command: 'node scripts/lint-bash.js', timeoutMs: 1000 },
      ],
      postToolUse: [
        { matcher: '*', command: 'node scripts/post-tool.js', timeoutMs: 1000 },
      ],
      stop: [
        { command: 'node scripts/notify.js', timeoutMs: 1000 },
      ],
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings accepts model, agent, and cache settings', () => {
  const result = validateSettings({
    models: {
      local: {
        provider: 'openai',
        model: 'gpt-local',
        contextWindow: 1_000_000,
      },
    },
    defaultModel: 'local',
    fallbackModel: 'anthropic',
    compactModel: 'local',
    agent: {
      system: 'custom system',
    },
    cache: {
      ttl1h: true,
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings checks supportsImageInput like other model booleans', () => {
  assert.deepEqual(validateSettings({
    models: {
      vision: { provider: 'anthropic', model: 'claude-vision', supportsImageInput: true },
      off: { provider: 'openai', model: 'gpt-text', supportsImageInput: false },
    },
  }), { valid: true, errors: [] })

  const result = validateSettings({
    models: {
      broken: { provider: 'anthropic', model: 'claude-broken', supportsImageInput: 'true' as never },
    },
  })

  assert.equal(result.valid, false)
  assert.deepEqual(result.errors, ['models.broken.supportsImageInput must be a boolean'])
})

test('validateSettings checks the disabled skill list', () => {
  assert.deepEqual(validateSettings({ skills: { disabled: ['demo'] } }).errors, [])
  // Rejected here rather than at the write, because `updateLocalSettings`
  // validates before writing: an unvalidated list would leave the project
  // unable to reload until someone edited the file by hand.
  assert.deepEqual(
    validateSettings({ skills: { disabled: 'demo' } } as never).errors,
    ['skills.disabled must be an array of strings'],
  )
  assert.deepEqual(
    validateSettings({ skills: { disabled: ['  '] } }).errors,
    ['skills.disabled must be an array of non-empty strings'],
  )
})

test('validateSettings rejects a defaultModel that names no configured model', () => {
  // With tiers gone, `defaultModel` can only be a model key, so a name that is
  // not one is a typo rather than a routing shorthand.
  const result = validateSettings({
    models: { local: { provider: 'openai', model: 'gpt-local' } },
    defaultModel: 'balanced',
  })

  assert.equal(result.valid, false)
  assert.deepEqual(result.errors, ['defaultModel "balanced" is not a key in models'])
})

test('validateSettings leaves defaultModel alone when this layer declares no models', () => {
  // `models` may live entirely in `config.json`, which `validateSettings` never
  // sees; checking unconditionally would reject a perfectly good split config.
  const result = validateSettings({ defaultModel: 'lives-in-config-json' })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings rejects malformed model settings', () => {
  const result = validateSettings({
    models: {
      broken: {
        provider: '',
        model: '',
        contextWindow: 0,
      },
    },
    defaultModel: '',
    fallbackModel: '',
    compactModel: '',
    agent: {
      system: 1 as unknown as string,
    },
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /provider/)
  assert.match(result.errors.join('\n'), /model/)
  assert.match(result.errors.join('\n'), /contextWindow/)
  assert.match(result.errors.join('\n'), /defaultModel/)
  assert.match(result.errors.join('\n'), /fallbackModel/)
  assert.match(result.errors.join('\n'), /compactModel/)
  assert.match(result.errors.join('\n'), /agent\.system/)
})

test('validateSettings rejects malformed hook settings', () => {
  const result = validateSettings({
    hooks: {
      userPromptSubmit: 'bad' as unknown as [],
      preToolUse: [
        { matcher: 'Bash', command: '', timeoutMs: 0 },
      ],
      stop: [
        { command: '' },
      ],
    },
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /command/)
  assert.match(result.errors.join('\n'), /timeoutMs/)
  assert.match(result.errors.join('\n'), /userPromptSubmit/)
  assert.match(result.errors.join('\n'), /stop/)
})

test('validateSettings rejects malformed cache settings', () => {
  const result = validateSettings({
    cache: {
      ttl1h: 'yes',
    },
  } as never)

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /cache\.ttl1h/)
})

test('validateSettings ignores legacy permission mode settings', () => {
  const result = validateSettings({
    permissionMode: 'accept-edits',
  } as never)

  assert.equal(result.valid, true)
  assert.doesNotMatch(result.errors.join('\n'), /permissionMode/)
})

test('validateSettings accepts permission rule arrays', () => {
  const result = validateSettings({
    permissions: {
      mode: 'bypass',
      allow: ['Read', 'Bash:*npm test*'],
      deny: ['Delete'],
      ask: ['Write:src/**'],
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings rejects invalid startup permission mode', () => {
  const result = validateSettings({
    permissions: {
      mode: 'plan',
    },
  } as never)

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /permissions\.mode/)

  const unknown = validateSettings({
    permissions: {
      mode: 'accept-edits',
    },
  } as never)

  assert.equal(unknown.valid, false)
  assert.match(unknown.errors.join('\n'), /permissions\.mode/)
})

test('validateSettings rejects malformed permission rule arrays', () => {
  const result = validateSettings({
    permissions: {
      allow: 'Read',
      deny: [''],
      ask: [1],
    },
  } as never)

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /permissions\.allow/)
  assert.match(result.errors.join('\n'), /permissions\.deny/)
  assert.match(result.errors.join('\n'), /permissions\.ask/)
})

test('validateSettings accepts trusted MCP servers and stdio timeout', () => {
  const result = validateSettings({
    mcp: {
      trustedServers: ['filesystem'],
    },
    mcpServers: {
      filesystem: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        timeoutMs: 60_000,
      },
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings rejects malformed MCP trust and args settings', () => {
  const result = validateSettings({
    mcp: {
      trustedServers: [''],
    },
    mcpServers: {
      unsafe: {
        transport: 'stdio',
        command: 'node',
        args: ['ok', 1] as unknown as string[],
        timeoutMs: 0,
      },
    },
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /trustedServers/)
  assert.match(result.errors.join('\n'), /args/)
  assert.match(result.errors.join('\n'), /timeoutMs/)
})

test('trustMcpServerLocally writes only project local settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await trustMcpServerLocally(dir, 'filesystem')
    await trustMcpServerLocally(dir, 'github')
    await trustMcpServerLocally(dir, 'filesystem')

    const content = await readFile(localSettingsPath(dir), 'utf-8')
    const parsed = JSON.parse(content) as { mcp?: { trustedServers?: string[] } }
    assert.deepEqual(parsed.mcp?.trustedServers, ['filesystem', 'github'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings ignores legacy permissionMode from local settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await mkdir(path.dirname(localSettingsPath(dir)), { recursive: true })
    await writeFile(localSettingsPath(dir), JSON.stringify({
      defaultModel: 'local',
      permissionMode: 'plan',
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    assert.equal(settings.defaultModel, 'local')
    assert.equal((settings as { permissionMode?: unknown }).permissionMode, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings merges permission rules and overrides startup mode', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'settings.json'), JSON.stringify({
      permissions: {
        mode: 'bypass',
        allow: ['Read'],
        deny: ['Delete'],
      },
    }), 'utf8')
    await mkdir(path.dirname(localSettingsPath(dir)), { recursive: true })
    await writeFile(localSettingsPath(dir), JSON.stringify({
      permissions: {
        mode: 'bypass',
        allow: ['Grep'],
        ask: ['Write:src/**'],
      },
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    assert.deepEqual(settings.permissions, {
      mode: 'bypass',
      allow: ['Read', 'Grep'],
      deny: ['Delete'],
      ask: ['Write:src/**'],
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings concatenates permissions.additionalDirectories across layers', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'settings.json'), JSON.stringify({
      permissions: { additionalDirectories: ['../shared'] },
    }), 'utf8')
    await mkdir(path.dirname(localSettingsPath(dir)), { recursive: true })
    await writeFile(localSettingsPath(dir), JSON.stringify({
      permissions: { additionalDirectories: ['../scratch'] },
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    assert.deepEqual(settings.permissions?.additionalDirectories, ['../shared', '../scratch'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings folds legacy mcp.json before local settings overrides', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'mcp.json'), JSON.stringify({
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'node',
          args: ['legacy.js'],
        },
        github: {
          transport: 'stdio',
          command: 'node',
          args: ['github.js'],
        },
      },
    }), 'utf8')
    await mkdir(path.dirname(localSettingsPath(dir)), { recursive: true })
    await writeFile(localSettingsPath(dir), JSON.stringify({
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'node',
          args: ['local.js'],
        },
      },
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    const mcpConfig = await loadMcpConfig(dir, settings)
    assert.deepEqual(mcpConfig.filesystem?.args, ['local.js'])
    assert.deepEqual(mcpConfig.github?.args, ['github.js'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ProviderRegistry registers and retrieves providers', () => {
  const registry = new ProviderRegistry()
  assert.ok(!registry.has('test'))
  assert.equal(registry.get('test'), undefined)

  const provider = createProvider({ provider: 'anthropic', model: 'claude-3' })
  if (provider) {
    registry.register(provider)
    assert.ok(registry.has('anthropic'))
    assert.equal(registry.get('anthropic')?.name, 'anthropic')
    assert.deepEqual(registry.list(), ['anthropic'])
  }
})

test('createProvider selects adapter from provider field', () => {
  const anthropic = createProvider({ provider: 'anthropic', model: 'claude-3', apiKey: 'test-key' })
  const openai = createProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' })

  assert.ok(anthropic instanceof AnthropicProvider)
  assert.ok(openai instanceof OpenAIProvider)
})

test('both adapters expose their image-input capability statically and per instance', () => {
  const anthropic = new AnthropicProvider({ provider: 'anthropic', model: 'claude-3', apiKey: 'test-key' })
  const openai = new OpenAIProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' })

  assert.equal(AnthropicProvider.supportsImageInput, true)
  assert.equal(OpenAIProvider.supportsImageInput, true)
  assert.equal(anthropic.supportsImageInput?.(), true)
  assert.equal(openai.supportsImageInput?.(), true)

  assert.equal(providerSupportsImageInput('anthropic'), true)
  assert.equal(providerSupportsImageInput('openai'), true)
  // An unknown or future provider name is incapable, not an error.
  assert.equal(providerSupportsImageInput('made-up'), false)
  assert.equal(providerSupportsImageInput(''), false)
  assert.equal(providerSupportsImageInput(undefined), false)
})

test('resolveImageCapability requires a strict true switch on an implementing adapter', () => {
  // Explicit on.
  assert.equal(resolveImageCapability({ provider: 'anthropic', supportsImageInput: true }), true)
  assert.equal(resolveImageCapability({ provider: 'openai', supportsImageInput: true }), true)

  // Default off: absent and explicit false, on an adapter that implements it —
  // the "switch off but adapter supports" combination.
  assert.equal(resolveImageCapability({ provider: 'anthropic' }), false)
  assert.equal(resolveImageCapability({ provider: 'anthropic', supportsImageInput: false }), false)

  // Only strict `=== true` counts; "true", 1, and any other truthy value are off.
  assert.equal(resolveImageCapability({ provider: 'anthropic', supportsImageInput: 'true' as never }), false)
  assert.equal(resolveImageCapability({ provider: 'anthropic', supportsImageInput: 1 as never }), false)

  // The "switch on but adapter does not implement" combination: a name outside
  // the supported adapters reports false even with the switch on.
  assert.equal(resolveImageCapability({ provider: 'made-up', supportsImageInput: true }), false)
  assert.equal(resolveImageCapability({ supportsImageInput: true }), false)

  // No model at all.
  assert.equal(resolveImageCapability(undefined), false)

  // The endpoint can carry the provider for a model that resolves through one.
  assert.equal(resolveImageCapability({ supportsImageInput: true }, { provider: 'openai' }), true)
  assert.equal(resolveImageCapability({ supportsImageInput: true }, { provider: 'made-up' }), false)
  assert.equal(resolveImageCapability({ supportsImageInput: true }, undefined), false)
  // The model's own provider wins over the endpoint's, like resolveModel's spread.
  assert.equal(
    resolveImageCapability({ provider: 'anthropic', supportsImageInput: true }, { provider: 'made-up' }),
    true,
  )
})

test('ConfigService persists image capability across save, reload, and endpoint resolution', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()
    service.setEndpoint('proxy', { provider: 'openai', baseUrl: 'https://proxy.example/v1' })
    service.addModel('vision', { model: 'gpt-vision', endpoint: 'proxy', supportsImageInput: true })
    service.addModel('text', { model: 'gpt-text', endpoint: 'proxy' })
    await service.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    // Resolving through the endpoint folds provider in without dropping the switch.
    assert.equal(reloaded.resolveModel('vision')?.supportsImageInput, true)
    assert.equal(reloaded.resolveModel('text')?.supportsImageInput, undefined)
    // Effective capability: same endpoint, two models, different answers.
    assert.equal(resolveImageCapability(reloaded.resolveModel('vision')), true)
    assert.equal(resolveImageCapability(reloaded.resolveModel('text')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the image-input switch is form-owned and survives saves and reference repair', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()
    service.addModel('vision', { provider: 'anthropic', model: 'claude-v', supportsImageInput: true })

    // Both model forms own the switch now (S03): they rebuild the config from
    // their fields and send the switch with it, seeded from what they loaded.
    // The carry no longer owns it — otherwise a deliberate switch-off would be
    // overridden by the stale on-disk value on every save.
    const carried = carryJsonOnlyModelFields(
      { provider: 'anthropic', model: 'claude-v' },
      { provider: 'anthropic', model: 'claude-v', supportsImageInput: true },
    )
    assert.equal(carried.supportsImageInput, undefined)

    // The form-shaped save — rebuilt with its own switch, JSON-only fields
    // carried — keeps the declaration and the unrelated edit together.
    const existing = service.getModel('vision')
    const rebuilt: ModelConfig = {
      provider: 'anthropic',
      model: 'claude-v',
      contextWindow: 123_000,
      supportsImageInput: true,
    }
    service.setModelConfig('vision', carryJsonOnlyModelFields(rebuilt, existing))
    assert.equal(service.getModel('vision')?.supportsImageInput, true)
    assert.equal(service.getModel('vision')?.contextWindow, 123_000)

    // An omitted switch is how the form writes "off" — absence, never `false`.
    service.setModelConfig('vision', { provider: 'anthropic', model: 'claude-v' })
    assert.equal(service.getModel('vision')?.supportsImageInput, undefined)

    // Removing an unrelated model repairs references without touching this one.
    service.addModel('vision', { provider: 'anthropic', model: 'claude-v', supportsImageInput: true })
    service.addModel('other', { provider: 'anthropic', model: 'claude-o' })
    service.get().defaultModel = 'other'
    service.removeModel('other')
    assert.equal(service.getModel('vision')?.supportsImageInput, true)
    assert.equal(service.get().defaultModel, 'vision')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('providers report dynamic ToolSearch support conservatively', () => {
  const original = process.env.HANEKAWA_DISABLE_EXPERIMENTAL_BETAS
  try {
    delete process.env.HANEKAWA_DISABLE_EXPERIMENTAL_BETAS
    const nativeAnthropic = new AnthropicProvider({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'test-key' })
    const proxiedAnthropic = new AnthropicProvider({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'test-key', baseUrl: 'https://example.test' })
    const openai = new OpenAIProvider({ provider: 'openai', model: 'gpt-test', apiKey: 'test-key' })

    assert.equal(nativeAnthropic.supportsDynamicToolSearch?.(), true)
    assert.equal(proxiedAnthropic.supportsDynamicToolSearch?.(), false)
    assert.equal(openai.supportsDynamicToolSearch?.(), false)

    // A schemeless baseUrl must not throw out of the constructor, and only the
    // exact official hostname qualifies — not a lookalike that merely contains it.
    const schemeless = new AnthropicProvider({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'test-key', baseUrl: 'proxy.example/v1' })
    const lookalike = new AnthropicProvider({ provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'test-key', baseUrl: 'https://api.anthropic.com.evil.test' })
    assert.equal(schemeless.supportsDynamicToolSearch?.(), false)
    assert.equal(lookalike.supportsDynamicToolSearch?.(), false)

    process.env.HANEKAWA_DISABLE_EXPERIMENTAL_BETAS = '1'
    assert.equal(nativeAnthropic.supportsDynamicToolSearch?.(), false)
  } finally {
    setEnv('HANEKAWA_DISABLE_EXPERIMENTAL_BETAS', original)
  }
})

test('buildAnthropicMessages includes tool use and tool results', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Read',
        input: { filePath: 'a.txt' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        tool: 'Read',
        ok: true,
        content: 'file body',
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.deepEqual(messages[0]?.content, [{
    type: 'text',
    text: 'hello',
  }])
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [{
    type: 'tool_use',
    id: 'call-1',
    name: 'Read',
    input: { filePath: 'a.txt' },
  }])
  assert.equal(messages[2]?.role, 'user')
  assert.deepEqual(messages[2]?.content, [{
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: 'file body',
    is_error: false,
  }])
})

test('buildAnthropicMessages uses a readable placeholder when context is empty', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    messages: [],
    contextItems: [],
  }

  const messages = buildAnthropicMessages(request)
  assert.deepEqual(messages, [{
    role: 'user',
    content: [{
      type: 'text',
      text: '(context truncated - please continue)',
    }],
  }])
})

test('buildAnthropicPayload caches static system and final message text blocks by default', () => {
  resetCacheTTLEvaluation()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    systemBlocks: ['identity text', 'instruction text', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'custom system text'],
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'hello',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'u2',
        role: 'user',
        content: 'latest',
        createdAt: new Date().toISOString(),
      },
    ],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>

  assert.deepEqual(payload.system, [
    {
      type: 'text',
      text: 'identity text\n\ninstruction text',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
    {
      type: 'text',
      text: 'custom system text',
    },
  ])
  assert.deepEqual(payload.messages, [
    {
      role: 'user',
      content: [{
        type: 'text',
        text: 'hello',
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'text',
        text: 'latest',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
    },
  ])
})

test('buildAnthropicPayload can enable 1h cache ttl from runtime settings', () => {
  resetCacheTTLEvaluation()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'latest',
      createdAt: new Date().toISOString(),
    }],
    cacheRuntime: {
      settings: { cache: { ttl1h: true } },
      env: { MYAGENT_PROMPT_CACHE_1H: '0' },
    },
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>
  const system = payload.system as Array<Record<string, unknown>>
  const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>

  assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(messages[0]?.content[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('buildAnthropicPayload caches only the final tool schema', () => {
  resetCacheTTLEvaluation()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
    tools: [
      { name: 'a', description: 'a', inputSchema: z.object({}).strict(), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) },
      { name: 'b', description: 'b', inputSchema: z.object({}).strict(), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) },
    ],
  }

  const payload = buildAnthropicPayload(request) as { tools: Array<Record<string, unknown>> }

  assert.equal(payload.tools[0]?.cache_control, undefined)
  assert.deepEqual(payload.tools[1]?.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('buildAnthropicPayload gates dynamic ToolSearch independently of caching', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-sonnet-4',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
    tools: [
      { name: 'ToolSearch', description: 'search', inputSchema: z.object({ query: z.string() }).strict(), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) },
      { name: 'DeferredTool', description: 'deferred', inputSchema: z.object({}).strict(), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) },
    ],
    hasDeferredTools: true,
    allDeferredToolNames: new Set(['DeferredTool']),
    postCompactDiscoveredNames: new Set(['DeferredTool']),
  }

  const nativePayload = buildAnthropicPayload(request, undefined, { dynamicToolSearch: true }) as unknown as { messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> }
  assert.equal(JSON.stringify(nativePayload.messages).includes('<available-deferred-tools>'), true)
  // The list rides the tail, uncached, so a changed list never moves the history ahead of it.
  assert.match(JSON.stringify(nativePayload.messages.at(-1)), /<available-deferred-tools>/)
  assert.doesNotMatch(JSON.stringify(nativePayload.messages.at(-1)), /cache_control|__myagentTransient/)
  assert.match(JSON.stringify(nativePayload.messages[0]), /hello.*cache_control/)
  assert.equal(nativePayload.tools.find((tool) => tool.name === 'DeferredTool')?.defer_loading, true)
  assert.deepEqual(getAnthropicBetaHeaders(request, { dynamicToolSearch: true }), ['advanced-tool-use-2025-11-20'])

  const thirdPartyPayload = buildAnthropicPayload(request) as unknown as { messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> }
  assert.equal(JSON.stringify(thirdPartyPayload.messages).includes('<available-deferred-tools>'), false)
  assert.equal(thirdPartyPayload.tools.some((tool) => 'defer_loading' in tool), false)
  assert.deepEqual(getAnthropicBetaHeaders(request), [])
  assert.equal(countCacheControlMarkers(thirdPartyPayload), countCacheControlMarkers(nativePayload))
})

test('enforceAnthropicCacheControlLimit removes tool schema markers first', () => {
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [
      { name: 'a', description: 'a', input_schema: {}, cache_control: { type: 'ephemeral' } },
    ],
  }

  enforceAnthropicCacheControlLimit(payload)

  assert.equal(countCacheControlMarkers(payload), 4)
  assert.equal(payload.tools[0]?.cache_control, undefined)
  assert.deepEqual(payload.system[0]?.cache_control, { type: 'ephemeral' })
})

test('collectCacheControlTelemetry reports marker count and distribution', () => {
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [
      { name: 'a', description: 'a', input_schema: {}, cache_control: { type: 'ephemeral' } },
    ],
  }

  assert.deepEqual(collectCacheControlTelemetry(payload), {
    total: 3,
    limit: 4,
    byLocation: {
      system: 1,
      tools: 1,
      messages: 1,
      other: 0,
    },
    paths: [
      'system.0.cache_control',
      'messages.0.content.0.cache_control',
      'tools.0.cache_control',
    ],
  })
})

test('assertAnthropicCacheControlLimit rejects payloads over Anthropic marker limit', () => {
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [
      { name: 'a', description: 'a', input_schema: {}, cache_control: { type: 'ephemeral' } },
    ],
  }

  assert.throws(
    () => assertAnthropicCacheControlLimit(payload),
    /Anthropic payload has 5 cache_control markers; limit is 4/,
  )
})

test('buildAnthropicPayload omits all cache markers when caching is disabled', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    systemBlocks: ['identity text', 'instruction text', 'custom system text'],
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildAnthropicPayload(request, undefined, { promptCaching: false }) as Record<string, unknown>

  assert.deepEqual(payload.system, [{ type: 'text', text: 'identity text\n\ninstruction text\n\ncustom system text' }])
  assert.deepEqual(payload.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
  }])
  assert.ok(!('tool_choice' in payload))
  assert.equal(JSON.stringify(payload).includes('cache_control'), false)
})

test('normalizeAnthropicUsage maps cache and output tokens', () => {
  assert.deepEqual(normalizeAnthropicUsage({
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 300,
    output_tokens: 40,
  }), {
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 20,
    inputTokens: 100,
    outputTokens: 40,
  })
})

test('normalizeAnthropicUsage keeps cache writes out of the input count', () => {
  // Folded into `inputTokens`, a write read as a cache miss in the hit rate and
  // as ordinary input in the cost, which bills writes above the input rate.
  const usage = normalizeAnthropicUsage({
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 300,
    output_tokens: 40,
  })
  assert.equal(usage.inputTokens, 100)
  assert.equal(promptTokens(usage), 420)
  assert.equal(cacheHitRate(usage), 300 / 420)
})

test('normalizeAnthropicUsage falls back to the per-TTL cache_creation breakdown', () => {
  // An endpoint that ships the object but not the scalar must not read as zero
  // writes — that is a context window that shrinks whenever a prefix is cached.
  assert.equal(normalizeAnthropicUsage({
    input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 300 },
    cache_read_input_tokens: 0,
    output_tokens: 5,
  }).cacheCreationInputTokens, 1000)
})

test('normalizeOpenAIUsage reports no cache-write count at all', () => {
  // `prompt_tokens` already covers the whole prompt: absent means "this protocol
  // has no such field", which is not the same answer as zero writes.
  const usage = normalizeOpenAIUsage({
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 400 },
    completion_tokens: 50,
  })
  assert.equal(usage.cacheCreationInputTokens, undefined)
  assert.equal(usage.inputTokens, 600)
  assert.equal(promptTokens(usage), 1000)
})

test('normalizeOpenAIUsage reads each server\'s cache fields and keeps writes out of the input count', () => {
  // OpenAI: reads and writes both sit inside `prompt_tokens`.
  const official = normalizeOpenAIUsage({
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
    completion_tokens: 5,
  })
  assert.deepEqual(official, { inputTokens: 500, cacheCreationInputTokens: 100, cacheReadInputTokens: 400, outputTokens: 5 })
  assert.equal(promptTokens(official), 1000)
  // DeepSeek and Kimi put the read count elsewhere.
  assert.equal(normalizeOpenAIUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 60, completion_tokens: 1 }).cacheReadInputTokens, 60)
  assert.equal(normalizeOpenAIUsage({ prompt_tokens: 100, cached_tokens: 70, completion_tokens: 1 }).cacheReadInputTokens, 70)
})

test('normalizeOpenAIUsage splits cached and uncached prompt tokens', () => {
  assert.deepEqual(normalizeOpenAIUsage({
    prompt_tokens: 500,
    completion_tokens: 60,
    prompt_tokens_details: {
      cached_tokens: 200,
    },
  }), {
    cacheReadInputTokens: 200,
    inputTokens: 300,
    outputTokens: 60,
  })
})

test('buildOpenAIMessages includes tool call history and tool results', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Grep',
        input: { pattern: 'hello' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        tool: 'Grep',
        ok: true,
        content: 'a.txt:1: hello',
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual((messages[1] as { tool_calls: unknown }).tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'Grep',
      arguments: JSON.stringify({ pattern: 'hello' }),
    },
  }])
  assert.equal(messages[2]?.role, 'tool')
  assert.equal((messages[2] as { tool_call_id: string }).tool_call_id, 'call-1')
})

test('buildAnthropicPayload omits tool fields for plain-text requests', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>
  assert.equal(payload.model, 'fake-model')
  assert.ok(Array.isArray(payload.messages))
  assert.ok(!('tools' in payload))
  assert.ok(!('tool_choice' in payload))
  assert.ok(!('system' in payload))
})

test('buildOpenAIPayload omits tools for plain-text requests', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildOpenAIPayload(request, { cacheKey: true }) as Record<string, unknown>
  assert.equal(payload.model, 'fake-model')
  assert.ok(Array.isArray(payload.messages))
  assert.ok(!('tools' in payload))
  assert.equal(JSON.stringify(payload).includes('cache_control'), false)
  assert.equal(typeof payload.prompt_cache_key, 'string')
})

test('buildOpenAIPayload does not inject ToolSearch discovery hints and keeps full tools', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'gpt-test',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
    tools: [
      { name: 'DeferredTool', description: 'deferred', inputSchema: z.object({}).strict(), riskLevel: 'safe', shouldDefer: true, execute: async () => ({ ok: true, content: '' }) },
    ],
    hasDeferredTools: false,
    allDeferredToolNames: new Set(['DeferredTool']),
  }

  const payload = buildOpenAIPayload(request) as {
    messages: Array<{ role: string; content?: string | null }>
    tools: Array<{ function: { name: string } }>
  }

  assert.equal(JSON.stringify(payload.messages).includes('<available-deferred-tools>'), false)
  assert.deepEqual(payload.tools.map((tool) => tool.function.name), ['DeferredTool'])
})

test('buildOpenAIPayload includes Hanekawa system, skills reminder, Skill tool, and cache key', async () => {
  const tools = await getAllTools()
  const builder = new ContextBuilder(undefined, { contextWindow: 50000, summaryOutputTokens: 0 })
  const built = await builder.build({
    records: [{
      type: 'message',
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
    tools,
    skills: [
      { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
    ],
    system: 'custom system',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'gpt-test',
    system: built.system,
    messages: built.messages,
    contextItems: built.contextItems,
    tools,
    promptCacheRetention: '24h',
  }
  const payload = buildOpenAIPayload(request, { cacheKey: true }) as {
    messages: Array<{ role: string; content: string }>
    tools: Array<{ function: { name: string } }>
    prompt_cache_key: string
    prompt_cache_retention?: string
  }

  assert.equal(payload.messages[0]?.role, 'developer')
  assert.match(payload.messages[0]?.content ?? '', /You are Hanekawa/)
  assert.match(payload.messages[0]?.content ?? '', /lyutianjian/)
  assert.match(payload.messages[0]?.content ?? '', /# Doing tasks/)
  assert.match(payload.messages[0]?.content ?? '', /# Using your tools/)
  assert.match(payload.messages[0]?.content ?? '', /custom system/)
  assert.match(payload.messages[0]?.content ?? '', /The following skills are available for use with the Skill tool/)
  assert.match(payload.messages[0]?.content ?? '', /- debugging: Use when diagnosing bugs/)
  assert.ok(payload.tools.some((tool) => tool.function.name === 'Skill'))
  assert.equal(payload.tools.some((tool) => tool.function.name.startsWith('skill_')), false)
  assert.match(payload.prompt_cache_key, /^myagent:[a-f0-9]{32}$/)
  assert.equal(payload.prompt_cache_retention, '24h')
  assert.equal(JSON.stringify(payload).includes('cache_control'), false)
})

test('buildOpenAIPromptCacheKey is stable for model, system, and tools', async () => {
  const tools = await getAllTools()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'gpt-test',
    system: 'system text',
    messages: [],
    tools,
  }

  assert.equal(buildOpenAIPromptCacheKey(request), buildOpenAIPromptCacheKey({ ...request, messages: [] }))
  assert.equal(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, cacheSource: 'agent:other-session' }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, system: 'different system' }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, model: 'gpt-other' }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, tools: [] }),
  )
})

test('buildOpenAIPromptCacheKey ignores dynamic system blocks', async () => {
  const tools = await getAllTools()
  const base: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'gpt-test',
    messages: [],
    tools,
    systemBlocks: ['static identity', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'plan mode reminder'],
  }

  // Toggling plan mode must not reroute the request to a different cache shard.
  assert.equal(
    buildOpenAIPromptCacheKey(base),
    buildOpenAIPromptCacheKey({ ...base, systemBlocks: ['static identity'] }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(base),
    buildOpenAIPromptCacheKey({ ...base, systemBlocks: ['other identity', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'plan mode reminder'] }),
  )
})

test('buildOpenAITools includes concrete schemas for built-in tools', () => {
  const readFileTool = getBuiltinTools().find((tool) => tool.name === 'Read')
  assert.ok(readFileTool)

  const tools = buildOpenAITools([readFileTool])
  assert.equal(tools.length, 1)
  const parameters = tools[0]?.function.parameters as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean; type: string }
  assert.equal(parameters.type, 'object')
  assert.deepEqual(parameters.required, ['filePath'])
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['filePath', 'limit', 'offset'])
  // Parameter descriptions must survive into the API schema: they are the
  // cheapest thing keeping the model from guessing a tool's input shape.
  for (const property of Object.values(parameters.properties)) {
    assert.equal(typeof (property as { description?: unknown }).description, 'string')
  }
})

test('buildAnthropicTools includes concrete schemas for built-in tools', () => {
  const readFileTool = getBuiltinTools().find((tool) => tool.name === 'Read')
  assert.ok(readFileTool)

  const tools = buildAnthropicTools([readFileTool])
  assert.equal(tools.length, 1)
  const schema = tools[0]?.input_schema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean; type: string }
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['filePath'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(Object.keys(schema.properties).sort(), ['filePath', 'limit', 'offset'])
  for (const property of Object.values(schema.properties)) {
    assert.equal(typeof (property as { description?: unknown }).description, 'string')
  }
})

test('buildAnthropicMessages merges assistant text with following tool use', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'read the file',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will read it now.',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Read',
        input: { filePath: 'src/config/providers.ts' },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [
    {
      type: 'text',
      text: 'I will read it now.',
    },
    {
      type: 'tool_use',
      id: 'call-1',
      name: 'Read',
      input: { filePath: 'src/config/providers.ts' },
    },
  ])
})

test('buildOpenAIMessages merges assistant text with following tool call', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'search for hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will search the codebase.',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Grep',
        input: { pattern: 'hello' },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  assert.equal((messages[1] as { content: string }).content, 'I will search the codebase.')
  assert.deepEqual((messages[1] as { tool_calls: unknown }).tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'Grep',
      arguments: JSON.stringify({ pattern: 'hello' }),
    },
  }])
})

test('buildAnthropicPayload uses the flat max_tokens default regardless of model name', () => {
  const build = (model: string) => {
    const request: ModelRequest = {
      cacheSource: 'agent:test',
      model,
      messages: [],
      contextItems: [
        {
          kind: 'message',
          message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
        },
      ],
    }
    return (buildAnthropicPayload(request) as { max_tokens: number }).max_tokens
  }

  assert.equal(build('claude-3-haiku-20240307'), 64_000)
  assert.equal(build('claude-sonnet-4'), 64_000)
  assert.equal(build('glm-5.3'), 64_000)
})

test('buildAnthropicPayload includes thinking parameter when enabled', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
    ],
    thinking: { type: 'enabled', budgetTokens: 5000 },
  }

  const payload = buildAnthropicPayload(request) as { thinking?: unknown; max_tokens: number }
  assert.deepEqual(payload.thinking, { type: 'enabled', budget_tokens: 5000 })
  assert.ok(payload.max_tokens > 5000)
})

test('buildAnthropicPayload defaults to adaptive thinking when not specified', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
    ],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>
  assert.deepEqual(payload.thinking, { type: 'adaptive' })
})

test('buildAnthropicMessages prepends thinking blocks before assistant content', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'solve this', createdAt: new Date().toISOString() },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'The answer is 42.',
          createdAt: new Date().toISOString(),
          thinkingBlocks: [
            { type: 'thinking', thinking: 'Let me think...', signature: 'sig-abc' },
          ],
        },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  const content = messages[1]?.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.type, 'thinking')
  assert.equal(content[0]?.thinking, 'Let me think...')
  assert.equal(content[0]?.signature, 'sig-abc')
  assert.equal(content[1]?.type, 'text')
  assert.equal(content[1]?.text, 'The answer is 42.')
})

test('buildAnthropicMessages preserves thinking blocks when followed by tool_use', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'read it', createdAt: new Date().toISOString() },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          thinkingBlocks: [
            { type: 'thinking', thinking: 'I should read the file', signature: 'sig-xyz' },
          ],
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Read',
        input: { filePath: 'a.txt' },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  const content = messages[1]?.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.type, 'thinking')
  assert.equal(content[1]?.type, 'tool_use')
})

test('buildOpenAIMessages includes reasoning_content on assistant messages', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'deepseek-reasoner',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'Hello!',
          createdAt: new Date().toISOString(),
          reasoningContent: 'The user greeted me, I should greet back.',
        },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 2)
  const assistant = messages[1] as { content: string; reasoning_content?: string }
  assert.equal(assistant.content, 'Hello!')
  assert.equal(assistant.reasoning_content, 'The user greeted me, I should greet back.')
})

test('buildOpenAIMessages omits reasoning_content for user messages', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'deepseek-reasoner',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  const user = messages[0] as { reasoning_content?: string }
  assert.equal(user.reasoning_content, undefined)
})

test('provider payload builders include at-mention context text', () => {
  const atMentionContent = '<system-reminder><file path="src/a.py" lines="1-1">print(1)</file></system-reminder>'
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'test-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'explain @src/a.py',
          createdAt: '2026-06-02T00:00:00.000Z',
        },
      },
      {
        kind: 'message',
        message: {
          id: 'at1',
          role: 'user',
          content: atMentionContent,
          createdAt: '2026-06-02T00:00:01.000Z',
        },
      },
    ],
  }

  const openAiMessages = buildOpenAIMessages(request)
  assert.equal(openAiMessages.some((message) => JSON.stringify(message).includes('src/a.py')), true)
  assert.equal(openAiMessages.some((message) => JSON.stringify(message).includes('print(1)')), true)

  const anthropicMessages = buildAnthropicMessages(request)
  assert.equal(anthropicMessages.some((message) => JSON.stringify(message).includes('src/a.py')), true)
  assert.equal(anthropicMessages.some((message) => JSON.stringify(message).includes('print(1)')), true)
})
