import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrap } from '../src/runtime/index.js'
import {
  checkResponseForCacheBreak,
  compactCacheSource,
  recordPromptState,
  resetCacheBreakDetection,
} from '../src/harness/cacheBreakDetection.js'
import { SessionStore } from '../src/sessions/service.js'
import type { RuntimeHost } from '../src/runtime/types.js'
import type { CommandContext } from '../src/commands/types.js'

/**
 * Two projects, one process.
 *
 * `AGENTS.md` used to say N sessions per project were safe but N projects per
 * process were not, and named the two reasons: the slash-command registry was a
 * module-level `Map`, and the cache-break diagnostics root was a process-wide
 * variable. Both are gone; this file is what keeps them gone.
 *
 * Everything here runs two `bootstrap()` calls side by side and asks whether
 * either one can see the other's state.
 */

// `ConfigService` and `loadMergedSettings` both layer a shared `~/.hanekawa`
// beneath the project one, so without a per-test home the two projects would
// share a config layer and prove nothing.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'hanekawa-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

const MODEL_CONFIG = {
  models: { main: { provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' } },
  defaultModel: 'main',
}

async function writeSkill(cwd: string, name: string, description: string): Promise<void> {
  const dir = path.join(cwd, '.hanekawa', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nPrompt body for ${name}`,
    'utf8',
  )
}

/** A project with one skill of its own, bootstrapped and ready. */
async function createProject(skillName: string): Promise<{ cwd: string; host: RuntimeHost }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hanekawa-multiproject-'))
  await mkdir(path.join(cwd, '.hanekawa'), { recursive: true })
  // One config for every project: the model lives in the test's home, not in
  // each project directory.
  const home = process.env.USERPROFILE!
  await mkdir(path.join(home, '.hanekawa'), { recursive: true })
  await writeFile(
    path.join(home, '.hanekawa', 'config.json'),
    JSON.stringify(MODEL_CONFIG),
    'utf8',
  )
  await writeSkill(cwd, skillName, `Only in ${skillName}`)

  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create(`${skillName} session`)
  const host = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: async () => false,
  })
  return { cwd, host }
}

function helpContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: '/tmp/project',
    sessionId: 'session-1',
    writeLine: () => {},
    clearMessages: () => {},
    ...overrides,
  }
}

test('two projects in one process keep their slash commands apart', async () => {
  const a = await createProject('only-in-a')
  const b = await createProject('only-in-b')

  try {
    // Distinct registries, both fully populated with the built-ins.
    assert.notEqual(a.host.commands, b.host.commands)
    assert.equal(a.host.commands.get('help')?.name, 'help')
    assert.equal(b.host.commands.get('help')?.name, 'help')

    // Each project's own skill is registered...
    assert.ok(a.host.commands.get('only-in-a'), 'project A should have its own skill command')
    assert.ok(b.host.commands.get('only-in-b'), 'project B should have its own skill command')

    // ...and neither can see the other's. This is the leak the module-level
    // `Map` produced: whichever project bootstrapped second used to find the
    // first one's skills already registered.
    assert.equal(a.host.commands.get('only-in-b'), undefined, 'B\'s skill leaked into A')
    assert.equal(b.host.commands.get('only-in-a'), undefined, 'A\'s skill leaked into B')
  } finally {
    await a.host.shutdown('test over')
    await b.host.shutdown('test over')
    await rm(a.cwd, { recursive: true, force: true })
    await rm(b.cwd, { recursive: true, force: true })
  }
})

test('/help lists only the project whose registry it was built against', async () => {
  const a = await createProject('only-in-a')
  const b = await createProject('only-in-b')

  try {
    // `/help` is the one command that reads the registry back, which is why it
    // is a closure over the registry it is registered into rather than a shared
    // constant reaching for a module-level list.
    let output = ''
    await a.host.commands.get('help')!.run('', helpContext({
      writeLine: (message) => { output = message },
    }))

    assert.match(output, /only-in-a/)
    assert.doesNotMatch(output, /only-in-b/)
  } finally {
    await a.host.shutdown('test over')
    await b.host.shutdown('test over')
    await rm(a.cwd, { recursive: true, force: true })
    await rm(b.cwd, { recursive: true, force: true })
  }
})

test('reloading one project\'s skills does not pull in another\'s', async () => {
  const a = await createProject('only-in-a')
  const b = await createProject('only-in-b')

  try {
    // A skill that appears on disk in B *after* both bootstrapped. Reloading A
    // re-reads `<A>/.hanekawa/skills/`, so it must not find this one.
    await writeSkill(b.cwd, 'added-to-b-later', 'Added after bootstrap')

    await a.host.reloadSkills()

    assert.equal(a.host.commands.get('added-to-b-later'), undefined)
    assert.ok(a.host.commands.get('only-in-a'), 'A kept its own skill across the reload')

    // And B picks it up when *it* reloads, so the negative above is about
    // isolation rather than the reload simply not working.
    await b.host.reloadSkills()
    assert.ok(b.host.commands.get('added-to-b-later'))
    assert.equal(b.host.commands.get('only-in-a'), undefined)
  } finally {
    await a.host.shutdown('test over')
    await b.host.shutdown('test over')
    await rm(a.cwd, { recursive: true, force: true })
    await rm(b.cwd, { recursive: true, force: true })
  }
})

test('the fixed-literal cache sources are partitioned by project root', () => {
  const rootA = '/tmp/project-a'
  const rootB = '/tmp/project-b'

  const sourceA = compactCacheSource(rootA)
  const sourceB = compactCacheSource(rootB)

  // `compact` is the same string in every project, so the root has to travel
  // inside the source or the two share one entry in `previousSnapshots`.
  assert.notEqual(sourceA, sourceB)

  resetCacheBreakDetection(sourceA)
  resetCacheBreakDetection(sourceB)

  // Project A establishes a baseline of 50k cache-read tokens.
  recordPromptState({ system: 'system a', toolsJson: '[]', model: 'model-a' }, sourceA)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, sourceA), null)

  // Project B then answers with a much smaller read. Sharing a source, this
  // would overwrite A's baseline and A's next unchanged request would look like
  // a 49k-token break.
  recordPromptState({ system: 'system b', toolsJson: '[]', model: 'model-b' }, sourceB)
  assert.equal(checkResponseForCacheBreak(1_000, 1_000, sourceB), null)

  // A repeats its request unchanged and holds its cache. No break.
  recordPromptState({ system: 'system a', toolsJson: '[]', model: 'model-a' }, sourceA)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, sourceA), null)

  resetCacheBreakDetection(sourceA)
  resetCacheBreakDetection(sourceB)
})

test('an unrooted fixed-literal source is still the bare literal', () => {
  // Callers with no cwd in reach keep the pre-existing behaviour, which is what
  // lets the root stay optional instead of threading a cwd everywhere.
  assert.equal(compactCacheSource(), 'compact')
  assert.equal(compactCacheSource(undefined), 'compact')
})
