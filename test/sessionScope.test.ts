import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v3'
import { bootstrap } from '../src/runtime/index.js'
import type { SessionScope } from '../src/runtime/index.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'
import {
  ImageAttachmentService,
  sessionAttachmentsDir,
} from '../src/services/imageAttachments/imageAttachmentService.js'
import { CoordinationStore } from '../src/services/coordination/threadStore.js'
import { loadFixtureBytes } from './helpers/imageFixtures.js'
import type { SessionCoordination } from '../src/sessions/service.js'
import type { AgentSession } from '../src/runtime/index.js'
import type { ToolContext } from '../src/harness/types.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import {
  getCoordinationNotesDir,
  getProjectDataDir,
  getProjectMemoryDir,
} from '../src/utils/paths.js'
import { getPlansDir } from '../src/utils/plans.js'

/**
 * What one process may hold twice.
 *
 * `bootstrap()` used to assemble the bridges, the permission gate and the
 * prompt-section cache inline and exactly once, which meant a second concurrent
 * session would have had to share all three. These tests pin the seam that
 * split them: everything on a `SessionScope` is per-conversation, everything on
 * the `ProjectRuntime` is shared on purpose, and the sharing is what makes two
 * tabs cheap rather than what makes them wrong.
 */

// Account configuration is global; every test needs its own home.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

const MODEL_CONFIG = {
  models: { main: { provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' } },
  defaultModel: 'main',
}

async function createProject(options: {
  config?: Record<string, unknown>
  settings?: Record<string, unknown>
} = {}): Promise<{ cwd: string; store: SessionStore; session: SessionMeta }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-scope-'))
  await mkdir(path.join(cwd, '.myagent'), { recursive: true })
  await mkdir(path.join(process.env.HOME!, '.myagent'), { recursive: true })
  await writeFile(
    path.join(process.env.HOME!, '.myagent', 'config.json'),
    JSON.stringify(options.config ?? MODEL_CONFIG),
    'utf8',
  )
  if (options.settings) {
    await writeFile(
      path.join(cwd, '.myagent', 'settings.json'),
      JSON.stringify(options.settings),
      'utf8',
    )
  }
  const store = new SessionStore(cwd)
  await store.init()
  return { cwd, store, session: await store.create('scope test') }
}

const denyTrust = async () => false

function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'done' }),
  }
}

function permissionRequest(name: string): PermissionRequest {
  return { tool: tool(name), input: {}, reason: 'test', source: 'mode', denialStreak: 0 }
}

test('two scopes route their prompts to their own UI, never to each other', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  assert.notEqual(second.bridges, host.bridges)
  assert.notEqual(second.permissionGate, host.permissionGate)
  assert.notEqual(second.promptSections, host.promptSections,
    'the cached Environment block names a model, so a shared cache leaks one tab\'s model into the other')

  const askedFirst: string[] = []
  const askedSecond: string[] = []
  host.bridges.prompt.setPrompt(async (request) => {
    askedFirst.push(request.tool.name)
    return true
  })
  second.bridges.prompt.setPrompt(async (request) => {
    askedSecond.push(request.tool.name)
    return true
  })

  assert.equal(await host.permissionGate.approve(tool('First'), {}), true)
  assert.equal(await second.permissionGate.approve(tool('Second'), {}), true)

  // A single set of bridges has one handler slot per proxy, so sharing would
  // send whichever scope installed last both tabs' prompts.
  assert.deepEqual(askedFirst, ['First'])
  assert.deepEqual(askedSecond, ['Second'])

  await host.shutdown('test over')
})

test('a permission mode change stays inside the scope that made it', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  host.permissionGate.setMode('plan')

  assert.equal(host.permissionGate.getMode(), 'plan')
  assert.equal(second.permissionGate.getMode(), 'default',
    'entering plan mode in one tab must not restrict the other')

  second.permissionGate.setMode('bypass')
  assert.equal(host.permissionGate.getMode(), 'plan')

  await host.shutdown('test over')
})

