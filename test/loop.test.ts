import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { AgentLoop } from '../src/harness/loop.js'
import { displayCacheSource, forkCacheSource } from '../src/harness/cacheBreakDetection.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate, type PermissionMode } from '../src/harness/permissions.js'
import { PlanModeManager } from '../src/harness/planModeManager.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { createAgentTool } from '../src/tools/AgentTool/AgentTool.js'
import { exitPlanModeTool } from '../src/tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { toolSearchTool } from '../src/tools/ToolSearchTool/ToolSearchTool.js'
import { SessionStore } from '../src/sessions/service.js'
import { clearAllPlanSlugs, writePlan } from '../src/utils/plans.js'
import { getAutoCompactThreshold } from '../src/prompts/budget.js'
import { getCompactPrompt } from '../src/prompts/compactPrompt.js'
import type { SessionMetricInput } from '../src/harness/metrics.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { ChatMessage, ModelProvider, ModelRequest, ModelStreamEvent, SessionRecord, TokenUsage, Tool } from '../src/harness/types.js'
import { FallbackNotApplicableForImagesError, TurnImageBlockError } from '../src/harness/turnImages.js'
import { FallbackTriggeredError } from '../src/config/retry.js'
import { resetAutoCompactFailureState } from '../src/harness/compact.js'
import { fixtureImagePath, loadFixtureBytes, makeImageAttachmentRef } from './helpers/imageFixtures.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  resetCacheBreakDetection,
} from '../src/harness/cacheBreakDetection.js'

function recordStreamFor(
  records: SessionRecord[],
  metrics?: Array<Record<string, unknown>>,
  onLoad?: () => void,
): RecordStream {
  return {
    load: async () => {
      onLoad?.()
      return records
    },
    append: async (record) => { records.push(record) },
    update: async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      if (index < 0) return
      const record = records[index]
      if (!record) return
      records[index] = update(record)
    },
    ...(metrics
      ? { appendMetric: async (metric: SessionMetricInput) => { metrics.push(metric) } }
      : {}),
  }
}

function testTool(name: string, options: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async () => ({ ok: true, content: `${name} result` }),
    ...options,
  }
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key as keyof typeof process.env]
  } else {
    process.env[key] = value
  }
}

test('agent loop appends user and assistant messages', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      assert.ok(!('maxTokens' in request))
      assert.equal(displayCacheSource(request.cacheSource!), 'agent:s1')
      return {
        content: 'hello back',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 10,
          inputTokens: 20,
          outputTokens: 30,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, metrics),
  })
  const response = await loop.run({ text: 'hello' })
  assert.equal(response.content, 'hello back')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 10,
    inputTokens: 20,
    outputTokens: 30,
  })
  assert.deepEqual(response.statusUsage, {
    cacheReadInputTokens: 10,
    inputTokens: 20,
    outputTokens: 30,
  })
  assert.equal(records.filter((record) => record.type === 'message').length, 2)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0]?.event, 'turn')
  assert.equal(metrics[0]?.model, 'fake-model')
  assert.equal(metrics[0]?.response_tokens, 30)
  assert.equal(metrics[0]?.cache_read_tokens, 10)
  assert.equal(metrics[0]?.tool_calls, 0)
})

test('a UserInput with images persists the refs on the user message record', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: 'seen',
        toolCalls: [],
        usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    supportsImageInput: true,
  })

  const first = makeImageAttachmentRef({ id: 'img-a', ownerSessionId: 's1', name: 'first.png' })
  const second = makeImageAttachmentRef({ id: 'img-b', ownerSessionId: 's1', name: 'second.png' })
  await loop.run({ text: 'look at these', images: [first, second] })

  const user = records[0]
  assert.equal(user?.type, 'message')
  if (user?.type !== 'message') return
  assert.equal(user.role, 'user')
  assert.equal(user.content, 'look at these')
  assert.deepEqual(user.images, [first, second])

  // An empty images array is "no images" — old logs never carried the key.
  const recordsBefore = records.length
  await loop.run({ text: 'no images', images: [] })
  const nextUser = records[recordsBefore]
  assert.equal(nextUser?.type, 'message')
  if (nextUser?.type !== 'message') return
  assert.equal(nextUser.content, 'no images')
  assert.equal('images' in nextUser, false)
})

test('@-mentioned project images import at input preparation and bind to the user message', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-atloop-'))
  try {
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'shot.png'))
    const records: SessionRecord[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return {
          content: 'seen',
          toolCalls: [],
          usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      },
    }
    const runner = new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })
    const ref = makeImageAttachmentRef({ id: 'img-1', ownerSessionId: 's1', name: 'shot.png' })
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      toolContext: { cwd: dir, sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
      supportsImageInput: true,
      imageAttachments: {
        importImage: async (sessionId, bytes, name) => {
          assert.equal(sessionId, 's1')
          assert.equal(name, 'shot.png')
          assert.deepEqual(bytes, await loadFixtureBytes('transparent.png'))
          return { ok: true, value: { ref } }
        },
      },
    })

    await loop.run({ text: 'what is in @shot.png' })

    const user = records[0]
    assert.equal(user?.type, 'message')
    if (user?.type !== 'message') return
    assert.equal(user.role, 'user')
    assert.equal(user.content, 'what is in @shot.png')
    assert.deepEqual(user.images, [ref])
    // The image mention never becomes code-text context; that record stays absent.
    assert.equal(records.some((record) => record.type === 'at_mention_context'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed @-mentioned image blocks the turn before any record is written', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-atloop-'))
  try {
    const records: SessionRecord[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return {
          content: 'seen',
          toolCalls: [],
          usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      },
    }
    const runner = new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      // Empty dir: the mention names a file that does not exist.
      toolContext: { cwd: dir, sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
      imageAttachments: {
        importImage: async () => {
          assert.fail('a failed mention must never reach the store')
        },
      },
    })

    await assert.rejects(
      loop.run({ text: 'see @gone.png' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /was not sent because @-mentioned images/)
        // The reason's class, the collector's facts, and the exit (S24).
        assert.match(error.message, /- @gone\.png: 图片文件已丢失：no such file in this project\./)
        assert.match(error.message, /重新附加这张图片后再发送。/)
        return true
      },
    )
    // No user message, no at-mention record, nothing to rewind.
    assert.deepEqual(records, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent loop applies per-run allowed tools to model requests', async () => {
  const records: SessionRecord[] = []
  const tools = [testTool('AllowedTool'), testTool('BlockedTool')]
  let seenRequest: ModelRequest | undefined
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      seenRequest = request
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' }, undefined, undefined, { allowedTools: ['AllowedTool'] })

  assert.deepEqual(seenRequest?.tools?.map((tool) => tool.name), ['AllowedTool'])
})

test('agent loop stores display input while sending real prompt to the model', async () => {
  const records: SessionRecord[] = []
  let seenRequest: ModelRequest | undefined
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      seenRequest = request
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'Expanded skill prompt' }, undefined, undefined, {
    displayInput: '/debug hello',
  })

  const userRecord = records.find((record) => record.type === 'message' && record.role === 'user')
  assert.equal(userRecord?.type, 'message')
  if (userRecord?.type === 'message') {
    assert.equal(userRecord.content, 'Expanded skill prompt')
    assert.equal(userRecord.displayContent, '/debug hello')
  }
  // The turn-varying user context trails the prompt now (spec §6.2), so the
  // prompt is the last *real* message rather than the last one.
  const sent = seenRequest?.messages.map((message) => message.content) ?? []
  assert.ok(sent.includes('Expanded skill prompt'))
  assert.match(String(sent.at(-1)), /# currentDate/)
})

test('agent loop rejects unknown per-run allowed tools before appending records', async () => {
  const records: SessionRecord[] = []
  const tools = [testTool('AllowedTool')]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      throw new Error('provider should not run')
    },
  }
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await assert.rejects(
    () => loop.run({ text: 'hello' }, undefined, undefined, { allowedTools: ['MissingTool'] }),
    /Unknown allowed tool/,
  )
  assert.equal(records.length, 0)
})

test('agent loop applies per-run model and effort without changing later turns', async () => {
  const records: SessionRecord[] = []
  const seen: Array<{ provider: string; model: string; effort?: string }> = []
  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage(request) {
      seen.push({ provider: 'primary', model: request.model, effort: request.effort })
      return { content: 'primary done', toolCalls: [] }
    },
  }
  const overrideProvider: ModelProvider = {
    name: 'override',
    async createMessage(request) {
      seen.push({ provider: 'override', model: request.model, effort: request.effort })
      return { content: 'override done', toolCalls: [] }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'primary-model',
    modelKey: 'primary',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    effort: 'low',
  })

  await loop.run({ text: 'skill turn' }, undefined, undefined, {
    model: { provider: overrideProvider, model: 'override-model', modelKey: 'override', providerName: 'override' },
    effort: 'xhigh',
  })
  await loop.run({ text: 'normal turn' })

  assert.deepEqual(seen, [
    { provider: 'override', model: 'override-model', effort: 'xhigh' },
    { provider: 'primary', model: 'primary-model', effort: 'low' },
  ])
})

test('agent loop merges per-run hooks only for the active turn', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    hooks: {
      userPromptSubmit: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('global hook')"`,
      }],
    },
  })

  await loop.run({ text: 'skill turn' }, undefined, undefined, {
    skillName: 'debugging',
    skillArgs: 'args',
    displayInput: '/debugging args',
    hooks: {
      userPromptSubmit: [{
        command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log('skill hook:' + data.skillName + ':' + data.skillArgs + ':' + data.prompt) })"`,
      }],
    },
  })
  await loop.run({ text: 'normal turn' })

  const hookMessages = records
    .filter((record) => record.type === 'message' && record.role === 'user' && record.content.includes('userPromptSubmit hook output'))
    .map((record) => record.type === 'message' ? record.content : '')
  assert.match(hookMessages[0] ?? '', /global hook/)
  assert.match(hookMessages[0] ?? '', /skill hook:debugging:args:skill turn/)
  assert.doesNotMatch(hookMessages[0] ?? '', /\/debugging args/)
  assert.match(hookMessages[1] ?? '', /global hook/)
  assert.doesNotMatch(hookMessages[1] ?? '', /skill hook/)
})

test('agent loop filters deferred tools only when provider supports dynamic ToolSearch', async () => {
  const original = process.env.HANEKAWA_TOOL_SEARCH
  process.env.HANEKAWA_TOOL_SEARCH = 'true'
  const records: SessionRecord[] = [
    {
      id: 'ts-use',
      type: 'tool_use',
      tool: 'ToolSearch',
      input: { query: 'select:DeferredTool' },
      riskLevel: 'safe',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'ts-result',
      type: 'tool_result',
      toolUseId: 'ts-use',
      tool: 'ToolSearch',
      ok: true,
      content: '{"matches":["DeferredTool"],"query":"select:DeferredTool","totalDeferredTools":1}',
      apiResultBlock: {
        type: 'tool_result',
        tool_use_id: 'ts-use',
        content: [{ type: 'tool_reference', tool_name: 'DeferredTool' }],
      },
      createdAt: new Date().toISOString(),
    },
  ]
  const active = testTool('ActiveTool')
  const deferred = testTool('DeferredTool', { shouldDefer: true })
  const alwaysLoad = testTool('AlwaysLoadTool', { shouldDefer: true, alwaysLoad: true })
  const tools = [active, deferred, alwaysLoad, toolSearchTool]
  let seenRequest: ModelRequest | undefined
  const provider: ModelProvider = {
    name: 'anthropic',
    supportsDynamicToolSearch: () => true,
    async createMessage(request) {
      seenRequest = request
      return { content: 'done', toolCalls: [] }
    },
  }
  try {
    const loop = new AgentLoop({
      provider,
      model: 'claude-sonnet-4',
      tools,
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
        onRecord: async (record) => { records.push(record) },
      }),
      toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    await loop.run({ text: 'next' })

    assert.deepEqual(seenRequest?.tools?.map((tool) => tool.name).sort(), [
      'ActiveTool',
      'AlwaysLoadTool',
      'DeferredTool',
      'ToolSearch',
    ])
    assert.equal(seenRequest?.hasDeferredTools, true)
    assert.deepEqual([...(seenRequest?.allDeferredToolNames ?? new Set())], ['DeferredTool'])
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', original)
  }
})

test('agent loop fully inlines tools and removes ToolSearch when provider lacks dynamic support', async () => {
  const original = process.env.HANEKAWA_TOOL_SEARCH
  process.env.HANEKAWA_TOOL_SEARCH = 'true'
  const records: SessionRecord[] = []
  const active = testTool('ActiveTool')
  const deferred = testTool('DeferredTool', { shouldDefer: true })
  const tools = [active, deferred, toolSearchTool]
  let seenRequest: ModelRequest | undefined
  const provider: ModelProvider = {
    name: 'openai',
    supportsDynamicToolSearch: () => false,
    async createMessage(request) {
      seenRequest = request
      return { content: 'done', toolCalls: [] }
    },
  }
  try {
    const loop = new AgentLoop({
      provider,
      model: 'gpt-test',
      tools,
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
        onRecord: async (record) => { records.push(record) },
      }),
      toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    await loop.run({ text: 'next' })

    assert.deepEqual(seenRequest?.tools?.map((tool) => tool.name).sort(), [
      'ActiveTool',
      'DeferredTool',
    ])
    assert.equal(seenRequest?.hasDeferredTools, false)
    assert.equal(seenRequest?.allDeferredToolNames, undefined)
  } finally {
    setEnv('HANEKAWA_TOOL_SEARCH', original)
  }
})

