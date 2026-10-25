import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CoordinationWakeEngine, type WakeEnginePort, type WakeLaneController } from '../src/runtime/coordination/wakeEngine.js'
import { CoordinationStore } from '../src/services/coordination/threadStore.js'
import { AUTO_WAKE_LIMIT } from '../src/runtime/coordination/wakeDecision.js'
import type { ThreadRecord } from '../src/services/coordination/types.js'
import type { CoordinationLaneControl, WakeDiscardReason } from '../src/runtime/protocol/coordinationHost.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { CoordinationRole, TurnOrigin } from '../src/harness/types.js'
import type { SessionMeta } from '../src/sessions/service.js'

const COORD = 's_coord'

class FakeLane implements CoordinationLaneControl, WakeLaneController {
  streaming = false
  pendingApproval = false
  wakes: string[] = []
  onDiscard: ((reason: WakeDiscardReason) => void) | undefined
  wakeError: Error | undefined
  compactFailureCount: number | undefined
  private events = new Set<(e: SessionEvent) => void>()
  private states = new Set<() => void>()
  constructor(readonly id: string, readonly role: CoordinationRole) {}
  // WakeLaneController
  onEvent(l: (e: SessionEvent) => void) { this.events.add(l); return () => this.events.delete(l) }
  getSessionMeta() {
    return { id: this.id, coordination: { role: this.role, projectKey: 'k' }, compactFailureCount: this.compactFailureCount } as unknown as SessionMeta
  }
  getSessionId() { return this.id }
  // CoordinationLaneControl
  async enqueueFromCoordinator() {}
  requestWake(text: string, onDiscard?: (reason: WakeDiscardReason) => void) {
    if (this.wakeError) throw this.wakeError
    this.wakes.push(text)
    this.onDiscard = onDiscard
  }
  async stop() {}
  setModel() {}
  setEffort() {}
  state() { return { streaming: this.streaming, pendingApproval: this.pendingApproval, pendingDialog: false } }
  onStateChange(l: () => void) { this.states.add(l); return () => this.states.delete(l) }
  // drivers
  emit(e: SessionEvent) { for (const l of this.events) l(e) }
  start(origin: TurnOrigin) {
    this.streaming = true
    this.emit({ type: 'turn-start', messageId: 'm', displayInput: '', createdAt: '', origin })
  }
  say(content: string) {
    this.emit({ type: 'record', record: { type: 'message', id: 'r', role: 'assistant', content, createdAt: '' } })
  }
  end(origin: TurnOrigin, extra: { aborted?: boolean; failed?: boolean } = {}) {
    this.streaming = false
    this.emit({ type: 'turn-end', origin, failed: extra.failed ?? false, aborted: extra.aborted ?? false, rolledBack: false, durationMs: 1 })
  }
  setApproval(b: boolean) { this.pendingApproval = b; for (const l of this.states) l() }
}

async function setup(threadCount = 2, options: { reseed?: (cwd: string, sessionId: string) => Promise<string> } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-wake-'))
  const store = new CoordinationStore(cwd)
  await store.setCoordinatorSessionId(COORD)
  const lanes = new Map<string, FakeLane>()
  const opened: Array<{ sessionId: string; activate: boolean }> = []
  const notices: string[] = []
  const errors: unknown[] = []
  const port: WakeEnginePort = {
    storeFor: () => store,
    laneControl: (id) => lanes.get(id),
    openLane: async (_cwd, sessionId, { activate }) => {
      opened.push({ sessionId, activate })
      const lane = new FakeLane(sessionId, 'coordinator')
      lanes.set(sessionId, lane)
      return lane
    },
    notify: (n) => notices.push(n.title),
    onError: (e) => errors.push(e),
    ...(options.reseed ? { reseedCoordinator: options.reseed } : {}),
  }
  const engine = new CoordinationWakeEngine(port)
  const attach = (lane: FakeLane) => { lanes.set(lane.id, lane); return engine.attachLane(cwd, lane, lane) }
  const coord = new FakeLane(COORD, 'coordinator')
  attach(coord)
  const threads: FakeLane[] = []
  for (let i = 0; i < threadCount; i++) {
    const t = new FakeLane(`s_t${i}`, 'thread')
    await store.upsertThread(thread(`t${i}`, t.id))
    attach(t)
    threads.push(t)
  }
  const settle = async () => { await engine.idle(cwd); await engine.idle(cwd) }
  return { cwd, store, engine, coord, threads, lanes, opened, notices, errors, attach, settle }
}

