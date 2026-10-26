import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUiBridges } from '../src/runtime/bridges.js'
import { registerBuiltinCommands } from '../src/commands/index.js'
import { CommandRegistry } from '../src/commands/registry.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import type { PaneRegistry } from '../src/runtime/protocol/host.js'
import type { HostCommand, HostEvent, WirePaneInfo } from '../src/runtime/protocol/wire.js'
import type { SessionPane } from '../src/runtime/sessionWorkspace.js'
import type { SessionController, SessionEvent } from '../src/runtime/sessionController.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { SessionRecord, TokenUsage, Tool } from '../src/harness/types.js'
import type { SessionMeta } from '../src/sessions/service.js'
import { SessionStore } from '../src/sessions/service.js'
import type { ImageAttachmentRef, UserInput } from '../src/media/types.js'
import { replayMessageQueue } from '../src/runtime/messageQueue.js'
import { projectRootKey } from '../src/runtime/projectDirectory.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

/**
 * The host is exercised against stub collaborators rather than a real runtime:
 * what matters here is the boundary contract — what crosses, in what order, and
 * what happens to outstanding questions when the client dies — not the loop.
 */

interface Harness {
  host: SessionHost
  received: HostEvent[]
  /** This harness's project registry, for tests that need the built-ins in it. */
  commands: CommandRegistry
  send: (command: HostCommand) => void
  /** Malformed payloads, which `send` is deliberately too well typed to express. */
  sendRaw: (message: unknown) => void
  emit: (event: SessionEvent) => void
  publishSnapshot: () => void
  setContextUsedTokens: (contextUsedTokens: number | undefined) => void
  /** Sets the turn state rather than toggling it; the queue pump reads the edge. */
  setStreaming: (value: boolean) => void
  /** Holds the lane as a switch in flight would, and releases it on false. */
  setSwitching: (value: boolean) => void
  setUsageTotal: (total: TokenUsage) => void
  setLastRequestUsage: (
    lastRequest: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number } | null,
  ) => void
  /** Gives the active model a price list, which is what makes a cost derivable. */
  /** Makes the next `controller.submit` reject, for the pump's failure path. */
  failNextSubmit: (message: string, options?: { afterAcceptance?: boolean }) => void
  bridges: ReturnType<typeof createUiBridges>
  /** The real store behind the stub controller, for the commands that write. */
  store: SessionStore
  /** The temp project root, for the commands that read the filesystem. */
  cwd: string
  sessionId: string
  calls: {
    submits: string[]
    /** `origin` of each submit, parallel to `submits`. */
    submitOrigins: Array<string | undefined>
    interrupts: unknown[]
    createdRuntimes: Array<{ modelKey: string; recordCount: number }>
    defaultModels: string[]
    shutdowns: string[]
    modeChanges: string[]
    cacheInvalidations: number
    /** `clearCachedSections()` calls — `# Environment` embeds the model name. */
    clearedSections: number
    summarized: SessionRecord[][]
    /** Every draft handed back, in order. */
    restoreInputs: Array<{ text: string; images?: ImageAttachmentRef[] }>
    openedPanes: string[]
    adoptedPanes: string[]
    closedPanes: string[]
    openedCallbacks: Array<{ paneId: string }>
    closedCallbacks: string[]
    focusedPanes: string[]
    openedProjects: number
    /** How often the shell was asked to fan a pane list out to its other windows. */
    paneListFanOuts: number
  }
  /** Drives the two subscriptions the host installs on the runtime host. */
  changeMode: (mode: string) => void
  getPermissionMode: () => string
  /** A background agent leaving a note for this idle session. */
  notifyParent: (note: string) => void
  changeBackgroundTasks: (tasks: unknown[]) => void
  closeClient: () => void
  dispose: () => void
}

/**
 * Knobs for the pane/project surface. Everything else about the fixture is
 * fixed — a test that needs a different runtime builds its own.
 */
interface HarnessOptions {
  /** The execution directory, when it differs from the project data root. */
  workingDir?: string
  /** Omit the three shell callbacks: a shell that owns exactly one project. */
  singleProject?: boolean
  /** What `onFocusPane` answers. Defaults to "the window was there". */
  focusFound?: boolean
  /** The whole-topology projection a multi-project shell supplies. */
  describePanes?: () => WirePaneInfo[]
  /** What this host's *own* workspace lists, for the fallback projection. */
  workspacePanes?: SessionMeta[]
  /** Records the session was reopened with; a queue is replayed from these. */
  existingRecords?: SessionRecord[]
  /** The scope's coordination role. */
  role?: 'coordinator' | 'thread'
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-protocol-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('protocol test')

  /**
   * A bare-bones `SessionPane` for the registry's `open` / `adopt` stubs.
   *
   * The host only touches `getSession()` on it through the registry, so the
   * rest can be left uninitialized; using a cast keeps the fixture inside the
   * test file rather than spreading fake-pane construction across the suite.
   */
  function fakePane(s: SessionMeta): SessionPane {
    return {
      getSession: () => s,
    } as unknown as SessionPane
  }

  const bridges = createUiBridges()
  const calls: Harness['calls'] = {
    submits: [],
    submitOrigins: [],
    interrupts: [],
    createdRuntimes: [],
    defaultModels: [],
    shutdowns: [],
    modeChanges: [],
    cacheInvalidations: 0,
    clearedSections: 0,
    summarized: [],
    restoreInputs: [],
    openedPanes: [],
    adoptedPanes: [],
    closedPanes: [],
    openedCallbacks: [],
    closedCallbacks: [],
    focusedPanes: [],
    openedProjects: 0,
    paneListFanOuts: 0,
  }

  const eventListeners = new Set<(event: SessionEvent) => void>()
  const snapshotListeners = new Set<() => void>()
  /** Set by `failNextSubmit`; consumed by the next `controller.submit`. */
  let submitFailure: string | undefined
  /** Whether that failure lands after the user record exists. */
  let submitFailsAfterAcceptance = false
  /** A switch the host has claimed and not finished. */
  let switchingState = false
  let snapshot: {
    isStreaming: boolean
    usage: { lastRequest: TokenUsage | null; total: TokenUsage }
    taskSnapshot: undefined
    spinnerSubText: undefined
    contextUsedTokens: number | undefined
    turnOutputTokens: number | undefined
  } = {
    isStreaming: false,
    usage: { lastRequest: null, total: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } },
    contextUsedTokens: undefined,
    turnOutputTokens: undefined,
    taskSnapshot: undefined,
    spinnerSubText: undefined,
  }

  let switching = false
  const controller = {
    beginSessionSwitch: () => {
      if (switching) throw new Error('会话正在切换，请稍候。')
      if (snapshot.isStreaming) throw new Error('当前回合仍在进行，请先停止再切换会话。')
      switching = true
      switchingState = true
      for (const listener of [...snapshotListeners]) listener()
    },
    endSessionSwitch: () => {
      switching = false
      switchingState = false
      for (const listener of [...snapshotListeners]) listener()
    },
    onEvent: (listener: (event: SessionEvent) => void) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    subscribe: (listener: () => void) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    busyKind: () => (switchingState ? 'switch' : snapshot.isStreaming ? 'turn' : undefined),
    getSubagentProgress: () => new Map([['agent-1', 'Reading file']]),
    // The third parameter is the queue's hand-off. The real controller fires
    // `onAccepted` when the user record lands; this stub writes no records, so
    // it stands in for that moment explicitly — and, like the real one, only
    // after the point where a refused submission would already have thrown.
    submit: async (input: UserInput, options?: { origin?: string }, handoff?: { onAccepted: () => void }) => {
      if (submitFailure !== undefined) {
        const message = submitFailure
        submitFailure = undefined
        if (submitFailsAfterAcceptance) handoff?.onAccepted()
        throw new Error(message)
      }
      handoff?.onAccepted()
      calls.submits.push(input.text)
      calls.submitOrigins.push(options?.origin)
    },
    // The queue's accept-time gate. Nothing in this file queues images, so the
    // stub accepts; `desktopUiRoundTrip.test.ts` covers the refusing side.
    assertInputAcceptable: () => {},
    interrupt: (reason: unknown) => { calls.interrupts.push(reason) },
    // Reads the real store and emits the reset the real controller emits, so a
    // command that rewrote the file on disk is observable through the boundary.
    reload: async () => {
      const loaded = await store.loadRecordsWithDiagnostics(session.id)
      for (const listener of [...eventListeners]) {
        listener({ type: 'transcript-reset', records: loaded.records, systemMessages: [], bumpGeneration: true })
      }
      return loaded.records
    },
    restoreInput: (text: string, images?: ImageAttachmentRef[]) => {
      calls.restoreInputs.push({ text, ...(images ? { images } : {}) })
      for (const listener of [...eventListeners]) listener({ type: 'restore-input', text })
    },
    retarget: () => {},
    getFileHistoryService: () => ({
      getCheckpointsWithDiffs: async () => [{ messageId: 'm1' }],
      rewindTo: async () => ({ success: true }),
    }),
  }

  const loop = {
    runTool: async () => ({ ok: true, content: 'ran' }),
    // The runtime snapshot reads the window off the loop, not off `modelConfig`:
    // only the loop knows which model is *active* after a fallback.
    getContextBudget: () => ({ contextWindow: 200_000, usableContextWindow: 167_000 }),
    // Same reason: the snapshot reports the active model, image capability
    // included. This stub never reports a capable model.
    getActiveModel: () => ({ model: 'test-model', modelKey: 'main', contextWindow: 200_000 }),
    clearCachedSections: () => { calls.clearedSections += 1 },
    invalidateRecordsCache: () => { calls.cacheInvalidations += 1 },
    summarizeRecordsForRewind: async (records: SessionRecord[]) => {
      calls.summarized.push(records)
      return { summary: `summary of ${records.length}`, preTokens: 1234 }
    },
  }
  const agentSession = {
    loop,
    planModeManager: undefined,
    modelKey: 'main',
    modelConfig: { model: 'test-model', contextWindow: 200_000, supportedEfforts: ['low', 'medium', 'high'], apiKey: 'SECRET' },
    providerName: 'anthropic',
  }
  const runtimeSlot = {
    current: agentSession as typeof agentSession | undefined,
    requireCurrent: () => runtimeSlot.current,
    getSnapshot: () => ({ status: 'ready', session: runtimeSlot.current, effort: 'high' }),
    subscribe: () => () => {},
    getEffort: () => 'high',
    setEffort: (level: string) => level,
    reapplyEffort: () => 'high',
    // The real slot installs the new session; the identity of `current` is what
    // the pump reads to tell that the runtime changed under a held message.
    replace: (next: typeof agentSession) => { runtimeSlot.current = next },
  }

  const modeListeners = new Set<(mode: string) => void>()
  const taskListeners = new Set<() => void>()
  let backgroundTaskSnapshot: unknown[] = []
  const parentNotes: string[] = []
  let permissionMode = 'default'

  const runtimeHost = {
    cwd,
    workingDir: options.workingDir ?? cwd,
    session,
    store,
    bridges,
    // A real registry, not a stub. `ProjectRuntime.commands` is what the host
    // resolves `/help` and `list-commands` through, and the `as unknown as`
    // below would happily hide its absence until the first slash command threw.
    commands: new CommandRegistry(),
    existingRecords: options.existingRecords ?? [],
    role: options.role,
    diagnostics: [],
    mcp: { connected: [], failed: [] },
    hasRecoverableInterruption: false,
    configuredEffortLevel: 'medium',
    permissionGate: {
      getMode: () => permissionMode,
      setMode: (mode: string) => { permissionMode = mode; calls.modeChanges.push(mode) },
      prepareContextForPlanMode: () => { permissionMode = 'plan'; calls.modeChanges.push('plan') },
      onModeChange: (listener: (mode: string) => void) => {
        modeListeners.add(listener)
        return () => modeListeners.delete(listener)
      },
    },
    backgroundTasks: {
      subscribe: (listener: () => void) => {
        taskListeners.add(listener)
        return () => taskListeners.delete(listener)
      },
      getSnapshot: () => backgroundTaskSnapshot,
      hasParentNotifications: () => parentNotes.length > 0,
      consumeParentNotifications: () => parentNotes.splice(0),
      restoreSession: async () => [] as string[],
      stopAll: async () => {},
      peekOutput: () => 'tail of the output',
      killTask: async (_sessionId: string, taskId: string) => ({ id: taskId, status: 'killed' }),
    },
    config: {
      get: () => ({
        models: { main: {}, fast: {}, broken: {} },
        defaultModel: 'main',
      }),
      getModel: (key: string) => (key === 'broken'
        ? undefined
        : {
          model: `${key}-model`,
          provider: 'anthropic',
          contextWindow: 200_000,
          supportedEfforts: ['low', 'medium', 'high'],
          // Present exactly as resolveModel would fold them in.
          apiKey: 'SECRET',
          baseUrl: 'https://secret.example.com',
        }),
      resolveModelInput: (input: string) => {
        if (input === 'nope') return undefined
        // A real key resolves to itself; anything else gets a marker suffix so a
        // test can tell "resolved" from "was already a key".
        return input in { main: 1, fast: 1, broken: 1 } ? input : `${input}-resolved`
      },
      resolveModelReference: (reference: string | undefined) => reference,
      resolveModelKeyFor: (_role: unknown, options?: { currentModelKey?: string }) =>
        options?.currentModelKey ?? 'main',
      setDefaultModel: (name: string) => { calls.defaultModels.push(name) },
      save: async () => {},
    },
    reloadAgentDefinitions: async () => 3,
    reloadSkills: async () => 4,
    reloadSettings: async () => ({ needsRuntimeRebuild: false }),
    reloadMcpServers: async () => {},
    getSettings: () => ({}),
    listAgentDefinitions: () => [],
    shutdown: async (reason: string) => { calls.shutdowns.push(reason) },
    createRuntime: (modelKey: string, _session: unknown, records?: readonly SessionRecord[]) => {
      calls.createdRuntimes.push({ modelKey, recordCount: records?.length ?? 0 })
      // A distinct object, like the real factory: same loop, new session.
      return { ...agentSession, modelKey }
    },
    createActiveModelRuntime: (modelKey: string) => ({ model: modelKey, provider: {} }),
  }

  const [hostSide, clientSide] = createMemoryChannelPair()
  const received: HostEvent[] = []
  clientSide.onMessage((message) => received.push(message as HostEvent))

  // The pane registry the host reaches for. Tests that need to drive it install
  // a custom one; the default is a no-op that swallows opens and records closes,
  // so a host built from this fixture cannot accidentally crash on a stray
  // open-pane command in a test that does not care about panes.
  const paneRegistry: PaneRegistry = {
    list: () => (options.workspacePanes ?? []).map(fakePane),
    paneForSession: () => undefined,
    open: async (session) => {
      calls.openedPanes.push(session.id)
      return fakePane(session)
    },
    adopt: (scope) => {
      calls.adoptedPanes.push(scope.session.id)
      return fakePane(scope.session)
    },
    close: () => {
      calls.closedPanes.push('test')
    },
  }

  /**
   * The three shell callbacks a multi-project shell supplies. Omitted entirely
   * with `singleProject`, which is the shape `test/protocolChildProcess.test.ts`
   * and the terminal build have — and the reason they are optional at all.
   */
  const shellDeps = options.singleProject
    ? {}
    : {
        onFocusPane: (paneId: string) => {
          calls.focusedPanes.push(paneId)
          return options.focusFound ?? true
        },
        onOpenProject: () => {
          calls.openedProjects++
        },
        onPaneListChanged: () => {
          calls.paneListFanOuts += 1
        },
        ...(options.describePanes ? { describePanes: options.describePanes } : {}),
      }

  const host = new SessionHost({
    channel: hostSide,
    controller: controller as unknown as SessionController,
    runtimeSlot: runtimeSlot as unknown as RuntimeSlot,
    // One fake satisfies both halves: `RuntimeHost` *is* their intersection, so
    // a single-session host sees exactly what it used to.
    project: runtimeHost as unknown as ProjectRuntime,
    scope: runtimeHost as unknown as SessionScope,
    workspace: paneRegistry,
    onPaneOpened: (pane, sessionId) => { calls.openedCallbacks.push({ paneId: sessionId ?? pane.getSession().id }) },
    onPaneClosed: (paneId) => { calls.closedCallbacks.push(paneId) },
    ...shellDeps,
  })

  return {
    host,
    received,
    /** This harness's project registry, for tests that need the built-ins in it. */
    commands: runtimeHost.commands,
    send: (command) => clientSide.post(command),
    sendRaw: (message) => clientSide.post(message),
    emit: (event) => { for (const listener of [...eventListeners]) listener(event) },
    publishSnapshot: () => {
      snapshot = { ...snapshot, isStreaming: !snapshot.isStreaming }
      for (const listener of [...snapshotListeners]) listener()
    },
    /**
     * Sets the turn state and notifies, the way the real controller does at both
     * ends of `submit`. Distinct from `publishSnapshot`, which toggles: the queue
     * pump's whole job is to fire on the false edge, so a test needs to say which
     * edge it means.
     */
    setStreaming: (value: boolean) => {
      snapshot = { ...snapshot, isStreaming: value }
      for (const listener of [...snapshotListeners]) listener()
    },
    setSwitching: (value: boolean) => {
      switchingState = value
      for (const listener of [...snapshotListeners]) listener()
    },
    setUsageTotal: (total: TokenUsage) => {
      snapshot = { ...snapshot, usage: { ...snapshot.usage, total } }
      for (const listener of [...snapshotListeners]) listener()
    },
    /** The occupancy the controller publishes; the host only forwards it. */
    setContextUsedTokens: (contextUsedTokens: number | undefined) => {
      snapshot = { ...snapshot, contextUsedTokens }
      for (const listener of [...snapshotListeners]) listener()
    },
    /** The last response's own counts. */
    setLastRequestUsage: (
      lastRequest: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number } | null,
    ) => {
      snapshot = { ...snapshot, usage: { ...snapshot.usage, lastRequest } }
      for (const listener of [...snapshotListeners]) listener()
    },
    /** Makes the next `controller.submit` reject, for the pump's failure path. */
    failNextSubmit: (message: string, options?: { afterAcceptance?: boolean }) => {
      submitFailure = message
      submitFailsAfterAcceptance = options?.afterAcceptance === true
    },
    bridges,
    store,
    cwd,
    sessionId: session.id,
    calls,
    changeMode: (mode: string) => { for (const listener of [...modeListeners]) listener(mode) },
    getPermissionMode: () => permissionMode,
    notifyParent: (note: string) => {
      parentNotes.push(note)
      for (const listener of [...taskListeners]) listener()
    },
    changeBackgroundTasks: (tasks: unknown[]) => {
      backgroundTaskSnapshot = tasks
      for (const listener of [...taskListeners]) listener()
    },
    closeClient: () => clientSide.close(),
    dispose: () => host.dispose(),
  }
}

