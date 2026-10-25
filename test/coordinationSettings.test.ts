import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ConfigService } from '../src/config/service.js'
import { migrateCoordinationSettings } from '../src/config/coordinationMigration.js'
import { localSettingsPath } from '../src/config/settings.js'
import { getGlobalMyAgentDir } from '../src/utils/paths.js'

// A throwaway home per test: `ConfigService`'s save target and every project's
// personal layer are resolved under `HOME`.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

async function newConfig(): Promise<ConfigService> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-config-'))
  const config = new ConfigService(cwd)
  await config.load()
  config.setModelConfig('big', { provider: 'openai', model: 'big' })
  config.setModelConfig('small', { provider: 'openai', model: 'small' })
  config.setDefaultModel('big')
  return config
}

async function projectRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'myagent-project-'))
}

async function writeSettings(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

const BACKUP = '.pre-coordination-migration.bak'

test('the global coordination group defaults, patches and deletes fields', async () => {
  const config = await newConfig()
  assert.deepEqual(config.getCoordination(), { quietDays: 3, autoResolveDays: 7 })

  config.setCoordination({ quietDays: 0, threadEffort: 'low' })
  assert.deepEqual(config.getCoordination(), { quietDays: 0, threadEffort: 'low', autoResolveDays: 7 })

  config.setCoordination({ quietDays: undefined })
  assert.equal(config.getCoordination().quietDays, 3)

  assert.throws(() => config.setCoordination({ quietDays: -1 }), /non-negative integer/)
  assert.throws(
    () => config.setCoordination({ coordinatorEffort: 'extreme' as never }),
    /must be one of/,
  )
})

test('coordination roles are ordinary routing entries and survive renames and removals', async () => {
  const config = await newConfig()
  config.setCoordinationRouting('thread', 'small')
  assert.deepEqual(config.resolveCoordinationModelKey('thread'), { modelKey: 'small' })

  config.renameModel('small', 'tiny')
  assert.equal(config.getRouting().thread, 'tiny')

  config.removeModel('tiny')
  assert.equal(config.getRouting().thread, 'inherit')
  assert.deepEqual(config.resolveCoordinationModelKey('thread'), { modelKey: 'big' })
})

test('a role naming an unknown model is reported instead of inheriting', async () => {
  const config = await newConfig()
  assert.throws(() => config.setCoordinationRouting('coordinator', 'ghost'), /unknown model/)

  config.setCoordinationRouting('coordinator', 'ghost', { allowUnknown: true })
  assert.deepEqual(config.resolveCoordinationModelKey('coordinator'), { invalid: 'ghost' })
})

test('a project without a coordination group migrates nothing', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  const result = await migrateCoordinationSettings({ config, roots: [root] })
  assert.deepEqual(result, { findings: [], migrated: {} })
})

test('one project migrates all six values into the global config and is cleaned up', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  const file = localSettingsPath(root)
  await writeSettings(file, {
    coordination: {
      coordinatorModel: 'big',
      threadModel: 'small',
      coordinatorEffort: 'low',
      threadEffort: 'high',
      quietDays: 0,
      autoResolveDays: 9,
    },
  })

  const result = await migrateCoordinationSettings({ config, roots: [root] })
  assert.deepEqual(result.findings, [])
  assert.deepEqual(config.getCoordination(), {
    coordinatorEffort: 'low',
    threadEffort: 'high',
    quietDays: 0,
    autoResolveDays: 9,
  })
  assert.equal(config.getRouting().coordinator, 'big')
  assert.equal(config.getRouting().thread, 'small')

  // The original bytes survive under the backup, and the field is gone.
  assert.match(await readFile(`${file}${BACKUP}`, 'utf8'), /coordinatorModel/)
  assert.equal((await readSettings(file)).coordination, undefined)

  // Saved, so a fresh load sees the same thing.
  const reloaded = new ConfigService(root)
  await reloaded.load()
  assert.equal(reloaded.getRouting().coordinator, 'big')
  assert.equal(reloaded.getCoordination().autoResolveDays, 9)
})

test('the global settings file is a source too; a repository file is not', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  await writeSettings(path.join(getGlobalMyAgentDir(), 'settings.json'), {
    coordination: { quietDays: 1 },
  })
  await writeSettings(path.join(root, '.myagent', 'settings.json'), {
    coordination: { quietDays: 6 },
  })

  await migrateCoordinationSettings({ config, roots: [root] })
  assert.equal(config.getCoordination().quietDays, 1)
  // A checked-in project file is never a migration source and is left alone.
  assert.equal(
    ((await readSettings(path.join(root, '.myagent', 'settings.json'))).coordination as { quietDays: number })
      .quietDays,
    6,
  )
})

test('differing values across projects are reported and nothing is chosen', async () => {
  const config = await newConfig()
  const a = await projectRoot()
  const b = await projectRoot()
  await writeSettings(localSettingsPath(a), { coordination: { threadModel: 'big' } })
  await writeSettings(localSettingsPath(b), { coordination: { threadModel: 'small' } })

  const result = await migrateCoordinationSettings({ config, roots: [a, b] })
  assert.equal(config.getRouting().thread, 'inherit')
  assert.match(result.findings.join('\n'), /threadModel 在多个项目里取值不同/)

  // Nothing was cleaned up: both projects still hold their value.
  for (const root of [a, b]) {
    assert.ok((await readSettings(localSettingsPath(root))).coordination)
  }
})