function thread(threadId: string, sessionId: string): ThreadRecord {
  return {
    threadId, sessionId, title: `title ${threadId}`, name: threadId, brief: 'b', background: 'bg',
    status: 'running', createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:00:00Z',
  }
}

async function runThread(t: FakeLane, origin: TurnOrigin = 'coordinator', text = 'did it', extra = {}) {
  t.start(origin)
  t.say(text)
  t.end(origin, extra)
}

test('a pending wake discarded before turn start restores notes and count once, without immediately waking again', async () => {
  for (const reason of ['stopped', 'failed', 'detached'] as const) {
    const h = await setup(1)
    await runThread(h.threads[0]!, 'coordinator', 'old report')
    await h.settle()
    const discard = h.coord.onDiscard
    assert.ok(discard)
    discard(reason)
    discard(reason)
    await h.settle()
    const coord = (await h.store.read()).coordinator!
    assert.equal(coord.wakeLocked, false)
    assert.equal(coord.autoWakeCount, 0)
    assert.equal(coord.notes.length, 1)
    assert.match(coord.notes[0]!.text, /old report/)
    assert.equal(h.coord.wakes.length, 1)
    h.coord.start('user'); h.coord.end('user')
    await h.settle()
    assert.equal(h.coord.wakes.length, 2)
    discard(reason)
    await h.settle()
    assert.equal((await h.store.read()).coordinator!.wakeLocked, true, 'an old receipt cannot cancel the new wake')
    h.coord.start('wake'); h.coord.end('wake')
    await h.settle()
    assert.equal((await h.store.read()).coordinator!.wakeLocked, false)
  }
})

test('requestWake failure restores the drained notes and releases its lock', async () => {
  const h = await setup(1)
  h.coord.wakeError = new Error('lane failed')
  await runThread(h.threads[0]!)
  await h.settle()
  const coord = (await h.store.read()).coordinator!
  assert.equal(coord.wakeLocked, false)
  assert.equal(coord.autoWakeCount, 0)
  assert.equal(coord.notes.length, 1)
  assert.equal(h.errors.length, 1)
})

test('each report wakes the coordinator; the last says the threads have finished', async () => {
  const h = await setup()
  h.threads[0]!.start('coordinator'); h.threads[1]!.start('coordinator')
  h.threads[0]!.say('first done'); h.threads[0]!.end('coordinator')
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
  assert.match(h.coord.wakes[0]!, /first done/)
  assert.match(h.coord.wakes[0]!, /others are still running/)
  let f = await h.store.read()
  assert.equal(f.coordinator!.notes.length, 0)
  assert.equal(f.coordinator!.wakeLocked, true)
  assert.equal(f.threads[0]!.status, 'idle')
  assert.equal(f.threads[0]!.lastReport, 'first done')
  h.coord.start('wake'); h.coord.end('wake')
  await h.settle()

  h.threads[1]!.say('second done'); h.threads[1]!.end('coordinator')
  await h.settle()
  assert.equal(h.coord.wakes.length, 2)
  assert.match(h.coord.wakes[1]!, /second done/)
  assert.match(h.coord.wakes[1]!, /Your threads have finished/)
  f = await h.store.read()
  assert.equal(f.coordinator!.autoWakeCount, 2)
})

test('two threads ending in the same tick wake once', async () => {
  const h = await setup()
  h.threads[0]!.start('coordinator'); h.threads[1]!.start('coordinator')
  h.threads[0]!.end('coordinator'); h.threads[1]!.end('coordinator')
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
})