/** The memory channel delivers on a microtask; give it a macrotask to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** For commands that touch disk, where one macrotask is not enough. */
async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const fakeTool = { name: 'Bash', riskLevel: 'confirm' } as unknown as Tool

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: fakeTool,
    input: { command: 'ls' },
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    ...overrides,
  } as PermissionRequest
}

test('session events are forwarded to the client in order', async () => {
  const harness = await createHarness()
  harness.emit({ type: 'turn-start', messageId: 'm1', displayInput: 'hi', createdAt: 'now' })
  harness.emit({ type: 'turn-end', aborted: false, rolledBack: false, durationMs: 5 })
  await settle()

  const events = harness.received.filter((event) => event.type === 'session-event')
  assert.deepEqual(events.map((event) => event.event.type), ['turn-start', 'turn-end'])
  harness.dispose()
})

/**
 * `Grep` is the case that makes the projection worth having: its display name is
 * "Search", and its summary is assembled from `pattern`/`path`/`glob` by a
 * function on the live `Tool`. A renderer guessing at `input`'s keys gets
 * neither.
 */
const grepUse: SessionRecord = {
  type: 'tool_use',
  id: 'tu-grep',
  tool: 'Grep',
  input: { pattern: 'foo' },
  riskLevel: 'safe',
  createdAt: 'now',
}

const grepDisplay = {
  displayName: 'Search',
  useSummary: 'pattern: "foo"',
  activityDescription: 'Searching for "foo"',
}

test('a tool_use record crosses with its display projection', async () => {
  const harness = await createHarness()
  harness.emit({ type: 'record', record: grepUse })
  harness.emit({ type: 'record', record: { type: 'message', id: 'm1', role: 'assistant', content: 'hi', createdAt: 'now' } })
  await settle()

  const events = harness.received.filter((event) => event.type === 'session-event')
  assert.deepEqual(events[0]?.toolDisplays, { 'tu-grep': grepDisplay })
  // Only tool calls earn an entry; a message record leaves the key off entirely
  // rather than shipping an empty object.
  assert.equal(events[1]?.toolDisplays, undefined)
  harness.dispose()
})

test('transcript-reset and hello go through the same projection', async () => {
  const harness = await createHarness()
  // The reset rebases the ledger, which is what `hello` replays from — so this
  // one emit exercises both exits with the same record.
  harness.emit({ type: 'transcript-reset', records: [grepUse], systemMessages: [], bumpGeneration: true })
  harness.send({ type: 'hello', id: 'td1' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'td1'),
    'a hello reply',
  )
  const reset = harness.received.find(
    (event) => event.type === 'session-event' && event.event.type === 'transcript-reset',
  )
  assert.ok(reset && reset.type === 'session-event')
  assert.deepEqual(reset.toolDisplays, { 'tu-grep': grepDisplay })

  assert.ok(reply.type === 'reply')
  const result = reply.result as { records: SessionRecord[]; toolDisplays?: Record<string, unknown> }
  assert.deepEqual(result.records, [grepUse])
  assert.deepEqual(result.toolDisplays, reset.toolDisplays)
  harness.dispose()
})

test('snapshots carry subagent progress, which cannot cross as a Map', async () => {
  const harness = await createHarness()
  harness.publishSnapshot()
  await settle()

  const snapshot = harness.received.find((event) => event.type === 'snapshot')
  assert.ok(snapshot && snapshot.type === 'snapshot')
  assert.deepEqual(snapshot.subagentProgress, [['agent-1', 'Reading file']])
  harness.dispose()
})

test('hello replays both snapshots and never leaks the model apiKey', async () => {
  const harness = await createHarness()
  harness.send({ type: 'hello', id: 'c1' })
  await settle()

  const runtime = harness.received.find((event) => event.type === 'runtime-snapshot')
  assert.ok(runtime && runtime.type === 'runtime-snapshot')
  assert.equal(runtime.snapshot.status, 'ready')
  assert.equal(runtime.snapshot.modelKey, 'main')
  assert.equal(runtime.snapshot.model, 'test-model')
  assert.equal(runtime.snapshot.permissionMode, 'default')
  assert.equal(JSON.stringify(runtime.snapshot).includes('SECRET'), false,
    'the endpoint credential must never reach a renderer')

  assert.ok(harness.received.some((event) => event.type === 'snapshot'))
  // The reply waits on a disk read (`.git/HEAD` for the branch pill), so one
  // macrotask is no longer enough — the two snapshots above still are, because
  // the host posts them before that read.
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'),
    'a hello reply',
  )
  harness.dispose()
})

test('interrupt crosses as a reason sentinel, not a signal', async () => {
  const harness = await createHarness()
  harness.send({ type: 'interrupt', id: 'c1', reason: 'user-cancel' })
  harness.send({ type: 'interrupt', id: 'c2', reason: 'exit' })
  await settle()

  // 'exit' deliberately misses isUserCancelAbort, so quitting writes no
  // turn_interruption record; both sentinels have to survive the boundary.
  assert.deepEqual(harness.calls.interrupts, ['user-cancel', 'exit'])
  harness.dispose()
})

test('a permission prompt becomes a DTO without the Tool or the callback', async () => {
  const harness = await createHarness()
  let alwaysAllowFired = false
  const pending = harness.bridges.prompt.prompt(permissionRequest({
    onAlwaysAllow: () => { alwaysAllowFired = true },
  }))
  await settle()

  const request = harness.received.find((event) => event.type === 'ui-request')
  assert.ok(request && request.type === 'ui-request' && request.request.kind === 'permission')
  assert.deepEqual(request.request.payload, {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: { command: 'ls' },
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: true,
    // Derived host-side so a renderer can draw the dialog without the harness.
    destructiveWarnings: [],
  })

  harness.send({
    type: 'ui-response',
    requestId: request.request.requestId,
    response: { kind: 'permission', approved: true, alwaysAllow: true },
  })

  assert.equal(await pending, true)
  assert.equal(alwaysAllowFired, true,
    'onAlwaysAllow must fire before the approval resolves; the gate reads the flag right after')
  harness.dispose()
})