test('reloading settings reaches every open scope, not just the newest', async () => {
  const { cwd, store, session } = await createProject({
    settings: { permissions: { deny: ['Bash(rm *)'] } },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  assert.equal(host.permissionGate.getConfigRules().length, 1)
  assert.equal(second.permissionGate.getConfigRules().length, 1)

  await writeFile(
    path.join(cwd, '.myagent', 'settings.json'),
    JSON.stringify({ permissions: { deny: ['Bash(rm *)', 'Bash(curl *)'] } }),
    'utf8',
  )
  await host.reloadSettings()

  // Each scope holds its own gate, so reaching only one would leave the other
  // tab enforcing the rules the process started with.
  assert.equal(host.permissionGate.getConfigRules().length, 2)
  assert.equal(second.permissionGate.getConfigRules().length, 2)

  await host.shutdown('test over')
})

test('disposing a scope restores the four asymmetric fallbacks', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const scope = await host.openScope(await store.create('second tab'))

  // Parked before dispose: with no UI attached the permission bridge waits
  // rather than auto-denying, and only a drain settles it.
  const parked = scope.bridges.prompt.prompt(permissionRequest('Parked'))

  const records: SessionRecord[] = []
  scope.bridges.record.setHandler((record) => { records.push(record) })
  scope.bridges.askUserQuestion.setOpen(async () => ({ kind: 'answers', answers: {} }))
  scope.bridges.enterPlan.setOpen(async () => false)
  scope.bridges.exitPlan.setOpen(async () => ({ kind: 'approve_restore_keep' }))

  scope.dispose()

  assert.equal(await parked, false, 'a UI that is never coming has to release the tool call')
  assert.equal(await scope.bridges.enterPlan.open(), true,
    'entering plan mode only ever restricts the agent, so its fallback approves')
  assert.deepEqual(await scope.bridges.exitPlan.open({ planContent: '', planFilePath: '' }),
    { kind: 'reject', feedback: '' })
  const asked = await scope.bridges.askUserQuestion.ask({ questions: [] })
  assert.equal(asked.kind, 'rejected')

  scope.bridges.record.onRecord({
    id: 'r1',
    type: 'message',
    role: 'user',
    content: 'dropped',
    createdAt: new Date().toISOString(),
  } as SessionRecord)
  assert.deepEqual(records, [], 'the record bridge drops rather than answering')

  await host.shutdown('test over')
})

test('shutdown releases every open scope, not only the one bootstrap opened', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  const parkedFirst = host.bridges.prompt.prompt(permissionRequest('First'))
  const parkedSecond = second.bridges.prompt.prompt(permissionRequest('Second'))

  await host.shutdown('test over')

  assert.equal(await parkedFirst, false)
  assert.equal(await parkedSecond, false)
})

test('closing a scope and shutting the project down leaves committed attachments on disk', async () => {
  // Design §12.3, "close pane / release runtime": memory and previews go, the
  // files stay. Deleting them here would silently empty the transcript of a
  // session the user only closed a tab on.
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  const stored = await host.attachments.importImage(
    session.id,
    await loadFixtureBytes('transparent.png'),
    'transparent.png',
  )
  assert.equal(stored.ok, true, JSON.stringify(stored))
  if (!stored.ok) return

  second.dispose()
  await host.shutdown('test over')

  assert.equal(existsSync(sessionAttachmentsDir(cwd, session.id)), true)
  // Still resolvable through a freshly built service, not just the live one.
  const reopened = await new ImageAttachmentService(cwd).readSendBytes(stored.value.ref)
  assert.equal(reopened.ok, true)
})

test('a scope opened onto a live session does not restore its tasks twice', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  const restored: string[] = []
  host.backgroundTasks.restoreSession = async (sessionId: string) => {
    restored.push(sessionId)
    return []
  }
  // Registered tasks are how a scope recognises a session that is already live
  // in this process.
  host.backgroundTasks.getSnapshot = (sessionId: string) => (
    sessionId === session.id ? [{ id: 'task-1' }] : []
  ) as unknown as ReturnType<typeof host.backgroundTasks.getSnapshot>

  await host.openScope(session)

  assert.deepEqual(restored, [],
    'restoring again would double-register every background task the session owns')

  await host.shutdown('test over')
})

