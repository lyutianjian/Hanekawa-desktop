import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUiBridges } from '../src/runtime/bridges.js'
import { CommandRegistry } from '../src/commands/registry.js'
import { SessionWorkspace, createSessionPane } from '../src/runtime/sessionWorkspace.js'
import type { SessionPane } from '../src/runtime/sessionWorkspace.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'
import type { SessionRecord } from '../src/harness/types.js'
import { SessionStore } from '../src/sessions/service.js'

/**
 * The container, against stub collaborators over a real store.
 *
 * What matters here is lifecycle, not the loop: which objects a pane owns, the
 * order it releases them in, and the one rule that makes two tabs safe — a
 * session belongs to at most one pane, because two `AgentLoop`s appending to one
 * JSONL and two `FileHistoryService`s backing up one worktree is corruption,
 * not concurrency.
 */

interface Harness {
  project: ProjectRuntime
  workspace: SessionWorkspace
  store: SessionStore
  /** Every step with an ordering constraint, in the order it happened. */
  order: string[]
  openedScopes: string[]
  restoredSessions: string[]
  scopes: Map<string, SessionScope>
}

async function createHarness(): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-workspace-'))
  const store = new SessionStore(cwd)
  await store.init()

  const order: string[] = []
  const openedScopes: string[] = []
  const restoredSessions: string[] = []
  const scopes = new Map<string, SessionScope>()

  const makeScope = (session: { id: string }): SessionScope => {
    const bridges = createUiBridges()
    const scope = {
      session,
      bridges,
      permissionGate: { getMode: () => 'default' },
      promptSections: {},
      createRuntime: (modelKey: string, runtimeSession: { id: string }) => {
        order.push(`createRuntime:${modelKey}:${runtimeSession.id}`)
        return {
          modelKey,
          modelConfig: { model: 'claude-test' },
          providerName: 'anthropic',
          planModeManager: {},
          loop: {
            setEffort: () => {},
            clearCachedSections: () => order.push('clearCachedSections'),
            invalidateRecordsCache: () => {},
            getActiveModel: () => ({ model: 'claude-test', modelKey }),
            assertImagesAllowedForSubmission: () => {},
            run: async () => ({
              content: 'ok',
              usage: { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 5 },
            }),
          },
          run: async () => ({ content: 'ok' }),
          dispose: () => order.push(`disposeRuntime:${runtimeSession.id}`),
        }
      },
      setFileEditTracker: () => {},
      existingRecords: [],
      hasRecoverableInterruption: false,
      diagnostics: [],
      dispose: () => order.push(`disposeScope:${session.id}`),
    } as unknown as SessionScope
    scopes.set(session.id, scope)
    return scope
  }

  const model = { model: 'claude-test', provider: 'anthropic' }
  const project = {
    cwd,
    store,
    // Just enough for the one model selection the pane resolves on creation.
    config: {
      get: () => ({ models: { sonnet: model }, defaultModel: 'sonnet' }),
      getModel: (key: string) => (key === 'sonnet' ? model : undefined),
      resolveModel: (key: string) => (key === 'sonnet' ? model : undefined),
      resolveModelReference: (reference: string | undefined) => reference,
      resolveModelKeyFor: () => 'sonnet',
      getCoordination: () => ({ quietDays: 3, autoResolveDays: 7 }),
      resolveCoordinationModelKey: () => ({ modelKey: 'sonnet' }),
    },
    mcp: { connected: [], failed: [] },
    initialModelKey: 'sonnet',
    initialEffort: 'high',
    configuredEffortLevel: 'high',
    backgroundTasks: {
      getSnapshot: () => [],
      hasParentNotifications: () => false,
      restoreSession: async (sessionId: string) => {
        restoredSessions.push(sessionId)
        return []
      },
      stopAll: async () => {},
    },
    openScope: async (session: { id: string }) => {
      openedScopes.push(session.id)
      return makeScope(session)
    },
    createActiveModelRuntime: () => ({}),
    commands: new CommandRegistry(),
    reloadAgentDefinitions: async () => 0,
    reloadSkills: async () => 0,
    reloadSettings: async () => ({ needsRuntimeRebuild: false }),
    reloadMcpServers: async () => {},
    getSettings: () => ({}),
    listAgentDefinitions: () => [],
    shutdown: async () => { order.push('shutdown') },
  } as unknown as ProjectRuntime

  // Real backups write outside the project; the controller exposes this seam
  // for exactly that reason.
  const workspace = new SessionWorkspace(project, {
    createFileHistoryService: () => ({
      init: async () => {},
      dispose: () => {},
      makeSnapshot: async () => {},
      trackEdit: async () => {},
    }) as unknown as FileHistoryService,
  })

  return { project, workspace, store, order, openedScopes, restoredSessions, scopes }
}

function message(id: string, content: string): SessionRecord {
  return { type: 'message', id, role: 'user', content, createdAt: 'now' }
}

