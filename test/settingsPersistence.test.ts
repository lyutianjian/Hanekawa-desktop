import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getGlobalMyAgentDir } from '../src/utils/paths.js'
import { ConfigService } from '../src/config/service.js'
import {
  validateSettings,
  type MyAgentSettings,
  loadLocalSettings,
  loadMergedSettings,
  localSettingsPath,
  setLocalCacheTtl1h,
  setLocalPermissionEntries,
  setLocalStartupPermissionMode,
  setMcpServerTrustLocally,
  setSkillEnabledLocally,
  updateLocalSettings,
} from '../src/config/settings.js'

/**
 * The settings screen's writes, against a real `ConfigService` and a real
 * directory.
 *
 * `test/desktopShellHost.test.ts` proves the shell calls `save()` before
 * `reloadSettings()` using a recorder. This file is the other half: that the
 * mutation plus that `save()` actually survives a fresh `load()`. A recorder
 * cannot show that, and the ordering bug it guards against is a *data-loss*
 * bug — `reloadSettings` ends in `config.load()`, which re-reads the layers off
 * disk and discards anything unsaved.
 *
 * A fresh temp home per test throughout: `config.json` is global-only now, so
 * without it these would read *and write* the developer's own
 * `~/.myagent/config.json` and the assertions would depend on whose machine ran
 * them. `loadMergedSettings` layers `~/.myagent/settings.json` under the project
 * one, so the local-layer cases below need the same isolation.
 */

test.beforeEach(() => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})


async function withProject(
  run: (cwd: string, config: ConfigService) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-settings-'))
  try {
    await mkdir(path.join(cwd, '.myagent'), { recursive: true })
    const config = new ConfigService(cwd)
    await config.load()
    await run(cwd, config)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** A second service over the same directory — what the next launch would see. */
async function reload(cwd: string): Promise<ConfigService> {
  const config = new ConfigService(cwd)
  await config.load()
  return config
}

test('an endpoint written through the screen survives a fresh load', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', {
      provider: 'anthropic',
      baseUrl: 'https://api.example',
      apiKey: 'sk-abcdefghijkl',
    })
    await config.save()

    const reloaded = await reload(cwd)
    assert.deepEqual(reloaded.getEndpoint('main'), {
      provider: 'anthropic',
      baseUrl: 'https://api.example',
      apiKey: 'sk-abcdefghijkl',
    })
  })
})

test('without save() the edit is gone on the next load — the ordering bug, demonstrated', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    // No save(). This is precisely what `reloadSettings()` does to an unsaved
    // mutation, since it ends in `config.load()`.
    await config.load()
    assert.equal(config.getEndpoint('main'), undefined, 'load() discarded the unsaved edit')

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getEndpoint('main'), undefined)
  })
})

test('getSaveTarget names the file that actually changes', async () => {
  await withProject(async (cwd, config) => {
    const target = config.getSaveTarget()
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    await config.save()

    const written = JSON.parse(await readFile(target, 'utf8')) as { models: Record<string, unknown> }
    assert.ok(written.models.big, 'the screen reports the path it really wrote')
  })
})

test('a model and its routing survive the round trip', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic', apiKey: 'sk-abcdefghijkl' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main', contextWindow: 200_000 })
    config.setRouting({ ...config.getRouting(), main: 'big' })
    config.setDefaultModel('big')
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getModel('big')?.contextWindow, 200_000)
    assert.equal(reloaded.getRouting().main, 'big')
    assert.equal(reloaded.get().defaultModel, 'big')
  })
})

test('renameModel carries the routing reference with it, on disk', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    config.setRouting({ ...config.getRouting(), main: 'big' })
    await config.save()

    config.renameModel('big', 'huge')
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getModel('big'), undefined)
    assert.equal(reloaded.getModel('huge')?.model, 'claude-big')
    assert.equal(
      reloaded.getRouting().main,
      'huge',
      'a rename that left routing behind would silently degrade the role to inherit',
    )
  })
})

test('removeModel frees the routing role that pointed at it, on disk', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    config.setRouting({ ...config.getRouting(), main: 'big' })
    await config.save()

    config.removeModel('big')
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getModel('big'), undefined)
    assert.equal(reloaded.getRouting().main, 'inherit')
  })
})

