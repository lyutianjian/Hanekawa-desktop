import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod/v3'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { ModelProvider, SessionRecord, Tool, ToolContext } from '../src/harness/types.js'

function mainRecordStream(records: SessionRecord[]): RecordStream {
  return {
    async append(record) { records.push(record) },
    async load() { return records.slice() },
  }
}

function neverProvider(): ModelProvider {
  return {
    name: 'never',
    async createMessage() {
      throw new Error('provider must not be invoked for runTool tests')
    },
  }
}

function makeLoop(opts: {
  tools: Tool[]
  toolContext: ToolContext
  mainRecords: SessionRecord[]
  provider?: ModelProvider
}) {
  const runner = new ToolRunner(opts.tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { opts.mainRecords.push(record) },
  })
  const loop = new AgentLoop({
    provider: opts.provider ?? neverProvider(),
    model: 'fake-model',
    tools: opts.tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: opts.toolContext,
    recordStream: mainRecordStream(opts.mainRecords),
  })
  return { loop, runner }
}

const noopSchema = z.object({}).strict()

test('runTool does not write tool_use/tool_result records to the main session by default', async () => {
  const tool: Tool = {
    name: 'noop',
    description: 'no-op',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute() {
      return { ok: true, content: 'done' }
    },
  }
  const mainRecords: SessionRecord[] = []
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-iso-1',
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords })

  const result = await loop.runTool({ id: 'verify-1', name: 'noop', input: {} })

  assert.equal(result.ok, true)
  // Main session must remain pristine.
  assert.deepEqual(mainRecords, [], 'runTool leaked records into the main session')
})

test('runTool forks toolContext: mutations do not leak back to the main loop', async () => {
  const probedFiles = new Set<string>()
  const probedState = new Map<string, { content: string; timestamp: number; mtimeMs: number; size: number }>()

  const tool: Tool = {
    name: 'mutator',
    description: 'pretends to read a file',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute(_input, ctx) {
      // Simulate Read-style state mutation on the context the tool receives.
      ctx.readFiles.add('/tmp/secret.txt')
      ctx.readFileState?.set('/tmp/secret.txt', {
        content: 'leaked',
        timestamp: 1,
        mtimeMs: 1,
        size: 6,
      })
      probedFiles.add('/tmp/secret.txt')
      probedState.set('/tmp/secret.txt', {
        content: 'leaked',
        timestamp: 1,
        mtimeMs: 1,
        size: 6,
      })
      return { ok: true, content: 'mutated' }
    },
  }

  const mainRecords: SessionRecord[] = []
  const mainContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-iso-2',
    readFiles: new Set(['/main/known.txt']),
    readFileState: new Map([
      ['/main/known.txt', { content: 'main', timestamp: 0, mtimeMs: 0, size: 4 }],
    ]),
    invokedSkills: new Map(),
    taskState: new Map(),
  }
  const { loop } = makeLoop({ tools: [tool], toolContext: mainContext, mainRecords })

  const result = await loop.runTool({ id: 'mut-1', name: 'mutator', input: {} })
  assert.equal(result.ok, true)

  // The mutator did mutate *its* context (sanity check).
  assert.deepEqual([...probedFiles], ['/tmp/secret.txt'])

  // But the main loop's context must be unchanged.
  assert.deepEqual([...mainContext.readFiles], ['/main/known.txt'])
  assert.equal(mainContext.readFileState?.has('/tmp/secret.txt'), false)
  assert.equal(mainContext.readFileState?.get('/main/known.txt')?.content, 'main')
})

test('runTool routes records to a caller-supplied recordStream when provided', async () => {
  const tool: Tool = {
    name: 'noop',
    description: 'no-op',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute() {
      return { ok: true, content: 'ok' }
    },
  }
  const mainRecords: SessionRecord[] = []
  const captured: SessionRecord[] = []
  const sink: RecordStream = {
    async append(record) { captured.push(record) },
    async load() { return captured.slice() },
  }
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-iso-3',
    readFiles: new Set(),
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords })

  await loop.runTool(
    { id: 't-1', name: 'noop', input: {} },
    { recordStream: sink, turnId: 'turn-iso-1' },
  )

  assert.deepEqual(mainRecords, [])
  const types = captured.map((record) => record.type)
  assert.ok(types.includes('tool_use'), `expected tool_use in ${types.join(',')}`)
  assert.ok(types.includes('tool_result'), `expected tool_result in ${types.join(',')}`)
  for (const record of captured) {
    if ('turnId' in record) {
      assert.equal(record.turnId, 'turn-iso-1')
    }
  }
})