test('a lost client settles each outstanding request with its own fallback', async () => {
  const harness = await createHarness()
  const permission = harness.bridges.prompt.prompt(permissionRequest())
  const enterPlan = harness.bridges.enterPlan.open()
  const exitPlan = harness.bridges.exitPlan.open({ planContent: 'p', planFilePath: 'p.md' })
  const question = harness.bridges.askUserQuestion.ask({ questions: [] })
  await settle()

  harness.closeClient()
  await settle()

  // Nothing else unblocks these: ToolRunner does not pass its abort signal into
  // PermissionGate.approve, so without this the loop waits forever.
  assert.equal(await permission, false, 'permission denies')
  assert.equal(await enterPlan, true, 'entering plan mode approves')
  assert.equal((await exitPlan).kind, 'reject', 'exiting plan mode rejects')
  assert.equal((await question).kind, 'rejected', 'AskUserQuestion rejects')
})

test('switching models passes the accumulated record ledger to the new runtime', async () => {
  const harness = await createHarness()
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm1', role: 'user', content: 'a', createdAt: 'now' },
  })
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm2', role: 'assistant', content: 'b', createdAt: 'now' },
  })
  // The same record arriving twice must not be counted twice.
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm2', role: 'assistant', content: 'b', createdAt: 'now' },
  })
  await settle()

  harness.send({ type: 'set-model', id: 'c1', modelKey: 'other' })
  await settle()

  assert.deepEqual(harness.calls.createdRuntimes, [{ modelKey: 'other', recordCount: 2 }],
    'createRuntime folds records into task state, so a stale list loses them')
  harness.dispose()
})

/** Three user/assistant messages on disk, so a rewind has something to cut. */
async function seedConversation(harness: Harness): Promise<void> {
  const records: SessionRecord[] = [
    { type: 'message', id: 'm1', role: 'user', content: 'first', createdAt: 'now' },
    { type: 'message', id: 'm2', role: 'assistant', content: 'answer one', createdAt: 'now' },
    { type: 'message', id: 'm3', role: 'user', content: 'second', createdAt: 'now' },
    { type: 'message', id: 'm4', role: 'assistant', content: 'answer two', createdAt: 'now' },
  ]
  for (const record of records) await harness.store.appendRecord(harness.sessionId, record)
}

test('truncate-session cuts the file, repaints the view and rebases the ledger', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm3' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')
  assert.ok(reply.type === 'reply')

  const { records } = reply.result as { records: SessionRecord[] }
  assert.deepEqual(records.map((record) => record.id), ['m1', 'm2'],
    'truncateBeforeMessage keeps records strictly before the target')

  // The event stream, not the reply, is what a view listens to.
  const reset = harness.received.find(
    (event) => event.type === 'session-event' && event.event.type === 'transcript-reset',
  )
  assert.ok(reset?.type === 'session-event' && reset.event.type === 'transcript-reset')
  assert.deepEqual(reset.event.records.map((record) => record.id), ['m1', 'm2'])

  // The cut prompt goes back to the composer, after the reset that removed it.
  const restore = harness.received.findIndex(
    (event) => event.type === 'session-event' && event.event.type === 'restore-input',
  )
  assert.ok(restore > harness.received.indexOf(reset))
  const restored = harness.received[restore]
  assert.ok(restored?.type === 'session-event' && restored.event.type === 'restore-input')
  assert.equal(restored.event.text, 'second')

  assert.equal(harness.calls.cacheInvalidations, 1,
    'without this the loop keeps serving the records it read before the cut')

  // A stale ledger would fold the discarded records into the next runtime.
  harness.send({ type: 'set-model', id: 'c2', modelKey: 'other' })
  await settle()
  assert.deepEqual(harness.calls.createdRuntimes, [{ modelKey: 'other', recordCount: 2 }])
  harness.dispose()
})

test('truncate-session fails loudly for a message that is not in the session', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'gone' })
  const failure = await waitFor(() => harness.received.find((event) => event.type === 'fail'), 'a fail reply')
  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /Message not found/)
  // Reporting success here would leave the caller showing a transcript the file
  // no longer matches.
  assert.equal(harness.received.some((event) => event.type === 'reply'), false)
  harness.dispose()
})

test('summarize-rewind replaces the earlier half with a boundary', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm3', decision: 'summarize-up-to-here' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')
  assert.ok(reply.type === 'reply')

  const { records } = reply.result as { records: SessionRecord[] }
  assert.deepEqual(records.map((record) => record.type),
    ['compact_boundary', 'message', 'message'])
  assert.deepEqual(records.slice(1).map((record) => record.id), ['m3', 'm4'])

  const boundary = records[0]
  assert.ok(boundary?.type === 'compact_boundary')
  assert.equal(boundary.summary, 'summary of 2')
  assert.equal(boundary.preTokens, 1234)

  // The summary must come from the loop, which is the only thing that can call
  // the provider -- and it arrives with exactly the records being replaced.
  assert.deepEqual(harness.calls.summarized.map((batch) => batch.map((record) => record.id)), [['m1', 'm2']])

  // Persisted, not just returned.
  const onDisk = await harness.store.loadRecordsWithDiagnostics(harness.sessionId)
  assert.deepEqual(onDisk.records.map((record) => record.type),
    ['compact_boundary', 'message', 'message'])
  harness.dispose()
})

test('summarize-rewind summarizes the later half for the other decision', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm3', decision: 'summarize-from-here' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')
  assert.ok(reply.type === 'reply')

  const { records } = reply.result as { records: SessionRecord[] }
  assert.deepEqual(records.map((record) => record.type), ['message', 'message', 'compact_boundary'])
  assert.deepEqual(harness.calls.summarized.map((batch) => batch.map((record) => record.id)), [['m3', 'm4']])
  harness.dispose()
})

test('summarize-rewind refuses a target with nothing on the far side', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  // Nothing precedes m1, so there is no earlier conversation to summarize.
  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm1', decision: 'summarize-up-to-here' })
  const failure = await waitFor(() => harness.received.find((event) => event.type === 'fail'), 'a fail reply')
  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /No earlier conversation/)
  assert.equal(harness.calls.summarized.length, 0, 'no provider call for a rewind that cannot happen')
  harness.dispose()
})

/**
 * A conversation whose last prompt was a queued message that has already been
 * sent — the state a rewind used to replay as still waiting.
 *
 * `enqueue` precedes the user record; the `dequeue` written once that record
 * landed follows it. Cutting at the user record therefore keeps the enqueue and
 * drops the two records that proved the send.
 */
async function seedRewindableQueue(harness: Harness): Promise<ImageAttachmentRef> {
  const image: ImageAttachmentRef = {
    id: 'img-q3',
    ownerSessionId: harness.sessionId,
    name: 'shot.png',
    mimeType: 'image/png',
    width: 4,
    height: 4,
    byteLength: 12,
  }
  const records: SessionRecord[] = [
    { type: 'message', id: 'm1', role: 'user', content: 'first', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'message', id: 'm2', role: 'assistant', content: 'answer one', createdAt: '2026-01-01T00:00:01.000Z' },
    {
      type: 'message_queue',
      id: 'q3-enqueue',
      operation: 'enqueue',
      message: {
        id: 'q3',
        content: 'second',
        priority: 'now',
        createdAt: '2026-01-01T00:00:02.000Z',
        images: [image],
      },
      createdAt: '2026-01-01T00:00:02.000Z',
    },
    {
      type: 'message',
      id: 'm3',
      role: 'user',
      content: 'second',
      sourceQueuedMessageId: 'q3',
      images: [image],
      createdAt: '2026-01-01T00:00:03.000Z',
    },
    { type: 'message', id: 'm4', role: 'assistant', content: 'answer two', createdAt: '2026-01-01T00:00:04.000Z' },
    {
      type: 'message_queue',
      id: 'q3-dequeue',
      operation: 'dequeue',
      messageId: 'q3',
      createdAt: '2026-01-01T00:00:05.000Z',
    },
  ]
  for (const record of records) await harness.store.appendRecord(harness.sessionId, record)
  return image
}

function queueRecords(records: readonly SessionRecord[]) {
  return records.filter((record) => record.type === 'message_queue')
}

test('rewind retires the queued message whose send the cut removed', async () => {
  const harness = await createHarness()
  const image = await seedRewindableQueue(harness)

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm3' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the reply')
  assert.ok(reply.type === 'reply')
  await givePumpAChance()

  assert.deepEqual(harness.calls.submits, [], 'a message that was already sent must not be queued again')
  assert.deepEqual(latestQueue(harness.received), [])
  assert.deepEqual(harness.calls.restoreInputs.map((input) => input.text), ['second'],
    'the prompt it cut goes back to the composer exactly once')
  assert.deepEqual(harness.calls.restoreInputs[0]?.images, [image], 'with its attachments')

  // The proof is on disk: the original enqueue survives the cut, and the
  // compensating dequeue follows it in the same rewrite, so even a restart
  // cannot replay the id.
  const onDisk = await harness.store.loadRecords(harness.sessionId)
  assert.deepEqual(queueRecords(onDisk).map((record) => record.operation), ['enqueue', 'dequeue'])
  const compensation = queueRecords(onDisk)[1]
  assert.equal(
    compensation?.type === 'message_queue' && compensation.operation === 'dequeue'
      ? compensation.messageId
      : undefined,
    'q3',
  )
  assert.deepEqual(replayMessageQueue(onDisk), [])
  harness.dispose()

  const reopened = await createHarness({ existingRecords: onDisk })
  try {
    reopened.send({ type: 'hello', id: 'hello' })
    await waitFor(() => reopened.received.find((event) => event.type === 'reply' && event.id === 'hello'), 'the reopened host')
    await givePumpAChance()
    assert.deepEqual(reopened.calls.submits, [], 'the rewound queue id cannot resend after restart')
    assert.deepEqual(reopened.calls.restoreInputs, [], 'reopening does not restore the draft again')
  } finally {
    reopened.dispose()
  }
})

test('a pending message enqueued after the rewind target survives and is sent once', async () => {
  const harness = await createHarness()
  await seedRewindableQueue(harness)
  // Held without a turn, so the message is genuinely pending when the rewind
  // starts and its own enqueue sits after the target's user record.
  harness.failNextSubmit('the active model cannot accept these images')
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'keep me' })
  const enqueued = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'),
    'the enqueue reply',
  )
  assert.ok(enqueued.type === 'reply')
  const pending = (enqueued.result as { message: { id: string } }).message

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm3' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the rewind reply')
  await givePumpAChance()
  assert.deepEqual(latestQueue(harness.received), ['keep me'],
    'the cut dropped its enqueue, so the rewrite has to restore it')
  assert.deepEqual(harness.calls.submits, [], 'and the paused head still holds the pump')

  // Releasing the refusal (a different runtime may accept it) sends it exactly once.
  harness.send({ type: 'set-model', id: 'sm1', modelKey: 'other' })
  await waitFor(() => (harness.calls.submits.length > 0 ? true : undefined), 'the preserved message')
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, ['keep me'], 'once, and never the already-sent target')
  assert.deepEqual(latestQueue(harness.received), [])

  const onDisk = await harness.store.loadRecords(harness.sessionId)
  const restored = queueRecords(onDisk).filter((record) =>
    record.operation === 'enqueue' && record.message.id === pending.id)
  assert.equal(restored.length, 1, 'and its enqueue record survives the cut exactly once')
  harness.dispose()
})

test('a message enqueued while a rewind is running survives and is sent once', async () => {
  const harness = await createHarness()
  await seedConversation(harness)

  const original = harness.store.replaceRecords.bind(harness.store)
  let releaseCut!: () => void
  const cutGate = new Promise<void>((resolve) => { releaseCut = resolve })
  let cutStarted = false
  harness.store.replaceRecords = async (sessionId: string, records: SessionRecord[]) => {
    cutStarted = true
    await cutGate
    return original(sessionId, records)
  }

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm1' })
  await waitFor(() => (cutStarted ? true : undefined), 'the rewrite to start')

  // Typed while the rewrite holds the queue lock. Its own write has to wait for
  // the rewrite rather than be replaced by it.
  harness.send({ type: 'enqueue-message', id: 'q9', content: 'typed during rewind' })
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'nothing may be sent between the cut and its replay')

  releaseCut()
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the rewind reply')
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'q9'), 'the enqueue reply')
  await waitFor(() => (harness.calls.submits.length > 0 ? true : undefined), 'the preserved message')
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, ['typed during rewind'], 'kept, and sent exactly once')
  assert.deepEqual(latestQueue(harness.received), [])

  const onDisk = await harness.store.loadRecords(harness.sessionId)
  assert.ok(
    queueRecords(onDisk).some((record) =>
      record.operation === 'enqueue' && record.message.content === 'typed during rewind'),
    'its record landed after the rewrite rather than inside the cut',
  )
  harness.dispose()
})

