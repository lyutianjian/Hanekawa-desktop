import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createNodeProcessChannel } from '../src/runtime/protocol/nodeChannel.js'

/**
 * The only test that crosses a real process boundary.
 *
 * Everything else runs the protocol in one process, where a payload that is not
 * structured-cloneable can still slip through and an "IPC" round trip is really
 * just a microtask. Here the host runs in a forked child with its own heap:
 * Node's process IPC uses the same structured clone algorithm as Electron's, so
 * anything that works here works over `ipcMain`/`ipcRenderer`.
 *
 * The child's source is written to a temp dir rather than committed as a
 * fixture, because `test/` is flat by convention and has no helpers directory.
 */

const repoRootUrl = new URL('..', import.meta.url)
const repoRoot = fileURLToPath(repoRootUrl)

/**
 * A host-side script driving `SessionHost` against stub collaborators. Kept
 * deliberately small: this test is about the transport, not the runtime.
 */
function childSource(): string {
  const toUrl = (relative: string) => JSON.stringify(new URL(relative, repoRootUrl).href)

  return `
import { SessionHost } from ${toUrl('src/runtime/protocol/host.js')}
import { createNodeProcessChannel } from ${toUrl('src/runtime/protocol/nodeChannel.js')}
import { createUiBridges } from ${toUrl('src/runtime/bridges.js')}
import { CommandRegistry } from ${toUrl('src/commands/registry.js')}

const bridges = createUiBridges()
const eventListeners = new Set()
let snapshot = {
  isStreaming: false,
  usage: { lastRequest: null, total: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } },
  taskSnapshot: undefined,
  spinnerSubText: undefined,
}
const snapshotListeners = new Set()

/** Flipped by the parent's \`__hang_checkpoints\`; see the checkpoint service below. */
let hangCheckpoints = false

const controller = {
  onEvent: (fn) => { eventListeners.add(fn); return () => eventListeners.delete(fn) },
  subscribe: (fn) => { snapshotListeners.add(fn); return () => snapshotListeners.delete(fn) },
  getSnapshot: () => snapshot,
  busyKind: () => (snapshot.isStreaming ? 'turn' : undefined),
  getSubagentProgress: () => new Map([['agent-1', 'Reading']]),
  submit: async (input) => {
    // The host wraps the wire string into a UserInput before this point; the
    // fake unwraps it again so the events and records carry text like the real
    // controller's would.
    const text = typeof input === 'string' ? input : input.text
    snapshot = { ...snapshot, isStreaming: true }
    for (const fn of snapshotListeners) fn()
    for (const fn of eventListeners) {
      fn({ type: 'turn-start', messageId: 'm1', displayInput: text, createdAt: 'now' })
      fn({ type: 'record', record: { type: 'message', id: 'm1', role: 'user', content: text, createdAt: 'now' } })
      fn({ type: 'turn-end', aborted: false, rolledBack: false, durationMs: 1 })
    }
    snapshot = { ...snapshot, isStreaming: false }
    for (const fn of snapshotListeners) fn()
  },
  interrupt: () => {},
  reload: async () => [],
  retarget: () => {},
  getFileHistoryService: () => ({
    // The parent can park this one on request, so "a command was in flight when
    // the host died" is a fact rather than a race with the reply.
    getCheckpointsWithDiffs: async () => hangCheckpoints ? new Promise(() => {}) : [],
    rewindTo: async () => ({ success: true }),
  }),
}

const agentSession = {
  loop: {
    runTool: async () => ({ ok: true, content: 'ran' }),
    clearCachedSections: () => {},
    getContextBudget: () => ({ contextWindow: 200_000, usableContextWindow: 167_000 }),
    // The runtime snapshot reads the active model off the loop — capability included.
    getActiveModel: () => ({ model: 'test-model', modelKey: 'main', contextWindow: 200_000 }),
  },
  planModeManager: undefined,
  modelKey: 'main',
  modelConfig: { model: 'test-model', apiKey: 'SECRET' },
  providerName: 'anthropic',
}
const runtimeSlot = {
  current: agentSession,
  subscribe: () => () => {},
  getEffort: () => 'high',
  setEffort: (level) => level,
  reapplyEffort: () => 'high',
  replace: () => {},
}

// One fake standing in for both halves: \`RuntimeHost\` is exactly their
// intersection, so a single-session host sees what it always did.
const runtimeHost = {
  cwd: process.cwd(),
  session: { id: 'child-session' },
  store: {},
  // What the runtime snapshot reads to name the model's source.
  config: {
    get: () => ({ models: {}, defaultModel: 'main' }),
    getModel: () => ({ model: 'test-model' }),
    resolveModelReference: (reference) => reference,
    resolveModelKeyFor: () => 'main',
    getRouting: () => ({ main: 'main' }),
    resolveCoordinationModelKey: () => ({ modelKey: 'main' }),
    getCoordination: () => ({ quietDays: 3, autoResolveDays: 7 }),
  },
  bridges,
  // Per-project slash commands. The child never sends \`run-command\`, but tsc
  // cannot see this string — keep it faithful, per todo.md (工作方法).
  commands: new CommandRegistry(),
  existingRecords: [],
  diagnostics: [],
  mcp: { connected: [], failed: [] },
  hasRecoverableInterruption: false,
  configuredEffortLevel: 'medium',
  permissionGate: { getMode: () => 'default', onModeChange: () => () => {} },
  backgroundTasks: { subscribe: () => () => {}, getSnapshot: () => [], hasParentNotifications: () => false },
  createRuntime: () => agentSession,
  createActiveModelRuntime: (key) => ({ model: key }),
}

// workspace is a minimal PaneRegistry stub: the child never sends pane
// commands, but tsc cannot see this string literal — keep the shape
// faithful to the interface so adding a new dep here (or removing one) is
// caught at edit time, not at runtime. See todo.md (工作方法).
const host = new SessionHost({
  channel: createNodeProcessChannel(process),
  controller,
  runtimeSlot,
  project: runtimeHost,
  scope: runtimeHost,
  workspace: {
    list: () => [],
    paneForSession: () => undefined,
    open: async () => ({}),
    adopt: () => ({}),
    close: () => {},
  },
  onPaneOpened: () => {},
  onPaneClosed: () => {},
})

// Lets the parent trigger a permission prompt from inside the child.
process.on('message', (message) => {
  if (message && message.type === '__ask_permission') {
    bridges.prompt.prompt({
      tool: { name: 'Bash', riskLevel: 'confirm' },
      input: { command: 'ls' },
      reason: 'child test',
      source: 'default',
      denialStreak: 0,
    }).then((approved) => {
      process.send({ type: '__permission_result', approved })
    })
  }
  if (message && message.type === '__echo_request') {
    process.send({ type: '__echo', payload: message })
  }
  if (message && message.type === '__hang_checkpoints') {
    hangCheckpoints = true
    process.send({ type: '__hanging' })
  }
})

process.send({ type: '__ready' })
`
}

