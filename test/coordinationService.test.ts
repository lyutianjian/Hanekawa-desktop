import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { CoordinationSettings } from '../src/config/settings.js'
import type { CoordinationLaneControl } from '../src/runtime/protocol/coordinationHost.js'
import {
  CoordinationService,
  type CoordinationEngineHooks,
  type CoordinationPort,
} from '../src/runtime/coordination/service.js'
import { OPENING_THREAD } from '../src/runtime/coordination/messages.js'
import { SessionStore } from '../src/sessions/service.js'

class FakeControl implements CoordinationLaneControl {
  enqueued: string[] = []
  models: string[] = []
  efforts: string[] = []
  stops = 0
  streaming = false
  async enqueueFromCoordinator(text: string): Promise<void> { this.enqueued.push(text) }
  wakes: string[] = []
  requestWake(text: string): void { this.wakes.push(text) }
  async stop(): Promise<void> { this.stops++ }
  setModel(key: string): void { this.models.push(key) }
  setEffort(level: string): void { this.efforts.push(level) }
  state() { return { streaming: this.streaming, pendingApproval: false, pendingDialog: false } }
  onStateChange(): () => void { return () => {} }
}

async function setup(t: TestContext, options: { git?: boolean } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'coord-svc-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
  if (options.git) {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 't')
    git('config', 'user.email', 't@example.com')
    await writeFile(path.join(cwd, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
  }
  const sessions = new SessionStore(cwd)
  await sessions.init()
  const lanes = new Map<string, FakeControl>()
  const opened: Array<{ sessionId: string; activate: boolean }> = []
  const notices: Array<{ title: string; body: string; sessionId: string }> = []
  const settings: CoordinationSettings = { threadModel: 'thread-model' }
  const port: CoordinationPort = {
    storeFor: () => sessions,
    laneControl: (id) => lanes.get(id),
    async openLane(_cwd, sessionId, { activate }) {
      opened.push({ sessionId, activate })
      let control = lanes.get(sessionId)
      if (!control) lanes.set(sessionId, control = new FakeControl())
      return control
    },
    notify: (n) => { notices.push(n) },
    settings: () => settings,
  }
  const calls: string[] = []
  const engine: CoordinationEngineHooks = {
    beginThreadStart: () => { calls.push('begin') },
    endThreadStart: () => { calls.push('end') },
    markStopped: (_c, id) => { calls.push(`stopped:${id}`) },
    noteQuestion: (_c, id, q) => { calls.push(`question:${id}:${q}`) },
  }
  const service = new CoordinationService(port, engine)
  const coordinatorId = await service.ensureCoordinator(cwd)
  const caller = { sessionId: coordinatorId, projectDir: cwd }
  const store = service.coordinationStore(cwd)
  const thread = async (id: string) => (await store.read()).threads.find((th) => th.threadId === id)!
  return { cwd, git, sessions, lanes, port, engine, opened, notices, settings, calls, service, caller, store, thread, coordinatorId }
}

const request = { title: 'Fix the bug', brief: 'Fix it', background: 'b'.repeat(80), writesCode: false }

async function commitIn(dir: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(dir, file), content)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir })
  g('add', '.')
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'c')
}

test('startThread in the shared directory sets the role before opening the lane', async (t) => {
  const s = await setup(t)
  const started = await s.service.startThread(s.caller, request)
  const meta = await s.sessions.resolve(started.sessionId)
  assert.equal(meta?.coordination?.role, 'thread')
  assert.equal(meta?.coordination?.threadId, started.threadId)
  assert.equal(meta?.coordination?.workingDir, undefined)
  assert.deepEqual(s.opened, [{ sessionId: started.sessionId, activate: false }])
  const lane = s.lanes.get(started.sessionId)!
  assert.deepEqual(lane.models, ['thread-model'])
  assert.match(lane.enqueued[0]!, /Task:\nFix it/)
  assert.equal((await s.thread(started.threadId)).status, 'running')
  assert.deepEqual(s.calls, ['begin', 'end'])
})

