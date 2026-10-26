import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ConfigService } from '../src/config/service.js'
import {
  DEFAULT_ROUTING,
  mergeRouting,
  pickRoutedModel,
} from '../src/config/routing.js'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

// `config.json` is global-only: one `~/.myagent/config.json` for every project.
// A fresh home per test keeps these off the developer's own config and stops a
// save() in one test from leaking models into the next.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

function tmpDir(): Promise<string> {
  return mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-routing-'))
}

test('selectable model catalog contains only public fields and resolvable keys in config order', async (t) => {
  const dir = await tmpDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeConfig(dir, {
    endpoints: { remote: { provider: 'anthropic', baseUrl: 'https://private.example', apiKey: 'endpoint-secret' } },
    models: {
      worker: { endpoint: 'remote', model: 'worker-model', contextWindow: 200000 },
      missingEndpoint: { endpoint: 'missing', model: 'unavailable' },
      main: { provider: 'anthropic', model: 'main-model', apiKey: 'model-secret' },
      inherit: { provider: 'anthropic', model: 'reserved-key' },
    },
    defaultModel: 'main',
  })
  const config = new ConfigService(dir)
  await config.load()
  assert.deepEqual(config.listSelectableModels(), [
    { key: 'worker', model: 'worker-model', contextWindow: 200000 },
    { key: 'main', model: 'main-model' },
  ])
})