test('removeEndpoint takes the models that resolve through it', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    await config.save()

    config.removeEndpoint('main')
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getEndpoint('main'), undefined)
    assert.equal(reloaded.getModel('big'), undefined)
  })
})

test('clearing an endpoint key really removes it from disk', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic', apiKey: 'sk-abcdefghijkl' })
    await config.save()

    // What `clear-endpoint-key` does: rewrite the endpoint without the key.
    config.setEndpoint('main', { provider: 'anthropic' })
    await config.save()

    const raw = await readFile(config.getSaveTarget(), 'utf8')
    assert.ok(!raw.includes('sk-abcdefghijkl'), 'the key is gone from the file, not just the object')
    const reloaded = await reload(cwd)
    assert.equal(reloaded.getEndpoint('main')?.apiKey, undefined)
  })
})

test('a routing value naming a model that no longer exists degrades to inherit', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    config.setRouting({ ...config.getRouting(), plan: 'ghost' })
    await config.save()

    const reloaded = await reload(cwd)
    // The stored value is kept as written; resolution is what degrades, which
    // is what makes deleting a model a recoverable mistake rather than a crash.
    assert.equal(reloaded.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'big' }), 'big')
  })
})

// --- context management -------------------------------------------------------

test('the context numbers survive a fresh load, in config.json', async () => {
  await withProject(async (cwd, config) => {
    config.setContextManagement({ contextWindow: 400_000, autoCompactReserveRatio: 0.2 })
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.get().agent.contextManagement?.contextWindow, 400_000)
    assert.equal(reloaded.get().agent.contextManagement?.autoCompactReserveRatio, 0.2)
    // Patching one field must not blank the others, which is what a plain
    // assignment of the patch would do.
    assert.equal(reloaded.get().agent.contextManagement?.summaryOutputTokens, 20_000)
  })
})

test('a context value that cannot mean anything is rejected instead of stored', async () => {
  await withProject(async (cwd, config) => {
    assert.throws(() => config.setContextManagement({ autoCompactReserveRatio: 1.5 }), /ratio in \(0, 1]/)
    assert.throws(() => config.setContextManagement({ microCompactThresholdRatio: 0 }), /ratio in \(0, 1]/)
    assert.throws(() => config.setContextManagement({ contextWindow: 0 }), /positive integer/)
    assert.throws(() => config.setContextManagement({ summaryOutputTokens: 1.5 }), /positive integer/)

    // Nothing was half-applied: a rejected patch leaves the live config alone.
    assert.equal(config.get().agent.contextManagement?.contextWindow, 272_000)
    await config.save()
    const reloaded = await reload(cwd)
    assert.equal(reloaded.get().agent.contextManagement?.autoCompactReserveRatio, 0.083)
  })
})

// --- the local settings layer -------------------------------------------------

/**
 * A project whose *project* layer already carries settings, so every case below
 * has something inherited to read past. That is the whole difficulty: the local
 * layer is the only file the screen may rewrite, and `mergeSettings`
 * concatenates permission groups rather than overriding them.
 */
async function withLocalLayer(
  projectSettings: Record<string, unknown>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-local-'))
  try {
    await mkdir(path.join(cwd, '.myagent'), { recursive: true })
    await writeFile(
      path.join(cwd, '.myagent', 'settings.json'),
      JSON.stringify(projectSettings),
      'utf8',
    )
    await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('rewriting a permission group leaves the inherited entries in their own file', async () => {
  await withLocalLayer({ permissions: { allow: ['Read'] } }, async (cwd) => {
    await setLocalPermissionEntries(cwd, 'allow', ['Bash(git status:*)'])

    // The mutation this guards against is writing the *merged* group back, which
    // would copy `Read` into the local layer and then show it twice.
    assert.deepEqual((await loadLocalSettings(cwd)).permissions, { allow: ['Bash(git status:*)'] })
    assert.deepEqual(
      (await loadMergedSettings(cwd)).permissions?.allow,
      ['Read', 'Bash(git status:*)'],
    )
  })
})

test('the home directory does not merge its user layer twice', async () => {
  // The home directory *is* the global workspace, so its "project" layer is
  // `~/.myagent/settings.json` itself. `mergeSettings` concatenates permission
  // groups, so loading both copies would double every entry — and run every
  // hook twice.
  const home = process.env.USERPROFILE!
  await mkdir(path.join(home, '.myagent'), { recursive: true })
  await writeFile(
    path.join(home, '.myagent', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] } }),
    'utf8',
  )

  assert.deepEqual((await loadMergedSettings(home)).permissions?.allow, ['Read'])
})