test('startThread with code gets its own worktree', async (t) => {
  const s = await setup(t, { git: true })
  const started = await s.service.startThread(s.caller, { ...request, writesCode: true })
  const record = await s.thread(started.threadId)
  assert.equal(started.branch, record.worktree?.branch)
  assert.ok(existsSync(record.worktree!.path))
  assert.equal((await s.sessions.resolve(started.sessionId))?.coordination?.workingDir, record.worktree!.cwd)
  t.after(() => rm(record.worktree!.path, { recursive: true, force: true }))
})

test('a thread whose worktree cannot be created leaves no row and no note', async (t) => {
  const s = await setup(t)
  await writeFile(path.join(s.cwd, '.git'), 'not a gitfile\n')
  await assert.rejects(s.service.startThread(s.caller, { ...request, writesCode: true }), { code: 'WORKTREE_FAILED' })
  const file = await s.store.read()
  assert.equal(file.threads.length, 0)
  assert.equal(file.coordinator?.notes.length ?? 0, 0)
  assert.deepEqual(s.calls, ['begin', 'end'])
  assert.equal(s.opened.length, 0)
})

test('only the coordinator may call; AskCoordinator needs a thread', async (t) => {
  const s = await setup(t)
  const started = await s.service.startThread(s.caller, request)
  const threadCaller = { sessionId: started.sessionId, projectDir: s.cwd }
  await assert.rejects(s.service.listThreads(threadCaller), { code: 'NOT_COORDINATOR' })
  await assert.rejects(s.service.askCoordinator(s.caller, 'q'), { code: 'THREAD_NOT_FOUND' })
  await s.service.askCoordinator(threadCaller, 'which file?')
  assert.ok(s.calls.includes(`question:${started.sessionId}:which file?`))
})

test('messageThread enqueues on idle and running lanes and cold-opens an unloaded one', async (t) => {
  const s = await setup(t)
  const started = await s.service.startThread(s.caller, request)
  const lane = s.lanes.get(started.sessionId)!
  await s.service.messageThread(s.caller, started.threadId, 'idle msg')
  lane.streaming = true
  await s.service.messageThread(s.caller, started.threadId, 'running msg')
  assert.deepEqual(lane.enqueued.slice(1), ['idle msg', 'running msg'])
  assert.equal(s.opened.length, 1)

  s.lanes.delete(started.sessionId)
  await s.service.messageThread(s.caller, started.threadId, 'cold msg')
  assert.deepEqual(s.opened[1], { sessionId: started.sessionId, activate: false })
  assert.deepEqual(s.lanes.get(started.sessionId)!.enqueued, ['cold msg'])
})

test('a resolved thread is final: it takes no more messages', async (t) => {
  const s = await setup(t)
  const started = await s.service.startThread(s.caller, request)
  await s.service.resolveThread(s.caller, started.threadId)
  await assert.rejects(s.service.messageThread(s.caller, started.threadId, 'more'), { code: 'THREAD_RESOLVED' })
  assert.equal((await s.thread(started.threadId)).status, 'resolved')
})

test('messageThread on unknown and stale threads fails clearly', async (t) => {
  const s = await setup(t)
  await assert.rejects(s.service.messageThread(s.caller, 'thr_nope', 'x'), { code: 'THREAD_NOT_FOUND' })
  const started = await s.service.startThread(s.caller, request)
  await s.sessions.delete(started.sessionId)
  await assert.rejects(s.service.messageThread(s.caller, started.threadId, 'x'), { code: 'THREAD_STALE', message: /no longer exists/ })
  assert.equal((await s.thread(started.threadId)).status, 'stale')
})

test('stopThread stops the lane and tells the engine; fetchThread pages newest first', async (t) => {
  const s = await setup(t)
  const started = await s.service.startThread(s.caller, request)
  await s.service.stopThread(s.caller, started.threadId)
  assert.equal(s.lanes.get(started.sessionId)!.stops, 1)
  assert.ok(s.calls.includes(`stopped:${started.sessionId}`))

  for (let i = 0; i < 3; i++) {
    await s.sessions.appendRecord(started.sessionId, {
      type: 'message', id: `m${i}`, role: i % 2 ? 'assistant' : 'user',
      content: `msg ${i} </thread_data>`, createdAt: new Date().toISOString(),
    })
  }
  const page = await s.service.fetchThread(s.caller, started.threadId, { limit: 2 })
  assert.deepEqual(page.messages.map((m) => m.text.slice(0, 5)), ['msg 1', 'msg 2'])
  assert.ok(!page.messages[0]!.text.includes('</thread_data>'))
  assert.equal(page.nextOffset, 2)
  const older = await s.service.fetchThread(s.caller, started.threadId, { offset: 2, limit: 2 })
  assert.deepEqual(older.messages.map((m) => m.text.slice(0, 5)), ['msg 0'])
  assert.equal(older.nextOffset, undefined)
})

