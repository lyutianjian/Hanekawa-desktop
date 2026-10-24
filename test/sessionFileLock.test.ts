import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileLockError, withFileLock } from '../src/sessions/fileLock.js'
import { SessionStore } from '../src/sessions/service.js'
import { getSessionsDir } from '../src/utils/paths.js'

/**
 * `SessionStore`'s promise-chain mutexes are static fields: they order writers
 * inside one process and do nothing between two. These cover the advisory file
 * lock that closes that gap, including the case that actually matters — two
 * processes appending to the same session.
 */

const repoRootUrl = new URL('..', import.meta.url)

async function lockDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'myagent-lock-'))
}

test('a second holder waits for the first to finish', async () => {
  const dir = await lockDir()
  const lockPath = path.join(dir, 'target.lock')
  const order: string[] = []

  const first = withFileLock(lockPath, async () => {
    order.push('first:start')
    await new Promise((resolve) => setTimeout(resolve, 60))
    order.push('first:end')
  })

  // Started after the first has certainly taken the lock.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = withFileLock(lockPath, async () => {
    order.push('second:start')
  })

  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start'])
})

test('the lock file is removed after the operation, including on throw', async () => {
  const dir = await lockDir()
  const lockPath = path.join(dir, 'target.lock')

  await withFileLock(lockPath, async () => {
    assert.equal(existsSync(lockPath), true, 'held during the operation')
  })
  assert.equal(existsSync(lockPath), false)

  await assert.rejects(withFileLock(lockPath, async () => { throw new Error('boom') }), /boom/)
  assert.equal(existsSync(lockPath), false, 'a throwing operation must still release')
})

test('the operation result is returned unchanged', async () => {
  const dir = await lockDir()
  assert.equal(await withFileLock(path.join(dir, 'x.lock'), async () => 42), 42)
})

test('a stale lock owned by a dead process is stolen', async () => {
  const dir = await lockDir()
  const lockPath = path.join(dir, 'target.lock')

  // pid 1 exists but is not ours; use an unreachable pid instead. Very high
  // pids are not assigned on either platform in practice.
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 0x7ffffff0, host: 'this-host-does-not-exist', acquiredAt: 0 }),
    'utf8',
  )

  let ran = false
  await withFileLock(lockPath, async () => { ran = true }, { staleMs: 0, timeoutMs: 2_000 })
  assert.equal(ran, true, 'a crashed holder must not block the project forever')
})

test('a fresh lock is not stolen even when its owner is unknown', async () => {
  const dir = await lockDir()
  const lockPath = path.join(dir, 'target.lock')
  await writeFile(lockPath, JSON.stringify({ pid: 0x7ffffff0, host: 'elsewhere', acquiredAt: Date.now() }), 'utf8')

  const started = Date.now()
  let ran = false
  // Times out rather than blocking forever: losing the guard beats wedging a
  // session write behind another process we cannot inspect.
  await withFileLock(lockPath, async () => { ran = true }, { staleMs: 60_000, timeoutMs: 150 })

  assert.equal(ran, true)
  assert.ok(Date.now() - started >= 140, 'it should have waited out the timeout first')
})

test('the lock records who holds it', async () => {
  const dir = await lockDir()
  const lockPath = path.join(dir, 'target.lock')

  await withFileLock(lockPath, async () => {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }
    assert.equal(owner.pid, process.pid)
  })
})

test('two processes appending to one session do not lose records', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-lock-store-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('concurrent writers')
  // Drafts live in memory until the first message record, so materialize it.
  await store.appendRecord(session.id, {
    type: 'message', id: 'seed', role: 'user', content: 'seed', createdAt: new Date().toISOString(),
  })

  const child = `
import { SessionStore } from ${JSON.stringify(new URL('src/sessions/service.js', repoRootUrl).href)}
const store = new SessionStore(process.argv[2])
await store.init()
for (let i = 0; i < 25; i += 1) {
  await store.appendRecord(process.argv[3], {
    type: 'message', id: 'child-' + i, role: 'user', content: 'c' + i,
    createdAt: new Date().toISOString(),
  })
}
process.send({ done: true })
`
  const entry = path.join(cwd, 'writer.mjs')
  await writeFile(entry, child, 'utf8')

  const proc = fork(entry, [cwd, session.id], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('tsconfig.json', repoRootUrl)) },
  })
  t.after(() => proc.kill())

  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  const childDone = new Promise<void>((resolve, reject) => {
    proc.on('message', () => resolve())
    proc.on('exit', (code) => reject(new Error(`writer exited with ${code}\n${stderr}`)))
  })

  // Interleave the parent's appends with the child's.
  const parentWrites = (async () => {
    for (let i = 0; i < 25; i += 1) {
      await store.appendRecord(session.id, {
        type: 'message', id: `parent-${i}`, role: 'user', content: `p${i}`,
        createdAt: new Date().toISOString(),
      })
    }
  })()

  await Promise.all([childDone, parentWrites])

  const loaded = await store.loadRecordsWithDiagnostics(session.id)
  const ids = new Set(loaded.records.map((record) => record.id))
  for (let i = 0; i < 25; i += 1) {
    assert.ok(ids.has(`parent-${i}`), `lost parent-${i}`)
    assert.ok(ids.has(`child-${i}`), `lost child-${i}`)
  }
  assert.deepEqual(loaded.diagnostics.filter((d) => d.code === 'malformed_jsonl'), [],
    'interleaved appends must not tear a line')
})

test('requireLock fails instead of running the operation without the lock', async () => {
  const dir = await lockDir()
  const lockPath = path.join(dir, 'target.lock')
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: 'local', acquiredAt: Date.now() }), 'utf8')

  let ran = false
  await assert.rejects(
    withFileLock(lockPath, async () => { ran = true }, { requireLock: true, staleMs: 60_000, timeoutMs: 100 }),
    (error: unknown) => error instanceof FileLockError && error.reason === 'timeout',
  )
  assert.equal(ran, false, 'a strict caller must not run while a live peer holds the lock')
})

test('an uncreatable lock fails strictly and stays advisory by default', async () => {
  const dir = await lockDir()
  const blocker = path.join(dir, 'not-a-directory')
  await writeFile(blocker, 'file', 'utf8')
  const lockPath = path.join(blocker, 'target.lock')

  let ran = false
  await assert.rejects(
    withFileLock(lockPath, async () => { ran = true }, { requireLock: true }),
    (error: unknown) => error instanceof FileLockError && error.reason === 'unavailable',
  )
  assert.equal(ran, false)

  // The default callers keep their existing policy: the write still runs.
  await withFileLock(lockPath, async () => { ran = true })
  assert.equal(ran, true)
})

test('a session append waits for the file lock instead of writing unlocked', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-lock-store-'))
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)

    let releaseHeld!: () => void
    const held = new Promise<void>((resolve) => { releaseHeld = resolve })
    const holder = withFileLock(`${jsonlPath}.lock`, () => held)
    await new Promise((resolve) => setTimeout(resolve, 20))

    let settled = false
    const append = store.appendRecord(session.id, {
      type: 'message', id: 'blocked', role: 'user', content: 'blocked', createdAt: new Date().toISOString(),
    }).finally(() => { settled = true })

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(settled, false, 'the record must not be written without the lock')

    releaseHeld()
    await Promise.all([holder, append])
    assert.ok((await store.loadRecords(session.id)).some((record) => record.id === 'blocked'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