test('plan mode text-only response ends turn normally as assistant message', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-loop-plan-'))
  clearAllPlanSlugs()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => true, undefined, { cwd })
    gate.prepareContextForPlanMode()

    let loop: AgentLoop | undefined
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: session,
      store,
      gate,
      appendRecord: async (record) => {
        records.push(record)
        loop?.noteRecordAppended(record)
      },
      loadRecords: async () => [...records],
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.onEnterPlanMode()

    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return {
          content: 'I need more information about the requirements.',
          toolCalls: [],
        }
      },
    }
    const runner = new ToolRunner([], gate, {
      onRecord: async (record) => { records.push(record) },
    })
    loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      toolContext: {
        cwd,
        sessionId: session.id,
        readFiles: new Set(),
        getPermissionMode: () => gate.getMode(),
        planModeBridge: manager.buildBridge(),
      },
      permissionMode: () => gate.getMode(),
      planModeManager: manager,
      planModel: {
        provider,
        model: 'plan-model',
        modelKey: 'plan-key',
        providerName: 'fake',
      },
      recordStream: recordStreamFor(records),
    })

    const response = await loop.run({ text: 'plan this change' })

    // Text-only response in plan mode should end the turn normally
    assert.equal(response.content, 'I need more information about the requirements.')
    // Assistant message should be persisted as chat (not intercepted as plan)
    assert.equal(
      records.some((record) =>
        record.type === 'message'
        && record.role === 'assistant'
        && record.content.includes('I need more information')
      ),
      true,
      'assistant text should be persisted as a normal message',
    )
    // No plan_mode_request should be emitted
    assert.equal(
      records.some((record) => record.type === 'plan_mode_request'),
      false,
      'no plan_mode_request should be emitted for text-only response',
    )
  } finally {
    clearAllPlanSlugs()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('plan mode reports the plan model image capability, not the primary label it shows', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-loop-plan-image-'))
  clearAllPlanSlugs()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => true, undefined, { cwd })
    gate.prepareContextForPlanMode()

    let loop: AgentLoop | undefined
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: session,
      store,
      gate,
      appendRecord: async (record) => {
        records.push(record)
        loop?.noteRecordAppended(record)
      },
      loadRecords: async () => [...records],
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.onEnterPlanMode()

    const seenModels: string[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage(request) {
        seenModels.push(request.model)
        return { content: 'thinking about it', toolCalls: [] }
      },
    }
    loop = new AgentLoop({
      provider,
      model: 'fake-model',
      modelKey: 'main',
      // An image-capable primary paired with a text-only plan model.
      supportsImageInput: true,
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner([], gate, {
        onRecord: async (record) => { records.push(record) },
      }),
      toolContext: {
        cwd,
        sessionId: session.id,
        readFiles: new Set(),
        getPermissionMode: () => gate.getMode(),
        planModeBridge: manager.buildBridge(),
      },
      permissionMode: () => gate.getMode(),
      planModeManager: manager,
      planModel: {
        provider,
        model: 'plan-model',
        modelKey: 'plan-key',
        providerName: 'fake',
      },
      recordStream: recordStreamFor(records),
    })

    await loop.run({ text: 'plan this change' })

    assert.equal(seenModels[0], 'plan-model')
    const active = loop.getActiveModel()
    // The *label* still names the primary — that display policy is unchanged.
    assert.equal(active.model, 'fake-model')
    // The *capability* follows the model serving the request, or the UI would
    // offer an attachment the plan model rejects.
    assert.equal(active.supportsImageInput, undefined)
  } finally {
    clearAllPlanSlugs()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('plan routing gates new images on the plan model, before any record exists', async () => {
  const records: SessionRecord[] = []
  let primaryCalls = 0
  let planCalls = 0
  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      primaryCalls += 1
      return { content: 'primary answered', toolCalls: [] }
    },
  }
  const planProvider: ModelProvider = {
    name: 'plan',
    async createMessage() {
      planCalls += 1
      return { content: 'plan answered', toolCalls: [] }
    },
  }
  let mode: PermissionMode = 'plan'
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'capable-primary',
    modelKey: 'primary',
    // The input bar names this image-capable primary even in plan mode.
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 's21-plan', readFiles: new Set() },
    permissionMode: () => mode,
    planModel: {
      provider: planProvider,
      model: 'text-only-plan',
      modelKey: 'plan',
      providerName: 'plan',
    },
    recordStream: recordStreamFor(records),
  })

  const ref = makeImageAttachmentRef({ id: 'img-plan', ownerSessionId: 's21-plan', name: 'shot.png' })

  // Layer 1: the capability the UI reads follows the model that will serve the
  // request, so the composer refuses the attachment instead of offering it.
  assert.equal(loop.getActiveModel().supportsImageInput, undefined)
  // Layer 2: the submission gate names the plan model, not the primary.
  assert.throws(
    () => loop.assertImagesAllowedForSubmission({ text: 'look', images: [ref] }),
    (error: unknown) => {
      assert.ok(error instanceof TurnImageBlockError)
      assert.equal(error.imageInputBlock, 'model-not-capable')
      assert.match(error.message, /text-only-plan/)
      return true
    },
  )
  await assert.rejects(
    loop.run({ text: 'look', images: [ref] }),
    (error: unknown) => error instanceof TurnImageBlockError,
  )
  assert.equal(records.length, 0, 'nothing is recorded for a submission blocked by plan routing')
  assert.equal(primaryCalls + planCalls, 0)

  // Leaving plan mode re-resolves against the primary, with no new runtime.
  mode = 'default'
  assert.equal(loop.getActiveModel().supportsImageInput, true)
  loop.assertImagesAllowedForSubmission({ text: 'look', images: [ref] })
})

test('a temporary model override decides image capability for the run it covers', async () => {
  const records: SessionRecord[] = []
  const capableProvider: ModelProvider = {
    name: 'capable',
    async createMessage() {
      return { content: 'ok', toolCalls: [] }
    },
  }
  const overrideProvider: ModelProvider = {
    name: 'override',
    async createMessage() {
      throw new Error('the override request must be blocked before it is sent')
    },
  }
  const loop = new AgentLoop({
    provider: capableProvider,
    model: 'capable-primary',
    modelKey: 'primary',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 's21-override', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const ref = makeImageAttachmentRef({ id: 'img-ovr', ownerSessionId: 's21-override', name: 'shot.png' })
  const overrides = {
    model: {
      provider: overrideProvider,
      model: 'text-only-override',
      modelKey: 'override',
      providerName: 'override',
    },
  }

  await assert.rejects(
    loop.run({ text: 'look', images: [ref] }, undefined, undefined, overrides),
    (error: unknown) => {
      assert.ok(error instanceof TurnImageBlockError)
      assert.match(error.message, /text-only-override/)
      return true
    },
  )
  assert.equal(records.length, 0)
  // Without the override the same input goes through on the primary.
  assert.equal((await loop.run({ text: 'look', images: [ref] })).content, 'ok')
})

test('plan mode approval reminder is last context and ExitPlanMode is not summarized', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-loop-plan-exit-tool-'))
  clearAllPlanSlugs()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => true, undefined, { cwd })
    gate.prepareContextForPlanMode()

    let loop: AgentLoop | undefined
    const manager = new PlanModeManager({
      cwd,
      sessionMeta: session,
      store,
      gate,
      appendRecord: async (record) => {
        records.push(record)
        loop?.noteRecordAppended(record)
      },
      loadRecords: async () => [...records],
      openExitDialog: async () => ({ kind: 'approve_auto_keep' }),
    })
    gate.setPlanSlugProvider(() => manager.getSlug())
    manager.onEnterPlanMode()
    // Write plan file to disk so ExitPlanMode validation passes.
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Final plan\n\n- Fix the approval handoff.')

    let calls = 0
    let summaryCalls = 0
    const seenModels: string[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage(request) {
        seenModels.push(request.model)
        calls += 1
        if (calls === 1) {
          return {
            content: 'submitting plan',
            toolCalls: [{
              id: 'exit-plan',
              name: 'ExitPlanMode',
              input: {},
            }],
          }
        }

        const contextItems = request.contextItems ?? []
        assert.equal(
          contextItems.some(
            (item) => item.kind === 'message'
              && /Summary of recent tool use/.test(item.message.content)
              && /Plan submitted/.test(item.message.content),
          ),
          false,
        )
        const lastContextItem = contextItems.at(-1)
        assert.equal(lastContextItem?.kind, 'message')
        if (lastContextItem?.kind === 'message') {
          assert.match(lastContextItem.message.content, /Exited Plan Mode/)
          assert.match(lastContextItem.message.content, /User has approved your plan/)
        }
        return { content: 'implementation can now start', toolCalls: [] }
      },
    }
    const compactProvider: ModelProvider = {
      name: 'compact',
      async createMessage() {
        summaryCalls += 1
        return { content: 'Plan submitted for user approval, rejection, or editing.', toolCalls: [] }
      },
    }
    const runner = new ToolRunner([exitPlanModeTool], gate, {
      onRecord: async (record) => {
        records.push(record)
        loop?.noteRecordAppended(record)
      },
    })
    loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [exitPlanModeTool],
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      toolContext: {
        cwd,
        sessionId: session.id,
        readFiles: new Set(),
        getPermissionMode: () => gate.getMode(),
        planModeBridge: manager.buildBridge(),
      },
      permissionMode: () => gate.getMode(),
      planModeManager: manager,
      planModel: {
        provider,
        model: 'plan-model',
        modelKey: 'plan-key',
        providerName: 'fake',
      },
      compactModel: {
        provider: compactProvider,
        model: 'cheap-model',
        modelKey: 'cheap',
        providerName: 'compact',
      },
      recordStream: recordStreamFor(records),
    })

    const response = await loop.run({ text: 'plan this change' })

    assert.equal(response.content, 'implementation can now start')
    assert.equal(summaryCalls, 0)
    assert.equal(seenModels[0], 'plan-model')
    assert.equal(seenModels[1], 'fake-model')
    assert.equal(records.some((record) => record.type === 'tool_use_summary'), false)
  } finally {
    clearAllPlanSlugs()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('agent loop persists max_tokens partial response before continuation reminder', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      calls += 1
      assert.equal(request.maxOutputTokens, 10)
      if (calls === 1) {
        return {
          content: 'partial answer',
          toolCalls: [],
          stopReason: 'max_tokens',
        }
      }

      assert.ok(request.contextItems?.some(
        (item) => item.kind === 'message'
          && item.message.role === 'assistant'
          && item.message.content === 'partial answer',
      ))
      assert.ok(request.contextItems?.some(
        (item) => item.kind === 'message'
          && item.message.role === 'user'
          && /Continue from the exact point where it stopped/.test(item.message.content),
      ))
      return { content: 'continued answer', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    maxOutputTokens: 10,
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'partial answer\n\ncontinued answer')
  assert.deepEqual(response.segments, ['partial answer', 'continued answer'])
  assert.equal(calls, 2)
  const partialIndex = records.findIndex((record) =>
    record.type === 'message' && record.role === 'assistant' && record.content === 'partial answer')
  const reminderIndex = records.findIndex((record) =>
    record.type === 'message' && record.role === 'user' && /Continue from the exact point where it stopped/.test(record.content))
  assert.ok(partialIndex >= 0)
  assert.ok(reminderIndex > partialIndex)
})

test('agent loop aggregates multiple max_tokens continuations into the final result', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      if (calls === 1) return { content: 'part one', toolCalls: [], stopReason: 'max_tokens' }
      if (calls === 2) return { content: 'part two', toolCalls: [], stopReason: 'max_tokens' }
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    maxOutputTokens: 10,
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'part one\n\npart two\n\ndone')
  assert.deepEqual(response.segments, ['part one', 'part two', 'done'])
  assert.equal(response.truncated, undefined)
  assert.equal(calls, 3)
})

test('agent loop returns explicit truncation metadata when max_tokens recovery is exhausted', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: `part ${calls}`, toolCalls: [], stopReason: 'max_tokens' }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    maxOutputTokens: 10,
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(calls, 4)
  assert.equal(response.content, 'part 1\n\npart 2\n\npart 3\n\npart 4')
  assert.deepEqual(response.segments, ['part 1', 'part 2', 'part 3', 'part 4'])
  assert.equal(response.stopReason, 'max_tokens')
  assert.equal(response.truncated, true)
})

