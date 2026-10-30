import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadMergedSettings } from '../src/config/settings.js'
import { buildStartupNotices } from '../src/runtime/startupNotices.js'
import { migrateLegacyProjectData } from '../src/sessions/legacyProjectData.js'
import { SessionStore } from '../src/sessions/service.js'
import { getLocalAgentsDir, getProjectDataDir, getProjectPlansDir, getSessionsDir, userHome } from '../src/utils/paths.js'

const OLD = '00000000-0000-4000-8000-000000000001'
const NEW = '00000000-0000-4000-8000-000000000002'

async function makeProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'hanekawa-legacy-data-'))
}

function row(id: string, title: string) {
  const at = new Date().toISOString()
  return { id, title, createdAt: at, updatedAt: at, messageCount: 1 }
}

/** What a project looked like when runtime data still lived in `<cwd>/.hanekawa/`. */
async function seedLegacy(cwd: string): Promise<string> {
  const legacy = path.join(cwd, '.hanekawa')
  await mkdir(path.join(legacy, 'sessions', 'subagents', OLD), { recursive: true })
  await writeFile(path.join(legacy, 'sessions', `${OLD}.jsonl`), '{"type":"message","id":"m1","role":"user","content":"old hello"}\n')
  await writeFile(path.join(legacy, 'sessions', `${OLD}.metrics.jsonl`), '')
  await writeFile(path.join(legacy, 'sessions', 'index.json'), JSON.stringify({ sessions: [row(OLD, 'old one')] }))
  await writeFile(path.join(legacy, 'sessions', 'index.json.lock'), '{}')
  await writeFile(path.join(legacy, 'sessions', 'subagents', OLD, 'agent-1.jsonl'), '{}\n')
  await mkdir(path.join(legacy, 'attachments', OLD, 'img-1'), { recursive: true })
  await writeFile(path.join(legacy, 'attachments', OLD, 'img-1', 'metadata.json'), '{}')
  await mkdir(path.join(legacy, 'plans'), { recursive: true })
  await writeFile(path.join(legacy, 'plans', 'calm-plan.md'), '# plan\n')
  return legacy
}

test('opening a legacy project moves its data out and removes the emptied .hanekawa', async () => {
  const cwd = await makeProject()
  try {
    await seedLegacy(cwd)
    const store = new SessionStore(cwd)
    await store.init()

    assert.equal(existsSync(path.join(cwd, '.hanekawa')), false)
    assert.deepEqual((await store.list()).map((s) => s.title), ['old one'])
    assert.equal(existsSync(path.join(getSessionsDir(cwd), 'subagents', OLD, 'agent-1.jsonl')), true)
    assert.equal(existsSync(path.join(getSessionsDir(cwd), 'index.json.lock')), false)
    assert.equal(existsSync(path.join(getProjectDataDir(cwd), 'attachments', OLD, 'img-1', 'metadata.json')), true)
    assert.equal(await readFile(path.join(getProjectPlansDir(cwd), 'calm-plan.md'), 'utf8'), '# plan\n')
    assert.deepEqual(store.takeMigrationFindings().map((f) => f.kind), ['moved'])
    assert.deepEqual(store.takeMigrationFindings(), [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('personal settings move with the data and still apply', async () => {
  const cwd = await makeProject()
  try {
    const legacy = path.join(cwd, '.hanekawa')
    await mkdir(path.join(legacy, 'agents.local'), { recursive: true })
    await writeFile(path.join(legacy, 'agents.local', 'mine.md'), '---\nname: mine\n---\n')
    await writeFile(path.join(legacy, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }))

    await new SessionStore(cwd).init()

    assert.equal(existsSync(legacy), false)
    assert.equal(existsSync(path.join(getLocalAgentsDir(cwd), 'mine.md')), true)
    assert.deepEqual((await loadMergedSettings(cwd)).permissions?.allow, ['Bash(ls:*)'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('project configuration stays where it is', async () => {
  const cwd = await makeProject()
  try {
    const legacy = await seedLegacy(cwd)
    await writeFile(path.join(legacy, 'settings.json'), '{}')
    await mkdir(path.join(legacy, 'skills', 'x'), { recursive: true })

    assert.deepEqual((await migrateLegacyProjectData(cwd)).length, 1)
    assert.equal(existsSync(path.join(legacy, 'settings.json')), true)
    assert.equal(existsSync(path.join(legacy, 'skills', 'x')), true)
    assert.equal(existsSync(path.join(legacy, 'sessions')), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('sessions created since the move are kept and the two indexes merge', async () => {
  const cwd = await makeProject()
  try {
    await seedLegacy(cwd)
    await mkdir(getSessionsDir(cwd), { recursive: true })
    await writeFile(path.join(getSessionsDir(cwd), `${NEW}.jsonl`), '{"type":"message","id":"m2","role":"user","content":"new"}\n')
    await writeFile(path.join(getSessionsDir(cwd), 'index.json'), JSON.stringify({ sessions: [row(NEW, 'new one')] }))

    const store = new SessionStore(cwd)
    await store.init()

    assert.deepEqual((await store.list()).map((s) => s.title).sort(), ['new one', 'old one'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a file that cannot be moved leaves the original data in place and says so', async () => {
  const cwd = await makeProject()
  try {
    const legacy = await seedLegacy(cwd)
    // A different file already sits where the plan would go: never overwrite.
    await mkdir(getProjectPlansDir(cwd), { recursive: true })
    await writeFile(path.join(getProjectPlansDir(cwd), 'calm-plan.md'), 'something else')

    const findings = await migrateLegacyProjectData(cwd)

    const failed = findings.find((f) => f.kind === 'failed')
    assert.match(failed?.message ?? '', /原数据保留[\s\S]*calm-plan\.md/)
    // Surfaced to the user as a startup warning, not only a debug log line.
    const notices = buildStartupNotices({
      diagnostics: [{ code: 'project_data_migration_failed', severity: 'warning', message: failed!.message }],
      mcp: { connected: [], failed: [] },
    })
    assert.ok(notices.some((n) => n.level === 'warning' && n.content === failed!.message))
    assert.equal(await readFile(path.join(legacy, 'plans', 'calm-plan.md'), 'utf8'), '# plan\n')
    assert.equal(await readFile(path.join(getProjectPlansDir(cwd), 'calm-plan.md'), 'utf8'), 'something else')
    // The entries that did copy cleanly still moved.
    assert.equal(existsSync(path.join(legacy, 'sessions')), false)
    assert.equal(existsSync(legacy), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the global workspace moves ~/.hanekawa/sessions but keeps ~/.hanekawa', async () => {
  // `userHome()`, not `os.homedir()`: it refuses the real home to a run that skipped `npm test`.
  const home = userHome()
  await mkdir(path.join(home, '.hanekawa', 'sessions'), { recursive: true })
  await writeFile(path.join(home, '.hanekawa', 'config.json'), '{}')
  await writeFile(path.join(home, '.hanekawa', 'sessions', `${OLD}.jsonl`), '{"type":"message","id":"m1","role":"user","content":"hi"}\n')

  await migrateLegacyProjectData(home)

  assert.equal(existsSync(path.join(home, '.hanekawa', 'sessions')), false)
  assert.equal(existsSync(path.join(home, '.hanekawa', 'config.json')), true)
  assert.equal(existsSync(path.join(getSessionsDir(home), `${OLD}.jsonl`)), true)
})

test('a project with nothing to migrate is left alone', async () => {
  const cwd = await makeProject()
  try {
    assert.deepEqual(await migrateLegacyProjectData(cwd), [])
    assert.equal(existsSync(path.join(cwd, '.hanekawa')), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
