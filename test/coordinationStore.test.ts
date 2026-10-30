import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CoordinationStore, newThreadId } from '../src/services/coordination/threadStore.js'
import { NOTE_QUEUE_MAX } from '../src/services/coordination/noteQueue.js'
import { getProjectDataDir } from '../src/utils/paths.js'
import type { CoordinatorNote, ThreadRecord } from '../src/services/coordination/types.js'

async function scratch(): Promise<{ cwd: string; store: CoordinationStore }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hanekawa-coord-'))
  return { cwd, store: new CoordinationStore(cwd) }
}

function thread(threadId: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    threadId, sessionId: `s_${threadId}`, title: 't', name: 'n', brief: 'b', background: 'bg',
    status: 'idle', createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:00:00Z', ...extra,
  }
}

function note(threadId: string, text = 'x'): CoordinatorNote {
  return { threadId, kind: 'report', userDriven: false, text, at: '2026-01-01T00:00:00Z' }
}

test('missing file reads as empty', async () => {
  const { store } = await scratch()
  assert.deepEqual(await store.read(), { version: 1, threads: [] })
  assert.equal(await store.getCoordinatorSessionId(), undefined)
})

test('newThreadId format', () => {
  assert.match(newThreadId(), /^thr_[0-9a-f]{12}$/)
})

test('upsert, patch, unknown patch throws, remove by session', async () => {
  const { store } = await scratch()
  await store.upsertThread(thread('a'))
  await store.upsertThread(thread('a', { title: 'new' }))
  await store.upsertThread(thread('b'))
  await store.patchThread('a', { status: 'running', statusLine: 'busy' })
  const f = await store.read()
  assert.equal(f.threads.length, 2)
  assert.equal(f.threads[0]!.title, 'new')
  assert.equal(f.threads[0]!.status, 'running')
  await assert.rejects(store.patchThread('nope', { title: 'x' }), /Unknown thread/)
  await store.removeThreadsBySession(['s_a'])
  assert.deepEqual((await store.read()).threads.map((t) => t.threadId), ['b'])
})

test('concurrent upserts all survive', async () => {
  const { store } = await scratch()
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.upsertThread(thread(`t${i}`))))
  assert.equal((await store.read()).threads.length, 20)
})

test('note queue dedupes per thread, caps, and drains', async () => {
  const { store } = await scratch()
  await store.setCoordinatorSessionId('coord')
  await store.enqueueNote(note('a', '1'))
  await store.enqueueNote(note('b', '2'))
  await store.enqueueNote(note('a', '3'))
  const f = await store.read()
  assert.deepEqual(f.coordinator!.notes.map((n) => `${n.threadId}:${n.text}`), ['b:2', 'a:3'])
  for (let i = 0; i < 40; i++) await store.enqueueNote(note(`x${i}`))
  assert.equal((await store.read()).coordinator!.notes.length, NOTE_QUEUE_MAX)
  assert.equal((await store.read()).coordinator!.notes[0]!.threadId, 'x8')
  const drained = await store.drainNotes()
  assert.equal(drained.length, NOTE_QUEUE_MAX)
  assert.deepEqual(await store.drainNotes(), [])
})

test('coordinator pointer change keeps threads and notes, resets counters', async () => {
  const { store } = await scratch()
  await store.upsertThread(thread('a'))
  await store.setCoordinatorSessionId('c1')
  await store.enqueueNote(note('a'))
  await store.setPendingSnapshot('snap')
  await store.setAutoWakeCount(3)
  await store.setWakeLocked(true)
  await store.setCoordinatorSessionId('c1')
  assert.equal((await store.read()).coordinator!.autoWakeCount, 3)
  await store.setCoordinatorSessionId('c2')
  const f = await store.read()
  assert.equal(f.coordinator!.sessionId, 'c2')
  assert.equal(f.coordinator!.autoWakeCount, 0)
  assert.equal(f.coordinator!.wakeLocked, false)
  assert.equal(f.coordinator!.notes.length, 1)
  assert.match(f.coordinator!.pendingSnapshot!, /Supersedes all previous snapshots/) // reseeded for the new coordinator session
  assert.equal(f.threads.length, 1)
  await store.setPendingSnapshot(undefined)
  assert.equal((await store.read()).coordinator!.pendingSnapshot, undefined)
})

test('corrupted file throws and is not overwritten', async () => {
  const { cwd, store } = await scratch()
  const file = path.join(getProjectDataDir(cwd), 'coordination', 'coordination.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{not json', 'utf8')
  await assert.rejects(store.read(), /corrupted/)
  await assert.rejects(store.upsertThread(thread('a')), /corrupted/)
  assert.equal(await readFile(file, 'utf8'), '{not json')
})

test('removeAll deletes the coordination dir; threadsDir is lazy', async () => {
  const { cwd, store } = await scratch()
  assert.equal(existsSync(store.threadsDir()), false)
  await store.upsertThread(thread('a'))
  await mkdir(store.threadsDir(), { recursive: true })
  await store.removeAll()
  assert.equal(existsSync(path.join(getProjectDataDir(cwd), 'coordination')), false)
  assert.deepEqual((await store.read()).threads, [])
})

test('thread changes regenerate the pending snapshot only with a coordinator', async () => {
  const { store } = await scratch()
  await store.upsertThread(thread('thr_a', { status: 'running' }))
  assert.equal((await store.read()).coordinator, undefined)
  await store.setCoordinatorSessionId('coord')
  const seeded = (await store.read()).coordinator!.pendingSnapshot!
  assert.match(seeded, /Supersedes all previous snapshots/)
  assert.match(seeded, /thr_a/)
  await store.patchThread('thr_a', { status: 'needs-you' })
  assert.match((await store.read()).coordinator!.pendingSnapshot!, /\[needs-you\]/)
})

test('peek/ack keeps notes enqueued in between and snapshots changed in between', async () => {
  const { store } = await scratch()
  await store.setCoordinatorSessionId('coord')
  await store.upsertThread(thread('thr_a', { status: 'running' }))
  await store.enqueueNote({ ...note('thr_a'), at: '2026-01-01T00:00:01Z' })
  const peeked = (await store.peekCoordinationUpdate())!
  assert.equal(peeked.notes.length, 1)
  assert.ok(peeked.snapshot)
  assert.equal((await store.read()).coordinator!.notes.length, 1) // peek consumes nothing
  await store.enqueueNote({ ...note('thr_b'), at: '2026-01-01T00:00:02Z' })
  await store.upsertThread(thread('thr_b', { status: 'running' }))
  await store.ackCoordinationUpdate(peeked)
  const c = (await store.read()).coordinator!
  assert.deepEqual(c.notes.map((n) => n.threadId), ['thr_b'])
  assert.match(c.pendingSnapshot!, /thr_b/)
  const again = (await store.peekCoordinationUpdate())!
  await store.ackCoordinationUpdate(again)
  assert.equal(await store.peekCoordinationUpdate(), undefined)
})

test('currentBoard renders fresh', async () => {
  const { store } = await scratch()
  await store.upsertThread(thread('thr_a', { status: 'running', name: 'alpha' }))
  assert.match(await store.currentBoard(), /alpha/)
})

test('onWrite fires once per update and on removeAll', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hanekawa-coord-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let writes = 0
  const store = new CoordinationStore(cwd, { onWrite: () => { writes++ } })
  await store.upsertThread(thread('thr_a'))
  assert.equal(writes, 1)
  await assert.rejects(store.patchThread('thr_missing', {}))
  assert.equal(writes, 1)
  await store.removeAll()
  assert.equal(writes, 2)
})