interface Child {
  client: SessionClient
  proc: ReturnType<typeof fork>
  raw: unknown[]
  kill: () => void
}

async function startChild(): Promise<Child> {
  const dir = await mkdtemp(path.join(tmpdir(), 'myagent-ipc-'))
  const entry = path.join(dir, 'host-child.mjs')
  await writeFile(entry, childSource(), 'utf8')

  // Left as a file:// URL, not a path: Node reads a bare Windows path after
  // `--import` as a URL whose scheme is the drive letter.
  const tsx = import.meta.resolve('tsx')
  const proc = fork(entry, [], {
    execArgv: ['--import', tsx],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.json') },
  })

  const raw: unknown[] = []
  proc.on('message', (message) => raw.push(message))

  // Collected so a child that dies during startup reports why, instead of a
  // bare exit code.
  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never became ready')), 30_000)
    proc.on('message', (message) => {
      if ((message as { type?: string })?.type === '__ready') {
        clearTimeout(timer)
        resolve()
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`child exited early with code ${code}\n${stderr}`))
    })
  })

  const client = new SessionClient(createNodeProcessChannel(proc))
  return { client, proc, raw, kill: () => proc.kill() }
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

test('a turn driven across a real process boundary streams events back', async (t) => {
  const child = await startChild()
  t.after(() => child.kill())

  const events: string[] = []
  child.client.onEvent((event) => events.push(event.type))

  const hello = await child.client.hello()
  assert.equal(hello.sessionId, 'child-session')

  await child.client.submit('hello from the parent')

  assert.deepEqual(events, ['turn-start', 'record', 'turn-end'])
  assert.equal(child.client.getSubagentProgress().get('agent-1'), 'Reading')
})