test('summarize-from-here retires the queue id its cut orphans', async () => {
  const harness = await createHarness()
  await seedRewindableQueue(harness)

  harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm3', decision: 'summarize-from-here' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the reply')
  await givePumpAChance()

  assert.deepEqual(harness.calls.submits, [], 'the summarized-away prompt must not be sent again')
  assert.deepEqual(harness.calls.restoreInputs, [], 'summarizing does not hand a draft back')

  const onDisk = await harness.store.loadRecords(harness.sessionId)
  assert.ok(
    queueRecords(onDisk).some((record) => record.operation === 'dequeue' && record.messageId === 'q3'),
    'the compensation is persisted with the rewrite',
  )
  assert.deepEqual(replayMessageQueue(onDisk), [])
  harness.dispose()
})

for (const decision of ['summarize-from-here', 'summarize-up-to-here'] as const) {
  test(`${decision} preserves pending messages across the boundary in send order`, async () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const first = { id: 'q-first', content: 'first pending', priority: 'later' as const, createdAt }
    const second = {
      id: 'q-second', content: 'second pending', priority: 'now' as const, createdAt,
      images: [makeImageAttachmentRef({ id: 'img-pending', ownerSessionId: 'original-session' })],
    }
    const records: SessionRecord[] = [
      { type: 'message', id: 'm1', role: 'user', content: 'earlier turn', createdAt },
      { type: 'message_queue', id: 'e-first', operation: 'enqueue', message: first, createdAt },
      { type: 'message', id: 'm3', role: 'user', content: 'selected turn', createdAt },
      { type: 'message_queue', id: 'e-second', operation: 'enqueue', message: second, createdAt },
      { type: 'message', id: 'm4', role: 'assistant', content: 'answer', createdAt },
    ]
    const harness = await createHarness({ existingRecords: records })
    try {
      for (const record of records) await harness.store.appendRecord(harness.sessionId, record)
      harness.failNextSubmit('the head cannot be accepted by this model')
      harness.send({ type: 'hello', id: 'hello' })
      await waitFor(() => harness.received.find((event) =>
        event.type === 'session-event' && event.event.type === 'notice'), 'the paused head')
      await givePumpAChance()

      harness.send({ type: 'summarize-rewind', id: 'c1', messageId: 'm3', decision })
      await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the rewrite reply')
      await givePumpAChance()

      assert.deepEqual(harness.calls.submits, [], 'the same head still holds the pump')
      assert.deepEqual(harness.calls.restoreInputs, [], 'summarizing does not restore a draft')
      const onDisk = await harness.store.loadRecords(harness.sessionId)
      assert.deepEqual(replayMessageQueue(onDisk), [first, second], 'order, priorities and images survive replay')

      // A new host uses only the persisted records, without the old pump block.
      const reopened = await createHarness({ existingRecords: onDisk })
      try {
        reopened.send({ type: 'hello', id: 'hello' })
        await waitFor(() => reopened.calls.submits.length === 2 ? true : undefined, 'both messages after restart')
        await givePumpAChance()
        assert.deepEqual(reopened.calls.submits, [first.content, second.content])
      } finally {
        reopened.dispose()
      }
    } finally {
      harness.dispose()
    }
  })
}

test('two rewinds in the same tick settle to one complete rewrite', async () => {
  const harness = await createHarness()
  await seedRewindableQueue(harness)

  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm2' })
  harness.send({ type: 'truncate-session', id: 'c2', messageId: 'm4' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the first reply')
  const second = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'c2'),
    'the second rewind to see the first one\'s log',
  )
  assert.ok(second.type === 'fail')
  assert.match(second.message, /Message not found/)

  const onDisk = await harness.store.loadRecords(harness.sessionId)
  assert.deepEqual(onDisk.map((record) => record.id), ['m1'], 'the second ran against the rewritten log')
  assert.deepEqual(replayMessageQueue(onDisk), [])
  assert.deepEqual(harness.calls.submits, [])
  harness.dispose()
})

test('a rewind is refused while the lane is busy, without touching the log', async () => {
  const harness = await createHarness()
  await seedConversation(harness)
  const before = await harness.store.loadRecords(harness.sessionId)

  harness.setStreaming(true)
  harness.send({ type: 'truncate-session', id: 'c1', messageId: 'm1' })
  const truncate = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'c1'),
    'the truncate refusal',
  )
  assert.ok(truncate.type === 'fail')
  assert.match(truncate.message, /无法回退/)

  harness.send({ type: 'summarize-rewind', id: 'c2', messageId: 'm1', decision: 'summarize-up-to-here' })
  const summarize = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'c2'),
    'the summarize refusal',
  )
  assert.ok(summarize.type === 'fail')
  assert.match(summarize.message, /无法回退/)

  assert.deepEqual(await harness.store.loadRecords(harness.sessionId), before)
  assert.deepEqual(harness.calls.summarized, [], 'and the summary call was never spent')
  harness.dispose()
})

test('a switch in flight holds the queue, and releasing it sends once', async () => {
  const harness = await createHarness()
  harness.setSwitching(true)
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'waiting' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'), 'the enqueue reply')
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'no turn may start under a switch that is still resolving')

  harness.setSwitching(false)
  await waitFor(() => (harness.calls.submits.length > 0 ? true : undefined), 'the message that waited')
  assert.deepEqual(harness.calls.submits, ['waiting'])
  harness.dispose()
})

test('a failing command replies with fail rather than hanging the client', async () => {
  const harness = await createHarness()
  harness.send({ type: 'retarget', id: 'c1', sessionId: 'does-not-exist' })

  const failure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail'),
    'a fail reply',
  )
  assert.ok(failure.type === 'fail')
  assert.equal(failure.id, 'c1')
  assert.match(failure.message, /Unknown session/)
  harness.dispose()
})

/** Effects and the reply share one channel; this reads them back in arrival order. */
function commandTraffic(harness: Harness): string[] {
  return harness.received.flatMap((event) => {
    if (event.type === 'command-effect') return [`effect:${event.effect.kind}`]
    if (event.type === 'reply') return ['reply']
    if (event.type === 'fail') return ['fail']
    return []
  })
}

test('a slash command\'s effects all arrive before its reply', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/help' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  // This ordering is the whole reason run-command needs an event channel: /help
  // pushes its view while it is still running.
  assert.deepEqual(commandTraffic(harness), ['effect:open-command-view', 'reply'])

  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'open-command-view')
  assert.equal(effect.effect.view.kind, 'list')
  harness.dispose()
})

test('input that is not a slash command comes back unhandled', async () => {
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: 'just a prompt' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: false })
  assert.equal(harness.received.some((event) => event.type === 'command-effect'), false)
  harness.dispose()
})

test('an unknown command is handled, and explains itself as a written line', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/nosuchthing' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  // Same tolerance as the TUI's dispatch: a bad command name is not a protocol
  // failure, so this must not be a `fail`.
  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: true })
  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'write-line')
  assert.match(effect.effect.text, /未知命令：\/nosuchthing/)
  assert.equal(effect.effect.tone, 'error')
  harness.dispose()
})

test('/exit asks the shell to close rather than shutting the host down', async () => {
  const harness = await createHarness()

  harness.send({ type: 'run-command', id: 'c1', input: '/exit' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: true, exit: true })
  assert.deepEqual(harness.calls.shutdowns, [],
    'the shell owns its teardown; it calls shutdown when it is ready')
  harness.dispose()
})

test('a command that throws is reported through a written line, not a fail', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)
  // Two agents sharing a prefix: `resolveAgentId` refuses to guess and throws,
  // which is a genuine throw out of `command.run` rather than a handled miss.
  for (const agentId of ['abc111', 'abc222']) {
    await harness.store.appendRecord(harness.sessionId, {
      type: 'subagent_task',
      id: `r-${agentId}`,
      agentId,
      subagentType: 'general',
      status: 'completed',
      description: 'd',
      task: 't',
      createdAt: 'now',
    } as SessionRecord)
  }

  harness.send({ type: 'run-command', id: 'c1', input: '/agents show abc' })
  const reply = await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  // Same tolerance as the TUI's dispatch: the command failed, the protocol did not.
  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { handled: true })
  assert.equal(harness.received.some((event) => event.type === 'fail'), false)

  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'write-line')
  assert.match(effect.effect.text, /命令出错：Ambiguous subagent id abc/)
  assert.equal(effect.effect.tone, 'error')
  harness.dispose()
})

test('/model with an argument switches the runtime and persists the model', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/model fast' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.deepEqual(harness.calls.createdRuntimes, [{ modelKey: 'fast', recordCount: 0 }])
  // The write-back is what separates /model from the set-model command.
  assert.deepEqual(harness.calls.defaultModels, ['fast'])
  harness.dispose()
})

test('/model with an unknown argument writes a line and leaves the runtime alone', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/model nope' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.deepEqual(harness.calls.createdRuntimes, [])
  assert.deepEqual(harness.calls.defaultModels, [])
  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'write-line')
  assert.match(effect.effect.text, /未知模型：nope/)
  harness.dispose()
})

test('/model with no argument asks for the picker', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/model' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  const effect = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(effect?.type === 'command-effect' && effect.effect.kind === 'open-surface')
  assert.equal(effect.effect.surface, 'model-picker')
  harness.dispose()
})

test('/clear switches to a fresh session and announces it', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)
  harness.emit({
    type: 'record',
    record: { type: 'message', id: 'm1', role: 'user', content: 'a', createdAt: 'now' },
  })
  await settle()

  harness.send({ type: 'run-command', id: 'c1', input: '/clear' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  const changed = harness.received.find((event) => event.type === 'session-changed')
  assert.ok(changed?.type === 'session-changed')
  assert.notEqual(changed.session.id, harness.sessionId,
    'without this a client keeps its message queue keyed to the session it left')

  const reset = harness.received.find(
    (event) => event.type === 'session-event' && event.event.type === 'transcript-reset',
  )
  assert.ok(reset?.type === 'session-event' && reset.event.type === 'transcript-reset')
  assert.deepEqual(reset.event.records, [])

  // The ledger went with it: the next runtime must not inherit the old records.
  harness.send({ type: 'set-model', id: 'c2', modelKey: 'other' })
  await settle()
  const forModel = harness.calls.createdRuntimes.at(-1)
  assert.equal(forModel?.recordCount, 0)
  harness.dispose()
})

test('/plan reaches the permission gate', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/plan' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply'), 'the reply')

  assert.deepEqual(harness.calls.modeChanges, ['plan'])
  assert.equal(harness.getPermissionMode(), 'plan')
  harness.dispose()
})

test('the command context reads the session through a getter, not a capture', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'run-command', id: 'c1', input: '/clear' })
  const changed = await waitFor(
    () => harness.received.find((event) => event.type === 'session-changed'),
    'the session-changed event',
  )
  assert.ok(changed.type === 'session-changed')
  const newSessionId = changed.session.id

  // /session prints context.sessionId. A captured id would still name the
  // session /clear left behind.
  harness.send({ type: 'run-command', id: 'c2', input: '/session' })
  await waitFor(
    () => (harness.received.filter((event) => event.type === 'reply').length === 2 ? true : undefined),
    'the second reply',
  )

  const views = harness.received.filter((event) =>
    event.type === 'command-effect' && event.effect.kind === 'open-command-view')
  const view = views[views.length - 1]
  assert.ok(view?.type === 'command-effect' && view.effect.kind === 'open-command-view')
  assert.equal(view.effect.view.kind, 'info')
  const rows = view.effect.view.kind === 'info' ? view.effect.view.sections[0]?.rows : undefined
  assert.equal(rows?.find((row: { label: string }) => row.label === 'Session ID')?.value, newSessionId)
  assert.notEqual(newSessionId, harness.sessionId)
  harness.dispose()
})

