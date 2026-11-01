import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { requestModel } from '../src/harness/requestUsage.js'
import { autoCompactIfNeeded, compactNow, resetAutoCompactFailureState } from '../src/harness/compact.js'
import { createAgentTool } from '../src/tools/AgentTool/AgentTool.js'
import { withPricing } from '../src/runtime/createRuntime.js'
import { addTokenUsage, EMPTY_TOKEN_USAGE, priceUsage, promptTokens } from '../src/harness/usage.js'
import type { ModelProvider, SessionRecord, TokenUsage, Tool } from '../src/harness/types.js'
import type { RequestUsage } from '../src/harness/metrics.js'
import { toMetricUsage } from '../src/harness/metrics.js'
import { SessionStore } from '../src/sessions/service.js'
import { JsonlRecordStream } from '../src/sessions/recordStream.js'

const usage = priceUsage({ inputTokens: 1000, cacheReadInputTokens: 0, outputTokens: 100 }, { inputPerMillionTokens: 1, outputPerMillionTokens: 2 })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const records: SessionRecord[] = ['old', 'new'].map((id) => ({ type: 'message', role: 'user', id, content: id, createdAt: '2026-11-01T00:00:00Z' }))
const read: Tool = { name: 'Read', description: 'read', inputSchema: z.object({}), riskLevel: 'safe', isReadOnly: true, execute: async () => ({ ok: true, content: 'ok' }) }

test('request settlements are priced for each attempt, and the final response is not counted twice', async () => {
  const provider = withPricing({ name: 'fake', createMessage: async (request) => {
    request.onUsage?.({ inputTokens: 1000, cacheReadInputTokens: 0, outputTokens: 10 })
    request.onUsage?.({ inputTokens: 2000, cacheReadInputTokens: 0, outputTokens: 20 })
    return { content: 'done', toolCalls: [], usage: { inputTokens: 2000, cacheReadInputTokens: 0, outputTokens: 20 } }
  } }, { inputPerMillionTokens: 2, outputPerMillionTokens: 3, currency: 'CNY' })
  const settled: TokenUsage[] = []
  const result = await requestModel(provider, { model: 'actual-model', cacheSource: 'agent:usage-test', messages: [] }, (usage, model) => {
    assert.equal(model, 'actual-model'); settled.push(usage)
  })
  assert.equal(settled.length, 2)
  assert.equal(result.usage.inputTokens, 3000)
  assert.ok(Math.abs(result.usage.cost!.amounts.CNY! - 0.00609) < 1e-12)
  assert.equal(result.response.usage!.inputTokens, 2000, 'context still describes the final request')
})

test('an older provider without settlement callbacks reports its response once', async () => {
  let calls = 0
  const result = await requestModel({ name: 'custom', createMessage: async () => ({ content: 'done', toolCalls: [], usage }) }, {
    model: 'custom', cacheSource: 'agent:usage-test', messages: [],
  }, () => { calls++ })
  assert.equal(calls, 1)
  assert.deepEqual(result.usage, usage)
})

test('failed compaction retains the successful empty shared-prefix request in its settlement', async () => {
  const settled: TokenUsage[] = []
  const key = 'usage-failed-compact'
  try {
    const result = await autoCompactIfNeeded({ records, model: 'main', tools: [], force: true, circuitKey: key,
      provider: { name: 'fake', createMessage: async () => { throw new Error('text fallback failed') } },
      summarizeWithSharedPrefix: async () => ({ content: '', usage }),
      onUsage: (usage, model) => { assert.equal(model, 'main'); settled.push(usage) },
      appendRecord: async () => {},
    })
    assert.equal(result.compacted, false)
    assert.deepEqual(settled, [usage])
    assert.deepEqual(result.usage, usage, 'the run result retains the spend too')
  } finally { resetAutoCompactFailureState(key) }
})

test('a completed compact request is accounted before cancellation blocks its summary', async () => {
  const ac = new AbortController()
  const settled: TokenUsage[] = []
  await assert.rejects(compactNow({ records, model: 'main', tools: [], signal: ac.signal,
    provider: { name: 'fake', createMessage: async () => { ac.abort(); return { content: 'summary', toolCalls: [], usage } } },
    onUsage: (usage) => { settled.push(usage) }, appendRecord: async () => assert.fail('cancelled summary must not land'),
  }), { name: 'AbortError' })
  assert.deepEqual(settled, [usage])
})