test('onRequestUsage reports every request of a turn, not just the last', async () => {
  const records: SessionRecord[] = []
  const reported: TokenUsage[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      const usage = { inputTokens: calls * 1000, cacheReadInputTokens: calls * 10, outputTokens: calls }
      if (calls === 1) {
        return { content: 'working', toolCalls: [{ id: 'noop-1', name: 'noop', input: {} }], usage }
      }
      return { content: 'done', toolCalls: [], usage }
    },
  }
  const tools: Tool[] = [{
    name: 'noop',
    description: 'noop',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      return { ok: true, content: 'ok' }
    },
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    onRequestUsage: (usage) => { reported.push(usage) },
  })

  const result = await loop.run({ text: 'hello' })

  // Two requests, two reports — the tool step is visible while it happens
  // rather than only once the whole turn has settled.
  assert.equal(calls, 2)
  assert.deepEqual(reported, [
    { inputTokens: 1000, cacheReadInputTokens: 10, outputTokens: 1 },
    { inputTokens: 2000, cacheReadInputTokens: 20, outputTokens: 2 },
  ])
  // And the last report is what the run settles on, so nothing contradicts.
  assert.deepEqual(result.statusUsage, reported.at(-1))
})

test('agent loop default maxTurns behavior still throws', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return {
        content: 'keep going',
        toolCalls: [{ id: `noop-${calls}`, name: 'noop', input: {} }],
      }
    },
  }
  const tools: Tool[] = [{
    name: 'noop',
    description: 'noop',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      return { ok: true, content: 'ok' }
    },
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    maxTurns: 1,
  })

  await assert.rejects(() => loop.run({ text: 'hello' }), /Agent loop exceeded maximum tool iterations/)
  assert.equal(calls, 1)
})

test('agent loop partial maxTurns behavior returns the latest assistant content', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return {
        content: 'latest partial answer',
        toolCalls: [{ id: `noop-${calls}`, name: 'noop', input: {} }],
      }
    },
  }
  const tools: Tool[] = [{
    name: 'noop',
    description: 'noop',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      return { ok: true, content: 'ok' }
    },
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    maxTurns: 1,
    maxTurnsExceededBehavior: 'partial',
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(calls, 1)
  assert.match(response.content, /latest partial answer/)
  assert.match(response.content, /Sub-agent output may be incomplete: reached max turns limit \(1\)/)
  assert.equal(response.stopReason, 'max_turns')
  assert.equal(response.truncated, true)
  assert.deepEqual(response.segments, [response.content])
})

test('agent loop escalates default max output tokens before persisting a max_tokens partial', async () => {
  const records: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      calls += 1
      if (calls === 1) {
        assert.equal(request.maxOutputTokens, undefined)
        return { content: 'discarded retry candidate', toolCalls: [], stopReason: 'max_tokens' }
      }
      assert.equal(request.maxOutputTokens, 128_000)
      return { content: 'complete after escalation', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'complete after escalation')
  assert.equal(calls, 2)
  assert.equal(records.some((record) =>
    record.type === 'message' && record.role === 'assistant' && record.content === 'discarded retry candidate',
  ), false)
})

test('agent loop updates records cache only after record stream append succeeds', async () => {
  const records: SessionRecord[] = []
  let failAssistantAppend = true
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      providerCalls += 1
      if (providerCalls === 2) {
        assert.equal(request.contextItems?.some(
          (item) => item.kind === 'message'
            && item.message.role === 'assistant'
            && item.message.content === 'lost assistant',
        ), false)
      }
      return {
        content: providerCalls === 1 ? 'lost assistant' : 'persisted assistant',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })
  const recordStream: RecordStream = {
    load: async () => records,
    append: async (record) => {
      if (
        failAssistantAppend
        && record.type === 'message'
        && record.role === 'assistant'
        && record.content === 'lost assistant'
      ) {
        throw new Error('disk full')
      }
      records.push(record)
    },
  }
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream,
  })

  await assert.rejects(loop.run({ text: 'first' }), /disk full/)
  failAssistantAppend = false
  const response = await loop.run({ text: 'second' })

  assert.equal(response.content, 'persisted assistant')
  assert.equal(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === 'lost assistant'), false)
})

test('agent loop marks cached tool protocol dirty after tool record append', async () => {
  const records: SessionRecord[] = []
  let providerCalls = 0
  let failToolResultAppend = true
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      providerCalls += 1
      if (providerCalls === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
        }
      }
      assert.ok(request.contextItems?.some(
        (item) => item.kind === 'tool_result'
          && item.toolUseId === 'call-1'
          && /lost in transport/.test(item.content),
      ))
      return { content: 'recovered', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ok' }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => {
      if (failToolResultAppend && record.type === 'tool_result') {
        throw new Error('tool result append failed')
      }
      records.push(record)
    },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await assert.rejects(loop.run({ text: 'first' }), /tool result append failed/)
  failToolResultAppend = false
  const response = await loop.run({ text: 'second' })

  assert.equal(response.content, 'recovered')
})

test('agent loop appends userPromptSubmit hook stdout before first model request', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && item.message.role === 'user'
          && /branch: test-branch/.test(item.message.content),
      ))
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      userPromptSubmit: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('branch: test-branch')"`,
      }],
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(records.some((record) => record.type === 'message' && /userPromptSubmit hook output/.test(record.content)))
})

test('agent loop appends stop hook stdout before returning', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      stop: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('typecheck: failed')"`,
      }],
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'done')
  const messages = records.filter((record) => record.type === 'message')
  assert.equal(messages.at(-1)?.role, 'user')
  assert.match(messages.at(-1)?.content ?? '', /stop hook output/)
  assert.match(messages.at(-1)?.content ?? '', /typecheck: failed/)
})

test('agent loop continues when stop hook reports a blocking error', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'first',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 1,
          },
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && item.message.role === 'user'
          && /stop hook blocking error:\nfix it/.test(item.message.content),
      ))
      return {
        content: 'second',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 20,
          outputTokens: 2,
        },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      stop: [{
        command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); if (data.response === 'first') { console.error('BLOCKING: fix it'); process.exitCode = 1 } })"`,
      }],
    },
    recordStream: recordStreamFor(records, metrics),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'second')
  assert.equal(callCount, 2)
  assert.deepEqual(metrics.filter((metric) => metric.event === 'turn').map((metric) => metric.response_tokens), [1, 2])
  assert.ok(records.some((record) => record.type === 'message' && /stop hook blocking error:\nfix it/.test(record.content)))
  assert.equal(records.some((record) => record.type === 'message' && /Hook failures:/.test(record.content)), false)
})

test('agent loop respects stop hook preventContinuation before blocking errors', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    hooks: {
      stop: [{
        command: `${JSON.stringify(process.execPath)} -e "console.log('__HANEKAWA_HOOK__'); console.log(JSON.stringify({ preventContinuation: true })); console.error('BLOCKING: should not continue')"`,
      }],
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'done')
  assert.equal(callCount, 1)
  assert.equal(records.some((record) => record.type === 'message' && /stop hook blocking error/.test(record.content)), false)
})

test('agent loop annotates records from one user turn with the same turnId', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: {} }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ok' }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  const turnIds = new Set(
    records
      .filter((record) => record.type !== 'tool_approval')
      .map((record) => record.turnId),
  )
  assert.equal(turnIds.size, 1)
  assert.equal(typeof [...turnIds][0], 'string')
})

test('agent loop emits cache break metrics from provider responses', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 100,
          inputTokens: 20,
          outputTokens: 5,
        },
        cacheBreak: {
          tokenDrop: 5000,
          prevCacheRead: 5100,
          currentCacheRead: 100,
          reasons: ['tool_schemas_changed'],
          source: 'agent:s1',
        },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, metrics),
  })

  await loop.run({ text: 'hello' })

  const cacheBreakMetric = metrics.find((metric) => metric.event === 'cache_break')
  assert.deepEqual(cacheBreakMetric?.reasons, ['tool_schemas_changed'])
  assert.equal('reason' in (cacheBreakMetric ?? {}), false)
  assert.equal(cacheBreakMetric?.drop_tokens, 5000)
  assert.equal(cacheBreakMetric?.source, 'agent:s1')
})


test('agent loop sends tool result into the next model request', async () => {
  const records: SessionRecord[] = []
  const seenRequests: ModelRequest[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      seenRequests.push(request)
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'I will use the echo tool.',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 1,
            inputTokens: 2,
            outputTokens: 3,
          },
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.role === 'assistant' && item.message.content === 'I will use the echo tool.'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1' && item.content === '{"value":"hello"}'))
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 4,
          inputTokens: 5,
          outputTokens: 6,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  let loadRecordsCount = 0
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, undefined, () => { loadRecordsCount += 1 }),
  })
  const response = await loop.run({ text: 'hello' })
  assert.equal(response.content, 'done')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 5,
    inputTokens: 7,
    outputTokens: 9,
  })
  assert.equal(seenRequests.length, 2)
  assert.equal(loadRecordsCount, 1)
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === 'I will use the echo tool.'))
  assert.ok(records.some((record) => record.type === 'tool_use'))
  assert.ok(records.some((record) => record.type === 'tool_result'))
  assert.equal(records.filter((record) => record.type === 'tool_use' && record.id === 'call-1').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_result' && record.toolUseId === 'call-1').length, 1)
  assert.equal(records.filter((record) => record.type === 'message' && record.role === 'tool').length, 0)
})

test('agent loop generates tool-use summary with compact model for the next request', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  let summaryModelSeen = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && /Summary of recent tool use/.test(item.message.content)
          && /echo returned hello/.test(item.message.content),
      ))
      return { content: 'done', toolCalls: [] }
    },
  }
  const compactProvider: ModelProvider = {
    name: 'compact',
    async createMessage(request) {
      summaryModelSeen = request.model
      assert.equal(displayCacheSource(request.cacheSource!), 'tool_use_summary')
      assert.match(request.messages[0]?.content ?? '', /"value":"hello"/)
      return { content: 'echo returned hello', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    compactModel: {
      provider: compactProvider,
      model: 'cheap-model',
      modelKey: 'cheap',
      providerName: 'compact',
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'done')
  assert.equal(summaryModelSeen, 'cheap-model')
  assert.ok(records.some((record) => record.type === 'tool_use_summary' && record.summary === 'echo returned hello'))
})

test('agent loop includes sub-agent transcript usage in returned turn usage', async () => {
  const responses = [
    {
      content: 'delegating',
      toolCalls: [{ id: 'agent-call', name: 'Agent', input: { task: 'research', subagent_type: 'general' } }],
      usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
    },
    {
      content: 'sub-agent done',
      toolCalls: [],
      usage: { inputTokens: 10, cacheReadInputTokens: 20, outputTokens: 30 },
    },
    {
      content: 'final',
      toolCalls: [],
      usage: { inputTokens: 4, cacheReadInputTokens: 5, outputTokens: 6 },
    },
  ]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      const response = responses.shift()
      assert.ok(response)
      return response
    },
  }
  let runtimeTools: Tool[] = []
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => runtimeTools,
    permissionPrompt: async () => true,
    cwd: process.cwd(),
  })
  runtimeTools = [agentTool]
  const records: SessionRecord[] = []
  const runner = new ToolRunner(runtimeTools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: runtimeTools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const result = await loop.run({ text: 'start' })

  assert.deepEqual(result.usage, {
    inputTokens: 15,
    cacheReadInputTokens: 27,
    outputTokens: 39,
  })
  assert.deepEqual(result.statusUsage, {
    inputTokens: 4,
    cacheReadInputTokens: 5,
    outputTokens: 6,
  })
  assert.ok(records.some((record) => record.type === 'subagent_transcript'))
})

test('an inheriting fork opens with the parent\'s instructions message and builds none of its own', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      const usage = { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 }
      if (requests.length === 1) {
        return { content: '', toolCalls: [{ id: 'fork-call', name: 'Agent', input: { task: 'look', subagent_type: 'fork' } }], usage }
      }
      return { content: 'done', toolCalls: [], usage }
    },
  }
  let runtimeTools: Tool[] = []
  const agentTool = createAgentTool({
    provider,
    model: 'fake-model',
    tools: () => runtimeTools,
    permissionPrompt: async () => true,
    cwd: process.cwd(),
    projectContext: 'PROJECT RULES',
  })
  runtimeTools = [testTool('Read'), agentTool]
  const records: SessionRecord[] = []
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: runtimeTools,
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner(runtimeTools, new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    projectContext: 'PROJECT RULES',
    memoryIndex: 'MEMORY INDEX',
  })

  await loop.run({ text: 'start' })

  const [parent, fork] = requests
  assert.ok(parent && fork)
  const parentPrefix = parent.messages.filter((message) => !message.transient)
  assert.equal(parentPrefix[0]?.content, '<system-reminder>\nPROJECT RULES\n\nMEMORY INDEX\n</system-reminder>')
  assert.deepEqual(fork.messages.slice(0, parentPrefix.length), parentPrefix)
  assert.equal(fork.messages.filter((message) => /PROJECT RULES/.test(message.content)).length, 1)
  assert.equal(fork.contextItems?.filter((item) => item.kind === 'message' && /PROJECT RULES/.test(item.message.content)).length, 1)
})

