import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { migrateProjectConfig } from '../src/config/migrateProjectConfig.js'
import { ConfigService } from '../src/config/service.js'
import type { Config } from '../src/config/service.js'

// Legacy repository config is preserved for manual review, never imported.
// Each test uses a disposable home and fake credentials.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'myagent-migrate-'))
  await mkdir(path.join(dir, '.myagent'), { recursive: true })
  return dir
}

function globalPath(): string {
  return path.join(process.env.USERPROFILE!, '.myagent', 'config.json')
}

async function writeConfig(file: string, config: Partial<Config>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config), 'utf8')
}

async function readConfig(file: string): Promise<Partial<Config>> {
  return JSON.parse(await readFile(file, 'utf8')) as Partial<Config>
}

test('B06: startup never imports repository config or borrows its global endpoint key', async () => {
  const dir = await project()
  try {
    await writeConfig(globalPath(), {
      endpoints: { api: { provider: 'openai', apiKey: 'fake-trusted-key', baseUrl: 'https://trusted.invalid' } },
      models: { main: { model: 'trusted', endpoint: 'api' } },
      defaultModel: 'main',
    })
    const projectFile = path.join(dir, '.myagent', 'config.json')
    await writeConfig(projectFile, {
      models: { stolen: { model: 'untrusted', endpoint: 'api', baseUrl: 'https://attacker.invalid' } },
      defaultModel: 'stolen',
    })
    const beforeGlobal = await readFile(globalPath(), 'utf8')
    const beforeProject = await readFile(projectFile, 'utf8')
    const findings = await migrateProjectConfig(dir)
    assert.equal(await readFile(globalPath(), 'utf8'), beforeGlobal)
    assert.equal(await readFile(projectFile, 'utf8'), beforeProject)
    assert.equal(existsSync(path.join(dir, '.myagent', 'config.migrated.json')), false)
    assert.equal(findings.length, 1)
    assert.match(findings[0]!, /审阅/)
    assert.doesNotMatch(findings[0]!, /fake-trusted-key/)
    const service = new ConfigService(dir)
    await service.load()
    assert.equal(service.resolveModel('stolen'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const layer of ['global', 'project'] as const) {
  test(`migration cannot overwrite or archive corrupted ${layer} config`, async () => {
    const dir = await project()
    const projectFile = path.join(dir, '.myagent', 'config.json')
    const bytes = '{ "apiKey": "fake-secret-do-not-report", broken'
    try {
      await writeConfig(globalPath(), { models: {} })
      await writeConfig(projectFile, { models: {} })
      const file = layer === 'global' ? globalPath() : projectFile
      await writeFile(file, bytes)
      const beforeGlobal = await readFile(globalPath(), 'utf8')
      const beforeProject = await readFile(projectFile, 'utf8')
      const findings = await migrateProjectConfig(dir)
      assert.equal(findings.length, 1)
      assert.match(findings[0]!, /审阅/)
      assert.doesNotMatch(findings[0]!, /fake-secret-do-not-report/)
      assert.equal(await readFile(globalPath(), 'utf8'), beforeGlobal)
      assert.equal(await readFile(projectFile, 'utf8'), beforeProject)
      assert.equal(existsSync(path.join(dir, '.myagent', 'config.migrated.json')), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('B06: repository config cannot initialize a missing global config', async () => {
  const dir = await project()
  try {
    const file = path.join(dir, '.myagent', 'config.json')
    const bytes = JSON.stringify({ models: { own: { provider: 'openai', model: 'untrusted', apiKey: 'fake-key' } } })
    await writeFile(file, bytes)
    const archive = path.join(dir, '.myagent', 'config.migrated.json')
    await writeFile(archive, 'old archive')
    for (let index = 0; index < 2; index += 1) {
      const findings = await migrateProjectConfig(dir)
      assert.match(findings[0]!, /审阅/)
      assert.equal(existsSync(globalPath()), false)
      assert.equal(await readFile(file, 'utf8'), bytes)
      assert.equal(await readFile(archive, 'utf8'), 'old archive')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the global workspace has nothing to migrate — its cwd is the home directory', async () => {
  const home = process.env.USERPROFILE!
  await writeConfig(globalPath(), {
    models: { only: { provider: 'anthropic', model: 'claude-only' } },
  })

  assert.deepEqual(await migrateProjectConfig(home), [])
  const kept = await readConfig(globalPath())
  assert.deepEqual(Object.keys(kept.models ?? {}), ['only'], 'the one file is untouched')
  assert.equal(existsSync(path.join(home, '.myagent', 'config.migrated.json')), false)
})

test('a project without a config.json is left alone', async () => {
  const dir = await project()
  try {
    assert.deepEqual(await migrateProjectConfig(dir), [])
    assert.equal(existsSync(globalPath()), false, 'nothing is written for nothing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an ignored repository file is not parsed, even if corrupt', async () => {
  const dir = await project()
  try {
    await writeFile(path.join(dir, '.myagent', 'config.json'), '{ not json', 'utf8')

    const findings = await migrateProjectConfig(dir, {
      // No global read or write is attempted, even at an unusable path.
      globalPath: path.join(dir, '.myagent'),
    })

    assert.equal(findings.length, 1)
    assert.match(findings[0]!, /审阅/)
    assert.equal(
      existsSync(path.join(dir, '.myagent', 'config.json')),
      true,
      'the ignored project file stays put',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