test('autoMemory: a later layer overrides an earlier one', async () => {
  await withLocalLayer({ autoMemory: true }, async (cwd) => {
    assert.equal((await loadMergedSettings(cwd)).autoMemory, true)
    const local = localSettingsPath(cwd)
    await mkdir(path.dirname(local), { recursive: true })
    await writeFile(local, JSON.stringify({ autoMemory: false }), 'utf8')
    assert.equal((await loadMergedSettings(cwd)).autoMemory, false)
  })
})

test('a local rule can be removed, which appending one at a time never could', async () => {
  await withLocalLayer({ permissions: { allow: ['Read'] } }, async (cwd) => {
    await setLocalPermissionEntries(cwd, 'allow', ['Bash(ls:*)', 'Bash(git status:*)'])
    await setLocalPermissionEntries(cwd, 'allow', ['Bash(ls:*)'])

    assert.deepEqual((await loadMergedSettings(cwd)).permissions?.allow, ['Read', 'Bash(ls:*)'])
  })
})

test('an invalid group is rejected before the file is written', async () => {
  await withLocalLayer({}, async (cwd) => {
    await setLocalPermissionEntries(cwd, 'deny', ['Bash(rm -rf:*)'])

    // Validation has to happen before the write: `reloadSettings()` *throws* on
    // invalid settings, so a bad file leaves the project unable to reload at all.
    await assert.rejects(() => setLocalPermissionEntries(cwd, 'deny', ['  ']), /Invalid settings/)
    assert.deepEqual((await loadLocalSettings(cwd)).permissions?.deny, ['Bash(rm -rf:*)'])
  })
})

test('a patch rewrites the keys it names and nothing else', async () => {
  await withLocalLayer({}, async (cwd) => {
    // A local layer with a key the patch type cannot even express: hand-written
    // files are the normal case, and a read-modify-write that forgets them is a
    // silent truncation.
    await mkdir(path.dirname(localSettingsPath(cwd)), { recursive: true })
    await writeFile(
      localSettingsPath(cwd),
      JSON.stringify({ models: { hand: { provider: 'anthropic', model: 'by-hand' } } }),
      'utf8',
    )

    await setLocalCacheTtl1h(cwd, true)
    await setLocalStartupPermissionMode(cwd, 'auto')

    const local = await loadLocalSettings(cwd)
    assert.equal(local.cache?.ttl1h, true)
    assert.equal(local.permissions?.mode, 'auto')
    assert.equal(local.models?.hand?.model, 'by-hand', 'the untouched key is still there')

    await updateLocalSettings(cwd, { cache: undefined })
    assert.equal((await loadLocalSettings(cwd)).cache, undefined, 'undefined deletes rather than writing null')
    assert.equal((await loadLocalSettings(cwd)).permissions?.mode, 'auto')
  })
})

test('untrusting an MCP server only reaches the local layer', async () => {
  await withLocalLayer({}, async (cwd) => {
    const userFile = path.join(getGlobalMyAgentDir(), 'settings.json')
    await mkdir(path.dirname(userFile), { recursive: true })
    await writeFile(userFile, JSON.stringify({ mcp: { trustedServers: ['shared'] } }), 'utf8')
    await setMcpServerTrustLocally(cwd, 'own', true)
    assert.deepEqual((await loadMergedSettings(cwd)).mcp?.trustedServers, ['shared', 'own'])

    await setMcpServerTrustLocally(cwd, 'own', false)
    assert.deepEqual((await loadMergedSettings(cwd)).mcp?.trustedServers, ['shared'])

    // `mcp.trustedServers` is *unioned* across layers, so a name trusted above
    // cannot be revoked from here. This is why the screen marks such a row
    // read-only instead of drawing a toggle that does nothing.
    await setMcpServerTrustLocally(cwd, 'shared', false)
    assert.deepEqual(
      (await loadMergedSettings(cwd)).mcp?.trustedServers,
      ['shared'],
      'the inherited trust survives, and the UI has to say so',
    )
  })
})