test('agent loop excludes compact summarizer usage from status usage', async () => {
  const records: SessionRecord[] = [
    {
      id: 'old-user',
      type: 'message',
      role: 'user',
      content: 'old context ' + 'x'.repeat(3000),
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    {
      id: 'old-assistant',
      type: 'message',
      role: 'assistant',
      content: 'old answer',
      createdAt: '2026-05-24T00:00:01.000Z',
    },
  ]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      // `displayCacheSource`, not `===`: the source carries a digest of the
      // project root now, so a fixed literal only matches after it is stripped.
      if (displayCacheSource(request.cacheSource!) === 'compact') {
        return {
          content: 'compact summary',
          toolCalls: [],
          usage: { inputTokens: 100, cacheReadInputTokens: 200, outputTokens: 300 },
        }
      }
      return {
        content: 'main response',
        toolCalls: [],
        usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
      }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextWindow: 1000,
    contextManagement: {
      contextWindow: 1000,
      summaryOutputTokens: 0,
      autoCompactBufferTokens: 0,
      autoCompactThresholdRatio: 0.5,
    },
    recordStream: recordStreamFor(records),
  })

  const result = await loop.run({ text: 'continue' })

  assert.deepEqual(result.usage, {
    inputTokens: 101,
    cacheReadInputTokens: 202,
    outputTokens: 303,
  })
  assert.deepEqual(result.statusUsage, {
    inputTokens: 1,
    cacheReadInputTokens: 2,
    outputTokens: 3,
  })
  assert.ok(records.some((record) => record.type === 'compact_boundary'))
})

test('agent loop consumes pending post-compact restore after a successful build', async () => {
  const records: SessionRecord[] = [{
    type: 'compact_boundary',
    id: 'compact-1',
    summary: 'summary',
    preTokens: 100,
    postCompactRestore: 'pending',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some(
        (item) => item.kind === 'message'
          && item.message.id === 'compact-1:restore'
          && !item.message.transient
          && /# restoredSkill debugging\nDebug skill body/.test(item.message.content),
      ))
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: {
      cwd: process.cwd(),
      sessionId: 's1',
      readFiles: new Set(),
      invokedSkills: new Map([['debugging', { content: 'Debug skill body', timestamp: 1 }]]),
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  const boundary = records.find((record) => record.id === 'compact-1')
  assert.equal(boundary?.type, 'compact_boundary')
  assert.equal(boundary?.type === 'compact_boundary' ? boundary.postCompactRestore : undefined, 'consumed')
  assert.match(boundary?.type === 'compact_boundary' ? boundary.restoredContext ?? '' : '', /Debug skill body/)
})

test('compact() summarizes between turns and the next turn starts from the boundary', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    { type: 'message', id: 'old-user', role: 'user', content: 'old context', createdAt: '2026-05-10T00:00:00.000Z' },
    { type: 'message', id: 'old-assistant', role: 'assistant', content: 'old answer', createdAt: '2026-05-10T00:01:00.000Z' },
  ]
  const requests: ModelRequest[] = []
  const streamed: ModelStreamEvent[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      const isCompact = displayCacheSource(request.cacheSource!) === 'compact'
      return { content: isCompact ? '<summary>manual summary</summary>' : 'done', toolCalls: [] }
    },
  }
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 'manual-compact', readFiles: new Set() },
    contextWindow: 200_000,
    recordStream: recordStreamFor(records),
    onStreamEvent: (event) => { streamed.push(event) },
  })

  const result = await loop.compact('keep the schema')

  assert.equal(result.compacted, true)
  assert.match(JSON.stringify(requests[0]!.messages.at(-1)), /keep the schema/)
  assert.deepEqual(streamed.filter((event) => event.type === 'compact'), [
    { type: 'compact', phase: 'start' },
    { type: 'compact', phase: 'end' },
  ])
  assert.equal(records.at(-1)?.type, 'compact_boundary')

  await loop.run({ text: 'next' })
  const sent = JSON.stringify(requests.at(-1)!.messages)
  assert.match(sent, /manual summary/)
  assert.doesNotMatch(sent, /old answer/)
})

test('compactBeforeSend forces compaction on iteration 0 with the variant, rolePrompt and board restore', async () => {
  const run = async (compactBeforeSend: boolean) => {
    resetAutoCompactFailureState()
    const records: SessionRecord[] = [
      { type: 'message', id: 'old-user', role: 'user', content: 'old context', createdAt: '2026-05-10T00:00:00.000Z' },
      { type: 'message', id: 'old-assistant', role: 'assistant', content: 'old answer', createdAt: '2026-05-10T00:01:00.000Z' },
    ]
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage(request) {
        requests.push(request)
        const isCompact = displayCacheSource(request.cacheSource!) === 'compact'
        return { content: isCompact ? '<summary>forced summary</summary>' : 'done', toolCalls: [] }
      },
    }
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner([], new PermissionGate(async () => true), {
        onRecord: async (record) => { records.push(record) },
      }),
      toolContext: { cwd: process.cwd(), sessionId: `forced-compact-${compactBeforeSend}`, readFiles: new Set() },
      contextWindow: 200_000,
      rolePrompt: 'You are the coordinator.',
      compactPromptVariant: 'coordinator',
      coordinationRestore: async () => 'BOARD: t1 running',
      recordStream: recordStreamFor(records),
    })
    await loop.run({ text: 'next' }, undefined, undefined, { compactBeforeSend })
    return { records, requests }
  }

  const idle = await run(false)
  assert.ok(!idle.records.some((record) => record.type === 'compact_boundary'))
  assert.equal(idle.requests.length, 1)
  assert.ok(idle.requests[0]!.systemBlocks!.some((block) => block.includes('You are the coordinator.')))

  const forced = await run(true)
  const boundary = forced.records.find((record) => record.type === 'compact_boundary')
  assert.equal(boundary?.type, 'compact_boundary')
  assert.match(boundary?.type === 'compact_boundary' ? boundary.summary : '', /forced summary/)
  assert.match(boundary?.type === 'compact_boundary' ? boundary.restoredContext ?? '' : '', /^<system-reminder>\nBOARD: t1 running/)
  const compactRequest = forced.requests.find((request) => displayCacheSource(request.cacheSource!) === 'compact')
  const serialized = JSON.stringify(compactRequest)
  assert.ok(serialized.includes(JSON.stringify(getCompactPrompt(undefined, 'coordinator')).slice(1, 80)))
})

test('agent loop preserves tool result association for mixed safe and unsafe order', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'unsafe-call', name: 'unsafeTool', input: {} },
            { id: 'safe-call', name: 'safeTool', input: {} },
          ],
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'unsafe-call' && item.content === 'unsafe-result'))
      assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'safe-call' && item.content === 'safe-result'))
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [
    {
      name: 'unsafeTool',
      description: 'unsafe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      execute: async () => ({ ok: true, content: 'unsafe-result' }),
    },
    {
      name: 'safeTool',
      description: 'safe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ ok: true, content: 'safe-result' }),
    },
  ]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'done')
  assert.equal(records.filter((record) => record.type === 'tool_use' && record.id === 'unsafe-call').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_use' && record.id === 'safe-call').length, 1)
})

test('agent loop runs consecutive safe calls concurrently and unsafe calls as barriers', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'safe-a-call', name: 'safeA', input: {} },
            { id: 'safe-b-call', name: 'safeB', input: {} },
            { id: 'unsafe-call', name: 'unsafe', input: {} },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const tools: Tool[] = [
    {
      name: 'safeA',
      description: 'safe a',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        events.push('safeA:start')
        await delay(20)
        events.push('safeA:end')
        return { ok: true, content: 'a' }
      },
    },
    {
      name: 'safeB',
      description: 'safe b',
      inputSchema: z.object({}).strict(),
      riskLevel: 'safe',
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        events.push('safeB:start')
        await delay(5)
        events.push('safeB:end')
        return { ok: true, content: 'b' }
      },
    },
    {
      name: 'unsafe',
      description: 'unsafe',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      execute: async () => {
        events.push('unsafe:start')
        return { ok: true, content: 'unsafe' }
      },
    },
  ]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(events.indexOf('safeB:start') > events.indexOf('safeA:start'))
  assert.ok(events.indexOf('safeB:start') < events.indexOf('safeA:end'))
  assert.ok(events.indexOf('unsafe:start') > events.indexOf('safeA:end'))
  assert.ok(events.indexOf('unsafe:start') > events.indexOf('safeB:end'))
})

test('agent loop runs read-only Bash calls concurrently and other commands as barriers', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'a', name: 'Bash', input: { command: 'git status' } },
            { id: 'b', name: 'Bash', input: { command: 'ls' } },
            { id: 'c', name: 'Bash', input: { command: 'npm test' } },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const tools: Tool[] = [{
    name: 'Bash',
    description: 'bash',
    inputSchema: z.object({ command: z.string() }).strict(),
    riskLevel: 'dangerous',
    isDestructive: true,
    concurrentWhenReadonly: true,
    execute: async (input) => {
      const { command } = input as { command: string }
      events.push(`${command}:start`)
      await delay(command === 'git status' ? 20 : 5)
      events.push(`${command}:end`)
      return { ok: true, content: command }
    },
  }]
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'loop-bash-concurrency-'))
  const runner = new ToolRunner(tools, new PermissionGate(async () => true, [], { cwd }), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd, sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(events.indexOf('ls:start') < events.indexOf('git status:end'))
  assert.ok(events.indexOf('npm test:start') > events.indexOf('git status:end'))
  await rm(cwd, { recursive: true, force: true })
})

test('agent loop caps concurrent calls and runs a call alone when classifying it fails', async () => {
  for (const classifierThrows of [false, true]) {
    const records: SessionRecord[] = []
    let inFlight = 0
    let maxInFlight = 0
    let callCount = 0
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        callCount += 1
        if (callCount === 1) {
          return {
            content: 'using tools',
            toolCalls: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: 'Bash', input: { command: 'ls' } })),
          }
        }
        return { content: 'done', toolCalls: [] }
      },
    }
    const tools: Tool[] = [{
      name: 'Bash',
      description: 'bash',
      inputSchema: z.object({ command: z.string() }).strict(),
      riskLevel: 'dangerous',
      isDestructive: true,
      concurrentWhenReadonly: true,
      execute: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { ok: true, content: 'ok' }
      },
    }]
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'loop-bash-cap-'))
    const runner = new ToolRunner(tools, new PermissionGate(async () => true, [], { cwd }), {
      onRecord: async (record) => { records.push(record) },
    })
    if (classifierThrows) runner.isReadonlyCall = () => { throw new Error('classifier failed') }
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools,
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      toolContext: { cwd, sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    await loop.run({ text: 'hello' })

    assert.equal(records.filter((record) => record.type === 'tool_result').length, 12)
    assert.equal(maxInFlight, classifierThrows ? 1 : 10)
    await rm(cwd, { recursive: true, force: true })
  }
})

test('agent loop runs read-only Agent calls concurrently by subagent_type', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using agents',
          toolCalls: [
            { id: 'explore-a-call', name: 'Agent', input: { task: 'map a', subagent_type: 'explore' } },
            { id: 'explore-b-call', name: 'Agent', input: { task: 'map b', subagent_type: 'explore' } },
            { id: 'explore-c-call', name: 'Agent', input: { task: 'map c', subagent_type: 'explore' } },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const agentTool: Tool = {
    name: 'Agent',
    description: 'agent',
    inputSchema: z.object({
      task: z.string(),
      subagent_type: z.enum(['general', 'explore', 'plan']),
    }).strict(),
    riskLevel: 'safe',
    isConcurrencySafeInput(input) {
      const parsed = this.inputSchema.safeParse(input)
      return parsed.success && ['general', 'explore', 'plan'].includes((parsed.data as { subagent_type: string }).subagent_type)
    },
    execute: async (input) => {
      const { task } = input as { task: string }
      events.push(`${task}:start`)
      await delay(task.endsWith('a') ? 20 : 5)
      events.push(`${task}:end`)
      return { ok: true, content: task }
    },
  }
  const runner = new ToolRunner([agentTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [agentTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(events.indexOf('map b:start') > events.indexOf('map a:start'))
  assert.ok(events.indexOf('map b:start') < events.indexOf('map a:end'))
  assert.ok(events.indexOf('map c:start') > events.indexOf('map a:start'))
  assert.ok(events.indexOf('map c:start') < events.indexOf('map a:end'))
})

test('agent loop keeps non-concurrency-safe Agent calls as barriers around read-only agents', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using agents',
          toolCalls: [
            { id: 'write-agent-call', name: 'Agent', input: { task: 'write-files', subagent_type: 'general' } },
            { id: 'explore-call', name: 'Agent', input: { task: 'explore', subagent_type: 'explore' } },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const agentTool: Tool = {
    name: 'Agent',
    description: 'agent',
    inputSchema: z.object({
      task: z.string(),
      subagent_type: z.enum(['general', 'explore', 'plan']),
    }).strict(),
    riskLevel: 'safe',
    isConcurrencySafeInput(input) {
      const parsed = this.inputSchema.safeParse(input)
      if (!parsed.success) return false
      const { subagent_type } = parsed.data as { subagent_type: string }
      // Only explore and plan are concurrency-safe; general is not
      return ['explore', 'plan'].includes(subagent_type)
    },
    execute: async (input) => {
      const { task } = input as { task: string }
      events.push(`${task}:start`)
      await delay(task === 'write-files' ? 20 : 1)
      events.push(`${task}:end`)
      return { ok: true, content: task }
    },
  }
  const runner = new ToolRunner([agentTool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [agentTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(events.indexOf('explore:start') > events.indexOf('write-files:end'))
})

test('agent loop keeps mislabeled write-like tools as barriers', async () => {
  const records: SessionRecord[] = []
  const events: string[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tools',
          toolCalls: [
            { id: 'write-a-call', name: 'writeA', input: {} },
            { id: 'write-b-call', name: 'writeB', input: {} },
          ],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const tools: Tool[] = [
    {
      name: 'writeA',
      description: 'mislabeled write a',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      isConcurrencySafe: true,
      execute: async () => {
        events.push('writeA:start')
        await delay(20)
        events.push('writeA:end')
        return { ok: true, content: 'a' }
      },
    },
    {
      name: 'writeB',
      description: 'mislabeled write b',
      inputSchema: z.object({}).strict(),
      riskLevel: 'confirm',
      isConcurrencySafe: true,
      execute: async () => {
        events.push('writeB:start')
        return { ok: true, content: 'b' }
      },
    },
  ]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(events.indexOf('writeB:start') > events.indexOf('writeA:end'))
})

test('agent loop appends reminder when all tool calls fail', async () => {
  const records: SessionRecord[] = []
  let callCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: 'using tool',
          toolCalls: [{ id: 'fail-call', name: 'failTool', input: {} }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'failTool',
    description: 'fail',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: false, content: 'failed' }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'hello' })

  assert.ok(records.some((record) => record.type === 'message' && /All tool calls in the previous turn failed/.test(record.content)))
})

test('agent loop auto-compacts without preparing records twice in the same iteration', async () => {
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer '.repeat(200),
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]
  let callCount = 0
  let loadRecordsCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      callCount += 1
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        assert.equal(request.tools?.length, 0)
        assert.equal(displayCacheSource(request.cacheSource!), 'compact')
        return {
          content: 'summary',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 10,
            inputTokens: 20,
            outputTokens: 30,
          },
        }
      }

      const contextItems = request.contextItems ?? []
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.id.startsWith('meta:user-context')))
      assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.id === 'old-user'))
      assert.ok(!contextItems.some((item) => item.kind === 'message' && /Prior conversation was compacted/.test(item.message.content)))
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextWindow: 10_000,
    contextManagement: {
      contextWindow: 10_000,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
      autoCompactThresholdRatio: 0.05,
    },
    recordStream: recordStreamFor(records, undefined, () => { loadRecordsCount += 1 }),
  })

  const response = await loop.run({ text: 'latest request' })

  assert.equal(response.content, 'done')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 11,
    inputTokens: 22,
    outputTokens: 33,
  })
  assert.equal(callCount, 2)
  assert.equal(loadRecordsCount, 1)
  assert.ok(records.some((record) => record.type === 'compact_boundary'))
})

