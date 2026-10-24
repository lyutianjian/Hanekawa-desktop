import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionStore, type LoadRecordsResult } from '../src/sessions/service.js'
import { getSessionsDir } from '../src/utils/paths.js'
import type { SessionRecord } from '../src/harness/types.js'

const repoRootUrl = new URL('..', import.meta.url)

/**
 * `/repair` rewrites the whole JSONL file. If it reads outside the lock that
 * guards the rewrite, an append landing between the two is overwritten by
 * records that predate it — the one failure mode a repair must never have,
 * because it deletes a user's conversation turn.
 */

const CREATED_AT = '2026-05-24T00:00:00.000Z'

const toolUse = (id: string): SessionRecord => ({
  type: 'tool_use',
  id,
  tool: 'Grep',
  input: { pattern: 'x' },
  riskLevel: 'safe',
  createdAt: CREATED_AT,
  turnId: 'turn-1',
})

const orphanResult = (id: string): SessionRecord => ({
  type: 'tool_result',
  id,
  toolUseId: 'missing-call',
  tool: 'Read',
  ok: true,
  content: 'orphan result',
  createdAt: CREATED_AT,
  turnId: 'turn-1',
})

const userMessage = (id: string): SessionRecord => ({
  type: 'message',
  id,
  role: 'user',
  content: `message ${id}`,
  createdAt: CREATED_AT,
  turnId: 'turn-1',
})

/** Holds `repairRecords` right after its read, so a writer can race the rewrite. */
class GatedLoadStore extends SessionStore {
  private gate?: { loaded: () => void; wait: Promise<void> }

  gateLoad(): { loaded: Promise<void>; release: () => void } {
    let signalLoaded!: () => void
    let release!: () => void
    const loaded = new Promise<void>((resolve) => { signalLoaded = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    this.gate = { loaded: signalLoaded, wait }
    return { loaded, release }
  }

  override async loadRecordsWithDiagnostics(sessionIdOrPrefix: string): Promise<LoadRecordsResult> {
    const result = await super.loadRecordsWithDiagnostics(sessionIdOrPrefix)
    const gate = this.gate
    if (!gate) return result
    this.gate = undefined
    gate.loaded()
    await gate.wait
    return result
  }
}

async function withTempStore(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-repair-'))
  try {
    await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('a repair keeps an append that lands between its read and its rewrite', async () => {
  await withTempStore(async (cwd) => {
    const setup = new SessionStore(cwd)
    await setup.init()
    const session = await setup.create()
    await setup.appendRecord(session.id, toolUse('call-1'))
    await setup.appendRecord(session.id, orphanResult('result-2'))

    const repairing = new GatedLoadStore(cwd)
    await repairing.init()
    const writer = new SessionStore(cwd)
    await writer.init()

    const gate = repairing.gateLoad()
    const repair = repairing.repairRecords(session.id)
    await gate.loaded

    let appendSettled = false
    const append = writer.appendRecord(session.id, userMessage('late-1'))
      .finally(() => { appendSettled = true })

    // Bounded, not a race: the rewrite is on the gate, so for a repair that
    // holds the lock the append provably cannot land yet.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const landedDuringRepair = appendSettled

    gate.release()
    await Promise.all([repair, append])

    const records = await writer.loadRecords(session.id)
    const ids = records.map((record) => record.id)
    assert.ok(ids.includes('late-1'), 'the concurrent append must survive the repair rewrite')
    assert.equal(landedDuringRepair, false, 'the append must wait for the lock instead of landing mid-repair')
    assert.ok(records.some((record) => record.type === 'tool_result' && record.toolUseId === 'call-1'))
    assert.ok(records.some((record) => record.type === 'tool_use' && record.id === 'missing-call'))

    // JSONL first, then the index derived from it: one message on both sides.
    assert.equal((await writer.load(session.id))?.messageCount, 1)
  })
})

test('a repair with nothing to fix leaves the file and index untouched', async () => {
  await withTempStore(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    await store.appendRecord(session.id, userMessage('u-1'))

    const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)
    const indexPath = path.join(getSessionsDir(cwd), 'index.json')
    const before = await readFile(jsonlPath, 'utf8')
    const indexBefore = await readFile(indexPath, 'utf8')

    const result = await store.repairRecords(session.id)

    assert.equal(result.repairedCount, 0)
    assert.equal(await readFile(jsonlPath, 'utf8'), before)
    assert.equal(await readFile(indexPath, 'utf8'), indexBefore)
    assert.equal(existsSync(`${jsonlPath}.lock`), false, 'the lock must be released')
  })
})

test('a repair of a draft stays in memory', async () => {
  await withTempStore(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const draft = store.createDraft()
    await store.appendRecord(draft.id, toolUse('call-1'))
    await store.appendRecord(draft.id, orphanResult('result-2'))

    const result = await store.repairRecords(draft.id)
    assert.equal(result.repairedCount, 2)

    const records = await store.loadRecords(draft.id)
    assert.ok(records.some((record) => record.type === 'tool_result' && record.toolUseId === 'call-1'))
    assert.equal(existsSync(path.join(getSessionsDir(cwd), `${draft.id}.jsonl`)), false)
    assert.equal((await store.list()).some((item) => item.id === draft.id), false)
  })
})

test('a repair migrates a legacy JSON session and keeps the index in step', async () => {
  await withTempStore(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const id = 'legacy-session'
    const sessionsDir = getSessionsDir(cwd)
    const meta = {
      id,
      shortId: id.slice(0, 12),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      messageCount: 0,
    }
    await writeFile(
      path.join(sessionsDir, `${id}.json`),
      JSON.stringify({ meta, records: [toolUse('call-1'), orphanResult('result-2')] }),
      'utf8',
    )
    await writeFile(path.join(sessionsDir, 'index.json'), JSON.stringify({ sessions: [meta] }), 'utf8')

    const result = await store.repairRecords(id)
    assert.equal(result.repairedCount, 2)

    const records = await store.loadRecords(id)
    assert.ok(records.some((record) => record.type === 'tool_result' && record.toolUseId === 'call-1'))
    assert.ok(records.some((record) => record.type === 'tool_use' && record.id === 'missing-call'))
    assert.equal(existsSync(path.join(sessionsDir, `${id}.json`)), false, 'the legacy file is consumed')

    const index = JSON.parse(await readFile(path.join(sessionsDir, 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string; messageCount: number }>
    }
    assert.equal(index.sessions.filter((item) => item.id === id).length, 1)
    assert.equal(index.sessions.find((item) => item.id === id)?.messageCount, 0)
  })
})

/** Replaces the JSONL file with a directory after the read, so the rewrite fails. */
class BrokenRewriteStore extends SessionStore {
  constructor(cwd: string, private readonly afterLoad: (sessionId: string) => Promise<void>) {
    super(cwd)
  }