test('runTool serializes against a concurrent run() via the in-flight gate', async () => {
  // Two deferreds: one signals when provider.createMessage is mid-flight,
  // the other gates when it returns. This lets us assert ordering deterministically.
  let signalRunMidFlight: () => void = () => {}
  let releaseRun: () => void = () => {}
  const runMidFlight = new Promise<void>((resolve) => { signalRunMidFlight = resolve })
  const runReleased = new Promise<void>((resolve) => { releaseRun = resolve })

  const provider: ModelProvider = {
    name: 'blocking',
    async createMessage() {
      signalRunMidFlight()
      await runReleased
      return { content: 'final', toolCalls: [] }
    },
  }

  const events: string[] = []
  const tool: Tool = {
    name: 'noop',
    description: 'no-op',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute() {
      events.push('tool:exec')
      return { ok: true, content: 'tool-ok' }
    },
  }
  const mainRecords: SessionRecord[] = []
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-iso-4',
    readFiles: new Set(),
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords, provider })

  // Kick run() but do NOT await.
  const runPromise = loop.run({ text: 'hello' }).then((r) => {
    events.push('run:resolved')
    return r
  })

  // Wait until run() is genuinely mid-flight inside the provider call.
  await runMidFlight

  // Dispatch runTool while run() is blocked. It must queue.
  const runToolPromise = loop.runTool({ id: 'tt-1', name: 'noop', input: {} }).then((r) => {
    events.push('runTool:resolved')
    return r
  })

  // Yield several macrotask turns. runTool must not progress while run() is in flight.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(events, [], `runTool executed before run() finished: ${events.join(',')}`)

  // Release run().
  releaseRun()

  const [runResult, toolResult] = await Promise.all([runPromise, runToolPromise])
  assert.equal(runResult.content, 'final')
  assert.equal(toolResult.ok, true)
  // run() must resolve first, then runTool's tool executes, then runTool resolves.
  assert.deepEqual(events, ['run:resolved', 'tool:exec', 'runTool:resolved'])
})

test('runTool rejects synchronously when given a pre-aborted signal', async () => {
  const tool: Tool = {
    name: 'noop',
    description: 'no-op',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute() {
      throw new Error('should not reach execute')
    },
  }
  const mainRecords: SessionRecord[] = []
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-iso-5',
    readFiles: new Set(),
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords })

  const ac = new AbortController()
  ac.abort()

  await assert.rejects(
    () => loop.runTool({ id: 't-abort', name: 'noop', input: {} }, { signal: ac.signal }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  )
  // Aborted call must not leave any record behind in the main stream.
  assert.deepEqual(mainRecords, [])
})

test('ToolRunner.fork shares tools, gate, and hooks but isolates record events', async () => {
  const events: SessionRecord[] = []
  const forkedEvents: SessionRecord[] = []
  let listenerInvocations = 0

  const tool: Tool = {
    name: 'noop',
    description: 'no-op',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute() {
      return { ok: true, content: 'ok' }
    },
  }
  const baseRunner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { events.push(record) },
  })
  baseRunner.addRecordListener(() => { listenerInvocations += 1 })

  const forked = baseRunner.fork({
    onRecord: async (record) => { forkedEvents.push(record) },
  })

  await forked.run(
    { id: 'f-1', name: 'noop', input: {} },
    { cwd: process.cwd(), sessionId: 's-fork', readFiles: new Set() },
    undefined,
    'turn-fork',
  )

  // Forked runner must not emit through the original sink.
  assert.deepEqual(events, [])
  // Forked runner must not invoke listeners registered on the original.
  assert.equal(listenerInvocations, 0)
  // Forked runner DID receive its own events.
  const forkedTypes = forkedEvents.map((record) => record.type)
  assert.ok(forkedTypes.includes('tool_use'))
  assert.ok(forkedTypes.includes('tool_result'))
})