test('a question wakes immediately while another thread runs', async () => {
  const h = await setup()
  h.threads[1]!.start('coordinator')
  h.threads[0]!.start('coordinator')
  h.engine.noteQuestion(h.cwd, h.threads[0]!.id, 'which branch?')
  h.threads[0]!.end('coordinator')
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
  assert.match(h.coord.wakes[0]!, /which branch\?/)
  assert.equal((await h.store.read()).threads[0]!.status, 'awaiting-coordinator')
})

test('user-driven, stopped and failed thread turns only queue', async () => {
  const h = await setup(3)
  await runThread(h.threads[0]!, 'user')
  await runThread(h.threads[1]!, 'coordinator', 'x', { aborted: true })
  await runThread(h.threads[2]!, 'coordinator', 'x', { failed: true })
  await h.settle()
  assert.equal(h.coord.wakes.length, 0)
  const f = await h.store.read()
  assert.equal(f.coordinator!.notes.length, 3)
  assert.ok(f.coordinator!.notes.every((n) => n.userDriven))
  assert.deepEqual(f.threads.map((t) => t.status), ['idle', 'interrupted', 'failed'])
})

test('markStopped makes the ending turn queue-only and drops its question', async () => {
  const h = await setup(1)
  const t = h.threads[0]!
  t.start('coordinator')
  h.engine.noteQuestion(h.cwd, t.id, 'q?')
  h.engine.markStopped(h.cwd, t.id)
  t.end('coordinator')
  await h.settle()
  assert.equal(h.coord.wakes.length, 0)
  const f = await h.store.read()
  assert.equal(f.threads[0]!.status, 'interrupted')
  assert.equal(f.coordinator!.notes[0]!.kind, 'report')
})

test('markStopped on a thread with no running turn marks it interrupted', async () => {
  const h = await setup(1)
  h.engine.markStopped(h.cwd, h.threads[0]!.id)
  await h.settle()
  assert.equal((await h.store.read()).threads[0]!.status, 'interrupted')
})

test('a thread resolved mid-turn stays resolved through its turn end and approvals', async () => {
  const h = await setup(1)
  const t = h.threads[0]!
  t.start('coordinator')
  await h.settle()
  await h.store.patchThread('t0', { status: 'resolved' })
  t.setApproval(true)
  t.end('coordinator')
  await h.settle()
  const f = await h.store.read()
  assert.equal(f.threads[0]!.status, 'resolved')
  assert.equal(h.coord.wakes.length, 1, 'its last report still goes out')
})

test('a running coordinator gets no wake, then exactly one at its turn-end', async () => {
  const h = await setup()
  h.coord.start('user')
  await runThread(h.threads[0]!)
  await runThread(h.threads[1]!)
  await h.settle()
  assert.equal(h.coord.wakes.length, 0)
  h.coord.end('user')
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
})

test('wake turn end releases the lock and replays a suppressed wake once', async () => {
  const h = await setup(1)
  const t = h.threads[0]!
  await runThread(t, 'coordinator', 'one')
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
  // Before the wake turn even starts, the thread reports again: locked, so suppressed.
  await runThread(t, 'coordinator', 'two')
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
  h.coord.start('wake'); h.coord.end('wake')
  await h.settle()
  assert.equal(h.coord.wakes.length, 2)
  assert.match(h.coord.wakes[1]!, /two/)
  // Nothing new: the next wake turn end does not wake again.
  h.coord.start('wake'); h.coord.end('wake')
  await h.settle()
  assert.equal(h.coord.wakes.length, 2)
  assert.equal((await h.store.read()).coordinator!.wakeLocked, false)
})