test('dispose stops forwarding and releases the bridges', async () => {
  const harness = await createHarness()
  harness.dispose()

  harness.emit({ type: 'restore-input', text: 'x' })
  await settle()
  assert.equal(harness.received.length, 0)

  // The prompt bridge is detached, not left pointing at a dead channel, so the
  // next UI to attach picks the request up.
  let settled: boolean | undefined
  void harness.bridges.prompt.prompt(permissionRequest()).then((value) => { settled = value })
  await settle()
  assert.equal(settled, undefined)
})

test('a plan-mode change reaches the client even though it never touches RuntimeSlot', async () => {
  const harness = await createHarness()
  const before = harness.received.filter((event) => event.type === 'runtime-snapshot').length

  // EnterPlanMode/ExitPlanMode drive PermissionGate directly, so without an
  // onModeChange subscription the client's permission mode goes stale.
  harness.changeMode('plan')
  await settle()

  const after = harness.received.filter((event) => event.type === 'runtime-snapshot').length
  assert.equal(after, before + 1)
  harness.dispose()
})

test('background task updates are coalesced into one message per macrotask', async () => {
  const harness = await createHarness()
  const before = harness.received.filter((event) => event.type === 'background-tasks').length

  // changed() fires on every output chunk of every running shell.
  for (let i = 0; i < 50; i += 1) harness.changeBackgroundTasks([{ id: 't1', outputBytes: i }])
  await settle()

  const posts = harness.received.filter((event) => event.type === 'background-tasks')
  assert.equal(posts.length - before, 1, '50 changes must collapse to one post')
  const last = posts.at(-1)
  assert.ok(last?.type === 'background-tasks')
  assert.deepEqual(last.tasks, [{ id: 't1', outputBytes: 49 }])
  harness.dispose()
})

test('the model list never carries an apiKey or a baseUrl', async () => {
  const harness = await createHarness()
  harness.send({ type: 'list-models', id: 'm1' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'm1'),
    'a model list',
  )
  assert.ok(reply.type === 'reply')
  const serialized = JSON.stringify(reply.result)
  assert.ok(!serialized.includes('SECRET'), 'apiKey must not cross the boundary')
  assert.ok(!serialized.includes('secret.example.com'), 'baseUrl must not cross the boundary')

  const result = reply.result as {
    models: Array<{ key: string; model?: string }>
    defaultModelKey?: string
    pickerOptions: Array<{ key: string; modelKey?: string; disabledReason?: string }>
  }
  assert.deepEqual(result.models.map((entry) => entry.key), ['main', 'fast', 'broken'])
  assert.equal(result.models[0]?.model, 'main-model')
  // An unresolvable entry still appears, matching availableModelKeys.
  assert.equal(result.models[2]?.model, undefined)
  assert.equal(result.defaultModelKey, 'main')

  // The picker rides along, resolved host-side because building it needs
  // getModel -- the same call that folds the secrets in above. Asserted
  // non-empty so the serialized check is not passing over an empty array.
  assert.deepEqual(result.pickerOptions.map((option) => option.key), ['main', 'fast', 'broken'])
  assert.deepEqual(result.pickerOptions.map((option) => option.modelKey), ['main', 'fast', undefined])
  // The key that will not load is listed and disabled rather than dropped.
  assert.match(result.pickerOptions[2]?.disabledReason ?? '', /could not be loaded/)
  harness.dispose()
})

test('hello carries everything a shell needs to paint its first frame', async () => {
  const harness = await createHarness()
  harness.send({ type: 'hello', id: 'h1' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'h1'),
    'a hello reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as {
    sessionId: string
    session: { id: string }
    cwd: string
    projectName: string
    projectIsGlobal: boolean
    gitBranch?: string
    records: SessionRecord[]
    notices: unknown[]
    hasRecoverableInterruption: boolean
    configuredEffortLevel: string
  }
  assert.equal(result.session.id, result.sessionId)
  assert.equal(typeof result.cwd, 'string')
  assert.equal(result.projectName, path.basename(harness.cwd))
  // A scratch project is a project, not the global workspace.
  assert.equal(result.projectIsGlobal, false)
  // The scratch project is not a repository, so the branch pill has nothing to
  // draw — absent, not an empty string.
  assert.equal(result.gitBranch, undefined)
  assert.deepEqual(result.records, [])
  assert.deepEqual(result.notices, [])
  assert.equal(result.hasRecoverableInterruption, false)
  assert.equal(result.configuredEffortLevel, 'medium')
  harness.dispose()
})

test('hello carries the git branch when the project root is a repository', async () => {
  const harness = await createHarness()
  await mkdir(path.join(harness.cwd, '.git'), { recursive: true })
  await writeFile(path.join(harness.cwd, '.git', 'HEAD'), 'ref: refs/heads/topic\n')

  harness.send({ type: 'hello', id: 'h2' })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'h2'),
    'a hello reply',
  )
  assert.ok(reply.type === 'reply')
  assert.equal((reply.result as { gitBranch?: string }).gitBranch, 'topic')
  harness.dispose()
})

test('list-branches answers with a list even where there is no repository', async () => {
  // The empty state's branch popover asks on every open, and a scratch project
  // is not a checkout: the host has to answer with an empty list rather than
  // `fail`, or the popover would show an error for the ordinary case.
  const harness = await createHarness()
  harness.send({ type: 'list-branches', id: 'b1' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'b1'),
    'a list-branches reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as { branches: string[]; current?: string }
  assert.deepEqual(result.branches, [])
  assert.equal(result.current, undefined)
  harness.dispose()
})

test('switch-branch refuses a name git must never see, without reaching git', async () => {
  const harness = await createHarness()
  harness.send({ type: 'switch-branch', id: 'b2', branch: '--force' })

  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'b2'),
    'a switch-branch reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as { ok: boolean; message?: string }
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /--force/)
  harness.dispose()
})

test('hello reports the global workspace when cwd is the home directory', async () => {
  const workingDir = path.join(tmpdir(), 'Documents', 'myagent')
  const harness = await createHarness({ workingDir })
  // `os.homedir()` answers from USERPROFILE/HOME on the platforms this suite
  // runs on; pointing both at the scratch project makes it the global root
  // without a filesystem move. Restored before any other assertion can run.
  const previousProfile = process.env.USERPROFILE
  const previousHome = process.env.HOME
  process.env.USERPROFILE = harness.cwd
  process.env.HOME = harness.cwd
  try {
    harness.send({ type: 'hello', id: 'h3' })
    const reply = await waitFor(
      () => harness.received.find((event) => event.type === 'reply' && event.id === 'h3'),
      'a hello reply',
    )
    assert.ok(reply.type === 'reply')
    const result = reply.result as { projectIsGlobal: boolean; projectName: string; cwd: string; projectRoot: string }
    assert.equal(result.projectIsGlobal, true)
    assert.equal(result.projectName, '最近')
    assert.equal(result.cwd, workingDir)
    assert.equal(result.projectRoot, projectRootKey(harness.cwd))
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    harness.dispose()
  }
})

test('switching sessions rebuilds the runtime and resets the transcript', async () => {
  const harness = await createHarness()
  const created = harness.calls.createdRuntimes.length

  harness.send({ type: 'create-session', id: 'c1', title: 'fresh' })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'),
    'a create-session reply',
  )

  assert.ok(reply.type === 'reply')
  const result = reply.result as { session: { id: string }; records: SessionRecord[] }
  assert.deepEqual(result.records, [])
  assert.notEqual(result.session.id, undefined)

  // Retargeting the controller alone would leave the loop bound to the old
  // session, so a switch must go through createRuntime + RuntimeSlot.replace.
  assert.equal(harness.calls.createdRuntimes.length, created + 1)

  const reset = harness.received.find((event) =>
    event.type === 'session-event' && event.event.type === 'transcript-reset')
  assert.ok(reset?.type === 'session-event' && reset.event.type === 'transcript-reset')
  assert.equal(reset.event.bumpGeneration, true)
  harness.dispose()
})

test('retargeting an unknown session fails instead of half-switching', async () => {
  const harness = await createHarness()
  const created = harness.calls.createdRuntimes.length

  harness.send({ type: 'retarget', id: 'r1', sessionId: 'does-not-exist' })
  const failure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'r1'),
    'a fail reply',
  )

  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /Unknown session/)
  assert.equal(harness.calls.createdRuntimes.length, created)
  harness.dispose()
})

test('every session-switch entry is refused while a turn is running', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)
  harness.setStreaming(true)
  const created = harness.calls.createdRuntimes.length

  harness.send({ type: 'create-session', id: 'cs1', title: 'too early' })
  const createFailure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'cs1'),
    'the create-session refusal',
  )
  assert.ok(createFailure.type === 'fail')
  assert.match(createFailure.message, /先停止/)

  const other = await harness.store.create('somewhere else')
  harness.send({ type: 'retarget', id: 'rt1', sessionId: other.id })
  const retargetFailure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'rt1'),
    'the retarget refusal',
  )
  assert.ok(retargetFailure.type === 'fail')
  assert.match(retargetFailure.message, /先停止/)

  // `/clear` reaches the same guard through the command context, and reports it
  // as a command line rather than switching behind the running turn.
  harness.send({ type: 'run-command', id: 'cc1', input: '/clear' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'cc1'), 'the /clear reply')
  const clearLine = harness.received.find((event) => event.type === 'command-effect'
    && event.effect.kind === 'write-line'
    && event.effect.text.includes('先停止'))
  assert.ok(clearLine, '/clear must say why it did nothing')

  // `/resume` only opens the picker; say why before it can lead anywhere.
  harness.send({ type: 'run-command', id: 'rs1', input: '/resume' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'rs1'), 'the /resume reply')
  const resumeLine = harness.received.find((event) => event.type === 'command-effect'
    && event.effect.kind === 'write-line'
    && event.effect.text.includes('先停止'))
  assert.ok(resumeLine, '/resume must not open a picker it cannot honour')
  assert.equal(harness.received.some((event) => event.type === 'command-effect'
    && event.effect.kind === 'open-surface'
    && event.effect.surface === 'resume-picker'), false)

  assert.equal(harness.received.some((event) => event.type === 'session-changed'), false,
    'nothing was retargeted')
  assert.equal(harness.calls.createdRuntimes.length, created, 'and no runtime was built')
  harness.dispose()
})

test('a stopped turn releases the switch', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  harness.send({ type: 'create-session', id: 'cs1' })
  await waitFor(() => harness.received.find((event) => event.type === 'fail' && event.id === 'cs1'), 'the refusal')

  harness.setStreaming(false)
  harness.send({ type: 'create-session', id: 'cs2' })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'cs2'),
    'the switch after the stop',
  )
  assert.ok(reply.type === 'reply')
  harness.dispose()
})

test('the reload commands forward to the host and report their counts', async () => {
  const harness = await createHarness()
  harness.send({ type: 'reload-agents', id: 'a1' })
  harness.send({ type: 'reload-skills', id: 's1' })
  harness.send({ type: 'reload-settings', id: 'g1' })

  const agents = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'a1'), 'reload-agents')
  const skills = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 's1'), 'reload-skills')
  const settings = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'g1'), 'reload-settings')

  assert.ok(agents.type === 'reply' && skills.type === 'reply' && settings.type === 'reply')
  assert.deepEqual(agents.result, { count: 3 })
  assert.deepEqual(skills.result, { count: 4 })
  assert.deepEqual(settings.result, { needsRuntimeRebuild: false, rebuilt: false, modelKey: 'main' })
  harness.dispose()
})

test('set-effort only persists when asked, and shutdown replies before the window closes', async () => {
  const harness = await createHarness()
  harness.send({ type: 'set-effort', id: 'e1', level: 'low' })
  const effort = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'e1'), 'set-effort')
  assert.ok(effort.type === 'reply')
  // No persist flag, so settings on disk are untouched.
  assert.deepEqual(effort.result, { effort: 'low', persisted: false })

  harness.send({ type: 'shutdown', id: 'x1', reason: 'window closed' })
  const bye = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'x1'), 'shutdown')
  assert.ok(bye.type === 'reply')
  assert.deepEqual(harness.calls.shutdowns, ['window closed'])
  harness.dispose()
})

test('background task commands read and kill through the registry', async () => {
  const harness = await createHarness()
  harness.send({ type: 'peek-task-output', id: 'p1', taskId: 't1' })
  harness.send({ type: 'kill-task', id: 'k1', taskId: 't1', reason: 'user asked' })

  const peeked = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'p1'), 'peek')
  const killed = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'k1'), 'kill')

  assert.ok(peeked.type === 'reply' && killed.type === 'reply')
  assert.deepEqual(peeked.result, { output: 'tail of the output' })
  assert.deepEqual(killed.result, { task: { id: 't1', status: 'killed' } })
  harness.dispose()
})