test('concurrent opens share one scope, allow other sessions, and retry a failed open', async () => {
  const h = await createHarness()
  const first = await h.store.create('first')
  const second = await h.store.create('second')
  const original = h.project.openScope.bind(h.project)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let attempts = 0
  h.project.openScope = async (session) => {
    if (session.id === first.id) {
      attempts++
      await gate
      if (attempts === 1) throw new Error('open failed')
    }
    return original(session)
  }
  const opens = [h.workspace.open(first), h.workspace.open(first), h.workspace.open(first)]
  const failure = Promise.all(opens.map((pending) => assert.rejects(pending, /open failed/)))
  await h.workspace.open(second)
  release()
  await failure
  assert.equal(attempts, 1)
  const [a, b, c] = await Promise.all([h.workspace.open(first), h.workspace.open(first), h.workspace.open(first)])
  assert.equal(a, b)
  assert.equal(a, c)
  assert.equal(attempts, 2)
  assert.equal(h.openedScopes.filter((id) => id === first.id).length, 1)
  h.workspace.closeAll()
})

test('closing the workspace while an open is pending disposes the late scope', async () => {
  const h = await createHarness()
  const session = await h.store.create('late')
  const original = h.project.openScope.bind(h.project)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  h.project.openScope = async (meta) => { await gate; return original(meta) }
  const pending = h.workspace.open(session)
  const rejected = assert.rejects(pending, /closed/i)
  await Promise.resolve()
  h.workspace.closeAll()
  release()
  await rejected
  assert.equal(h.workspace.list().length, 0)
  assert.deepEqual(h.order, [`disposeScope:${session.id}`])
  await assert.rejects(h.workspace.open(session), /closed/i)
})

test('a pane\'s controller listens to its own scope, not to another pane\'s', async () => {
  const harness = await createHarness()
  const first = await harness.workspace.open(await harness.store.create('first'))
  const second = await harness.workspace.open(await harness.store.create('second'))

  const firstEvents: SessionEvent[] = []
  const secondEvents: SessionEvent[] = []
  first.controller.onEvent((event) => firstEvents.push(event))
  second.controller.onEvent((event) => secondEvents.push(event))

  first.scope.bridges.record.onRecord(message('m1', 'hello'))

  assert.deepEqual(firstEvents.map((event) => event.type), ['record'])
  assert.deepEqual(secondEvents, [],
    'one shared record proxy would replay every tab\'s transcript into every tab')
})

test('opening a session that is already open hands back the same pane', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('only once')

  const first = await harness.workspace.open(session)
  const again = await harness.workspace.open(session)

  assert.equal(again, first)
  assert.deepEqual(harness.openedScopes, [session.id],
    'a second scope on one session means two loops appending to one JSONL')
  assert.equal(harness.workspace.list().length, 1)
})

test('adopting the scope bootstrap already opened does not open a second one', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('initial')
  const scope = await harness.project.openScope(session)
  harness.openedScopes.length = 0

  const pane = harness.workspace.adopt(scope)

  assert.equal(pane.scope, scope)
  assert.deepEqual(harness.openedScopes, [])
  assert.equal(harness.workspace.paneForSession(session.id), pane)
  // Idempotent, so a shell cannot register its first tab twice.
  assert.equal(harness.workspace.adopt(scope), pane)
})

test('closing a pane interrupts, then releases the controller, slot and scope in order', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('closing')
  const pane = await harness.workspace.open(session)

  const interrupts: unknown[] = []
  const originalInterrupt = pane.controller.interrupt.bind(pane.controller)
  pane.controller.interrupt = (reason?: unknown) => {
    interrupts.push(reason)
    harness.order.push('interrupt')
    originalInterrupt(reason)
  }
  harness.order.length = 0

  pane.close()

  assert.deepEqual(harness.order, [
    'interrupt',
    `disposeRuntime:${session.id}`,
    `disposeScope:${session.id}`,
  ], 'the scope goes last, so a prompt parked on a bridge is still drainable')
  assert.deepEqual(interrupts, ['exit'],
    '"user-cancel" would write a turn_interruption record for a tab nobody is resuming')
})

test('closing twice is a no-op, and the session can be opened again afterwards', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('reopen me')
  const pane = await harness.workspace.open(session)

  pane.close()
  harness.order.length = 0
  pane.close()

  assert.deepEqual(harness.order, [],
    'shutdown disposes every scope as a backstop and may arrive either side of this')
  assert.equal(harness.workspace.paneForSession(session.id), undefined)
  assert.equal(harness.workspace.list().length, 0)

  const reopened = await harness.workspace.open(session)
  assert.notEqual(reopened, pane)
  assert.deepEqual(harness.openedScopes, [session.id, session.id])
})