test('successful text fallback retains spend reported by a failed shared-prefix attempt', async () => {
  const settled: TokenUsage[] = []
  const result = await compactNow({ records, model: 'main', tools: [],
    summarizeWithSharedPrefix: async (_prompt, onUsage) => { onUsage?.(usage, 'main'); throw new Error('filtered summary') },
    provider: { name: 'fake', createMessage: async () => ({ content: 'fallback summary', toolCalls: [], usage }) },
    onUsage: (usage) => { settled.push(usage) }, appendRecord: async () => {},
  })
  assert.equal(result.compacted, true)
  assert.equal(settled.length, 2)
  assert.equal(result.usage.inputTokens, 2000)
  assert.equal(result.usage.outputTokens, 200)
})

test('a subagent reports completed spend before a later request fails', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-child-usage-'))
  try {
    let calls = 0
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create('parent')
    const settled: RequestUsage[] = []
    const provider: ModelProvider = { name: 'fake', createMessage: async () => {
      if (++calls === 1) return { content: '', toolCalls: [{ id: 'r1', name: 'Read', input: {} }], usage }
      throw new Error('later request failed')
    } }
    const agent = createAgentTool({ provider, model: 'child', tools: () => [read], cwd, permissionPrompt: async () => true,
      onUsage: (event, sessionId) => {
        assert.equal(sessionId, session.id)
        settled.push(event)
        store.appendSessionMetric(sessionId, { event: 'request_usage', source: 'subagent', model: event.model, usage: toMetricUsage(event.usage) })
      },
    })
    const result = await agent.execute({ task: 'audit', subagent_type: 'general' }, { cwd, sessionId: session.id, readFiles: new Set() })
    assert.equal(result.ok, false)
    assert.match(result.content, /later request failed/)
    assert.equal(calls, 2)
    assert.equal(settled.length, 1)
    assert.equal(settled[0]!.model, 'child')
    assert.deepEqual(settled[0]!.usage, usage)
    assert.deepEqual(store.loadSessionUsage(session.id)!.total, usage, 'reopening also retains the failed child spend')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a resolved session metric is committed before live observers can reopen it', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-usage-commit-'))
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create('accounting')
    const stream = new JsonlRecordStream(store, session.id)
    const pending = stream.appendMetric({ event: 'request_usage', source: 'foreground', model: 'main', usage: toMetricUsage(usage) })
    assert.deepEqual(store.loadSessionUsage(session.id)!.total, usage)
    await pending
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a child summary settling after completion still reports spend without duplicating its transcript', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-late-child-usage-'))
  try {
    let calls = 0
    let finish!: (response: Awaited<ReturnType<ModelProvider['createMessage']>>) => void
    const settled: RequestUsage[] = []
    const parentRecords: SessionRecord[] = []
    const provider: ModelProvider = { name: 'fake', createMessage: async () => ++calls === 1
      ? { content: '', toolCalls: [{ id: 'r1', name: 'Read', input: {} }], usage }
      : { content: 'done', toolCalls: [], usage } }
    const agent = createAgentTool({ provider, model: 'child', tools: () => [read], cwd, permissionPrompt: async () => true,
      compactModel: { model: 'summary', provider: { name: 'fake', createMessage: () => new Promise((resolve) => { finish = resolve }) } },
      onUsage: (event) => { settled.push(event) },
    })
    const result = await agent.execute({ task: 'audit', subagent_type: 'general' }, {
      cwd, sessionId: 'parent', readFiles: new Set(), appendRecord: async (record) => { parentRecords.push(record) },
    })
    assert.equal(result.ok, true)
    const transcript = parentRecords.find((record) => record.type === 'subagent_transcript')
    assert.ok(transcript?.type === 'subagent_transcript' && transcript.usageReported)
    assert.equal(settled.length, 2)
    finish({ content: 'summary', toolCalls: [], usage })
    await tick()
    const total = settled.reduce((total, event) => addTokenUsage(total, event.usage), EMPTY_TOKEN_USAGE)
    assert.equal(promptTokens(total) + total.outputTokens, 3300)
    assert.equal(settled[2]!.model, 'summary')
    assert.equal(settled[2]!.source, 'tool_summary')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
