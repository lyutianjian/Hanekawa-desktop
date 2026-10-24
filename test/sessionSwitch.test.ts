import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  reconcileOrphanedAgents,
  switchToExistingSession,
  switchToNewSession,
  type SessionSwitchDeps,
} from '../src/runtime/sessionSwitch.js'
import type { SessionRecord } from '../src/harness/types.js'
import { SessionStore } from '../src/sessions/service.js'
import { getSessionsDir } from '../src/utils/paths.js'

/**
 * Two halves. `reconcileOrphanedAgents` is pure and decides *what to write*:
 * agents still marked running that did not survive into this process. Without it
 * a resumed transcript shows them running forever.
 *
 * The switch functions themselves are exercised against stub collaborators over
 * a real store, because what matters is the choreography — the order of the
 * queue hook, `createRuntime`, `retarget` and `replace` — rather than the loop.
 */

function task(
  agentId: string,
  status: 'running' | 'completed',
  id = `rec-${agentId}`,
): Extract<SessionRecord, { type: 'subagent_task' }> {
  return {
    type: 'subagent_task',
    id,
    agentId,
    subagentType: 'explore',
    task: 'look around',
    description: 'look around',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

const now = () => '2026-08-15T12:00:00.000Z'
let counter = 0
const createId = () => `new-${(counter += 1)}`

test('no orphans means no records to write', () => {
  assert.deepEqual(reconcileOrphanedAgents([task('a', 'running')], [], now, createId), [])
})

test('a running orphan becomes an interruption record', () => {
  counter = 0
  const [record] = reconcileOrphanedAgents([task('a', 'running')], ['a'], now, createId)

  assert.ok(record && record.type === 'subagent_task')
  assert.equal(record.agentId, 'a')
  assert.equal(record.status, 'interrupted')
  assert.equal(record.error, 'Background agent was not present when the session resumed')
  assert.equal(record.createdAt, now())
  assert.equal(record.id, 'new-1', 'a fresh id, so the original record is preserved')
})

test('an agent that already finished is left alone', () => {
  counter = 0
  assert.deepEqual(
    reconcileOrphanedAgents([task('a', 'completed')], ['a'], now, createId),
    [],
  )
})

test('an orphan with no record at all is ignored', () => {
  counter = 0
  assert.deepEqual(reconcileOrphanedAgents([], ['ghost'], now, createId), [])
})

test('only the latest record for an agent decides its fate', () => {
  counter = 0
  const records = [task('a', 'running', 'first'), task('a', 'completed', 'second')]

  assert.deepEqual(reconcileOrphanedAgents(records, ['a'], now, createId), [],
    'the later completion wins over the earlier running record')
})

test('several orphans each get their own record', () => {
  counter = 0
  const records = [task('a', 'running'), task('b', 'running'), task('c', 'completed')]

  const written = reconcileOrphanedAgents(records, ['a', 'b', 'c'], now, createId)

  assert.deepEqual(written.map((record) => record.type === 'subagent_task' && record.agentId), ['a', 'b'])
  assert.deepEqual(written.map((record) => record.id), ['new-1', 'new-2'])
})

// --- the switch choreography ------------------------------------------------

interface SwitchHarness {
  deps: SessionSwitchDeps
  store: SessionStore
  cwd: string
  /** Every step that has an ordering constraint, in the order it happened. */
  order: string[]
  restoredSessions: string[]
  stopped: Array<{ sessionId: string; reason: string }>
  /** Agent ids `restoreSession` reports as not having survived. */
  orphans: string[]
  registered: Set<string>
}

async function createSwitchHarness(): Promise<SwitchHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-switch-'))
  const store = new SessionStore(cwd)
  await store.init()

  const order: string[] = []
  const restoredSessions: string[] = []
  const stopped: Array<{ sessionId: string; reason: string }> = []
  const orphans: string[] = []
  const registered = new Set<string>()

  const runtimeSlot = {
    current: {
      modelKey: 'sonnet',
      loop: { clearCachedSections: () => order.push('clearCachedSections') },
    },
    replace: () => order.push('replace'),
    getSnapshot: () => ({ status: 'ready', session: runtimeSlot.current, effort: 'high' }),
  }

  let switching = false
  const deps: SessionSwitchDeps = {
    host: {
      store,
      createRuntime: (modelKey, session) => {
        order.push(`createRuntime:${modelKey}:${session.id}`)
        return {} as never
      },
    },
    runtimeSlot: runtimeSlot as unknown as SessionSwitchDeps['runtimeSlot'],
    controller: {
      beginSessionSwitch: () => {
        if (switching) throw new Error('会话正在切换，请稍候。')
        switching = true
      },
      endSessionSwitch: () => { switching = false },
      retarget: (session: { id: string }) => order.push(`retarget:${session.id}`),
    } as unknown as SessionSwitchDeps['controller'],
    backgroundTasks: {
      getSnapshot: (sessionId: string) => (registered.has(sessionId) ? [{}] : []),
      restoreSession: async (sessionId: string) => {
        restoredSessions.push(sessionId)
        return orphans
      },
      stopAll: async (sessionId: string, reason: string) => { stopped.push({ sessionId, reason }) },
    } as unknown as SessionSwitchDeps['backgroundTasks'],
  }

  return { deps, store, cwd, order, restoredSessions, stopped, orphans, registered }
}

function message(id: string, content: string): SessionRecord {
  return { type: 'message', id, role: 'user', content, createdAt: 'now' }
}

test('the queue hook runs before the runtime is swapped, not after', async () => {
  const harness = await createSwitchHarness()
  const session = await harness.store.create('resume me')
  await harness.store.appendRecord(session.id, message('m1', 'hello'))

  const seen: Array<{ id: string; records: number }> = []
  await switchToExistingSession({
    ...harness.deps,
    beforeApply: async (next, records) => {
      harness.order.push('beforeApply')
      seen.push({ id: next.id, records: records.length })
    },
  }, session.id)

  assert.deepEqual(harness.order, [
    'beforeApply',
    `createRuntime:sonnet:${session.id}`,
    `retarget:${session.id}`,
    'replace',
  ], 'a queue still keyed to the previous session must not outlive the swap')
  assert.deepEqual(seen, [{ id: session.id, records: 1 }],
    'the hook is handed the session it is switching to and the records it loaded')
})

test('a new session hands the hook the draft id that did not exist before the call', async () => {
  const harness = await createSwitchHarness()
  const previous = await harness.store.create('old')

  const seen: string[] = []
  const result = await switchToNewSession({
    ...harness.deps,
    beforeApply: async (next) => {
      harness.order.push('beforeApply')
      seen.push(next.id)
    },
  }, { previousSessionId: previous.id })

  assert.deepEqual(seen, [result.session.id])
  assert.notEqual(result.session.id, previous.id)
  assert.deepEqual(harness.order, [
    'clearCachedSections',
    'beforeApply',
    `createRuntime:sonnet:${result.session.id}`,
    `retarget:${result.session.id}`,
    'replace',
  ], 'the cached Environment section goes first; the swap still goes last')
  assert.deepEqual(harness.stopped, [{ sessionId: previous.id, reason: 'Session cleared' }])
})

test('a refused claim leaves both switch entry points without side effects', async () => {
  const harness = await createSwitchHarness()
  const session = await harness.store.create('busy one')
  const refusedAtClaim: SessionSwitchDeps = {
    ...harness.deps,
    controller: {
      beginSessionSwitch: () => { throw new Error('当前回合仍在进行，请先停止再切换会话。') },
      endSessionSwitch: () => { throw new Error('a refused claim must not be released') },
      retarget: () => harness.order.push('retarget'),
    } as unknown as SessionSwitchDeps['controller'],
  }

  await assert.rejects(() => switchToExistingSession(refusedAtClaim, session.id), /先停止/)
  await assert.rejects(
    () => switchToNewSession(refusedAtClaim, { previousSessionId: session.id }),
    /先停止/,
  )

  assert.deepEqual(harness.order, [], 'no runtime was built and the controller was not retargeted')
  assert.deepEqual(harness.stopped, [], "the outgoing session's background tasks were left alone")
})

test('a second switch cannot start while one is already in flight', async () => {
  const harness = await createSwitchHarness()
  const first = await harness.store.create('first')
  const second = await harness.store.create('second')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const held: SessionSwitchDeps = { ...harness.deps, beforeApply: () => gate }

  const running = switchToExistingSession(held, first.id)
  // Both commands are detached protocol runs, so the busy check alone would let
  // the second through before the first had retargeted anything.
  await assert.rejects(() => switchToExistingSession(held, second.id), /正在切换/)

  release()
  await running
  // The claim is released in a `finally`, not latched.
  await switchToExistingSession(harness.deps, second.id)
})

test('the hook is optional, and leaving it out changes nothing else', async () => {
  const harness = await createSwitchHarness()
  const session = await harness.store.create('resume me')

  await switchToExistingSession(harness.deps, session.id)

  assert.deepEqual(harness.order, [
    `createRuntime:sonnet:${session.id}`,
    `retarget:${session.id}`,
    'replace',
  ])
})

test('diagnostics come back raw, for each shell to word its own way', async () => {
  const harness = await createSwitchHarness()
  const session = await harness.store.create('damaged')
  await harness.store.appendRecord(session.id, message('m1', 'hello'))
  // A torn line is the diagnostic the reader self-heals from and reports.
  await appendFile(path.join(getSessionsDir(harness.cwd), `${session.id}.jsonl`), '{not json\n')

  const result = await switchToExistingSession(harness.deps, session.id)

  assert.equal(result.records.length, 1, 'the malformed line is skipped, not fatal')
  const torn = result.diagnostics.find((diagnostic) => diagnostic.code === 'malformed_jsonl')
  // The structured fields are the point: `code` and `line` are exactly what
  // `summarizeDiagnosticsForTui` throws away, so a shell that wants to word this
  // differently still can.
  assert.ok(torn, 'the reader self-heals from a torn line and reports it')
  assert.equal(torn.severity, 'warning')
  assert.equal(torn.line, 2)
  assert.ok(!('notices' in result),
    'formatting these here would need `mcp`, which puts the whole RuntimeHost back in the deps')
})

test('an unknown session throws rather than switching to nothing', async () => {
  const harness = await createSwitchHarness()

  await assert.rejects(
    () => switchToExistingSession(harness.deps, 'no-such-session'),
    /Unknown session: no-such-session/,
  )
  assert.deepEqual(harness.order, [], 'nothing was swapped on the way to failing')
})

test('a session already live in this process is not restored a second time', async () => {
  const harness = await createSwitchHarness()
  const session = await harness.store.create('already running')
  harness.registered.add(session.id)

  await switchToExistingSession(harness.deps, session.id)

  assert.deepEqual(harness.restoredSessions, [],
    'restoring again would double-register every background task it owns')
})

test('an orphaned agent is written to the store and joins the returned records', async () => {
  const harness = await createSwitchHarness()
  const session = await harness.store.create('had an agent')
  await harness.store.appendRecord(session.id, task('a', 'running'))
  harness.orphans.push('a')

  const result = await switchToExistingSession(harness.deps, session.id)

  const written = result.records.filter(
    (record): record is Extract<SessionRecord, { type: 'subagent_task' }> =>
      record.type === 'subagent_task' && record.status === 'interrupted',
  )
  assert.equal(written.length, 1, 'the interruption is in what the caller renders')
  const reloaded = await harness.store.loadRecordsWithDiagnostics(session.id)
  assert.equal(
    reloaded.records.filter((r) => r.type === 'subagent_task' && r.status === 'interrupted').length,
    1,
    'and on disk, so the next resume does not report it again',
  )
})