test('the runtime snapshot crosses without the model apiKey', async (t) => {
  const child = await startChild()
  t.after(() => child.kill())

  await child.client.hello()
  const runtime = await waitFor(() => child.client.getRuntimeSnapshot(), 'a runtime snapshot')

  assert.equal(runtime.status, 'ready')
  assert.equal(runtime.modelKey, 'main')
  assert.equal(runtime.model, 'test-model')
  assert.equal(JSON.stringify(runtime).includes('SECRET'), false)
})

test('a permission prompt round-trips through the parent and back', async (t) => {
  const child = await startChild()
  t.after(() => child.kill())

  child.client.setHandlers({
    permission: async (request) => {
      assert.equal(request.toolName, 'Bash')
      assert.equal(request.riskLevel, 'confirm')
      assert.deepEqual(request.input, { command: 'ls' })
      return { approved: true }
    },
  })

  await child.client.hello()
  child.proc.send({ type: '__ask_permission' })

  const result = await waitFor(
    () => child.raw.find((message) => (message as { type?: string })?.type === '__permission_result'),
    'the child\'s permission result',
  ) as { approved: boolean }

  assert.equal(result.approved, true, 'the gate inside the child got the parent\'s answer')
})

test('killing the host rejects the parent\'s in-flight commands', async (t) => {
  const child = await startChild()
  t.after(() => child.kill())

  await child.client.hello()

  // Park the child's checkpoint service first. Without this the test races the
  // reply against the kill: `getCheckpointsWithDiffs` answers immediately, so
  // whether anything is still in flight depends on which crosses the IPC pipe
  // first — and it flipped the moment `hello` grew a disk read (the git branch),
  // because that changed when the child yields.
  child.proc.send({ type: '__hang_checkpoints' } as never)
  await waitFor(
    () => child.raw.find((message) => (message as { type?: string })?.type === '__hanging'),
    'the child to park its checkpoint service',
  )

  // Attached before the kill so the rejection is never briefly unhandled.
  const pending = assert.rejects(child.client.getCheckpoints(), /host disconnected/)
  child.proc.kill()
  await pending
})

test('Node IPC silently drops a function, which is why the memory channel clones', async (t) => {
  const child = await startChild()
  t.after(() => child.kill())

  await child.client.hello()

  // `child_process.send` defaults to JSON serialization: a function-valued
  // field vanishes without an error. Electron's IPC uses structured clone and
  // would throw instead. Neither is a safety net we can rely on here, so
  // `createMemoryChannelPair` runs `structuredClone` on every post and every
  // in-process protocol test fails loudly on a payload like this one.
  let echoed: unknown
  child.proc.on('message', (message) => {
    if ((message as { type?: string })?.type === '__echo') echoed = message
  })
  child.proc.send({ type: '__echo_request', fn: () => {}, keep: 'value' } as never)

  const received = await waitFor(
    () => (echoed as { payload?: Record<string, unknown> } | undefined)?.payload,
    'the child\'s echo',
  )
  assert.deepEqual(received, { type: '__echo_request', keep: 'value' },
    'the function is gone and nothing warned us')
})