test('auto-compaction sends the conversation\'s own request with the compact prompt last', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    { type: 'message', id: 'old-user', role: 'user', content: 'old context '.repeat(200), createdAt: '2026-05-10T00:00:00.000Z' },
    { type: 'message', id: 'old-assistant', role: 'assistant', content: 'old answer '.repeat(200), createdAt: '2026-05-10T00:01:00.000Z' },
  ]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      const last = request.contextItems?.at(-1)
      const isCompact = last?.kind === 'message' && last.message.id === 'compact-request'
      return { content: isCompact ? '<summary>shared summary</summary>' : 'done', toolCalls: [] }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({ value: z.string() }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
  }]
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 'shared-prefix-compact', readFiles: new Set() },
    contextWindow: 10_000,
    contextManagement: { contextWindow: 10_000, summaryOutputTokens: 100, autoCompactBufferTokens: 50, autoCompactThresholdRatio: 0.05 },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'latest request' })

  const [compact, main] = requests
  assert.equal(displayCacheSource(compact!.cacheSource!), 'compact')
  const compactPrompt = compact!.contextItems!.at(-1)
  assert.ok(compactPrompt?.kind === 'message' && compactPrompt.message.transient === true)
  assert.match(compactPrompt.kind === 'message' ? compactPrompt.message.content : '', /Do not call any tools/)
  // Same system, tools, and history as the main request: the prefix it reads.
  assert.deepEqual(compact!.systemBlocks, main!.systemBlocks)
  assert.deepEqual(compact!.tools?.map((tool) => tool.name), ['echo'])
  const durable = (request: ModelRequest) => request.contextItems!
    .filter((item) => !(item.kind === 'message' && item.message.transient))
    .map((item) => item.kind === 'message' ? item.message.id : item.kind)
  assert.deepEqual(durable(compact!), durable(main!))
  assert.ok(durable(compact!).includes('old-user'))
  const boundary = records.find((record) => record.type === 'compact_boundary')
  assert.match(boundary?.type === 'compact_boundary' ? boundary.summary : '', /shared summary/)
})

test('an inheriting fork auto-compacts its own records behind the unchanged parent prefix', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    { type: 'message', id: 'fork-user', role: 'user', content: 'fork context '.repeat(200), createdAt: '2026-05-10T00:00:00.000Z' },
    { type: 'message', id: 'fork-assistant', role: 'assistant', content: 'fork answer '.repeat(200), createdAt: '2026-05-10T00:01:00.000Z' },
  ]
  const parentMessage: ChatMessage = { id: 'parent-history', role: 'user', content: 'parent history', createdAt: '2026-05-10T00:00:00.000Z' }
  const inheritedRequest: ModelRequest = {
    system: 'parent system',
    messages: [parentMessage],
    contextItems: [{ kind: 'message', message: parentMessage }],
    tools: [],
    model: 'fake-model',
    cacheSource: forkCacheSource('parent', process.cwd()),
    promptCacheKey: 'parent-session',
  }
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      const last = request.contextItems?.at(-1)
      const isCompact = last?.kind === 'message' && last.message.id === 'compact-request'
      return { content: isCompact ? '<summary>fork summary</summary>' : 'done', toolCalls: [] }
    },
  }
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 'fork-compact', readFiles: new Set() },
    contextWindow: 10_000,
    contextManagement: { contextWindow: 10_000, summaryOutputTokens: 100, autoCompactBufferTokens: 50, autoCompactThresholdRatio: 0.05 },
    recordStream: recordStreamFor(records),
    inheritedRequest,
  })

  await loop.run({ text: 'latest request' })

  assert.ok(records.some((record) => record.type === 'compact_boundary'))
  const [compact, main] = requests
  for (const request of [compact!, main!]) {
    assert.equal(request.system, 'parent system')
    assert.equal(request.promptCacheKey, 'parent-session', 'a fork routes its cache with its parent')
    assert.ok(request.turnId)
    const first = request.contextItems?.[0]
    assert.equal(first?.kind === 'message' ? first.message.id : undefined, 'parent-history')
  }

  await loop.run({ text: 'next request' })
  const next = requests.at(-1)!
  const firstNext = next.contextItems?.[0]
  assert.equal(firstNext?.kind === 'message' ? firstNext.message.id : undefined, 'parent-history')
  assert.ok(!next.contextItems!.some((item) => item.kind === 'message' && item.message.id === 'fork-user'))
})

test('agent loop includes compact summary on the next user turn after compaction', async () => {
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer '.repeat(200),
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]
  let mainCallCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const contextItems = request.contextItems ?? []
      const isCompactRequest = contextItems.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      )
      if (isCompactRequest) {
        return { content: 'compact summary for later turns', toolCalls: [] }
      }

      mainCallCount += 1
      const hasCompactSummary = contextItems.some(
        (item) =>
          item.kind === 'message'
          && /Prior conversation was compacted/.test(item.message.content)
          && /compact summary for later turns/.test(item.message.content),
      )
      if (mainCallCount === 1) {
        assert.equal(hasCompactSummary, false)
        assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.id === 'old-user'))
      } else {
        assert.equal(hasCompactSummary, true)
        assert.equal(contextItems.some((item) => item.kind === 'message' && item.message.id === 'old-user'), false)
      }

      return { content: `done ${mainCallCount}`, toolCalls: [] }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 'summary-next-turn-session', readFiles: new Set() },
    contextWindow: 10_000,
    contextManagement: {
      contextWindow: 10_000,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
      autoCompactThresholdRatio: 0.05,
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'latest request' })
  await loop.run({ text: 'follow up' })

  assert.equal(mainCallCount, 2)
  assert.equal(records.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('agent loop runs preCompact and postCompact hooks around successful compaction', async () => {
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer '.repeat(200),
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        return { content: 'summary', toolCalls: [] }
      }
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const hookCommand = `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log(data.hook + ':' + data.trigger) })"`
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextWindow: 600,
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    hooks: {
      preCompact: [{ matcher: 'auto', command: hookCommand }],
      postCompact: [{ matcher: 'auto', command: hookCommand }],
    },
    recordStream: recordStreamFor(records),
  })

  await loop.run({ text: 'latest request' })

  const preHookIndex = records.findIndex((record) => record.type === 'message' && /preCompact hook output/.test(record.content))
  const boundaryIndex = records.findIndex((record) => record.type === 'compact_boundary')
  const postHookIndex = records.findIndex((record) => record.type === 'message' && /postCompact hook output/.test(record.content))
  assert.ok(preHookIndex >= 0)
  assert.ok(boundaryIndex > preHookIndex)
  assert.ok(postHookIndex > boundaryIndex)
  assert.match(records[preHookIndex]?.type === 'message' ? records[preHookIndex].content : '', /preCompact:auto/)
  assert.match(records[postHookIndex]?.type === 'message' ? records[postHookIndex].content : '', /postCompact:auto/)
})