test('a skill switched off above can be switched back on locally', async () => {
  await withLocalLayer({ skills: { disabled: ['inherited', 'shared'] } }, async (cwd) => {
    await setSkillEnabledLocally(cwd, 'own', false)
    // The local list *replaces* the project one — it is not concatenated like
    // `permissions.*` nor unioned like `mcp.trustedServers`. The whole point:
    // a switch that could not turn a skill back on would be a switch that
    // silently does nothing.
    assert.deepEqual((await loadMergedSettings(cwd)).skills?.disabled, ['own'])

    await setSkillEnabledLocally(cwd, 'shared', false)
    assert.deepEqual(
      (await loadMergedSettings(cwd)).skills?.disabled,
      ['own', 'shared'],
      'the list is sorted, so the file does not churn on every toggle',
    )

    await setSkillEnabledLocally(cwd, 'own', true)
    assert.deepEqual((await loadMergedSettings(cwd)).skills?.disabled, ['shared'])
    assert.deepEqual((await loadLocalSettings(cwd)).skills?.disabled, ['shared'])
  })
})

test('a permissions edit does not write config.json', async () => {
  await withLocalLayer({}, async (cwd) => {
    const config = new ConfigService(cwd)
    await config.load(await loadMergedSettings(cwd))

    await setLocalPermissionEntries(cwd, 'ask', ['Bash(git push:*)'])

    // The shell must not call `config.save()` for a settings-layer edit: `save()`
    // writes the *merged* `Config`, which would copy every settings-declared
    // model and endpoint into config.json as a side effect of adding one rule.
    assert.equal(
      existsSync(config.getSaveTarget()),
      false,
      'config.json was created by a change that has nothing to do with it',
    )
  })
})

test('a legacy acceptEdits mode loads as auto', async () => {
  await withLocalLayer({}, async (cwd) => {
    await mkdir(path.dirname(localSettingsPath(cwd)), { recursive: true })
    await writeFile(localSettingsPath(cwd), JSON.stringify({ permissions: { mode: 'acceptEdits' } }), 'utf8')
    assert.equal((await loadLocalSettings(cwd)).permissions?.mode, 'auto')
    assert.equal((await loadMergedSettings(cwd)).permissions?.mode, 'auto')
  })
})

test('the project layer cannot pick the startup mode or pre-trust MCP servers', async () => {
  await withLocalLayer(
    { permissions: { mode: 'bypass', allow: ['Bash(ls:*)'] }, mcp: { trustedServers: ['evil'] } },
    async (cwd) => {
      const merged = await loadMergedSettings(cwd)
      assert.equal(merged.permissions?.mode, undefined)
      assert.deepEqual(merged.permissions?.allow, ['Bash(ls:*)'])
      assert.equal(merged.mcp?.trustedServers, undefined)
    },
  )
})

test('coordination: the retired project group is ignored at runtime', async () => {
  const home = process.env.USERPROFILE!
  await mkdir(path.join(home, '.myagent'), { recursive: true })
  await writeFile(
    path.join(home, '.myagent', 'settings.json'),
    JSON.stringify({ coordination: { quietDays: 5, threadModel: 'user-model' } }),
    'utf8',
  )
  await withLocalLayer({ coordination: { autoResolveDays: 0, threadModel: 'local-model' } }, async (cwd) => {
    const merged = await loadMergedSettings(cwd)
    // The group is not part of the runtime settings any more: the migration
    // reads the raw files, and nothing promotes them per project.
    assert.equal('coordination' in merged, false)

    const config = new ConfigService(cwd)
    await config.load(merged)
    assert.equal(config.getCoordination().quietDays, 3)
    assert.equal(config.getCoordination().autoResolveDays, 7)
    assert.equal(config.getRouting().thread, 'inherit')
  })
})