test('an unrecognized command fails instead of replying that it worked', async () => {
  const harness = await createHarness()
  harness.sendRaw({ type: 'bogus', id: 'c1' })
  await settle()

  const answers = harness.received.filter((event) => event.type === 'fail' || event.type === 'reply')
  assert.equal(answers.length, 1)
  // The old blind cast let this fall out of the switch in execute(), which
  // answered `{ type: 'reply', result: undefined }` -- a command that had done
  // nothing, reported as a success.
  assert.equal(answers[0]?.type, 'fail')
  assert.equal(answers[0] && 'id' in answers[0] ? answers[0].id : undefined, 'c1')
  harness.dispose()
})

test('a malformed permission mode is refused rather than applied', async () => {
  const harness = await createHarness()
  harness.sendRaw({ type: 'set-permission-mode', id: 'c1', mode: 'god' })
  await settle()

  const fail = harness.received.find((event) => event.type === 'fail')
  assert.ok(fail && fail.type === 'fail')
  assert.match(fail.message, /mode/)
  // The point of validating at all: in an Electron shell the renderer is the
  // less trusted half, and this command reaches PermissionGate directly.
  assert.deepEqual(harness.calls.modeChanges, [])

  harness.send({ type: 'set-permission-mode', id: 'c2', mode: 'bypass' })
  await settle()
  assert.deepEqual(harness.calls.modeChanges, ['bypass'], 'a legal mode still applies')
  harness.dispose()
})

test('a malformed ui-response settles the prompt with its own fallback', async () => {
  const harness = await createHarness()
  const permission = harness.bridges.prompt.prompt(permissionRequest())
  const enterPlan = harness.bridges.enterPlan.open()
  await settle()

  const requests = harness.received.filter((event) => event.type === 'ui-request')
  for (const event of requests) {
    assert.ok(event.type === 'ui-request')
    // `response` is missing the field its kind requires.
    harness.sendRaw({ type: 'ui-response', requestId: event.request.requestId, response: { kind: event.request.kind } })
  }
  await settle()

  // Dropping these would hang the agent loop outright, so the fallback applies
  // -- and it stays asymmetric: a renderer answering garbage is not
  // distinguishable from one that has gone away.
  assert.equal(await permission, false, 'permission denies')
  assert.equal(await enterPlan, true, 'entering plan mode still approves')
  harness.dispose()
})

test('a malformed ui-response is never answered with a fail', async () => {
  const harness = await createHarness()
  harness.sendRaw({ type: 'ui-response', requestId: 'nobody', response: { kind: 'permission' } })
  await settle()

  // There is no command id to fail against, and inventing one would reject a
  // request the client never made.
  assert.equal(harness.received.some((event) => event.type === 'fail'), false)
  harness.dispose()
})

test('file-suggestions resolves against the project root and ships plain data', async () => {
  const harness = await createHarness()
  await writeFile(path.join(harness.cwd, 'alpha.ts'), 'export {}\n')
  await mkdir(path.join(harness.cwd, 'nested'), { recursive: true })

  harness.send({ type: 'file-suggestions', id: 'fs1', input: 'read @alp', cursorPos: 9 })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'fs1'),
    'the file-suggestions reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as { suggestions: Array<Record<string, unknown>> }

  const match = result.suggestions.find((suggestion) => suggestion.displayText === 'alpha.ts')
  assert.ok(match, 'the file in the project root is offered')
  // The renderer hands this straight back to `applyFileSuggestion`, so the
  // nesting has to survive the boundary intact.
  assert.deepEqual(match.metadata, {
    replacementText: '@alpha.ts',
    path: 'alpha.ts',
    kind: 'file',
  })

  // The memory channel clones every post, so arriving at all proves this is
  // structured-clone-safe -- which is the property Electron's IPC needs and
  // would otherwise break silently.
  for (const suggestion of result.suggestions) {
    assert.equal(typeof suggestion.id, 'string')
    assert.equal(typeof suggestion.displayText, 'string')
  }
  harness.dispose()
})

test('file-suggestions answers nothing when the caret is not in a mention', async () => {
  const harness = await createHarness()
  await writeFile(path.join(harness.cwd, 'beta.ts'), 'export {}\n')

  harness.send({ type: 'file-suggestions', id: 'fs2', input: 'no mention here', cursorPos: 15 })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'fs2'),
    'the empty file-suggestions reply',
  )
  assert.ok(reply.type === 'reply')
  assert.deepEqual((reply.result as { suggestions: unknown[] }).suggestions, [])
  harness.dispose()
})

test('list-commands ships metadata only, with no callable on the wire', async () => {
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)

  harness.send({ type: 'list-commands', id: 'lc1' })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'lc1'),
    'the list-commands reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as { commands: Array<Record<string, unknown>> }

  assert.ok(result.commands.length > 0, 'the built-ins are registered')
  assert.ok(result.commands.some((command) => command.name === 'help'))

  for (const command of result.commands) {
    assert.equal(typeof command.name, 'string')
    assert.equal(typeof command.description, 'string')
    // A spread would carry `run` here. The memory channel clones every post, so
    // this reply proves cloneability too -- but Electron's IPC drops functions
    // *silently*, which is what this assertion is really guarding.
    assert.equal('run' in command, false, `${String(command.name)} must not ship its run function`)
    assert.equal('isEnabled' in command, false)
    assert.equal('isHidden' in command, false)
  }

  assert.doesNotThrow(() => structuredClone(result))
  harness.dispose()
})

// --- the message queue ------------------------------------------------------
//
// The queue lives host-side for the desktop shell (the terminal's belongs to
// `App.tsx`), because it is persisted through `store.appendRecord` and because
// the pump's gate reads two things only this process knows: whether a turn is in
// flight, and whether a blocking UI request is outstanding.

/** The messages the most recent `queued-messages` event announced. */
function latestQueue(received: HostEvent[]): string[] {
  const last = received.filter((event) => event.type === 'queued-messages').at(-1)
  return last && last.type === 'queued-messages'
    ? last.messages.map((message) => message.content)
    : []
}

/**
 * Long enough that a pump which *was* allowed to run has finished.
 *
 * Every assertion below of the form "nothing was sent" needs a time budget,
 * because the pump is detached (`void (async () => …)`) and its first step is a
 * `MessageQueue.dequeue` that writes to disk. Asserting immediately after the
 * enqueue reply proves nothing: the work simply has not started yet, and the
 * assertion passes whether the gate held or not — verified by mutation, which is
 * why this exists at all. The unblocked path lands in ~30ms in this suite, so
 * this is a comfortable multiple of it.
 */
const PUMP_BUDGET_MS = 150
const givePumpAChance = () => new Promise((resolve) => setTimeout(resolve, PUMP_BUDGET_MS))

/**
 * `waitFor` for a reader that has to hit the disk.
 *
 * Separate rather than widening `waitFor`, whose reader is synchronous: an async
 * reader passed there returns a promise, which is never `undefined`, so the poll
 * would "succeed" on the first attempt with the promise itself.
 */
async function waitForAsync<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

test('a message queued mid-turn is held, then sent when the turn ends', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)

  harness.send({ type: 'enqueue-message', id: 'q1', content: 'second thought' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'),
    'the enqueue reply',
  )
  await givePumpAChance()

  assert.deepEqual(harness.calls.submits, [], 'nothing may be sent while a turn is running')
  assert.deepEqual(latestQueue(harness.received), ['second thought'])

  // The false edge is the pump's trigger: it arrives as a snapshot publish, which
  // is the only signal the host gets that a turn is over.
  harness.setStreaming(false)
  await waitFor(
    () => (harness.calls.submits.length > 0 ? true : undefined),
    'the queued message to be sent',
  )

  assert.deepEqual(harness.calls.submits, ['second thought'])
  // The removal now follows the send rather than preceding it — the message is
  // consumed when the runtime accepts it — so the empty queue arrives a write
  // later than the submit does.
  await waitFor(
    () => (latestQueue(harness.received).length === 0 ? true : undefined),
    'the queue to empty as it drains',
  )
  harness.dispose()
})

test('the queue drains in order', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'first' })
  harness.send({ type: 'enqueue-message', id: 'q2', content: 'second' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q2'),
    'both enqueue replies',
  )
  assert.deepEqual(latestQueue(harness.received), ['first', 'second'])

  harness.setStreaming(false)
  // Both land because this fake `submit` resolves without ever setting
  // `isStreaming`; the tail re-check in `pumpQueue` is what picks up the second.
  await waitFor(
    () => (harness.calls.submits.length === 2 ? true : undefined),
    'both messages to be sent',
  )
  assert.deepEqual(harness.calls.submits, ['first', 'second'], 'order is the queue')
  harness.dispose()
})

test('a pending permission prompt holds the queue back until it is answered', async () => {
  const harness = await createHarness()
  // Idle, so the dialog is the only thing blocking. This is the desktop's answer
  // to `canPumpQueue`'s `uiBlocked`: the terminal counts any overlay, the host
  // counts an outstanding *blocking* request.
  const pending = harness.bridges.prompt.prompt(permissionRequest())
  await settle()
  const request = harness.received.find((event) => event.type === 'ui-request')
  assert.ok(request && request.type === 'ui-request')

  harness.send({ type: 'enqueue-message', id: 'q1', content: 'held' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'),
    'the enqueue reply',
  )
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'a blocking dialog must hold the pump')
  assert.deepEqual(latestQueue(harness.received), ['held'], 'and the message stays queued')

  harness.send({
    type: 'ui-response',
    requestId: request.request.requestId,
    response: { kind: 'permission', approved: true },
  })
  assert.equal(await pending, true)

  await waitFor(
    () => (harness.calls.submits.length > 0 ? true : undefined),
    'the message to be sent',
  )
  assert.deepEqual(harness.calls.submits, ['held'], 'answering the dialog releases the pump')
  harness.dispose()
})

test('an idle host sends a queued message immediately', async () => {
  const harness = await createHarness()

  harness.send({ type: 'enqueue-message', id: 'q1', content: 'now' })
  await waitFor(
    () => (harness.calls.submits.length > 0 ? true : undefined),
    'the message to be sent',
  )

  assert.deepEqual(harness.calls.submits, ['now'])
  harness.dispose()
})

test('a reopened session with an unsent queued message sends it once a renderer attaches', async () => {
  const queued = {
    id: 'reopened-1',
    type: 'message_queue',
    operation: 'enqueue',
    message: {
      id: 'queued-before-close',
      content: 'left over from last time',
      createdAt: '2026-10-10T00:00:00.000Z',
      priority: 'next',
    },
    createdAt: '2026-10-10T00:00:00.000Z',
  } as SessionRecord
  const harness = await createHarness({ existingRecords: [queued] })

  // Constructing the host replays the queue but does not pump it: nothing
  // attaches a renderer yet, so nothing may be sent.
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'no send before a renderer says hello')

  harness.send({ type: 'hello', id: 'reopen-hello' })
  await waitFor(
    () => (harness.calls.submits.length > 0 ? true : undefined),
    'the reopened queue to be sent after hello',
  )
  assert.deepEqual(harness.calls.submits, ['left over from last time'])

  await waitFor(
    () => (latestQueue(harness.received).length === 0 ? true : undefined),
    'the queue to empty once the message is sent',
  )
  harness.dispose()
})

test('a background agent note wakes an idle host, and waits out a running turn', async () => {
  const harness = await createHarness()
  harness.notifyParent('<system-reminder>\nagent one done\n</system-reminder>')
  await waitFor(() => (harness.calls.submits.length > 0 ? true : undefined), 'the wake turn')
  assert.deepEqual(harness.calls.submits, ['<system-reminder>\nagent one done\n</system-reminder>'])

  harness.setStreaming(true)
  harness.notifyParent('<system-reminder>\nagent two done\n</system-reminder>')
  await settle()
  assert.equal(harness.calls.submits.length, 1, 'a running turn takes the note at its next step instead')
  harness.setStreaming(false)
  await waitFor(() => (harness.calls.submits.length > 1 ? true : undefined), 'the second wake turn')
  harness.dispose()
})