test('the project\'s startup diagnostics are surfaced once, by the initial scope', async () => {
  const { cwd, store, session } = await createProject({
    config: { ...MODEL_CONFIG, fallbackModel: 'typo-model' },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.ok(host.diagnostics.some((diagnostic) => diagnostic.code === 'unknown_fallback_model'))

  const second: SessionScope = await host.openScope(await store.create('second tab'))
  assert.deepEqual(second.diagnostics, [],
    'a project warning shown once per tab would be shown once too often')

  await host.shutdown('test over')
})

// --- Coordination roles ----------------------------------------------------

async function coordinationSession(
  store: SessionStore,
  cwd: string,
  value: Omit<SessionCoordination, 'projectKey'>,
): Promise<SessionMeta> {
  const created = await store.create(value.role)
  await store.setCoordination(created.id, { ...value, projectKey: path.basename(getProjectDataDir(cwd)) })
  const meta = await store.resolve(created.id)
  assert.ok(meta?.coordination)
  return meta
}

/** The tool array the runtime's loop was built with; private, so read through a cast. */
function toolsOf(runtime: AgentSession): Tool[] {
  return (runtime.loop as unknown as { options: { tools: Tool[] } }).options.tools
}

function contextProbe(): { tool: Tool; seen: ToolContext[] } {
  const seen: ToolContext[] = []
  return {
    seen,
    tool: {
      name: 'ContextProbe',
      description: 'probe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      execute: async (_input, context) => {
        seen.push(context)
        return { ok: true, content: 'ok' }
      },
    },
  }
}

test('a thread scope runs tools in its worktree but keys data dirs off the project', async () => {
  const { cwd, store, session } = await createProject()
  const worktree = await mkdtemp(path.join(tmpdir(), 'myagent-worktree-'))
  const probe = contextProbe()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust, extraTools: [probe.tool] })
  const thread = await host.openScope(await coordinationSession(store, cwd, { role: 'thread', threadId: 't1', workingDir: worktree }))

  assert.equal(thread.workingDir, worktree)
  assert.equal(thread.projectDir, cwd)
  assert.equal(thread.role, 'thread')

  const runtime = thread.createRuntime('main', thread.session)
  await runtime.loop.runTool({ id: 'c1', name: 'ContextProbe', input: {} })
  const context = probe.seen[0]
  assert.ok(context)
  assert.equal(context.cwd, worktree)
  assert.equal(context.projectDir, cwd)
  assert.equal(runtime.planModeManager.resolvePlanFilePathLazy().startsWith(getPlansDir(cwd)), true)
  // Memory is keyed off the project: writing there needs no prompt.
  thread.bridges.prompt.setPrompt(async () => false)
  assert.equal(await thread.permissionGate.approve(writeFileTool, {
    file_path: path.join(getProjectMemoryDir(cwd), 'note.md'),
    content: 'x',
  }), true)

  runtime.dispose()
  await host.shutdown('test over')
})

test('a coordinator scope is locked readonly and gets the coordinator tool set', async () => {
  const { cwd, store, session } = await createProject({ settings: { permissions: { mode: 'bypass' } } })
  const coordinatorTool: Tool = { ...tool('CoordinatorOnly'), sessionRoles: ['coordinator'] }
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust, extraTools: [coordinatorTool] })
  const coordinator = await host.openScope(await coordinationSession(store, cwd, { role: 'coordinator' }))

  assert.equal(coordinator.permissionGate.getMode(), 'readonly')
  assert.equal(coordinator.permissionGate.isModeLocked(), true)
  coordinator.permissionGate.setMode('bypass')
  coordinator.permissionGate.prepareContextForPlanMode()
  assert.equal(coordinator.permissionGate.getMode(), 'readonly')

  const coordinatorRuntime = coordinator.createRuntime('main', coordinator.session)
  const names = toolsOf(coordinatorRuntime).map((entry) => entry.name)
  assert.ok(names.includes('CoordinatorOnly'))
  assert.ok(!names.includes('EnterPlanMode'))
  assert.ok(!names.includes('ExitPlanMode'))

  const normalRuntime = host.createRuntime('main', session)
  const normalNames = toolsOf(normalRuntime).map((entry) => entry.name)
  assert.ok(!normalNames.includes('CoordinatorOnly'))
  assert.ok(normalNames.includes('EnterPlanMode'))

  coordinatorRuntime.dispose()
  normalRuntime.dispose()
  await host.shutdown('test over')
})