test('agent loop checks auto-compact before later model requests in a tool loop', async () => {
  const records: SessionRecord[] = []
  const providerCalls: string[] = []
  let loadRecordsCount = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        providerCalls.push('compact')
        assert.equal(displayCacheSource(request.cacheSource!), 'compact')
        return {
          content: 'second-iteration summary',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 10,
            inputTokens: 20,
            outputTokens: 30,
          },
        }
      }

      if (providerCalls.length === 0) {
        providerCalls.push('model-1')
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 90,
            outputTokens: 0,
          },
        }
      }

      providerCalls.push('model-2')
      const contextItems = request.contextItems ?? []
      assert.ok(!contextItems.some((item) => item.kind === 'message' && /Prior conversation was compacted/.test(item.message.content)))
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 2,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextWindow: 200,
    contextManagement: {
      contextWindow: 200,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    tokenBudget: 200,
    tokenWarningThreshold: 0.4,
    recordStream: recordStreamFor(records, undefined, () => { loadRecordsCount += 1 }),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'done')
  assert.deepEqual(response.usage, {
    cacheReadInputTokens: 10,
    inputTokens: 111,
    outputTokens: 32,
  })
  assert.deepEqual(providerCalls, ['model-1', 'compact', 'model-2'])
  assert.equal(loadRecordsCount, 1)
  assert.equal(records.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('agent loop counts pending records against the prepared request baseline after compaction', async () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 8; index++) {
    records.push({
      type: 'message',
      id: `pre-compact-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `pre compact ${index}`,
      createdAt: `2026-05-10T00:${String(index).padStart(2, '0')}:00.000Z`,
    })
  }
  records.push(
    {
      type: 'compact_boundary',
      id: 'compact-existing',
      summary: 'prior summary',
      preTokens: 500,
      postCompactRestore: 'consumed',
      createdAt: '2026-05-10T00:08:00.000Z',
    },
    {
      type: 'message',
      id: 'previous-user',
      role: 'user',
      content: 'previous user',
      createdAt: '2026-05-10T00:09:00.000Z',
    },
    {
      type: 'message',
      id: 'previous-assistant',
      role: 'assistant',
      content: 'previous assistant',
      createdAt: '2026-05-10T00:10:00.000Z',
    },
  )

  const providerCalls: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      if (isCompactRequest) {
        providerCalls.push('compact')
        return { content: 'new summary', toolCalls: [] }
      }

      if (providerCalls.length === 0) {
        providerCalls.push('model-1')
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 70,
            outputTokens: 0,
          },
        }
      }

      providerCalls.push('model-2')
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'pending tool output '.repeat(120) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 'prepared-baseline-session', readFiles: new Set() },
    contextWindow: 200,
    contextManagement: {
      contextWindow: 200,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 20,
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'latest request' })

  assert.equal(response.content, 'done')
  assert.deepEqual(providerCalls, ['model-1', 'compact', 'model-2'])
  assert.equal(records.filter((record) => record.type === 'compact_boundary').length, 2)
})

test('agent loop continues the turn when auto-compact summary fails', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context '.repeat(200),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer '.repeat(200),
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]
  const providerCalls: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = displayCacheSource(request.cacheSource!) === 'compact'
      if (isCompactRequest) {
        providerCalls.push('compact')
        throw new Error('compact summarizer failed')
      }

      providerCalls.push('main')
      return {
        content: 'main response',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 'compact-failure-session', readFiles: new Set() },
    contextWindow: 600,
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'latest request' })

  assert.equal(response.content, 'main response')
  // The shared-prefix summary fails, then the text fallback does.
  assert.deepEqual(providerCalls, ['compact', 'compact', 'main'])
  assert.equal(records.filter((record) => record.type === 'compact_attempt_failed').length, 1)
  assert.equal(records.some((record) => record.type === 'compact_boundary'), false)
})

test('agent loop switches to fallback model after overload fallback trigger', async () => {
  resetCacheBreakDetection()
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'previous-assistant',
    role: 'assistant',
    content: 'previous response',
    thinkingBlocks: [{
      type: 'thinking',
      thinking: 'previous thinking',
      signature: 'primary-signature',
    }],
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const source = 'agent:s1'
  recordPromptState({ system: 'system', toolsJson: '[]', model: 'primary-model' }, source)
  checkResponseForCacheBreak(10_000, 10_000, source)

  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
    },
  }
  const fallbackProvider: ModelProvider = {
    name: 'fallback',
    async createMessage(request) {
      assert.equal(request.model, 'fallback-model')
      assert.equal(request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.thinkingBlocks && item.message.thinkingBlocks.length > 0,
      ), false)
      recordPromptState({ system: 'system', toolsJson: '[]', model: request.model }, request.cacheSource)
      assert.equal(checkResponseForCacheBreak(0, 10_000, request.cacheSource), null)
      return {
        content: 'fallback response',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    },
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'primary-model',
    modelKey: 'primary',
    fallbackModel: {
      provider: fallbackProvider,
      model: 'fallback-model',
      modelKey: 'fallback',
      providerName: 'fallback',
    },
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })
  assert.equal(response.content, 'fallback response')
  assert.equal(loop.getActiveModel().modelKey, 'fallback')
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.model === 'fallback-model'))
})

test('the context budget follows the active model, and reserves what autocompact needs', async () => {
  resetCacheBreakDetection()
  const records: SessionRecord[] = []
  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
    },
  }
  const fallbackProvider: ModelProvider = {
    name: 'fallback',
    async createMessage() {
      return {
        content: 'fallback response',
        toolCalls: [],
        usage: { cacheReadInputTokens: 0, inputTokens: 10, outputTokens: 5 },
      }
    },
  }
  const tools: Tool[] = []
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'primary-model',
    modelKey: 'primary',
    contextWindow: 200_000,
    fallbackModel: {
      provider: fallbackProvider,
      model: 'fallback-model',
      modelKey: 'fallback',
      contextWindow: 1_000_000,
      providerName: 'fallback',
    },
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  // The usable half is `getAutoCompactThreshold`, which is what the loop itself
  // thresholds on — a display dividing by the raw window would promise room no
  // turn is ever allowed to use.
  assert.deepEqual(loop.getContextBudget(), {
    contextWindow: 200_000,
    usableContextWindow: getAutoCompactThreshold({ contextWindow: 200_000 }),
  })

  await loop.run({ text: 'hello' })
  assert.equal(loop.getActiveModel().modelKey, 'fallback')
  // Read off the *active* model: after a fallback the runtime snapshot must not
  // still be reporting the window the loop was built with.
  assert.deepEqual(loop.getContextBudget(), {
    contextWindow: 1_000_000,
    usableContextWindow: getAutoCompactThreshold({ contextWindow: 1_000_000 }),
  })
})

test('agent loop retries primary model after fallback cooldown', async () => {
  resetCacheBreakDetection()
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const records: SessionRecord[] = []
    const cacheClears: Array<string | undefined> = []
    const contextBuilder = new class extends ContextBuilder {
      override clearCachedSections(key?: string): void {
        cacheClears.push(key)
        super.clearCachedSections(key)
      }
    }()
    let primaryCalls = 0
    let fallbackCalls = 0

    const primaryProvider: ModelProvider = {
      name: 'primary',
      async createMessage(request) {
        primaryCalls += 1
        assert.equal(request.model, 'primary-model')
        if (primaryCalls === 1) {
          throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
        }
        recordPromptState({ system: 'system', toolsJson: '[]', model: request.model }, request.cacheSource)
        assert.equal(checkResponseForCacheBreak(0, 10_000, request.cacheSource), null)
        return {
          content: 'primary response',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
        }
      },
    }
    const fallbackProvider: ModelProvider = {
      name: 'fallback',
      async createMessage(request) {
        fallbackCalls += 1
        assert.equal(request.model, 'fallback-model')
        recordPromptState({ system: 'system', toolsJson: '[]', model: request.model }, request.cacheSource)
        assert.equal(checkResponseForCacheBreak(0, 10_000, request.cacheSource), null)
        return {
          content: 'fallback response',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
        }
      },
    }
    const runner = new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })
    const loop = new AgentLoop({
      provider: primaryProvider,
      model: 'primary-model',
      modelKey: 'primary',
      fallbackModel: {
        provider: fallbackProvider,
        model: 'fallback-model',
        modelKey: 'fallback',
        providerName: 'fallback',
      },
      tools: [],
      contextBuilder,
      toolRunner: runner,
      toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    const first = await loop.run({ text: 'hello' })
    assert.equal(first.content, 'fallback response')
    assert.equal(loop.getActiveModel().modelKey, 'fallback')

    now += (5 * 60 * 1000) - 1
    const second = await loop.run({ text: 'still there?' })
    assert.equal(second.content, 'fallback response')
    assert.equal(loop.getActiveModel().modelKey, 'fallback')

    now += 1
    const third = await loop.run({ text: 'try again' })
    assert.equal(third.content, 'primary response')
    assert.equal(loop.getActiveModel().modelKey, 'primary')
    assert.equal(primaryCalls, 2)
    assert.equal(fallbackCalls, 2)
    assert.ok(cacheClears.length >= 2)
    assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.model === 'primary-model'))
  } finally {
    Date.now = originalNow
  }
})

test('agent loop returns to fallback when primary cooldown retry is still overloaded', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const records: SessionRecord[] = []
    const calls: string[] = []
    const primaryProvider: ModelProvider = {
      name: 'primary',
      async createMessage() {
        calls.push('primary')
        throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
      },
    }
    const fallbackProvider: ModelProvider = {
      name: 'fallback',
      async createMessage() {
        calls.push('fallback')
        return {
          content: 'fallback response',
          toolCalls: [],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 10,
            outputTokens: 5,
          },
        }
      },
    }
    const runner = new ToolRunner([], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    })
    const loop = new AgentLoop({
      provider: primaryProvider,
      model: 'primary-model',
      modelKey: 'primary',
      fallbackModel: {
        provider: fallbackProvider,
        model: 'fallback-model',
        modelKey: 'fallback',
        providerName: 'fallback',
      },
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: runner,
      toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
      recordStream: recordStreamFor(records),
    })

    await loop.run({ text: 'hello' })
    now += 5 * 60 * 1000
    const response = await loop.run({ text: 'try primary' })

    assert.equal(response.content, 'fallback response')
    assert.deepEqual(calls, ['primary', 'fallback', 'primary', 'fallback'])
    assert.equal(loop.getActiveModel().modelKey, 'fallback')
  } finally {
    Date.now = originalNow
  }
})

test('agent loop uses last response usage, not cumulative usage, for auto-compact checks', async () => {
  const records: SessionRecord[] = []
  const providerCalls: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      const isCompactRequest = request.contextItems?.some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      ) ?? false
      assert.equal(isCompactRequest, false)

      if (providerCalls.length === 0) {
        // The source carries a digest of the project root so two projects never
        // share a cache-break baseline; the logical part is still `agent:<id>`.
        assert.equal(displayCacheSource(request.cacheSource!), 'agent:s1')
        providerCalls.push('model-1')
        return {
          content: 'using tool',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          usage: {
            cacheReadInputTokens: 0,
            inputTokens: 80,
            outputTokens: 30,
          },
        }
      }

      providerCalls.push('model-2')
      assert.equal(displayCacheSource(request.cacheSource!), 'agent:s1')
      return {
        content: 'done',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 10,
          outputTokens: 5,
        },
      }
    },
  }
  const tools: Tool[] = [{
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({
      value: z.string(),
    }).strict(),
    riskLevel: 'safe',
    execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
  }]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    contextWindow: 200,
    contextManagement: {
      contextWindow: 200,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 20,
    },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'hello' })

  assert.equal(response.content, 'done')
  assert.deepEqual(providerCalls, ['model-1', 'model-2'])
  assert.equal(records.filter((record) => record.type === 'compact_boundary').length, 0)
})


// --- turn image rules (S15, design §9) --------------------------------------

test('a text-only model blocks new images before any record is written', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      throw new Error('provider must not be called')
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'text-only-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const ref = makeImageAttachmentRef({ id: 'img-gate', ownerSessionId: 's1', name: 'queued.png' })
  // A queued message is the current input the moment its dequeued run starts
  // — waiting never turns its images into degradable history.
  await assert.rejects(
    loop.run({ text: 'queued earlier, executing now', images: [ref] }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
      && error.imageInputBlock === 'model-not-capable'
      && error.images.length === 1,
  )
  assert.equal(records.length, 0)
})

test('a current input whose cached files are gone is blocked before any record', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      throw new Error('provider must not be called')
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    attachmentFacts: {
      resolveAttachmentFacts: async () => ({ ok: false }),
    },
  })

  const ref = makeImageAttachmentRef({ id: 'img-gone', ownerSessionId: 's1', name: 'gone.png' })
  await assert.rejects(
    loop.run({ text: 'look at this', images: [ref] }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
      && error.imageInputBlock === 'file-missing'
      && error.images.length === 1,
  )
  assert.equal(records.length, 0)
})

test('a text-only model projects historical images as text and notifies once per state', async () => {
  const historyImage = makeImageAttachmentRef({ id: 'img-old', ownerSessionId: 's1', name: 'shot.png' })
  const historyToolImage = makeImageAttachmentRef({ id: 'img-old-tool', ownerSessionId: 's1', name: 'read.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'what is this',
      images: [historyImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'an earlier answer',
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:01.000Z',
    },
    {
      type: 'tool_use',
      id: 'old-call',
      tool: 'Probe',
      input: {},
      riskLevel: 'safe',
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:02.000Z',
    },
    {
      type: 'tool_result',
      id: 'old-result',
      toolUseId: 'old-call',
      tool: 'Probe',
      ok: true,
      content: 'probed',
      images: [historyToolImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:03.000Z',
    },
  ]
  const requests: ModelRequest[] = []
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      providerCalls += 1
      requests.push(request)
      if (providerCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'Probe', input: {} }],
          usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      }
      return {
        content: 'summarized',
        toolCalls: [],
        usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
      }
    },
  }
  const tools: Tool[] = [testTool('Probe')]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const streamEvents: ModelStreamEvent[] = []
  const loop = new AgentLoop({
    provider,
    model: 'text-only-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    attachmentFacts: {
      resolveAttachmentFacts: async (ref) => ({
        ok: true,
        facts: {
          originalWidth: 3840,
          originalHeight: 2160,
          localPath: `C:/cache/${ref.id}/original.png`,
        },
      }),
    },
    onStreamEvent: (event) => { streamEvents.push(event) },
  })

  const response = await loop.run({ text: 'summarize the screenshot' })
  assert.equal(response.content, 'summarized')
  assert.equal(providerCalls, 2)

  // Every request the provider saw is image-free and carries the honest
  // placeholders instead — across the tool round-trip too (request rebuild).
  assert.equal(requests.length, 2)
  for (const request of requests) {
    for (const message of request.messages) {
      assert.equal(message.images, undefined)
    }
    for (const item of request.contextItems ?? []) {
      if (item.kind === 'message') assert.equal(item.message.images, undefined)
      if (item.kind === 'tool_result') assert.equal(item.images, undefined)
    }
    const oldUser = request.messages.find((message) => message.content.includes('what is this'))
    assert.equal(
      oldUser?.content,
      'what is this\n\n[Historical image omitted for this text-only model:\n'
        + 'shot.png, original 3840x2160, cached at C:/cache/img-old/original.png.\n'
        + 'The pixels are not present in this request.]',
    )
  }

  // The projection is request-only: the persisted records keep their images
  // and their original text, so switching back restores the pixels.
  const persistedOldUser = records.find((record) => record.id === 'old-user')
  assert.equal(persistedOldUser?.type, 'message')
  assert.equal(persistedOldUser?.type === 'message' ? persistedOldUser.content : undefined, 'what is this')
  assert.deepEqual(persistedOldUser?.type === 'message' ? persistedOldUser.images : undefined, [historyImage])
  const persistedOldResult = records.find((record) => record.id === 'old-result')
  assert.equal(persistedOldResult?.type, 'tool_result')
  assert.deepEqual(persistedOldResult?.type === 'tool_result' ? persistedOldResult.images : undefined, [historyToolImage])

  // The degradation notice fires once for this (model, image set) state — not
  // again on the second request after the tool step.
  const notices = streamEvents.filter((event) => event.type === 'image_capability_notice')
  assert.equal(notices.length, 1)
  if (notices[0]?.type === 'image_capability_notice') {
    assert.equal(notices[0].omittedImageCount, 2)
    assert.match(notices[0].message, /2 historical images/)
    assert.match(notices[0].message, /replaced with file paths/)
  }
})

test('an automatic fallback to a text-only model does not apply to a turn with new images', async () => {
  const records: SessionRecord[] = []
  let providerCalls = 0
  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      providerCalls += 1
      throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
    },
  }
  const fallbackProvider: ModelProvider = {
    name: 'fallback',
    async createMessage() {
      throw new Error('fallback request must be blocked before it is sent')
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'capable-model',
    modelKey: 'primary',
    supportsImageInput: true,
    fallbackModel: {
      provider: fallbackProvider,
      model: 'text-only-fallback',
      modelKey: 'fallback',
      providerName: 'fallback',
    },
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  const ref = makeImageAttachmentRef({ id: 'img-fb', ownerSessionId: 's1', name: 'shot.png' })
  // The turn started under a capable model, so the user message exists; the
  // fallback switch must not buy a degradation by making the images look old.
  await assert.rejects(
    loop.run({ text: 'look at this', images: [ref] }),
    (error: unknown) => {
      assert.ok(error instanceof FallbackNotApplicableForImagesError)
      assert.equal(error.imageInputBlock, 'model-not-capable')
      // The outage that asked for the fallback survives — replacing it with
      // only the image reason would misreport why the turn failed.
      assert.match(error.message, /529 overloaded/)
      assert.equal((error.cause as Error).message, '529 overloaded')
      assert.match(error.message, /text-only-fallback/)
      assert.deepEqual(error.images, [ref])
      return true
    },
  )
  // One primary attempt and no fallback attempt: refusing to switch is also
  // what stops the same incompatible target being retried in a loop.
  assert.equal(providerCalls, 1)
  const user = records.find((record) => record.type === 'message' && record.role === 'user')
  assert.deepEqual(user?.type === 'message' ? user.images : undefined, [ref])
})

test('an automatic fallback to a text-only model still applies when only history carries images', async () => {
  const oldImage = makeImageAttachmentRef({ id: 'img-hist', ownerSessionId: 's1', name: 'old.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'first shot',
      images: [oldImage],
      turnId: 'turn-old',
      createdAt: '2026-09-09T00:00:00.000Z',
    },
  ]
  let primaryCalls = 0
  const primaryProvider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      primaryCalls += 1
      throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
    },
  }
  const fallbackRequests: ModelRequest[] = []
  const fallbackProvider: ModelProvider = {
    name: 'fallback',
    async createMessage(request) {
      fallbackRequests.push(request)
      return { content: 'answered without pixels', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const streamEvents: ModelStreamEvent[] = []
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'capable-model',
    modelKey: 'primary',
    supportsImageInput: true,
    fallbackModel: {
      provider: fallbackProvider,
      model: 'text-only-fallback',
      modelKey: 'fallback',
      providerName: 'fallback',
    },
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    attachmentFacts: {
      resolveAttachmentFacts: async (ref) => ({
        ok: true,
        facts: { originalWidth: 800, originalHeight: 600, localPath: `C:/cache/${ref.id}/original.png` },
      }),
    },
    onStreamEvent: (event) => { streamEvents.push(event) },
  })

  const result = await loop.run({ text: 'and now in words' })

  assert.equal(result.content, 'answered without pixels')
  assert.equal(primaryCalls, 1)
  assert.equal(fallbackRequests.length, 1, 'history-only images do not stop the fallback')
  assert.equal(fallbackRequests[0].imageBytes, undefined)
  const degraded = fallbackRequests[0].messages.find((message) =>
    message.content.includes('Historical image omitted for this text-only model'))
  assert.ok(degraded, 'the history degrades to a placeholder rather than blocking the turn')
  assert.equal(degraded.images, undefined)
  const notice = streamEvents.find((event) => event.type === 'image_capability_notice')
  assert.ok(notice, 'the user is told why the history is not visible to the fallback model')
})


// --- media-count cap and image-token budgets (S16, design §8, §11) -----------

test('an adapter limit below the local cap omits the oldest history and notifies once', async () => {
  const oldImage = makeImageAttachmentRef({ id: 'img-old', ownerSessionId: 's1', name: 'old.png' })
  const midImage = makeImageAttachmentRef({ id: 'img-mid', ownerSessionId: 's1', name: 'mid.png' })
  const currentImage = makeImageAttachmentRef({ id: 'img-cur', ownerSessionId: 's1', name: 'cur.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'first shot',
      images: [oldImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'mid-user',
      role: 'user',
      content: 'second shot',
      images: [midImage],
      turnId: 'turn-mid',
      createdAt: '2026-09-08T00:01:00.000Z',
    },
  ]
  const requests: ModelRequest[] = []
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    // A lower adapter limit wins over the local default of 100.
    maxImagesPerRequest: () => 2,
    async createMessage(request) {
      providerCalls += 1
      requests.push(request)
      if (providerCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'Probe', input: {} }],
          usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      }
      return {
        content: 'done',
        toolCalls: [],
        usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
      }
    },
  }
  const tools: Tool[] = [testTool('Probe')]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const streamEvents: ModelStreamEvent[] = []
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's16-adapter-cap', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    onStreamEvent: (event) => { streamEvents.push(event) },
  })

  const response = await loop.run({ text: 'look at these', images: [currentImage] })
  assert.equal(response.content, 'done')
  assert.equal(requests.length, 2)

  // 3 images, adapter cap 2: the oldest history leaves the request; the
  // current input's image never does — across the tool round-trip too.
  // (Messages and context items both carry the records, so ids dedupe them.)
  for (const request of requests) {
    const seen = new Set<string>()
    for (const message of request.messages) {
      for (const image of message.images ?? []) seen.add(`${message.id}:${image.id}`)
    }
    for (const item of request.contextItems ?? []) {
      if (item.kind === 'message') {
        for (const image of item.message.images ?? []) seen.add(`${item.message.id}:${image.id}`)
      }
      if (item.kind === 'tool_result') {
        for (const image of item.images ?? []) seen.add(`${item.toolUseId}:${image.id}`)
      }
    }
    assert.deepEqual(
      [...seen].map((entry) => entry.split(':').at(-1)).sort(),
      ['img-cur', 'img-mid'],
    )
    const firstShot = request.messages.find((message) => message.content.includes('first shot'))
    assert.match(
      firstShot?.content ?? '',
      /\[Historical image omitted to stay within the 2-image request limit: old\.png/,
    )
  }

  // The strip is a request projection: JSONL keeps every image and its text.
  const persistedOld = records.find((record) => record.id === 'old-user')
  assert.equal(persistedOld?.type === 'message' ? persistedOld.content : undefined, 'first shot')
  assert.deepEqual(persistedOld?.type === 'message' ? persistedOld.images : undefined, [oldImage])

  // The notice fires once for this (cap, kept set) state, not per tool step.
  const notices = streamEvents.filter((event) => event.type === 'media_limit_notice')
  assert.equal(notices.length, 1)
  if (notices[0]?.type === 'media_limit_notice') {
    assert.equal(notices[0].omittedImageCount, 1)
    assert.equal(notices[0].maxImages, 2)
    assert.match(notices[0].message, /limit of 2 images/)
  }
  // The capability notice stays silent: the model is image-capable.
  assert.equal(streamEvents.some((event) => event.type === 'image_capability_notice'), false)
})

test('the local 100-image cap applies when no adapter limit is declared', async () => {
  const records: SessionRecord[] = []
  for (let index = 0; index < 101; index++) {
    records.push({
      type: 'message',
      id: `hist-user-${index}`,
      role: 'user',
      content: `history ${index}`,
      images: [makeImageAttachmentRef({ id: `img-${index}`, ownerSessionId: 's1' })],
      turnId: `turn-${index}`,
      createdAt: '2026-09-08T00:00:00.000Z',
    })
  }
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const streamEvents: ModelStreamEvent[] = []
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's16-local-cap', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    onStreamEvent: (event) => { streamEvents.push(event) },
  })

  // 101 history images + 1 current = 102, cap 100: the two oldest go.
  await loop.run({
    text: 'one more',
    images: [makeImageAttachmentRef({ id: 'img-current', ownerSessionId: 's1' })],
  })
  assert.equal(requests.length, 1)
  const seen = new Set<string>()
  for (const message of requests[0]!.messages) {
    for (const image of message.images ?? []) seen.add(image.id)
  }
  for (const item of requests[0]!.contextItems ?? []) {
    if (item.kind === 'message') for (const image of item.message.images ?? []) seen.add(image.id)
    if (item.kind === 'tool_result') for (const image of item.images ?? []) seen.add(image.id)
  }
  assert.equal(seen.size, 100)
  assert.equal(seen.has('img-0'), false)
  assert.equal(seen.has('img-1'), false)
  assert.equal(seen.has('img-100'), true)
  assert.equal(seen.has('img-current'), true)
  const notices = streamEvents.filter((event) => event.type === 'media_limit_notice')
  assert.equal(notices.length, 1)
})

test('submission is blocked when the input alone exceeds the model request cap', async () => {
  const provider: ModelProvider = {
    name: 'fake',
    maxImagesPerRequest: () => 2,
    async createMessage() {
      throw new Error('provider must not be called')
    },
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's16-submit-cap', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  // Within the cap: allowed.
  loop.assertImagesAllowedForSubmission({
    text: 'fine',
    images: [
      makeImageAttachmentRef({ id: 'img-1', ownerSessionId: 's1' }),
      makeImageAttachmentRef({ id: 'img-2', ownerSessionId: 's1' }),
    ],
  })
  // Over the cap: blocked before any record is written, with the count and
  // the way out in the message.
  assert.throws(
    () => loop.assertImagesAllowedForSubmission({
      text: 'too many',
      images: [
        makeImageAttachmentRef({ id: 'img-1', ownerSessionId: 's1' }),
        makeImageAttachmentRef({ id: 'img-2', ownerSessionId: 's1' }),
        makeImageAttachmentRef({ id: 'img-3', ownerSessionId: 's1' }),
      ],
    }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'too-many-images'
        && /3 images/.test(error.message)
        && /at most 2 per request/.test(error.message),
  )
  assert.equal(records.length, 0)
})

test('a mid-run model switch drops the usage baseline and re-estimates with image tokens', async () => {
  resetAutoCompactFailureState()
  const historyImage = makeImageAttachmentRef({
    id: 'img-big',
    ownerSessionId: 's1',
    width: 2000,
    height: 2000,
  })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'what is this',
      images: [historyImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'an earlier answer',
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:01.000Z',
    },
  ]
  let primaryCalls = 0
  const primaryProvider: ModelProvider = {
    name: 'primary',
    // Text-only: the historical image leaves this request as a placeholder.
    async createMessage() {
      primaryCalls += 1
      if (primaryCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'Probe', input: {} }],
          // Tiny reported usage: the baseline reuse path would keep the next
          // estimate far below the compact threshold.
          usage: { inputTokens: 50, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      }
      throw new FallbackTriggeredError(new Error('529 overloaded'), 3)
    },
  }
  let fallbackCalls = 0
  const fallbackProvider: ModelProvider = {
    name: 'fallback',
    async createMessage(request) {
      fallbackCalls += 1
      const isCompactRequest = (request.contextItems ?? []).some(
        (item) => item.kind === 'message' && item.message.id === 'compact-request',
      )
      if (isCompactRequest) return { content: 'compact summary', toolCalls: [] }
      return { content: 'done after fallback', toolCalls: [] }
    },
  }
  const tools: Tool[] = [testTool('Probe')]
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider: primaryProvider,
    model: 'text-only-model',
    modelKey: 'primary',
    contextWindow: 35_000,
    fallbackModel: {
      provider: fallbackProvider,
      model: 'capable-fallback',
      modelKey: 'fallback',
      providerName: 'fallback',
      supportsImageInput: true,
      contextWindow: 35_000,
    },
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's16-baseline', readFiles: new Set() },
    // Threshold 2000: the projected text-only request stays below it, but the
    // capable fallback's request (with the image's ~5.3k estimated tokens)
    // crosses it — but only when the baseline is dropped and the records are
    // re-counted.
    contextManagement: { contextWindow: 35_000 },
    recordStream: recordStreamFor(records),
  })

  const response = await loop.run({ text: 'look again' })
  assert.equal(response.content, 'done after fallback')
  assert.equal(primaryCalls, 2)
  assert.equal(fallbackCalls, 2, 'compact summary plus the final request')

  // The re-estimate crossed the threshold, so the turn compacted — with the
  // stale baseline the estimate would have stayed near 51 tokens.
  assert.ok(
    records.some((record) => record.type === 'compact_boundary'),
    'the model switch forced a full re-count that crossed the compact threshold',
  )
  // The projection never touches what was persisted.
  const persistedOld = records.find((record) => record.id === 'old-user')
  assert.deepEqual(persistedOld?.type === 'message' ? persistedOld.images : undefined, [historyImage])
  resetAutoCompactFailureState()
})


// --- Final-send byte loading (S17, design §11.1 step 5) ---

test('final-send image bytes load once per request build and ride the ModelRequest', async () => {
  const historyImage = makeImageAttachmentRef({ id: 'img-hist-load', ownerSessionId: 's17-load', name: 'hist.png' })
  const currentImage = makeImageAttachmentRef({ id: 'img-cur-load', ownerSessionId: 's17-load', name: 'cur.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'what is this',
      images: [historyImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
  ]
  const requests: ModelRequest[] = []
  let loadCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's17-load', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    attachmentBytes: {
      readSendBytes: async (ref) => {
        loadCalls += 1
        return { ok: true, value: { bytes: new TextEncoder().encode(ref.id), mimeType: 'image/png' } }
      },
    },
  })

  await loop.run({ text: 'look at this', images: [currentImage] })

  // One load per unique ref for the one request built — history and current.
  assert.equal(loadCalls, 2)
  const imageBytes = requests[0]?.imageBytes
  assert.ok(imageBytes, 'the request carries the loaded byte map')
  assert.equal(imageBytes.size, 2)
  assert.deepEqual(imageBytes.get('img-hist-load'), {
    bytes: new TextEncoder().encode('img-hist-load'),
    mimeType: 'image/png',
  })
  assert.deepEqual(imageBytes.get('img-cur-load'), {
    bytes: new TextEncoder().encode('img-cur-load'),
    mimeType: 'image/png',
  })

  // A later request builds a fresh map of its own — the earlier turn's images
  // are history now, still loaded, but never a map carried over by identity.
  await loop.run({ text: 'plain text now' })
  assert.notEqual(requests[1]?.imageBytes, requests[0]?.imageBytes)
  assert.equal(requests[1]?.imageBytes?.size, 2)
  assert.equal(loadCalls, 4, 'each request build loads its own bytes')

  // Nothing was rewritten into the records the projections read from.
  const persistedOld = records.find((record) => record.id === 'old-user')
  assert.equal(persistedOld?.type === 'message' ? persistedOld.content : undefined, 'what is this')
  assert.deepEqual(persistedOld?.type === 'message' ? persistedOld.images : undefined, [historyImage])
})

test('an unloadable historical image degrades to a file-missing placeholder while current images still send', async () => {
  const historyImage = makeImageAttachmentRef({ id: 'img-hist-gone', ownerSessionId: 's17-gone', name: 'hist.png' })
  const currentImage = makeImageAttachmentRef({ id: 'img-cur-ok', ownerSessionId: 's17-gone', name: 'cur.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'what is this',
      images: [historyImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
  ]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's17-gone', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    attachmentBytes: {
      readSendBytes: async (ref) => ref.id === 'img-hist-gone'
        ? { ok: false, reason: 'file-missing', message: 'cached files are gone' }
        : { ok: true, value: { bytes: new TextEncoder().encode(ref.id), mimeType: 'image/png' } },
    },
  })

  await loop.run({ text: 'look at this', images: [currentImage] })

  const request = requests[0]
  assert.ok(request)
  // The historical occurrence kept its slot as an honest placeholder and no
  // longer rides the request as an image ref.
  const historyItem = request.contextItems?.find(
    (item) => item.kind === 'message' && item.message.id === 'old-user',
  )
  assert.ok(historyItem && historyItem.kind === 'message')
  assert.match(historyItem.message.content, /\[Historical image missing: hist\.png/)
  assert.equal(historyItem.message.images, undefined)
  // The current turn's image still sends, with its bytes.
  const currentItem = request.contextItems?.find(
    (item) => item.kind === 'message' && item.message.content === 'look at this',
  )
  assert.ok(currentItem && currentItem.kind === 'message')
  assert.deepEqual(currentItem.message.images, [currentImage])
  assert.deepEqual(request.imageBytes?.get('img-cur-ok'), {
    bytes: new TextEncoder().encode('img-cur-ok'),
    mimeType: 'image/png',
  })
  assert.equal(request.imageBytes?.has('img-hist-gone'), false)

  // The projection never touched the persisted record.
  const persistedOld = records.find((record) => record.id === 'old-user')
  assert.equal(persistedOld?.type === 'message' ? persistedOld.content : undefined, 'what is this')
  assert.deepEqual(persistedOld?.type === 'message' ? persistedOld.images : undefined, [historyImage])
})

test('an unloadable current-turn image stops the request instead of dropping it silently', async () => {
  const currentImage = makeImageAttachmentRef({ id: 'img-cur-block', ownerSessionId: 's17-block', name: 'cur.png' })
  const records: SessionRecord[] = []
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      providerCalls += 1
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    // No attachmentFacts: the submission-time availability check passes, so
    // the load-time failure is what stops the request.
    toolContext: { cwd: process.cwd(), sessionId: 's17-block', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    attachmentBytes: {
      readSendBytes: async () => ({ ok: false, reason: 'file-missing', message: 'cached files are gone' }),
    },
  })

  await assert.rejects(
    loop.run({ text: 'look at this', images: [currentImage] }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
      && error.imageInputBlock === 'file-missing'
      && error.images.length === 1
      && error.images[0]?.id === 'img-cur-block',
  )
  assert.equal(providerCalls, 0, 'no request was sent')
  // The user message was recorded (the submission itself was accepted); the
  // failure belongs to the request build, after the record exists.
  assert.ok(records.some((record) => record.type === 'message' && record.role === 'user'))
})


// --- Request-size budget and final validation (S19, design §11.1) -------------

test('the request-size budget omits the oldest historical images before bytes load', async () => {
  const historyImage = makeImageAttachmentRef({
    id: 'img-hist-bytes', ownerSessionId: 's19-budget', name: 'hist.png', byteLength: 3000,
  })
  const currentImage = makeImageAttachmentRef({
    id: 'img-cur-bytes', ownerSessionId: 's19-budget', name: 'cur.png', byteLength: 3000,
  })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'what is this',
      images: [historyImage],
      turnId: 'turn-old',
      createdAt: '2026-09-08T00:00:00.000Z',
    },
  ]
  const requests: ModelRequest[] = []
  const events: ModelStreamEvent[] = []
  const loadedIds: string[] = []
  // Budget after the text estimate (~540 bytes for two short messages): fits
  // exactly one 4,128-byte image occurrence, so the oldest history leaves.
  const provider: ModelProvider = {
    name: 'fake',
    maxRequestBodyBytes: () => 5000,
    async createMessage(request) {
      requests.push(request)
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's19-budget', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    onStreamEvent: (event) => { events.push(event) },
    attachmentBytes: {
      readSendBytes: async (ref) => {
        loadedIds.push(ref.id)
        return { ok: true, value: { bytes: new TextEncoder().encode(ref.id), mimeType: 'image/png' } }
      },
    },
  })

  await loop.run({ text: 'look at this', images: [currentImage] })

  const request = requests[0]
  assert.ok(request)
  const historyItem = request.contextItems?.find(
    (item) => item.kind === 'message' && item.message.id === 'old-user',
  )
  assert.ok(historyItem && historyItem.kind === 'message')
  assert.match(
    historyItem.message.content,
    /\[Historical image omitted to keep this request within its [\d,]+-byte size limit: hist\.png \(attachment img-hist-bytes\)\. The pixels are not present in this request\.\]/,
  )
  assert.equal(historyItem.message.images, undefined)
  const currentItem = request.contextItems?.find(
    (item) => item.kind === 'message' && item.message.content === 'look at this',
  )
  assert.ok(currentItem && currentItem.kind === 'message')
  assert.deepEqual(currentItem.message.images, [currentImage])

  // Only what survived the budget was loaded — omission runs before loading.
  assert.deepEqual(loadedIds, ['img-cur-bytes'])
  assert.equal(request.imageBytes?.has('img-hist-bytes'), false)
  assert.deepEqual(request.imageBytes?.get('img-cur-bytes'), {
    bytes: new TextEncoder().encode('img-cur-bytes'),
    mimeType: 'image/png',
  })

  const notices = events.filter((event) => event.type === 'request_size_notice')
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.type === 'request_size_notice' ? notices[0].omittedImageCount : undefined, 1)
  assert.match(
    notices[0]?.type === 'request_size_notice' ? notices[0].message : '',
    /replaced with file placeholders/,
  )

  // The projection never touched the persisted record.
  const persistedOld = records.find((record) => record.id === 'old-user')
  assert.equal(persistedOld?.type === 'message' ? persistedOld.content : undefined, 'what is this')
  assert.deepEqual(persistedOld?.type === 'message' ? persistedOld.images : undefined, [historyImage])
})

test('an input whose images alone exceed the request-body limit is rejected before any record', async () => {
  const first = makeImageAttachmentRef({
    id: 'img-in-1', ownerSessionId: 's19-input', name: 'first.png', byteLength: 3000,
  })
  const second = makeImageAttachmentRef({
    id: 'img-in-2', ownerSessionId: 's19-input', name: 'second.png', byteLength: 3000,
  })
  const records: SessionRecord[] = []
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    maxRequestBodyBytes: () => 4000,
    async createMessage() {
      providerCalls += 1
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's19-input', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await assert.rejects(
    loop.run({ text: 'look at this', images: [first, second] }),
    (error: unknown) =>
      error instanceof TurnImageBlockError
        && error.imageInputBlock === 'request-too-large'
        && error.images.length === 2
        && /first\.png, second\.png/.test(error.message)
        && /crop\/downscale/.test(error.message),
  )
  assert.equal(providerCalls, 0, 'no request was sent')
  assert.equal(records.length, 0, 'the blocked input never became a record')
})

test('a request-size rejection after tool results leaves every tool call settled', async () => {
  const records: SessionRecord[] = []
  let providerCalls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      providerCalls += 1
      if (providerCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'Echo', input: { value: 'x' } }],
        }
      }
      throw new TurnImageBlockError(
        'request-too-large',
        [],
        'The serialized request body is 30,000,000 bytes, over the 25,000,000-byte request limit.',
      )
    },
  }
  const runner = new ToolRunner(
    [testTool('Echo')],
    new PermissionGate(async () => true),
    { onRecord: async (record) => { records.push(record) } },
  )
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    tools: [testTool('Echo')],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's19-settled', readFiles: new Set() },
    recordStream: recordStreamFor(records),
  })

  await assert.rejects(
    loop.run({ text: 'run the tool' }),
    (error: unknown) =>
      error instanceof TurnImageBlockError && error.imageInputBlock === 'request-too-large',
  )
  assert.equal(providerCalls, 2, 'the second request build failed the final check')

  // Every tool_use the assistant emitted has its settled tool_result — the
  // failure left no dangling calls behind (design §11.1).
  const toolUseIds = records.filter((record) => record.type === 'tool_use').map((record) => record.id)
  const resultIds = new Set(
    records.filter((record) => record.type === 'tool_result').map((record) => record.toolUseId),
  )
  assert.deepEqual(toolUseIds, ['call-1'])
  for (const id of toolUseIds) {
    assert.ok(resultIds.has(id), `tool_use ${id} is settled`)
  }
})

test('userPromptSubmit hooks receive attachment metadata beside the verbatim prompt', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }
  const runner = new ToolRunner([], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  // Reads the hook's stdin JSON and echoes the prompt and the image metadata
  // it received, so the test can pin both halves of the contract.
  const hookScript = 'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{'
    + 'const j=JSON.parse(d);console.log("hook-prompt:"+j.prompt);'
    + 'console.log("hook-images:"+(j.images||[]).map(i=>i.id+":"+i.width+"x"+i.height).join(","));})'
  const loop = new AgentLoop({
    provider,
    model: 'capable-model',
    supportsImageInput: true,
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's19-hooks', readFiles: new Set() },
    hooks: {
      userPromptSubmit: [{ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(hookScript)}` }],
    },
    recordStream: recordStreamFor(records),
  })

  const image = makeImageAttachmentRef({
    id: 'img-meta-1', ownerSessionId: 's19-hooks', name: 'meta.png', width: 64, height: 48,
  })
  await loop.run({ text: 'analyze this', images: [image] })

  const hookOutput = records.find(
    (record) => record.type === 'message' && /userPromptSubmit hook output/.test(record.content),
  )
  assert.ok(hookOutput && hookOutput.type === 'message')
  assert.match(hookOutput.content, /hook-prompt:analyze this/, 'the prompt arrived verbatim, no placeholder written back')
  assert.match(hookOutput.content, /hook-images:img-meta-1:64x48/, 'attachment metadata rode along')
})