test('a disposed host stops pumping, so a later turn end sends nothing', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'orphaned' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'),
    'the enqueue reply',
  )

  harness.dispose()
  // The turn the message was waiting behind now ends. Before `dispose()` this is
  // exactly the edge that releases the pump; after it, nothing may start a turn on
  // a host with detached bridges, where every permission prompt auto-denies.
  //
  // What this pins is the *teardown* — `dispose()` draining `this.teardown`
  // unsubscribes the snapshot listener, so `pumpQueue` is never reached. The two
  // `disposed` checks inside `pumpQueue` are defence in depth on top of that:
  // removing either one by mutation leaves this green, which is why the comment
  // there says so rather than claiming this test covers them.
  harness.setStreaming(false)
  await givePumpAChance()

  assert.deepEqual(harness.calls.submits, [], 'a disposed host must not start a turn')
})

test('hello carries the messages already waiting', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'waiting' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'),
    'the enqueue reply',
  )

  harness.send({ type: 'hello', id: 'h1' })
  const reply = await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'h1'),
    'the hello reply',
  )
  assert.ok(reply.type === 'reply')
  const result = reply.result as { queuedMessages: Array<{ content: string }> }
  assert.deepEqual(result.queuedMessages.map((message) => message.content), ['waiting'])
  harness.dispose()
})

test('clear-queue drops what is waiting without touching the running turn', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'never mind' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'q1'),
    'the enqueue reply',
  )

  harness.send({ type: 'clear-queue', id: 'c1' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'),
    'the clear reply',
  )
  assert.deepEqual(latestQueue(harness.received), [])

  harness.setStreaming(false)
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'a cleared message must not surface later')
  harness.dispose()
})

test('a /clear carries pending messages into the new session', async () => {
  const harness = await createHarness()
  // A refused submission holds the queue without a turn: a running turn would
  // now refuse the switch itself, and an unblocked idle queue would drain before
  // the test could clear the session.
  harness.failNextSubmit('the active model cannot accept these images')
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'still relevant' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'session-event'
      && event.event.type === 'notice'
      && event.event.content.includes('cannot accept these images')),
    'the pause notice',
  )

  harness.send({ type: 'create-session', id: 'cs1' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'cs1'),
    'the create-session reply',
  )

  // The load-bearing half is *which log the queue is now writing to*, not what the
  // wire says: without the rebind the in-memory snapshot looks identical and the
  // message still sends, but every later `message_queue` record goes to the
  // session that was left — so a restart replays the queue into the wrong
  // conversation. Only the persisted side can tell the two apart.
  const changed = harness.received.find((event) => event.type === 'session-changed')
  assert.ok(changed && changed.type === 'session-changed')
  const nextSessionId = changed.session.id
  assert.notEqual(nextSessionId, harness.sessionId, 'a /clear must mint a new session')

  const migrated = await waitForAsync(async () => {
    const loaded = await harness.store.loadRecordsWithDiagnostics(nextSessionId)
    const enqueues = loaded.records.filter((record) =>
      record.type === 'message_queue' && record.operation === 'enqueue')
    return enqueues.length > 0 ? enqueues : undefined
  }, 'the enqueue record in the new session log')
  assert.equal(migrated.length, 1)
  assert.equal(
    migrated[0]?.type === 'message_queue' && migrated[0].operation === 'enqueue'
      ? migrated[0].message.content
      : undefined,
    'still relevant',
  )

  // And the old log gets a compensating `clear`, so replaying it later cannot
  // resurrect a message that now lives elsewhere.
  const previous = await harness.store.loadRecordsWithDiagnostics(harness.sessionId)
  assert.ok(
    previous.records.some((record) => record.type === 'message_queue' && record.operation === 'clear'),
    'the session that was left must be compensated',
  )

  // The new runtime releases the old runtime's block, so the migrated message
  // is sent in the session it now belongs to.
  await waitFor(
    () => (harness.calls.submits.length > 0 ? true : undefined),
    'the migrated message to be sent',
  )
  assert.deepEqual(harness.calls.submits, ['still relevant'])
  harness.dispose()
})

test('a /resume swaps in the target session\'s own queue instead of carrying one over', async () => {
  const harness = await createHarness()
  const other = await harness.store.create('somewhere else')
  // Same hold as the /clear case: a pending message with no turn in flight.
  harness.failNextSubmit('the active model cannot accept these images')
  harness.send({ type: 'enqueue-message', id: 'q1', content: 'meant for this session' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'session-event'
      && event.event.type === 'notice'
      && event.event.content.includes('cannot accept these images')),
    'the pause notice',
  )

  harness.send({ type: 'retarget', id: 'rt1', sessionId: other.id })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'rt1'),
    'the retarget reply',
  )

  // `reset`, not `migrateTo`: `/resume` goes to a different conversation, which has
  // a queue of its own replayed from its own log. Carrying the pending message over
  // would send it into a conversation the user did not write it for.
  assert.deepEqual(latestQueue(harness.received), [])

  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'and it must not be sent to the wrong session')
  harness.dispose()
})

test('a submission refused before acceptance stays queued and pauses the pump', async () => {
  const harness = await createHarness()
  harness.failNextSubmit('the active model cannot accept images')

  harness.send({ type: 'enqueue-message', id: 'q1', content: 'doomed' })
  const notice = await waitFor(
    () => harness.received.find((event) => event.type === 'session-event'
      && event.event.type === 'notice'
      && event.event.content.includes('cannot accept images')),
    'the pause notice',
  )
  assert.ok(notice.type === 'session-event' && notice.event.type === 'notice')
  assert.equal(notice.event.level, 'error')

  // The refusal happened before the runtime took the message, so it is still
  // there to be fixed — and the pump holds instead of retrying it forever. The
  // stub only fails *once*, so a retry would send it and empty the queue.
  await givePumpAChance()
  assert.deepEqual(latestQueue(harness.received), ['doomed'], 'the message survives the refusal')
  assert.deepEqual(harness.calls.submits, [], 'and nothing retried it')

  // A second message does *not* release it — the head is still the message the
  // runtime refused, and running the queue past it would reorder the user's
  // messages.
  harness.send({ type: 'enqueue-message', id: 'q2', content: 'next' })
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'the pause holds the whole queue behind it')

  // Switching models does: a different runtime may well accept what this one
  // refused, which is the retry the user is being asked to make.
  harness.send({ type: 'set-model', id: 'sm1', modelKey: 'other' })
  await waitFor(
    () => (harness.calls.submits.length === 2 ? true : undefined),
    'the queue to drain once the model changed',
  )
  assert.deepEqual(harness.calls.submits, ['doomed', 'next'])
  harness.dispose()
})

test('a turn that fails after acceptance is not queued again', async () => {
  const harness = await createHarness()
  harness.failNextSubmit('provider exploded', { afterAcceptance: true })

  harness.send({ type: 'enqueue-message', id: 'q1', content: 'committed' })
  const notice = await waitFor(
    () => harness.received.find((event) => event.type === 'session-event'
      && event.event.type === 'notice'
      && event.event.content.includes('provider exploded')),
    'the failure notice',
  )
  assert.ok(notice.type === 'session-event' && notice.event.type === 'notice')
  assert.equal(notice.event.level, 'error')

  // The user record exists, so the message is part of the conversation:
  // re-queueing it would duplicate a message the transcript already shows.
  await givePumpAChance()
  assert.deepEqual(latestQueue(harness.received), [])
  harness.dispose()
})

// --- context occupancy ------------------------------------------------------

/** The occupancy on the most recent snapshot event. */
function latestContextUsed(received: HostEvent[]): number | undefined {
  const last = received.filter((event) => event.type === 'snapshot').at(-1)
  return last && last.type === 'snapshot' ? last.snapshot.contextUsedTokens : undefined
}

test('the runtime snapshot carries the usable window, not just the raw one', async () => {
  const harness = await createHarness()
  harness.send({ type: 'hello', id: 'c1' })
  await settle()

  const runtime = harness.received.find((event) => event.type === 'runtime-snapshot')
  assert.ok(runtime && runtime.type === 'runtime-snapshot')
  assert.equal(runtime.snapshot.status, 'ready')
  // Both come off the loop rather than off `modelConfig`: only the loop knows
  // which model is active after a fallback, and only it knows what autocompact
  // reserves. `usableContextWindow` is what an occupancy display divides by.
  assert.equal(runtime.snapshot.contextWindow, 200_000)
  assert.equal(runtime.snapshot.usableContextWindow, 167_000)
  harness.dispose()
})

test('context occupancy is forwarded, not recomputed', async () => {
  // The number is the controller's (see `contextUsage.test.ts`); the host's only
  // job is to let it ride on the snapshot so the desktop and the TUI read one
  // field. A host that computed its own would drift from the status line.
  const harness = await createHarness()
  harness.setContextUsedTokens(100_000)
  await settle()

  assert.equal(latestContextUsed(harness.received), 100_000)
  harness.dispose()
})

test('/cost reports the cost accumulated on the session total', async () => {
  // Each request is priced as it lands, so `/cost` and the status bar read one
  // figure off the snapshot instead of repricing the total at today's rate.
  const harness = await createHarness()
  registerBuiltinCommands(harness.commands)
  harness.setUsageTotal({
    inputTokens: 1_234_567,
    cacheReadInputTokens: 89_000,
    outputTokens: 4_321,
    cost: { amounts: { USD: 3.77 } },
  })
  await settle()

  harness.send({ type: 'run-command', id: 'rc1', input: '/cost' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'rc1'),
    'the /cost reply',
  )

  const view = harness.received.find((event) =>
    event.type === 'command-effect' && event.effect.kind === 'open-command-view')
  assert.ok(view && view.type === 'command-effect' && view.effect.kind === 'open-command-view')
  const opened = view.effect.view
  assert.ok(opened.kind === 'info')
  const total = opened.sections.flatMap((section) => section.rows).find((row) => row.label === 'Total cost')
  assert.equal(total?.value, 'USD 3.77')
  harness.dispose()
})

// --- panes across projects ---------------------------------------------------

/** The one shape a pane list takes on the wire, spelled out for the assertions. */
function paneInfo(overrides: Partial<WirePaneInfo> & { paneId: string }): WirePaneInfo {
  return {
    sessionId: overrides.sessionId ?? overrides.paneId,
    projectRoot: overrides.projectRoot ?? 'c:/repo/other',
    projectName: overrides.projectName ?? 'other',
    paneId: overrides.paneId,
    ...(overrides.sessionTitle !== undefined ? { sessionTitle: overrides.sessionTitle } : {}),
  }
}

async function replyTo(harness: Harness, command: HostCommand, id: string): Promise<unknown> {
  harness.send(command)
  await settle()
  const reply = harness.received.find((event) => event.type === 'reply' && event.id === id)
  assert.ok(reply && reply.type === 'reply', `expected a reply for ${id}`)
  return reply.result
}

test('focus-pane is handed straight to the shell, with its answer passed back', async () => {
  // No workspace lookup at all: with several projects open the pane may live in
  // a `SessionWorkspace` this host has never seen.
  const harness = await createHarness()
  const result = await replyTo(harness, { type: 'focus-pane', id: 'f1', paneId: 'pane-9' }, 'f1')

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(harness.calls.focusedPanes, ['pane-9'])
  assert.deepEqual(harness.calls.openedPanes, [], 'focusing must not resolve a session')
  assert.deepEqual(harness.calls.adoptedPanes, [], 'focusing must not adopt a scope')
  harness.dispose()
})

test('a focus the shell could not satisfy answers ok:false, not a failure', async () => {
  // The renderer re-lists on false; a rejection would make a stale tab look like
  // a broken host.
  const harness = await createHarness({ focusFound: false })
  const result = await replyTo(harness, { type: 'focus-pane', id: 'f1', paneId: 'ghost' }, 'f1')

  assert.deepEqual(result, { ok: false })
  assert.equal(harness.received.some((event) => event.type === 'fail'), false)
  harness.dispose()
})

test('open-project hands off to the shell', async () => {
  const harness = await createHarness()
  assert.deepEqual(await replyTo(harness, { type: 'open-project', id: 'p1' }, 'p1'), { ok: true })
  assert.equal(harness.calls.openedProjects, 1)
  harness.dispose()
})

