import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentLoop } from '../src/harness/loop.js'
import { displayCacheSource } from '../src/harness/cacheBreakDetection.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PromptComposer } from '../src/prompts/composer.js'
import { SystemPromptSectionCache } from '../src/harness/sections.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { SessionController } from '../src/runtime/sessionController.js'
import { createRecordProxy } from '../src/runtime/bridges.js'
import { SessionStore } from '../src/sessions/service.js'
import { JsonlRecordStream } from '../src/sessions/recordStream.js'
import type { ModelProvider, SessionRecord, TokenUsage, Tool } from '../src/harness/types.js'
import type { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'

/**
 * The readout under the composer and a reopened session must agree.
 *
 * Every spend is reported as it lands — a foreground response, a compaction
 * summary, a subagent transcript, a side summary — and the same events are what
 * the metrics sidecar records. This drives the real loop, controller and store
 * so the two halves are checked against each other instead of each in
 * isolation.
 */
test('the live total equals what a reopened session reads back from the sidecar', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-accounting-'))
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create('accounting')
    const proxy = createRecordProxy()
    const stream = new JsonlRecordStream(store, session.id)
    let calls = 0
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        calls += 1
        return {
          content: `answer ${calls}`,
          toolCalls: [],
          usage: { inputTokens: 1_000 * calls, cacheReadInputTokens: 100 * calls, outputTokens: 10 },
        }
      },
    }
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner([], new PermissionGate(async () => true), {
        onRecord: async (record) => { await stream.append(record) },
      }),
      toolContext: { cwd, sessionId: session.id, readFiles: new Set() },
      recordStream: stream,
      onRequestUsage: (usage: TokenUsage) => proxy.onRequestUsage(usage),
      onAuxUsage: (usage: TokenUsage) => proxy.onAuxUsage(usage),
    })
    const controller = new SessionController({
      cwd,
      store,
      session,
      existingRecords: [],
      recordProxy: proxy,
      getSession: () => ({
        loop,
        modelKey: 'fake-model',
        modelConfig: { model: 'fake-model' },
        providerName: 'fake',
      }) as never,
      createFileHistoryService: () => ({
        init: async () => {},
        dispose: () => {},
        makeSnapshot: async () => {},
        trackEdit: async () => {},
      }) as unknown as FileHistoryService,
    })

    await controller.submit({ text: 'one' })
    await controller.submit({ text: 'two' })
    // A subagent that finishes while the session sits idle: the case a settle
    // at the end of a turn would never have seen.
    loop.noteRecordAppended({
      id: 'sub-1',
      type: 'subagent_transcript',
      agentId: 'a1',
      subagentType: 'Explore',
      model: 'helper',
      usage: { inputTokens: 7, cacheReadInputTokens: 3, outputTokens: 2 },
      createdAt: new Date().toISOString(),
    } as SessionRecord)
    await new Promise((resolve) => setImmediate(resolve))

    const live = controller.getSnapshot().usage.total
    const seeded = await store.loadSessionTotals(session.id)
    assert.ok(seeded)
    assert.deepEqual(
      [live.inputTokens, live.cacheCreationInputTokens ?? 0, live.cacheReadInputTokens, live.outputTokens],
      [seeded.inputTokens, seeded.cacheCreationInputTokens ?? 0, seeded.cacheReadInputTokens, seeded.outputTokens],
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a turn that aborts after compacting still counts the summary', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-accounting-'))
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create('aborting')
    const existing: SessionRecord[] = [
      {
        id: 'old-user',
        type: 'message',
        role: 'user',
        content: 'old context ' + 'x'.repeat(10_000),
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
    for (const record of existing) await store.appendRecord(session.id, record)

    const proxy = createRecordProxy()
    const stream = new JsonlRecordStream(store, session.id)
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage(request) {
        if (displayCacheSource(request.cacheSource!) === 'compact') {
          return {
            content: 'compact summary',
            toolCalls: [],
            usage: { inputTokens: 100, cacheReadInputTokens: 200, outputTokens: 300 },
          }
        }
        throw new Error('provider exploded')
      },
    }
    const tools: Tool[] = []
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools,
      contextBuilder: new ContextBuilder(new PromptComposer(), {}, new SystemPromptSectionCache(), []),
      toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
        onRecord: async (record) => { await stream.append(record) },
      }),
      toolContext: { cwd, sessionId: session.id, readFiles: new Set() },
      contextWindow: 5000,
      contextManagement: { contextWindow: 5000, summaryOutputTokens: 0, autoCompactReserveRatio: 0.5 },
      recordStream: stream,
      onRequestUsage: (usage: TokenUsage) => proxy.onRequestUsage(usage),
      onAuxUsage: (usage: TokenUsage) => proxy.onAuxUsage(usage),
    })
    const controller = new SessionController({
      cwd,
      store,
      session,
      existingRecords: existing,
      recordProxy: proxy,
      getSession: () => ({
        loop,
        modelKey: 'fake-model',
        modelConfig: { model: 'fake-model' },
        providerName: 'fake',
      }) as never,
      createFileHistoryService: () => ({
        init: async () => {},
        dispose: () => {},
        makeSnapshot: async () => {},
        trackEdit: async () => {},
      }) as unknown as FileHistoryService,
    })

    await controller.submit({ text: 'continue' })

    // The turn never finished, but the compaction request was sent and billed.
    assert.deepEqual(controller.getSnapshot().usage.total, {
      inputTokens: 100,
      cacheReadInputTokens: 200,
      outputTokens: 300,
    })
    const seeded = await store.loadSessionTotals(session.id)
    assert.ok(seeded)
    assert.deepEqual(
      [seeded.inputTokens, seeded.cacheReadInputTokens, seeded.outputTokens],
      [100, 200, 300],
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