test('general routing reaches built-in types while explicit inherit survives save and reload', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { main: { provider: 'openai', model: 'main' }, small: { provider: 'openai', model: 'small' } },
      defaultModel: 'main', routing: { subagent: { general: 'small', plan: 'inherit' } },
    })
    const service = new ConfigService(dir)
    await service.load()
    for (let i = 0; i < 3; i++) {
      for (const type of ['general', 'explore', 'custom']) {
        assert.equal(service.resolveModelKeyFor({ kind: 'subagent', type }, { currentModelKey: 'main' }), 'small')
      }
      assert.equal(service.resolveModelKeyFor({ kind: 'subagent', type: 'plan' }, { currentModelKey: 'main' }), 'main')
      await service.save()
      await service.load()
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/**
 * Seeds the config a service opened at `_dir` will read — which is the *home*
 * file, whatever the project directory is. The parameter is kept so each case
 * still reads as "this project's config".
 */
async function writeConfig(_dir: string, content: object): Promise<void> {
  const home = process.env.USERPROFILE!
  await mkdir(path.join(home, '.myagent'), { recursive: true })
  await writeFile(path.join(home, '.myagent', 'config.json'), JSON.stringify(content))
}

test('mergeRouting: every role inherits by default', () => {
  const merged = mergeRouting()
  assert.equal(merged.main, DEFAULT_ROUTING.main)
  assert.equal(merged.plan, DEFAULT_ROUTING.plan)
  assert.equal(merged.compact, DEFAULT_ROUTING.compact)
  // No tiers means no role has anything to be promoted or demoted to: plan no
  // longer upgrades and compact no longer downgrades.
  assert.equal(merged.main, 'inherit')
  assert.equal(merged.plan, 'inherit')
  assert.equal(merged.compact, 'inherit')
  assert.equal(merged.subagent?.explore, undefined)
  assert.equal(merged.subagent?.plan, undefined)
})

test('mergeRouting: deep-merges subagent overrides', () => {
  const merged = mergeRouting(
    { subagent: { explore: 'big' } },
    { main: 'small' },
  )
  assert.equal(merged.main, 'small')
  assert.equal(merged.subagent?.explore, 'big')
  // Untouched defaults preserved.
  assert.equal(merged.subagent?.plan, undefined)
})

test('retired fork routing is removed on load, updates, save and reload', async (t) => {
  const dir = await tmpDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeConfig(dir, {
    models: { main: { provider: 'openai', model: 'main' } },
    defaultModel: 'main',
    routing: { subagent: { fork: 'main', explore: 'main', custom: 'main' } },
  })
  await writeFile(path.join(process.env.USERPROFILE!, '.myagent', 'settings.json'), JSON.stringify({
    routing: { subagent: { fork: 'legacy', plan: 'main' } },
  }))

  const config = new ConfigService(dir)
  await config.load()
  const expected = { general: 'inherit', explore: 'main', plan: 'main', custom: 'main' }
  assert.deepEqual(config.get().routing?.subagent, expected)
  config.setRouting({ ...config.getRouting(), subagent: { ...expected, fork: 'main' } })
  assert.deepEqual(config.getRouting().subagent, expected)
  await config.save()
  const persisted = JSON.parse(await readFile(config.getSaveTarget(), 'utf8'))
  assert.deepEqual(persisted.routing.subagent, expected)
  await config.load()
  assert.deepEqual(config.get().routing?.subagent, expected)
  assert.equal(config.resolveModelKeyFor({ kind: 'subagent', type: 'custom' }), 'main')
})

test('pickRoutedModel: subagent type override beats general fallback', () => {
  const routing = mergeRouting({
    subagent: { general: 'small', explore: 'big' },
  })
  assert.equal(pickRoutedModel(routing, { kind: 'subagent', type: 'explore' }), 'big')
  assert.equal(pickRoutedModel(routing, { kind: 'subagent', type: 'unknown-custom' }), 'small')
})

test('pickRoutedModel: subagent without general falls through to inherit', () => {
  const routing = mergeRouting({ subagent: { explore: 'small' } })
  assert.equal(pickRoutedModel(routing, { kind: 'subagent', type: 'something-else' }), 'inherit')
})

test('ConfigService.resolveModel: legacy inline model still works', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        legacy: { provider: 'anthropic', model: 'claude-test', apiKey: 'sk', baseUrl: 'https://x' },
      },
      defaultModel: 'legacy',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const resolved = cfg.resolveModel('legacy')
    assert.ok(resolved)
    assert.equal(resolved!.provider, 'anthropic')
    assert.equal(resolved!.model, 'claude-test')
    assert.equal(resolved!.apiKey, 'sk')
    assert.equal(resolved!.baseUrl, 'https://x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModel: endpoint reference inlines provider/baseUrl/apiKey', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      endpoints: {
        deepseek: { provider: 'anthropic', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-d' },
      },
      models: {
        ds: { endpoint: 'deepseek', model: 'deepseek-v4-flash' },
      },
      defaultModel: 'ds',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const resolved = cfg.resolveModel('ds')
    assert.ok(resolved)
    assert.equal(resolved!.provider, 'anthropic')
    assert.equal(resolved!.baseUrl, 'https://api.deepseek.com')
    assert.equal(resolved!.apiKey, 'sk-d')
    assert.equal(resolved!.model, 'deepseek-v4-flash')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModel: model fields override endpoint fields', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      endpoints: {
        e: { provider: 'anthropic', baseUrl: 'https://shared', apiKey: 'shared-key' },
      },
      models: {
        m: { endpoint: 'e', model: 'm', apiKey: 'override-key' },
      },
      defaultModel: 'm',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const resolved = cfg.resolveModel('m')!
    assert.equal(resolved.apiKey, 'override-key')
    assert.equal(resolved.baseUrl, 'https://shared')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModel: missing endpoint reference returns undefined', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { m: { endpoint: 'missing', model: 'x' } },
      defaultModel: 'm',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModel('m'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: routing names model keys directly', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        small: { provider: 'openai', model: 'small' },
        med: { provider: 'openai', model: 'med' },
        big: { provider: 'openai', model: 'big' },
      },
      defaultModel: 'med',
      routing: { plan: 'big', compact: 'small' },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    // main is unset, so it inherits the current model.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: 'med' }), 'med')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'med' }), 'big')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'med' }), 'small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: unrouted subagents inherit the parent model', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        med: { provider: 'openai', model: 'med' },
        big: { provider: 'openai', model: 'big' },
      },
      defaultModel: 'med',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    for (const type of ['general', 'explore', 'plan', 'custom']) {
      assert.equal(
        cfg.resolveModelKeyFor({ kind: 'subagent', type }, { currentModelKey: 'med' }),
        'med',
        `subagent ${type} should inherit`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: an explicit "inherit" falls back to the current model', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        med: { provider: 'openai', model: 'med' },
        big: { provider: 'openai', model: 'big' },
      },
      defaultModel: 'big',
      routing: { plan: 'inherit' },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'med' }), 'med')
    // With no current model there is nothing to inherit, so defaultModel answers.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }), 'big')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: routing at a model that does not exist degrades to the fallback', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
      routing: { plan: 'deleted-model' },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    // Deleting a model that routing pointed at must not leave the role unusable.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'only' }), 'only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: no routing -> falls back to currentModelKey/defaultModel', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: 'only' }), 'only')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'only' }), 'only')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'only' }), 'only')
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'explore' }, { currentModelKey: 'only' }),
      'only',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: invalid current falls back to valid default', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'missing' }), 'only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelInput: only model keys resolve; tiers and inherit do not', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        main: { provider: 'openai', model: 'main' },
        power: { provider: 'openai', model: 'power' },
      },
      defaultModel: 'main',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelInput('main'), 'main')
    assert.equal(cfg.resolveModelInput('power'), 'power')
    assert.equal(cfg.resolveModelInput('inherit'), undefined)
    // The tier names are ordinary unknown strings now.
    assert.equal(cfg.resolveModelInput('fast'), undefined)
    assert.equal(cfg.resolveModelInput('balanced'), undefined)
    assert.equal(cfg.resolveModelInput('powerful'), undefined)
    assert.equal(cfg.resolveModelInput('sonnet'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService: model reference fields must name model keys', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        fastModel: { provider: 'openai', model: 'fast-id' },
        main: { provider: 'openai', model: 'main-id' },
        power: { provider: 'openai', model: 'power-id' },
      },
      defaultModel: 'main',
      fallbackModel: 'fastModel',
      compactModel: 'power',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()

    assert.equal(cfg.resolveModelReference(cfg.get().defaultModel), 'main')
    assert.equal(cfg.resolveModelReference(cfg.get().fallbackModel), 'fastModel')
    assert.equal(cfg.resolveModelReference(cfg.get().compactModel), 'power')
    assert.equal(cfg.getDefaultModel()?.model, 'main-id')
    assert.equal(cfg.getFallbackModel()?.model, 'fast-id')
    assert.equal(cfg.getCompactModel()?.model, 'power-id')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: 'main' }), 'main')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: subagent routing override beats the inherit default', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        med: { provider: 'openai', model: 'm' },
        big: { provider: 'openai', model: 'b' },
      },
      defaultModel: 'med',
      routing: {
        subagent: { explore: 'big' },
      },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'explore' }, { currentModelKey: 'med' }),
      'big',
    )
    // Untouched roles still inherit.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'med' }), 'med')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: setEndpoint + setModelConfig persist', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { seed: { provider: 'anthropic', model: 'seed' } },
      defaultModel: 'seed',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.setEndpoint('e1', { provider: 'anthropic', baseUrl: 'https://x' })
    cfg.setModelConfig('m1', { endpoint: 'e1', model: 'm1' })
    await cfg.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    assert.equal(reloaded.getEndpoint('e1')?.baseUrl, 'https://x')
    assert.equal(reloaded.resolveModel('m1')?.baseUrl, 'https://x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeEndpoint takes its models with it', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      endpoints: { e: { provider: 'anthropic', baseUrl: 'https://x' } },
      models: {
        m: { endpoint: 'e', model: 'm' },
        keep: { provider: 'anthropic', model: 'keep' },
      },
      defaultModel: 'm',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.deepEqual(cfg.modelsForEndpoint('e'), ['m'])
    cfg.removeEndpoint('e')
    assert.equal(cfg.getEndpoint('e'), undefined)
    assert.equal(cfg.getModel('m'), undefined)
    // The model that outlived it is what `defaultModel` now names.
    assert.equal(cfg.get().defaultModel, 'keep')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeModel sends a routing role back to inherit', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        a: { provider: 'anthropic', model: 'a' },
        b: { provider: 'anthropic', model: 'b' },
      },
      defaultModel: 'b',
      routing: { plan: 'a' },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.removeModel('a')
    assert.equal(cfg.getModel('a'), undefined)
    assert.equal(cfg.getRouting().plan, 'inherit')
    // Untouched: only the roles that named the removed model move.
    assert.equal(cfg.get().defaultModel, 'b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeModel sends a subagent route back to inherit', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        a: { provider: 'anthropic', model: 'a' },
        b: { provider: 'anthropic', model: 'b' },
      },
      defaultModel: 'b',
      routing: { subagent: { explore: 'a' } },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.removeModel('a')
    assert.equal(cfg.getRouting().subagent?.explore, 'inherit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removing the defaultModel promotes the next one', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        d: { provider: 'anthropic', model: 'd' },
        next: { provider: 'anthropic', model: 'next' },
      },
      defaultModel: 'd',
      compactModel: 'd',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.removeModel('d')
    assert.equal(cfg.get().defaultModel, 'next')
    assert.equal(cfg.get().compactModel, 'next')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removing the last model drops defaultModel entirely', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'anthropic', model: 'only' } },
      defaultModel: 'only',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.removeModel('only')
    assert.equal('defaultModel' in cfg.get(), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: renameModel follows the key through routing', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        a: { provider: 'anthropic', model: 'a' },
        b: { provider: 'anthropic', model: 'b' },
      },
      defaultModel: 'b',
      routing: { plan: 'a', subagent: { explore: 'a' } },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.renameModel('a', 'a2')
    const routing = cfg.get().routing
    assert.equal(routing?.plan, 'a2')
    assert.equal(routing?.subagent?.explore, 'a2')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'b' }), 'a2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: setRouting persists deep-merged routing', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        x: { provider: 'openai', model: 'x' },
        y: { provider: 'openai', model: 'y' },
      },
      defaultModel: 'x',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const before = cfg.getRouting()
    cfg.setRouting({ ...before, main: 'y', subagent: { ...before.subagent, explore: 'y' } })
    await cfg.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    const after = reloaded.getRouting()
    assert.equal(after.main, 'y')
    assert.equal(after.subagent?.explore, 'y')
    // Untouched defaults preserved through reload.
    assert.equal(after.subagent?.plan, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- migration off the tier era ---------------------------------------------

test('migration: profiles / activeProfile warn and do not block startup', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        small: { provider: 'openai', model: 'small' },
        big: { provider: 'openai', model: 'big' },
      },
      profiles: { cn: { fast: 'small', balanced: 'big' } },
      activeProfile: 'cn',
      defaultModel: 'big',
    })
    const cfg = new ConfigService(dir)
    // Loading must not throw: a stale config starts with a warning, not a wall.
    await cfg.load()

    const findings = cfg.getLegacyModelFindings()
    assert.ok(findings.some((f) => f.includes('`profiles`')), findings.join('\n'))
    assert.ok(findings.some((f) => f.includes('`activeProfile`')), findings.join('\n'))
    // The still-valid defaultModel is left alone.
    assert.equal(cfg.get().defaultModel, 'big')
    assert.equal(cfg.getDefaultModel()?.model, 'big')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration: a defaultModel naming a tier lands on the first resolvable model', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        broken: { endpoint: 'missing', model: 'broken' },
        good: { provider: 'openai', model: 'good' },
      },
      profiles: { p: { balanced: 'good' } },
      defaultModel: 'balanced',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()

    // "first resolvable", not "first": `broken` has a dangling endpoint.
    assert.equal(cfg.get().defaultModel, 'good')
    assert.equal(cfg.getDefaultModel()?.model, 'good')
    assert.ok(
      cfg.getLegacyModelFindings().some((f) => f.includes('defaultModel was the tier "balanced"')),
      cfg.getLegacyModelFindings().join('\n'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration: routing values naming tiers become inherit', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
      routing: { plan: 'powerful', compact: 'fast', subagent: { explore: 'balanced' } },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()

    const routing = cfg.get().routing
    assert.equal(routing?.plan, 'inherit')
    assert.equal(routing?.compact, 'inherit')
    assert.equal(routing?.subagent?.explore, 'inherit')

    const findings = cfg.getLegacyModelFindings()
    assert.ok(findings.some((f) => f.includes('routing.plan')), findings.join('\n'))
    assert.ok(findings.some((f) => f.includes('routing.subagent.explore')), findings.join('\n'))

    // And every role now resolves to the one real model.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'only' }), 'only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration: a model actually keyed "fast" is left alone', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        fast: { provider: 'openai', model: 'a-real-model' },
        other: { provider: 'openai', model: 'other' },
      },
      defaultModel: 'fast',
      routing: { compact: 'fast' },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()

    // This is a valid new-style config that merely spells a key like an old
    // tier. Rewriting it would break a working setup to fix an imaginary one.
    assert.deepEqual(cfg.getLegacyModelFindings(), [])
    assert.equal(cfg.get().defaultModel, 'fast')
    assert.equal(cfg.get().routing?.compact, 'fast')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'other' }), 'fast')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration: a clean config reports nothing', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
      routing: { plan: 'inherit' },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.deepEqual(cfg.getLegacyModelFindings(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