test('a single-project shell fails both hand-offs instead of pretending', async () => {
  // The callbacks are optional so the string-script host in
  // `protocolChildProcess.test.ts` keeps compiling, but a missing one must
  // reject: answering `{ ok: true }` would look like a focus that did nothing.
  const harness = await createHarness({ singleProject: true })
  harness.send({ type: 'focus-pane', id: 'f1', paneId: 'p' })
  harness.send({ type: 'open-project', id: 'p1' })
  await settle()

  const failures = harness.received.filter((event) => event.type === 'fail')
  assert.deepEqual(failures.map((event) => event.type === 'fail' && event.id), ['f1', 'p1'])
  assert.match(failures.map((event) => (event.type === 'fail' ? event.message : '')).join(' '), /cannot focus panes/)
  assert.match(failures.map((event) => (event.type === 'fail' ? event.message : '')).join(' '), /cannot open projects/)
  harness.dispose()
})

test('list-panes reports the shell topology when the shell has one', async () => {
  // With more than one project open this host's own workspace is a subset of the
  // tabs on screen, so its own projection would blink the others out.
  const shellPanes = [
    paneInfo({ paneId: 'mine', projectRoot: 'c:/repo/mine', projectName: 'mine' }),
    paneInfo({ paneId: 'theirs', sessionTitle: 'Other project' }),
  ]
  const harness = await createHarness({
    describePanes: () => shellPanes,
    workspacePanes: [{ id: 'mine' } as SessionMeta],
  })

  assert.deepEqual(await replyTo(harness, { type: 'list-panes', id: 'l1' }, 'l1'), { panes: shellPanes })
  harness.dispose()
})

test('without a shell projection, list-panes describes its own project', async () => {
  // The single-project answer, which is what the terminal and every fake
  // registry use. `projectRoot` comes from the host's own cwd, normalized the
  // same way `WirePaneInfo` carries it.
  const harness = await createHarness({
    singleProject: true,
    workspacePanes: [
      { id: 's1', title: 'First' } as SessionMeta,
      { id: 's2' } as SessionMeta,
    ],
  })

  const result = await replyTo(harness, { type: 'list-panes', id: 'l1' }, 'l1') as { panes: WirePaneInfo[] }
  assert.deepEqual(result.panes.map((info) => info.paneId), ['s1', 's2'])
  assert.equal(result.panes[0]?.projectRoot, projectRootKey(harness.cwd))
  assert.equal(result.panes[0]?.projectName, path.basename(harness.cwd))
  assert.equal(result.panes[0]?.sessionTitle, 'First')
  assert.equal('sessionTitle' in (result.panes[1] ?? {}), false, 'an untitled draft carries no title key')
  harness.dispose()
})

test('the pane-list event pushed on close carries the shell topology too', async () => {
  // `broadcastPaneList` and `list-panes` must not disagree: one is the push, the
  // other the pull, and a renderer paints whichever arrived last.
  const shellPanes = [paneInfo({ paneId: 'left', projectRoot: 'c:/repo/mine', projectName: 'mine' })]
  const harness = await createHarness({
    describePanes: () => shellPanes,
    // The pane the close resolves against; the id is the registry's, not the
    // fixture session's, so the command can be written without waiting for one.
    workspacePanes: [{ id: 'doomed' } as SessionMeta],
  })

  harness.send({ type: 'close-pane', id: 'c1', paneId: 'doomed' })
  await settle()

  assert.deepEqual(harness.calls.closedCallbacks, ['doomed'])
  const pushed = harness.received.filter((event) => event.type === 'pane-list')
  assert.ok(pushed.length > 0, 'closing a pane must announce the new topology')
  assert.deepEqual(pushed.at(-1), { type: 'pane-list', panes: shellPanes })
  harness.dispose()
})

test('a session naming itself is announced as metadata, not as a switch', async () => {
  // The controller names a session from its first message. The pane list is the
  // load-bearing half: `sessionTitle` is a `WirePaneInfo` field, so a shell that
  // is only told through `session-changed` keeps drawing 「未命名会话」 on the
  // lane until something else re-lists it.
  const harness = await createHarness()
  const before = harness.received.filter((event) => event.type === 'pane-list').length
  const fanOuts = harness.calls.paneListFanOuts

  const meta = (await harness.store.list()).find((one) => one.id === harness.sessionId)
  assert.ok(meta, 'the fixture session is in the store')
  harness.emit({ type: 'session-meta', session: { ...meta, title: '第一条消息' } })
  await settle()

  const changed = harness.received.find((event) => event.type === 'session-changed')
  assert.ok(changed?.type === 'session-changed')
  assert.equal(changed.session.title, '第一条消息')
  assert.equal(changed.session.id, harness.sessionId, 'the id must not move; this is not /clear')

  assert.ok(
    harness.received.filter((event) => event.type === 'pane-list').length > before,
    'the lane list carries the title, so it has to be pushed',
  )
  assert.ok(harness.calls.paneListFanOuts > fanOuts, 'and the shell reaches its other lanes')

  // Still forwarded as a session event: the two shells dispatch exhaustively
  // over `SessionEvent`, and a variant the host swallowed would be untestable.
  assert.ok(harness.received.find(
    (event) => event.type === 'session-event' && event.event.type === 'session-meta',
  ))
  harness.dispose()
})

test('a session switch announces the new topology to every window', async () => {
  // A pane *is* its session id, so `/clear` and `/resume` move it. Without an
  // announcement every tab bar keeps the old id: the row still draws, closing it
  // fails with "Pane not found", and focusing it only works after a re-list.
  const shellPanes = [paneInfo({ paneId: 'whatever' })]
  const harness = await createHarness({ describePanes: () => shellPanes })
  const before = harness.received.filter((event) => event.type === 'pane-list').length

  harness.send({ type: 'create-session', id: 'n1' })
  await waitFor(
    () => harness.received.find((event) => event.type === 'reply' && event.id === 'n1'),
    'the create-session reply',
  )

  const announcements = harness.received.filter((event) => event.type === 'pane-list')
  assert.ok(announcements.length > before, 'the switch must push a pane-list')
  assert.ok(harness.calls.paneListFanOuts > 0, 'and the shell must be asked to reach its other windows')
  harness.dispose()
})

test('refreshAfterConfigChange rebuilds the runtime and posts a snapshot', async () => {
  const harness = await createHarness()
  const created = harness.calls.createdRuntimes.length
  harness.received.length = 0

  const result = harness.host.refreshAfterConfigChange({ rebuild: true, scope: 'models' })

  assert.equal(result.rebuilt, true)
  assert.equal(harness.calls.createdRuntimes.length, created + 1, 'a new runtime was built')
  await waitFor(
    () => harness.received.find((event) => event.type === 'runtime-snapshot'),
    'a runtime-snapshot telling the renderer the runtime moved',
  )
  harness.dispose()
})

test('refreshAfterConfigChange with rebuild:false touches nothing', async () => {
  const harness = await createHarness()
  const created = harness.calls.createdRuntimes.length
  harness.received.length = 0

  const result = harness.host.refreshAfterConfigChange({ rebuild: false, scope: 'models' })

  assert.equal(result.rebuilt, false)
  assert.equal(result.modelKey, 'main')
  assert.equal(harness.calls.createdRuntimes.length, created, 'no runtime was built')
  assert.equal(harness.received.length, 0, 'and nothing was posted')
  harness.dispose()
})

test('a rebuild clears the cached system sections, because Environment names the model', async () => {
  const harness = await createHarness()
  const before = harness.calls.clearedSections

  harness.host.refreshAfterConfigChange({ rebuild: true, scope: 'models' })

  assert.ok(
    harness.calls.clearedSections > before,
    'a runtime swap that keeps the cached `# Environment` block serves the old model name',
  )
  harness.dispose()
})

// --- CoordinationLaneControl ---------------------------------------------

test('a coordinator message enqueued on an idle lane is pumped with its origin', async () => {
  const harness = await createHarness({ role: 'thread' })
  await harness.host.enqueueFromCoordinator('from the coordinator')
  await waitFor(() => (harness.calls.submits.length > 0 ? true : undefined), 'the coordinator message')
  assert.deepEqual(harness.calls.submits, ['from the coordinator'])
  assert.deepEqual(harness.calls.submitOrigins, ['coordinator'])
  harness.dispose()
})

test('CoordinationLaneControl.setEffort applies through the runtime slot', async () => {
  const harness = await createHarness({ role: 'thread' })
  harness.host.setEffort('low')
  harness.send({ type: 'set-effort', id: 'e2', level: 'low' })
  const reply = await waitFor(
    () => harness.received.find((e) => e.type === 'reply' && e.id === 'e2'), 'set-effort')
  assert.ok(reply.type === 'reply')
  assert.deepEqual(reply.result, { effort: 'low', persisted: false })
  harness.dispose()
})

test('stop discards what was queued, then interrupts', async () => {
  const harness = await createHarness({ role: 'thread' })
  harness.setStreaming(true)
  await harness.host.enqueueFromCoordinator('one')
  await harness.host.enqueueFromCoordinator('two')
  await harness.host.stop()
  assert.deepEqual(latestQueue(harness.received), [])
  assert.deepEqual(harness.calls.interrupts, ['coordinator-stop'])
  harness.setStreaming(false)
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'nothing queued before the stop is sent after it')
  harness.dispose()
})

test('requestWake before hello runs a wake turn, once, folding in background notes', async () => {
  const harness = await createHarness({ role: 'coordinator' })
  harness.setStreaming(true)
  harness.host.requestWake('wake up')
  harness.notifyParent('note')
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, [], 'a running turn holds the wake')
  harness.setStreaming(false)
  harness.send({ type: 'hello', id: 'h1' })
  await waitFor(() => (harness.calls.submits.length > 0 ? true : undefined), 'the wake turn')
  await givePumpAChance()
  assert.deepEqual(harness.calls.submits, ['wake up\n\nnote'], 'one turn, not a second notification wake')
  assert.deepEqual(harness.calls.submitOrigins, ['wake'])
  harness.dispose()
})

test('stopping or detaching a queued wake sends one discard receipt and never submits it', async () => {
  for (const exit of ['stop', 'interrupt', 'dispose'] as const) {
    const h = await createHarness({ role: 'coordinator' })
    h.setStreaming(true)
    const receipts: string[] = []
    h.host.requestWake('pending wake', (reason) => receipts.push(reason))
    if (exit === 'stop') await h.host.stop()
    else if (exit === 'dispose') h.host.dispose()
    else {
      h.send({ type: 'interrupt', id: 'stop-wake', reason: 'user-cancel' })
      await waitFor(() => h.received.find((event) => event.type === 'reply' && event.id === 'stop-wake'), 'stop reply')
    }
    h.setStreaming(false)
    await givePumpAChance()
    assert.deepEqual(h.calls.submits, [])
    assert.deepEqual(receipts, [exit === 'dispose' ? 'detached' : 'stopped'])
    h.dispose()
    assert.equal(receipts.length, 1)
  }
})

test('a thread scope refuses /clear and retarget', async () => {
  const harness = await createHarness({ role: 'thread' })
  registerBuiltinCommands(harness.commands)
  harness.send({ type: 'run-command', id: 'c1', input: '/clear' })
  await waitFor(() => harness.received.find((event) => event.type === 'reply' && event.id === 'c1'), 'the reply')
  assert.equal(harness.received.some((event) => event.type === 'session-changed'), false)
  const line = harness.received.find((event) => event.type === 'command-effect')
  assert.ok(line?.type === 'command-effect' && line.effect.kind === 'write-line')

  harness.send({ type: 'retarget', id: 'r1', sessionId: harness.sessionId })
  const failure = await waitFor(
    () => harness.received.find((event) => event.type === 'fail' && event.id === 'r1'),
    'a fail reply',
  )
  assert.ok(failure.type === 'fail')
  assert.match(failure.message, /cannot switch/)
  harness.dispose()
})

test('state flips while a permission prompt is open', async () => {
  const harness = await createHarness({ role: 'thread' })
  let changes = 0
  harness.host.onStateChange(() => { changes += 1 })
  const pending = harness.bridges.prompt.prompt(permissionRequest())
  await settle()
  assert.deepEqual(harness.host.state(), { streaming: false, pendingApproval: true, pendingDialog: false })
  const request = harness.received.find((event) => event.type === 'ui-request')
  assert.ok(request && request.type === 'ui-request')
  harness.send({
    type: 'ui-response',
    requestId: request.request.requestId,
    response: { kind: 'permission', approved: true },
  })
  await pending
  await settle()
  assert.deepEqual(harness.host.state(), { streaming: false, pendingApproval: false, pendingDialog: false })
  assert.ok(changes >= 2)
  harness.dispose()
})