test(`the limit of ${AUTO_WAKE_LIMIT} counts question wakes and resets on a user coordinator turn`, async () => {
  const h = await setup(1)
  const t = h.threads[0]!
  for (let i = 0; i < AUTO_WAKE_LIMIT + 2; i++) {
    t.start('coordinator')
    if (i % 2) h.engine.noteQuestion(h.cwd, t.id, `q${i}`)
    t.end('coordinator')
    await h.settle()
    if (h.coord.wakes.length > 0 && i < AUTO_WAKE_LIMIT) { h.coord.start('wake'); h.coord.end('wake'); await h.settle() }
  }
  assert.equal(h.coord.wakes.length, AUTO_WAKE_LIMIT)
  assert.equal((await h.store.read()).coordinator!.autoWakeCount, AUTO_WAKE_LIMIT)
  h.coord.start('user')
  await h.settle()
  assert.equal((await h.store.read()).coordinator!.autoWakeCount, 0)
  h.coord.end('user')
  await h.settle()
  assert.equal(h.coord.wakes.length, AUTO_WAKE_LIMIT + 1)
})

test('a closed coordinator lane is cold-opened without activating', async () => {
  const h = await setup(1)
  h.lanes.delete(COORD)
  await runThread(h.threads[0]!)
  await h.settle()
  assert.deepEqual(h.opened, [{ sessionId: COORD, activate: false }])
  assert.equal(h.lanes.get(COORD)!.wakes.length, 1)
})

test('a closed coordinator lane with only user-driven notes is never opened', async () => {
  const h = await setup(1)
  h.lanes.delete(COORD)
  await runThread(h.threads[0]!, 'user')
  await h.settle()
  assert.deepEqual(h.opened, [])
})

test('a failed cold open puts the notes back and unlocks', async () => {
  const h = await setup(1)
  h.lanes.delete(COORD)
  const engine = new CoordinationWakeEngine({
    storeFor: () => h.store,
    laneControl: (id) => h.lanes.get(id),
    openLane: async () => { throw new Error('boom') },
    notify: () => {},
    onError: () => {},
  })
  const t = new FakeLane('s_t9', 'thread')
  await h.store.upsertThread(thread('t9', t.id))
  h.lanes.set(t.id, t)
  engine.attachLane(h.cwd, t, t)
  await runThread(t)
  await engine.idle(h.cwd)
  const c = (await h.store.read()).coordinator!
  assert.equal(c.notes.length, 1)
  assert.equal(c.wakeLocked, false)
  assert.equal(c.autoWakeCount, 0)
})

test('starting threads hold a converged wake until the start ends', async () => {
  const h = await setup(1)
  h.engine.beginThreadStart(h.cwd)
  await runThread(h.threads[0]!)
  await h.settle()
  assert.equal(h.coord.wakes.length, 0)
  h.engine.endThreadStart(h.cwd)
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
})

test('an interrupted coordinator is not woken until the user speaks', async () => {
  const h = await setup(1)
  h.coord.start('user'); h.coord.end('user', { aborted: true })
  await runThread(h.threads[0]!)
  await h.settle()
  assert.equal(h.coord.wakes.length, 0)
})

test('pending approval marks needs-you and notifies; settling returns to running', async () => {
  const h = await setup(1)
  const t = h.threads[0]!
  t.start('coordinator')
  t.setApproval(true)
  await h.settle()
  assert.equal((await h.store.read()).threads[0]!.status, 'needs-you')
  assert.deepEqual(h.notices, ['title t0'])
  t.setApproval(false)
  await h.settle()
  assert.equal((await h.store.read()).threads[0]!.status, 'running')
})

test('lanes without a coordination role are ignored; detach unsubscribes', async () => {
  const h = await setup(1)
  const plain = new FakeLane('s_plain', 'thread')
  plain.getSessionMeta = () => ({ id: 's_plain' }) as unknown as SessionMeta
  h.attach(plain)
  await runThread(plain)
  const detach = h.attach(new FakeLane('s_t0', 'thread'))
  detach()
  await h.settle()
  assert.equal((await h.store.read()).coordinator!.notes.length, 0)
  assert.deepEqual(h.errors, [])
})