test('costs ride on the turn metric, and a subagent run gets a usage metric of its own', async () => {
  const records: SessionRecord[] = []
  const metrics: Array<Record<string, unknown>> = []
  const provider: ModelProvider = {
    name: 'fake',
    createMessage: async () => ({
      content: 'done',
      toolCalls: [],
      usage: { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 1, cost: { amounts: { USD: 0.5 } } },
    }),
  }
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [],
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner([], new PermissionGate(async () => true), { onRecord: async (record) => { records.push(record) } }),
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records, metrics),
  })

  const result = await loop.run({ text: 'hello' })
  assert.deepEqual(result.usage.cost, { amounts: { USD: 0.5 } })
  assert.deepEqual(metrics.find((metric) => metric.event === 'turn')?.cost, { amounts: { USD: 0.5 } })

  loop.noteRecordAppended({
    id: 'sub-1',
    type: 'subagent_transcript',
    agentId: 'a1',
    subagentType: 'Explore',
    model: 'helper',
    usage: { inputTokens: 4, cacheReadInputTokens: 6, outputTokens: 2, cost: { amounts: { CNY: 1 } } },
    createdAt: new Date().toISOString(),
  } as SessionRecord)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(metrics.find((metric) => metric.event === 'subagent_usage'), {
    event: 'subagent_usage',
    model: 'helper',
    usage: { input_tokens: 4, cache_read_tokens: 6, response_tokens: 2, cost: { amounts: { CNY: 1 } } },
  })
})