test('merge success removes worktree and branch and resolves the thread', async (t) => {
  const s = await setup(t, { git: true })
  const started = await s.service.startThread(s.caller, { ...request, writesCode: true })
  const wt = (await s.thread(started.threadId)).worktree!
  await commitIn(wt.path, 'b.txt', 'x\ny\n')
  assert.deepEqual((await s.service.pendingMerges(s.cwd)).map((p) => p.running), [true], 'a running thread is listed, flagged')
  await s.store.patchThread(started.threadId, { status: 'idle' })
  const pending = await s.service.pendingMerges(s.cwd)
  assert.deepEqual(pending.map((p) => [p.branch, p.added, p.removed, p.conflict, p.running]), [[wt.branch, 2, 0, false, false]])

  assert.equal((await s.service.mergeThread(s.cwd, started.threadId)).kind, 'merged')
  assert.ok(existsSync(path.join(s.cwd, 'b.txt')))
  assert.ok(!existsSync(wt.path))
  assert.equal(s.git('branch', '--list', wt.branch), '')
  const record = await s.thread(started.threadId)
  assert.equal(record.status, 'resolved')
  assert.equal(record.statusLine, 'merged')
  assert.equal(record.worktree, undefined)
})

test('merge refuses a dirty tree and aborts a conflict', async (t) => {
  const s = await setup(t, { git: true })
  const started = await s.service.startThread(s.caller, { ...request, writesCode: true })
  const wt = (await s.thread(started.threadId)).worktree!
  t.after(() => rm(wt.path, { recursive: true, force: true }))
  await s.store.patchThread(started.threadId, { status: 'idle' })
  await commitIn(wt.path, 'a.txt', 'theirs\n')

  await writeFile(path.join(s.cwd, 'a.txt'), 'dirty\n')
  const dirty = await s.service.mergeThread(s.cwd, started.threadId)
  assert.equal(dirty.kind, 'dirty')
  assert.match(dirty.message!, /uncommitted/)

  s.git('checkout', '--', 'a.txt')
  await commitIn(s.cwd, 'a.txt', 'ours\n')
  assert.equal((await s.service.mergeThread(s.cwd, started.threadId)).kind, 'conflict')
  assert.equal(s.git('status', '--porcelain'), '')
  assert.equal((await s.thread(started.threadId)).merge?.conflict, true)
  assert.equal((await s.service.pendingMerges(s.cwd))[0]?.conflict, true)

  await s.service.resolveConflictViaThread(s.cwd, started.threadId)
  assert.match(s.lanes.get(started.sessionId)!.enqueued.at(-1)!, /conflicts with the project's current branch \(main\)/)
})

test('dismissMerge hides the prompt until the branch gets a new commit', async (t) => {
  const s = await setup(t, { git: true })
  const started = await s.service.startThread(s.caller, { ...request, writesCode: true })
  const wt = (await s.thread(started.threadId)).worktree!
  t.after(() => rm(wt.path, { recursive: true, force: true }))
  await s.store.patchThread(started.threadId, { status: 'idle' })
  await commitIn(wt.path, 'b.txt', 'x\n')
  await s.service.dismissMerge(s.cwd, started.threadId)
  assert.deepEqual(await s.service.pendingMerges(s.cwd), [])
  await commitIn(wt.path, 'c.txt', 'y\n')
  assert.equal((await s.service.pendingMerges(s.cwd)).length, 1)
})

test('reconcileOnStartup marks running threads interrupted and unlocks wakes', async (t) => {
  const s = await setup(t)
  const started = await s.service.startThread(s.caller, request)
  await s.store.setWakeLocked(true)
  await s.service.reconcileOnStartup(s.cwd)
  assert.equal((await s.thread(started.threadId)).status, 'interrupted')
  assert.equal((await s.store.read()).coordinator?.wakeLocked, false)
})

test('ensureCoordinator creates once and recreates when the session is gone', async (t) => {
  const s = await setup(t)
  assert.equal(await s.service.ensureCoordinator(s.cwd), s.coordinatorId)
  assert.equal((await s.sessions.resolve(s.coordinatorId))?.coordination?.role, 'coordinator')
  await s.sessions.delete(s.coordinatorId)
  const next = await s.service.ensureCoordinator(s.cwd)
  assert.notEqual(next, s.coordinatorId)
  assert.equal(await s.store.getCoordinatorSessionId(), next)
  s.settings.coordinatorModel = 'coord-model'
  await s.sessions.delete(next)
  const third = await s.service.ensureCoordinator(s.cwd)
  assert.deepEqual(s.lanes.get(third)!.models, ['coord-model'])
})

test('reseedCoordinator seeds a new session from the last summary and moves the pointer once', async (t) => {
  const s = await setup(t)
  const oldId = s.coordinatorId
  await s.sessions.appendRecord(oldId, {
    id: 'b1', type: 'compact_boundary', summary: 'first summary', preTokens: 10, createdAt: '2026-01-01T00:00:00Z',
  })
  await s.sessions.appendRecord(oldId, {
    id: 'b2', type: 'compact_boundary', summary: 'latest summary', preTokens: 10, createdAt: '2026-01-01T00:00:01Z',
  })
  await s.store.enqueueNote({ threadId: 't', kind: 'report', userDriven: false, text: 'queued note', at: '2026-01-01T00:00:00Z' })

  const newId = await s.service.reseedCoordinator(s.cwd, oldId)
  assert.notEqual(newId, oldId)
  const file = await s.store.read()
  assert.equal(file.coordinator?.sessionId, newId)
  assert.deepEqual(file.coordinator?.notes.map((n) => n.text), ['queued note'])
  assert.equal((await s.sessions.resolve(newId))?.coordination?.role, 'coordinator')
  assert.equal((await s.sessions.resolve(oldId))?.coordination?.role, 'coordinator')

  const records = await s.sessions.loadRecords(newId)
  assert.equal(records.length, 1)
  const seed = records[0]!
  assert.equal(seed.type, 'compact_boundary')
  if (seed.type !== 'compact_boundary') return
  assert.equal(seed.postCompactRestore, 'pending')
  assert.equal(seed.preTokens, 0)
  assert.match(seed.summary, new RegExp(oldId))
  assert.match(seed.summary, /latest summary/)
  assert.doesNotMatch(seed.summary, /first summary/)

  assert.deepEqual(s.opened, [{ sessionId: newId, activate: false }])
  assert.equal(s.notices.length, 1)
  assert.equal(s.notices[0]!.sessionId, newId)

  // The pointer already moved: a second trip from the old lane does nothing.
  assert.equal(await s.service.reseedCoordinator(s.cwd, oldId), newId)
  assert.equal(await s.store.getCoordinatorSessionId(), newId)
  assert.equal(s.opened.length, 1)
  assert.equal(await s.service.ensureCoordinator(s.cwd), newId)
})

test('threadInfos and the by-id commands work without a coordinator caller', async (t) => {
  const s = await setup(t)
  const a = await s.service.startThread(s.caller, request)
  const b = await s.service.startThread(s.caller, { ...request, title: 'Second' })
  await s.store.patchThread(a.threadId, { lastActivityAt: '2030-01-01T00:00:00Z', status: 'needs-you' })
  const info = await s.service.threadInfos(s.cwd)
  assert.equal(info.coordinatorSessionId, s.coordinatorId)
  assert.deepEqual(info.threads.map((th) => th.threadId), [a.threadId, b.threadId])
  assert.equal(info.threads[0]!.sessionId, a.sessionId)
  assert.equal(info.threads[0]!.needsUser, true)

  await s.service.stopThreadById(s.cwd, a.threadId)
  assert.equal(s.lanes.get(a.sessionId)!.stops, 1)
  await s.service.resolveThreadById(s.cwd, b.threadId, 'done')
  const after = (await s.service.threadInfos(s.cwd)).threads.find((th) => th.threadId === b.threadId)!
  assert.equal(after.status, 'resolved')
  assert.equal(after.statusLine, 'done')
  await assert.rejects(s.service.stopThreadById(s.cwd, 'thr_nope'), { code: 'THREAD_NOT_FOUND' })
})

test('onThreadsChanged fires on store writes until unsubscribed', async (t) => {
  const s = await setup(t)
  const seen: string[] = []
  const off = s.service.onThreadsChanged((cwd) => { seen.push(cwd) })
  await s.service.startThread(s.caller, request)
  assert.ok(seen.length > 0)
  assert.ok(seen.every((c) => c === s.cwd))
  off()
  const n = seen.length
  await s.store.update(() => {})
  assert.equal(seen.length, n)
})

test('coordinator and thread effort are applied with the model', async (t) => {
  const s = await setup(t)
  s.settings.threadEffort = 'low'
  s.settings.coordinatorEffort = 'high'
  const started = await s.service.startThread(s.caller, request)
  assert.deepEqual(s.lanes.get(started.sessionId)!.efforts, ['low'])
  await s.store.setCoordinatorSessionId('gone')
  const fresh = await s.service.ensureCoordinator(s.cwd)
  assert.notEqual(fresh, s.coordinatorId)
  assert.deepEqual(s.lanes.get(fresh)!.efforts, ['high'])
})

test('a coordinator created with opening starts one survey thread, and no coordinator turn', async (t) => {
  const h = await setup(t)
  assert.equal(await h.service.ensureCoordinator(h.cwd, { opening: true }), h.coordinatorId, 'an existing coordinator is reused')
  assert.equal((await h.store.read()).threads.length, 0, 'and opens nothing')

  const fresh = await mkdtemp(path.join(tmpdir(), 'coord-svc-open-'))
  t.after(() => rm(fresh, { recursive: true, force: true }))
  const sessions = new SessionStore(fresh)
  await sessions.init()
  const lanes = new Map<string, FakeControl>()
  const port: CoordinationPort = {
    ...h.port,
    storeFor: () => sessions,
    laneControl: (id) => lanes.get(id),
    async openLane(_cwd, id) {
      let lane = lanes.get(id)
      if (!lane) lanes.set(id, lane = new FakeControl())
      return lane
    },
  }
  const service = new CoordinationService(port, h.engine)
  const id = await service.ensureCoordinator(fresh, { opening: true })
  const file = await service.coordinationStore(fresh).read()
  assert.equal(file.threads.length, 1)
  const survey = file.threads[0]!
  assert.equal(survey.title, OPENING_THREAD.title)
  assert.equal(survey.worktree, undefined, 'the survey changes nothing, so it shares the project directory')
  assert.equal(file.coordinator!.openingThreadId, survey.threadId)
  assert.equal(lanes.get(survey.sessionId)!.enqueued.length, 1, 'the brief went to the thread')
  assert.deepEqual(lanes.get(id)?.wakes ?? [], [], 'the coordinator runs no turn of its own')
  assert.equal((await service.threadInfos(fresh)).openingThreadId, survey.threadId)
})

test('a survey that cannot start leaves no thread and tells the user', async (t) => {
  const h = await setup(t)
  const fresh = await mkdtemp(path.join(tmpdir(), 'coord-svc-open-'))
  t.after(() => rm(fresh, { recursive: true, force: true }))
  const sessions = new SessionStore(fresh)
  await sessions.init()
  const service = new CoordinationService({
    ...h.port,
    storeFor: () => sessions,
    async openLane() { throw new Error('no lane') },
  }, h.engine)
  const id = await service.ensureCoordinator(fresh, { opening: true })
  const file = await service.coordinationStore(fresh).read()
  assert.equal(file.threads.length, 0)
  assert.equal(file.coordinator!.openingThreadId, undefined)
  assert.equal(h.notices.at(-1)!.sessionId, id)
})