test('the persisted wake lock holds across a new engine (restart)', async () => {
  const h = await setup(1)
  await runThread(h.threads[0]!)
  await h.settle()
  assert.equal(h.coord.wakes.length, 1)
  const engine = new CoordinationWakeEngine({
    storeFor: () => h.store, laneControl: (id) => h.lanes.get(id),
    openLane: async () => { throw new Error('unexpected') }, notify: () => {},
  })
  const t = new FakeLane('s_t0', 'thread')
  engine.attachLane(h.cwd, t, t)
  await runThread(t)
  await engine.idle(h.cwd)
  assert.equal(h.coord.wakes.length, 1)
  const c = (await h.store.read()).coordinator!
  assert.equal(c.wakeLocked, true)
  assert.equal(c.autoWakeCount, 1)
  assert.equal(c.notes.length, 1)
})

function reseeder(getStore: () => CoordinationStore, calls: string[]) {
  return async (_cwd: string, sessionId: string) => {
    calls.push(sessionId)
    const store = getStore()
    if ((await store.getCoordinatorSessionId()) !== sessionId) return (await store.getCoordinatorSessionId())!
    await store.setCoordinatorSessionId('s_coord2')
    return 's_coord2'
  }
}

test('a circuitOpen record on the coordinator lane reseeds at turn end, then wakes the new coordinator', async () => {
  const calls: string[] = []
  let store!: CoordinationStore
  const h = await setup(1, { reseed: reseeder(() => store, calls) })
  store = h.store
  h.coord.start('user')
  h.coord.emit({ type: 'record', record: {
    id: 'f', type: 'compact_attempt_failed', error: 'x', failureCount: 3, circuitOpen: true, preTokens: 1, createdAt: '',
  } })
  await h.settle()
  assert.deepEqual(calls, [])
  await runThread(h.threads[0]!)
  h.coord.end('user', { failed: true })
  await h.settle()
  assert.deepEqual(calls, [COORD])
  assert.equal(await h.store.getCoordinatorSessionId(), 's_coord2')
  // The old turn failed, but the new session never ran: the queued note wakes it.
  assert.deepEqual(h.opened, [{ sessionId: 's_coord2', activate: false }])
  assert.equal(h.lanes.get('s_coord2')!.wakes.length, 1)
  assert.equal(h.coord.wakes.length, 0)
})

test('a persisted failure count at the limit also trips; an unflagged turn does not', async () => {
  const calls: string[] = []
  let store!: CoordinationStore
  const h = await setup(0, { reseed: reseeder(() => store, calls) })
  store = h.store
  h.coord.compactFailureCount = 2
  h.coord.start('user'); h.coord.end('user')
  await h.settle()
  assert.deepEqual(calls, [])
  h.coord.compactFailureCount = 3
  h.coord.start('user'); h.coord.end('user')
  await h.settle()
  assert.deepEqual(calls, [COORD])
})

test('a retired coordinator lane no longer drives the wake state', async () => {
  const h = await setup(1)
  await h.store.setCoordinatorSessionId('s_coord2')
  const next = new FakeLane('s_coord2', 'coordinator')
  h.attach(next)
  // The old lane running does not hold back a wake of the new one.
  h.coord.start('user')
  await runThread(h.threads[0]!)
  await h.settle()
  assert.equal(next.wakes.length, 1)
  // Nor does its failed turn end, or its user turn reset the count.
  h.coord.end('user', { failed: true })
  await h.settle()
  const f = await h.store.read()
  assert.equal(f.coordinator!.autoWakeCount, 1)
  assert.equal(f.coordinator!.wakeLocked, true)
})

test('a coordinator wake-origin turn with no notes neither counts toward the limit nor locks anything', async () => {
  const h = await setup(0)
  await h.store.setAutoWakeCount(3)
  h.coord.start('wake'); h.coord.end('wake')
  await h.settle()
  const coordinator = (await h.store.read()).coordinator!
  assert.equal(coordinator.autoWakeCount, 3)
  assert.equal(coordinator.wakeLocked, false)
  assert.equal(h.coord.wakes.length, 0)
})