  override async loadRecordsWithDiagnostics(sessionIdOrPrefix: string): Promise<LoadRecordsResult> {
    const result = await super.loadRecordsWithDiagnostics(sessionIdOrPrefix)
    await this.afterLoad(sessionIdOrPrefix)
    return result
  }
}

test('a failed repair rewrite releases the lock and leaves the index alone', async () => {
  await withTempStore(async (cwd) => {
    const setup = new SessionStore(cwd)
    await setup.init()
    const session = await setup.create()
    await setup.appendRecord(session.id, userMessage('u-1'))
    await setup.appendRecord(session.id, toolUse('call-1'))
    await setup.appendRecord(session.id, orphanResult('result-2'))

    const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)
    const indexPath = path.join(getSessionsDir(cwd), 'index.json')
    const indexBefore = await readFile(indexPath, 'utf8')

    const store = new BrokenRewriteStore(cwd, async (id) => {
      const target = path.join(getSessionsDir(cwd), `${id}.jsonl`)
      await rm(target, { force: true })
      await mkdir(target)
    })
    await store.init()

    await assert.rejects(store.repairRecords(session.id))
    assert.equal(existsSync(`${jsonlPath}.lock`), false, 'a failing rewrite must still release the lock')
    assert.equal(await readFile(indexPath, 'utf8'), indexBefore, 'the index is only written after the JSONL rewrite')
  })
})

test('another process cannot append into a repair in flight', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-repair-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))

  const setup = new SessionStore(cwd)
  await setup.init()
  const session = await setup.create()
  await setup.appendRecord(session.id, toolUse('call-1'))
  await setup.appendRecord(session.id, orphanResult('result-2'))

  const repairing = new GatedLoadStore(cwd)
  await repairing.init()

  const child = `
import { SessionStore } from ${JSON.stringify(new URL('src/sessions/service.js', repoRootUrl).href)}
const store = new SessionStore(process.argv[2])
await store.init()
process.send({ ready: true })
for (let i = 0; i < 10; i += 1) {
  await store.appendRecord(process.argv[3], {
    type: 'message', id: 'child-' + i, role: 'user', content: 'c' + i,
    createdAt: new Date().toISOString(),
  })
}
process.send({ done: true })
`
  const entry = path.join(cwd, 'writer.mjs')
  await writeFile(entry, child, 'utf8')

  const gate = repairing.gateLoad()
  const repair = repairing.repairRecords(session.id)
  await gate.loaded

  const proc = fork(entry, [cwd, session.id], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('tsconfig.json', repoRootUrl)) },
  })
  t.after(() => proc.kill())

  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  let markReady!: () => void
  let markDone!: () => void
  const ready = new Promise<void>((resolve) => { markReady = resolve })
  const done = new Promise<void>((resolve) => { markDone = resolve })
  proc.on('message', (message: { ready?: boolean; done?: boolean }) => {
    if (message.ready) markReady()
    if (message.done) markDone()
  })
  proc.on('exit', (code) => {
    if (code !== 0) markDone()
  })

  await ready
  let finished = false
  done.then(() => { finished = true })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(finished, false, 'the child must be blocked on the session file lock')

  gate.release()
  await Promise.all([repair, done])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stderr, '')

  const records = await setup.loadRecords(session.id)
  const ids = new Set(records.map((record) => record.id))
  for (let i = 0; i < 10; i += 1) assert.ok(ids.has(`child-${i}`), `lost child-${i}`)
  assert.ok(records.some((record) => record.type === 'tool_result' && record.toolUseId === 'call-1'))
  assert.equal((await setup.load(session.id))?.messageCount, 10)
})