test('an existing global value wins; every legacy value is cleaned once it is settled', async () => {
  // The retired fields are inert at runtime, so keeping a disagreeing one only
  // made the same conflict reappear on every launch. Once the global value is
  // settled, the old value is superseded — reported, then removed.
  const config = await newConfig()
  config.setCoordinationRouting('thread', 'small')
  const same = await projectRoot()
  const other = await projectRoot()
  await writeSettings(localSettingsPath(same), { coordination: { threadModel: 'small' } })
  await writeSettings(localSettingsPath(other), { coordination: { threadModel: 'big' } })

  const result = await migrateCoordinationSettings({ config, roots: [same, other] })
  assert.equal(config.getRouting().thread, 'small')
  assert.match(result.findings.join('\n'), /threadModel 已有全局值 small/)
  assert.match(result.findings.join('\n'), /按全局值处理并清理/)
  assert.equal((await readSettings(localSettingsPath(same))).coordination, undefined)
  assert.equal((await readSettings(localSettingsPath(other))).coordination, undefined)
})

test('unusable values are reported and left in place', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  await writeSettings(localSettingsPath(root), {
    coordination: { quietDays: -1, threadEffort: 'extreme' },
  })

  const result = await migrateCoordinationSettings({ config, roots: [root] })
  assert.equal(config.getCoordination().quietDays, 3)
  assert.equal(config.getCoordination().threadEffort, undefined)
  assert.match(result.findings.join('\n'), /quietDays 不是不小于 0 的整数/)
  assert.match(result.findings.join('\n'), /threadEffort 不是合法的思考强度/)
  assert.ok((await readSettings(localSettingsPath(root))).coordination)
})

test('a model the config does not know is promoted and reported', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  await writeSettings(localSettingsPath(root), { coordination: { coordinatorModel: 'ghost' } })

  const result = await migrateCoordinationSettings({ config, roots: [root] })
  assert.equal(config.getRouting().coordinator, 'ghost')
  assert.match(result.findings.join('\n'), /目前没有名为 ghost 的模型/)
})

test('a corrupted global config stops migration before modifying the sources', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  const file = localSettingsPath(root)
  await writeSettings(file, { coordination: { quietDays: 2 } })
  const beforeSource = await readFile(file, 'utf8')
  await mkdir(path.dirname(config.getSaveTarget()), { recursive: true })
  await writeFile(config.getSaveTarget(), '{ corrupted config')
  await assert.rejects(() => migrateCoordinationSettings({ config, roots: [root] }))
  assert.equal(await readFile(config.getSaveTarget(), 'utf8'), '{ corrupted config')
  assert.equal(await readFile(file, 'utf8'), beforeSource)
})

test('a source corrupted after migration reads it is not replaced by cleanup', async (t) => {
  const config = await newConfig()
  const root = await projectRoot()
  const file = localSettingsPath(root)
  await writeSettings(file, { coordination: { quietDays: 2 } })
  const save = config.save.bind(config)
  const bytes = '{ "apiKey": "fake-secret-do-not-report", broken'
  t.mock.method(config, 'save', async () => {
    await save()
    await writeFile(file, bytes)
  })
  const result = await migrateCoordinationSettings({ config, roots: [root] })
  assert.match(result.findings.join('\n'), /清理旧字段失败/)
  assert.doesNotMatch(result.findings.join('\n'), /fake-secret-do-not-report/)
  assert.equal(await readFile(file, 'utf8'), bytes)
})

test('a failed migration backup never overwrites the original config or cleans the source', async (t) => {
  const config = await newConfig()
  await config.save()
  const root = await projectRoot()
  const file = localSettingsPath(root)
  await writeSettings(file, { coordination: { quietDays: 2 } })
  const beforeConfig = await readFile(config.getSaveTarget(), 'utf8')
  const beforeSource = await readFile(file, 'utf8')
  const original = fs.writeFile
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith(BACKUP)) throw Object.assign(new Error('fixture backup denied'), { code: 'EACCES' })
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(() => migrateCoordinationSettings({ config, roots: [root] }), /fixture backup denied/)
    assert.equal(await readFile(config.getSaveTarget(), 'utf8'), beforeConfig)
    assert.equal(await readFile(file, 'utf8'), beforeSource)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('running the migration twice changes nothing the second time', async () => {
  const config = await newConfig()
  const root = await projectRoot()
  await writeSettings(localSettingsPath(root), {
    coordination: { threadModel: 'small', quietDays: 2 },
  })

  const first = await migrateCoordinationSettings({ config, roots: [root] })
  assert.equal(first.migrated.threadModel, 'small')

  const second = await migrateCoordinationSettings({ config, roots: [root] })
  assert.deepEqual(second, { findings: [], migrated: {} })
  assert.equal(config.getRouting().thread, 'small')
  assert.equal(config.getCoordination().quietDays, 2)
})