test('planModeBridge is visible to a tool execute() call on the main ToolContext', async () => {
  let observedBridge: { parentSessionId: string; activePlanFilePath?: string } | undefined
  const tool: Tool = {
    name: 'inspect',
    description: 'inspect bridge',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute(_input, ctx) {
      observedBridge = ctx.planModeBridge
        ? {
          parentSessionId: ctx.planModeBridge.parentSessionId,
          activePlanFilePath: ctx.planModeBridge.activePlanFilePath,
        }
        : undefined
      return { ok: true, content: '' }
    },
  }
  const parentRecords: SessionRecord[] = []
  const mainRecords: SessionRecord[] = []
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-bridge-1',
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
    planModeBridge: {
      parentSessionId: 's-bridge-1',
      parentAppendRecord: async (record) => { parentRecords.push(record) },
      activePlanFilePath: '/abs/.hanekawa/plans/crimson-tiger-abc.md',
    },
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords })

  await loop.runTool({ id: 'b1', name: 'inspect', input: {} })

  assert.equal(observedBridge?.parentSessionId, 's-bridge-1')
  assert.equal(observedBridge?.activePlanFilePath, '/abs/.hanekawa/plans/crimson-tiger-abc.md')
})

test('planModeBridge.parentAppendRecord routes to the parent stream, bypassing tool runner emit', async () => {
  const parentRecords: SessionRecord[] = []
  const tool: Tool = {
    name: 'emit-via-bridge',
    description: 'emit a request via bridge',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute(_input, ctx) {
      await ctx.planModeBridge?.parentAppendRecord({
        id: 'req-from-tool',
        type: 'plan_mode_request',
        kind: 'enter',
        submittedFromSessionId: ctx.sessionId,
        createdAt: new Date().toISOString(),
      })
      return { ok: true, content: '' }
    },
  }
  const mainRecords: SessionRecord[] = []
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-bridge-2',
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
    planModeBridge: {
      parentSessionId: 's-bridge-2',
      parentAppendRecord: async (record) => { parentRecords.push(record) },
    },
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords })

  await loop.runTool({ id: 'b2', name: 'emit-via-bridge', input: {} })

  // The plan_mode_request record went to the parent stream, NOT the
  // mainRecords (which is fed by ToolRunner.emit). For this test the
  // toolContext is the main session, so parent and runner streams happen
  // to be different sinks; the assertion is that bridge writes appear in
  // parentRecords specifically.
  assert.equal(parentRecords.length, 1)
  assert.equal(parentRecords[0]?.type, 'plan_mode_request')
})

test('ToolRunner preserves a parent-supplied planModeBridge verbatim (regression)', async () => {
  let observedBridge: typeof toolContext.planModeBridge
  const tool: Tool = {
    name: 'reflect',
    description: 'reflect bridge',
    inputSchema: noopSchema,
    riskLevel: 'safe',
    async execute(_input, ctx) {
      observedBridge = ctx.planModeBridge
      return { ok: true, content: '' }
    },
  }
  const mainRecords: SessionRecord[] = []
  const bridge = {
    parentSessionId: 's-pres',
    parentAppendRecord: async () => {},
    activePlanFilePath: '/x/.hanekawa/plans/pres.md',
  } as const
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    sessionId: 's-pres',
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
    planModeBridge: bridge,
  }
  const { loop } = makeLoop({ tools: [tool], toolContext, mainRecords })

  await loop.runTool({ id: 'b3', name: 'reflect', input: {} })

  // Identity check: tool received the SAME bridge object the parent set.
  assert.equal(observedBridge, bridge)
  assert.equal(observedBridge?.parentSessionId, 's-pres')
  assert.equal(observedBridge?.activePlanFilePath, '/x/.hanekawa/plans/pres.md')
})