test('only the coordinator loop gets the role prompt and coordination hooks; a superseded one does not consume', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const coordinator = await host.openScope(await coordinationSession(store, cwd, { role: 'coordinator' }))
  const thread = await host.openScope(await coordinationSession(store, cwd, { role: 'thread', threadId: 't1' }))
  type Opts = { rolePrompt?: string; compactPromptVariant?: string; consumeCoordinationUpdate?: () => Promise<unknown>; coordinationRestore?: unknown; taskRestore?: unknown }
  const optsOf = (r: AgentSession): Opts => (r.loop as unknown as { options: Opts }).options
  const coordRuntime = coordinator.createRuntime('main', coordinator.session)
  const threadRuntime = thread.createRuntime('main', thread.session)
  const normalRuntime = host.createRuntime('main', session)

  const c = optsOf(coordRuntime)
  assert.ok(c.rolePrompt)
  assert.equal(c.compactPromptVariant, 'coordinator')
  assert.equal(typeof c.consumeCoordinationUpdate, 'function')
  assert.equal(typeof c.coordinationRestore, 'function')
  assert.equal(c.taskRestore, undefined)

  // A thread restores its own task, never the board.
  const t = optsOf(threadRuntime)
  assert.equal(t.rolePrompt, undefined)
  assert.equal(t.compactPromptVariant, 'thread')
  assert.equal(t.consumeCoordinationUpdate, undefined)
  assert.equal(t.coordinationRestore, undefined)
  assert.equal(typeof t.taskRestore, 'function')

  // An ordinary session gets none of it.
  const n = optsOf(normalRuntime)
  assert.equal(n.rolePrompt, undefined)
  assert.equal(n.compactPromptVariant, undefined)
  assert.equal(n.consumeCoordinationUpdate, undefined)
  assert.equal(n.coordinationRestore, undefined)
  assert.equal(n.taskRestore, undefined)

  const coordStore = new CoordinationStore(cwd)
  await coordStore.setCoordinatorSessionId(coordinator.session.id)
  await coordStore.setPendingSnapshot('BOARD')
  const taken = await c.consumeCoordinationUpdate!() as { content: string; ack(): Promise<void> }
  assert.match(taken.content, /Thread board/)
  await coordStore.setCoordinatorSessionId('someone-else')
  await coordStore.setPendingSnapshot('BOARD2')
  assert.equal(await c.consumeCoordinationUpdate!(), undefined)

  coordRuntime.dispose()
  threadRuntime.dispose()
  normalRuntime.dispose()
  await host.shutdown('test over')
})

test('a thread scope starts in auto whatever the global mode is', async () => {
  const { cwd, store, session } = await createProject({ settings: { permissions: { mode: 'plan' } } })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const thread = await host.openScope(await coordinationSession(store, cwd, { role: 'thread', threadId: 't1' }))

  assert.equal(thread.permissionGate.getMode(), 'auto')
  assert.equal(thread.permissionGate.isModeLocked(), false)
  assert.equal(thread.workingDir, cwd)

  await host.shutdown('test over')
})

test('coordination scopes reach the shared notes dir; a normal scope does not', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const worktree = await mkdtemp(path.join(tmpdir(), 'myagent-worktree-'))
  const thread = await host.openScope(await coordinationSession(store, cwd, { role: 'thread', threadId: 't1', workingDir: worktree }))
  const coordinator = await host.openScope(await coordinationSession(store, cwd, { role: 'coordinator' }))
  const notesDir = getCoordinationNotesDir(cwd)
  const note = path.join(notesDir, 't1.md')

  const prompted: string[] = []
  for (const scope of [thread, coordinator]) {
    scope.bridges.prompt.setPrompt(async (request) => {
      prompted.push(request.tool.name)
      return false
    })
  }

  assert.equal(await thread.permissionGate.approve(writeFileTool, { file_path: note, content: 'x' }), true)
  assert.equal(await coordinator.permissionGate.approve(readFileTool, { file_path: note }), true)
  assert.deepEqual(prompted, [])

  assert.ok(thread.permissionGate.getAdditionalDirectories().some((dir) => dir.endsWith(path.join('coordination', 'notes'))))
  assert.deepEqual(host.permissionGate.getAdditionalDirectories(), [])

  await host.shutdown('test over')
})