test('closeAll releases every pane, and shutdown after it is harmless', async () => {
  const harness = await createHarness()
  const first = await harness.workspace.open(await harness.store.create('first'))
  const second = await harness.workspace.open(await harness.store.create('second'))

  harness.workspace.closeAll()

  assert.equal(harness.workspace.list().length, 0)
  assert.deepEqual(
    harness.order.filter((step) => step.startsWith('disposeScope')),
    [`disposeScope:${first.getSession().id}`, `disposeScope:${second.getSession().id}`],
  )
  await harness.project.shutdown('done')
})

test('a pane reports the session it currently shows, not the one it opened with', async () => {
  const harness = await createHarness()
  const opened = await harness.store.create('opened with')
  const target = await harness.store.create('switched to')
  const pane = await harness.workspace.open(opened)

  await harness.workspace.switchPane(pane, target.id)

  assert.equal(pane.getSession().id, target.id)
  assert.equal(pane.scope.session.id, opened.id, 'the scope keeps the session it was built for')
  // Derived from the controller rather than indexed, so there is no key to
  // forget to move.
  assert.equal(harness.workspace.paneForSession(target.id), pane)
  assert.equal(harness.workspace.paneForSession(opened.id), undefined)
})

test('switching goes through the one copy of the switch choreography', async () => {
  const harness = await createHarness()
  const opened = await harness.store.create('opened with')
  const pane = await harness.workspace.open(opened)
  const target = await harness.store.create('switched to')
  await harness.store.appendRecord(target.id, message('m1', 'hello'))
  harness.order.length = 0

  const result = await harness.workspace.switchPane(pane, target.id)

  assert.equal(result.session.id, target.id)
  assert.equal(result.records.length, 1)
  assert.deepEqual(harness.restoredSessions, [target.id])
  assert.deepEqual(harness.order, [
    `createRuntime:sonnet:${target.id}`,
    `disposeRuntime:${opened.id}`,
  ], 'the loop is rebuilt for the new session, and the outgoing one is disposed only after')
})

test('a session open in another pane is refused, and nothing is swapped', async () => {
  const harness = await createHarness()
  const own = await harness.store.create('first')
  const first = await harness.workspace.open(own)
  const shared = await harness.store.create('contested')
  await harness.workspace.open(shared)
  harness.order.length = 0

  await assert.rejects(
    () => harness.workspace.switchPane(first, shared.id),
    /already open in another pane/,
  )

  assert.deepEqual(harness.order, [], 'nothing was swapped on the way to failing')
  assert.equal(first.getSession().id, own.id, 'the refused pane still shows what it showed')
  assert.equal(harness.workspace.list().length, 2)
})

test('switching a pane onto the session it already shows is allowed', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('same session')
  const pane = await harness.workspace.open(session)

  await harness.workspace.switchPane(pane, session.id)

  assert.equal(pane.getSession().id, session.id)
})

test('clearing a pane mints a draft and moves the pane onto it', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('to be cleared')
  const pane = await harness.workspace.open(session)

  const result = await harness.workspace.clearPane(pane, { title: 'fresh' })

  assert.notEqual(result.session.id, session.id)
  assert.deepEqual(result.records, [])
  assert.equal(pane.getSession().id, result.session.id)
  assert.equal(harness.workspace.paneForSession(result.session.id), pane)
  assert.equal(harness.workspace.paneForSession(session.id), undefined)
})

test('a pane that is not open here cannot be switched or cleared', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('detached')
  const scope = await harness.project.openScope(session)
  const detached = createSessionPane(harness.project, scope)

  await assert.rejects(
    () => harness.workspace.switchPane(detached, session.id),
    /not open in this workspace/,
  )
  await assert.rejects(
    () => harness.workspace.clearPane(detached),
    /not open in this workspace/,
  )
})

test('one pane\'s token totals do not accumulate into another\'s', async () => {
  const harness = await createHarness()
  const first = await harness.workspace.open(await harness.store.create('first'))
  const second = await harness.workspace.open(await harness.store.create('second'))

  await first.controller.submit({ text: 'hello' })

  assert.deepEqual(first.controller.getSnapshot().usage.total, {
    inputTokens: 10,
    cacheReadInputTokens: 0,
    outputTokens: 5,
  })
  assert.deepEqual(second.controller.getSnapshot().usage.total, {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  })
})

test('a pane built without a workspace is the same three objects', async () => {
  const harness = await createHarness()
  const session = await harness.store.create('single pane shell')
  const scope = await harness.project.openScope(session)

  const pane: SessionPane = createSessionPane(harness.project, scope)

  // What `tui.tsx` gets: the slot already holds a runtime for this session, and
  // the effort is the project's startup level.
  assert.equal(pane.runtimeSlot.requireCurrent().modelKey, 'sonnet')
  assert.equal(pane.runtimeSlot.getEffort(), 'high')
  assert.equal(pane.controller.getSessionId(), session.id)
  assert.equal(pane.getSession().id, session.id)
})
