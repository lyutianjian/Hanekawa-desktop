import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoCompactIfNeeded, COMPACT_FAILURE_LIMIT, compactNow, resetAutoCompactFailureState, summarizeRecordsForContinuation } from '../src/harness/compact.js'
import type { ModelProvider, SessionRecord } from '../src/harness/types.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

test('autoCompactIfNeeded writes compact boundary when threshold is exceeded', async () => {
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
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      assert.equal(request.tools?.length, 0)
      assert.match(request.messages[0]?.content ?? '', /old context/)
      // The boundary lands after the latest user message, so the summary must carry it.
      assert.match(request.messages[0]?.content ?? '', /latest request/)
      return {
        content: 'compact summary',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 1,
          inputTokens: 2,
          outputTokens: 3,
        },
      }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, true)
  assert.ok((result.metrics?.preTokens ?? 0) > 0)
  assert.ok((result.metrics?.postTokens ?? 0) > 0)
  assert.equal(typeof result.metrics?.compactDurationMs, 'number')
  assert.deepEqual(result.usage, {
    cacheReadInputTokens: 1,
    inputTokens: 2,
    outputTokens: 3,
  })
  assert.equal(appended.length, 1)
  assert.equal(appended[0]?.type, 'compact_boundary')
  assert.equal(appended[0]?.type === 'compact_boundary' ? appended[0].summary : '', 'compact summary')
  assert.equal(appended[0]?.type === 'compact_boundary' ? appended[0].postCompactRestore : undefined, 'pending')
})

test('autoCompactIfNeeded uses configured compact model when provided', async () => {
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
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]
  let primaryCalled = false
  let compactModelSeen = ''
  const provider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      primaryCalled = true
      return { content: 'wrong', toolCalls: [] }
    },
  }
  const compactProvider: ModelProvider = {
    name: 'compact',
    async createMessage(request) {
      compactModelSeen = request.model
      return { content: 'compact summary', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'primary-model',
    compactRuntime: {
      provider: compactProvider,
      model: 'cheap-model',
      modelKey: 'cheap',
      providerName: 'compact',
    },
    tools: [],
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, true)
  assert.equal(primaryCalled, false)
  assert.equal(compactModelSeen, 'cheap-model')
})

test('autoCompactIfNeeded skips compacting below threshold', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'user',
    role: 'user',
    content: 'short',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  let called = false
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return { content: '', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: {
      contextWindow: 10_000,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, false)
  assert.equal(called, false)
})

test('autoCompactIfNeeded prefers last model usage token count over rough estimates', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'user',
    role: 'user',
    content: 'short',
    createdAt: '2026-05-10T00:00:00.000Z',
  }, {
    type: 'message',
    id: 'latest-user',
    role: 'user',
    content: 'latest request',
    createdAt: '2026-05-10T00:01:00.000Z',
  }]
  let called = false
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return {
        content: 'usage-triggered summary',
        toolCalls: [],
        usage: {
          cacheReadInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: {
      contextWindow: 600,
      summaryOutputTokens: 100,
      autoCompactBufferTokens: 50,
    },
    lastResponseTokenCount: 500,
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(called, true)
  assert.equal(result.compacted, true)
  assert.equal(appended[0]?.type, 'compact_boundary')
})

test('autoCompactIfNeeded adds pending records to last model usage token count', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
    {
      type: 'message',
      id: 'model-response',
      role: 'assistant',
      content: 'already counted by output usage '.repeat(500),
      createdAt: '2026-05-10T00:03:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'tool-result',
      toolUseId: 'tool-use',
      tool: 'Read',
      ok: true,
      content: 'pending tool output '.repeat(100),
      createdAt: '2026-05-10T00:04:00.000Z',
    },
  ]
  let called = false
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return { content: 'pending-triggered summary', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: compactTestBudget(),
    lastResponseTokenCount: 400,
    lastResponseRecordCount: 3,
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(called, true)
  assert.equal(result.compacted, true)
  assert.equal(appended[0]?.type, 'compact_boundary')
})

test('summarizeRecordsForContinuation formats supported record types', async () => {
  let requestContent = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requestContent = request.messages[0]?.content ?? ''
      return { content: 'rewind summary', toolCalls: [] }
    },
  }

  const result = await summarizeRecordsForContinuation({
    records: [
      {
        type: 'message',
        id: 'user-1',
        role: 'user',
        content: 'user goal',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        type: 'at_mention_context',
        id: 'ctx-1',
        userMessageId: 'user-1',
        files: [],
        content: 'attached file context',
        createdAt: '2026-06-01T00:00:01.000Z',
      },
      {
        type: 'tool_use',
        id: 'tool-1',
        tool: 'Read',
        input: { filePath: 'src/a.ts' },
        riskLevel: 'safe',
        createdAt: '2026-06-01T00:00:02.000Z',
      },
      {
        type: 'tool_result',
        id: 'result-1',
        toolUseId: 'tool-1',
        tool: 'Read',
        ok: true,
        content: 'file body',
        createdAt: '2026-06-01T00:00:03.000Z',
      },
      {
        type: 'tool_approval',
        id: 'approval-1',
        tool: 'Bash',
        input: { command: 'git status' },
        approved: true,
        riskLevel: 'dangerous',
        createdAt: '2026-06-01T00:00:04.000Z',
      },
      {
        type: 'compact_boundary',
        id: 'compact-1',
        summary: 'prior summary',
        preTokens: 100,
        createdAt: '2026-06-01T00:00:05.000Z',
      },
    ],
    provider,
    model: 'fake-model',
    preTokens: 123,
  })

  assert.equal(result.content, 'rewind summary')
  assert.equal(result.preTokens, 123)
  assert.match(requestContent, /<pre_compact_tokens>123<\/pre_compact_tokens>/)
  assert.match(requestContent, /<message role="user">\nuser goal\n<\/message>/)
  assert.match(requestContent, /<at_mention_context user_message_id="user-1">/)
  assert.match(requestContent, /<tool_use name="Read" id="tool-1">/)
  assert.match(requestContent, /<tool_result name="Read" tool_use_id="tool-1" ok="true">/)
  assert.match(requestContent, /<tool_approval name="Bash" approved="true">/)
  assert.match(requestContent, /<compact_summary>\nprior summary\n<\/compact_summary>/)
})

test('summarizeRecordsForContinuation prefers compact runtime', async () => {
  let primaryCalled = false
  let compactModelSeen = ''
  const provider: ModelProvider = {
    name: 'primary',
    async createMessage() {
      primaryCalled = true
      return { content: 'wrong', toolCalls: [] }
    },
  }
  const compactProvider: ModelProvider = {
    name: 'compact',
    async createMessage(request) {
      compactModelSeen = request.model
      return { content: 'compact summary', toolCalls: [] }
    },
  }

  const result = await summarizeRecordsForContinuation({
    records: [{
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'summarize me',
      createdAt: '2026-06-01T00:00:00.000Z',
    }],
    provider,
    model: 'primary-model',
    compactRuntime: {
      provider: compactProvider,
      model: 'compact-model',
      promptCacheRetention: '24h',
    },
  })

  assert.equal(primaryCalled, false)
  assert.equal(compactModelSeen, 'compact-model')
  assert.equal(result.content, 'compact summary')
})

test('autoCompactIfNeeded uses last response record id when record count is stale', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'old context',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'old-assistant',
      role: 'assistant',
      content: 'old answer',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'tool_approval',
      id: 'approval-inserted-before-boundary',
      tool: 'Read',
      input: { file: 'example.ts' },
      approved: true,
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:01:30.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'already included in provider usage '.repeat(200),
      createdAt: '2026-05-10T00:02:00.000Z',
    },
    {
      type: 'message',
      id: 'model-response',
      role: 'assistant',
      content: 'already counted by output usage '.repeat(500),
      createdAt: '2026-05-10T00:03:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'tool-result',
      toolUseId: 'tool-use',
      tool: 'Read',
      ok: true,
      content: 'small pending output',
      _tokens: 5,
      createdAt: '2026-05-10T00:04:00.000Z',
    },
  ]
  let called = false
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      called = true
      return { content: 'should not compact', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: compactTestBudget(),
    lastResponseTokenCount: 440,
    lastResponseRecordCount: 3,
    lastResponseRecordId: 'latest-user',
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, false)
  assert.equal(called, false)
})

test('autoCompactIfNeeded records telemetry and degrades when summary fails', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      throw new Error('compact model unavailable')
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-failure-test',
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, false)
  assert.deepEqual(result.usage, {
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  })
  assert.equal(appended.length, 1)
  const telemetry = appended[0]
  assert.equal(telemetry?.type, 'compact_attempt_failed')
  assert.equal(telemetry?.type === 'compact_attempt_failed' ? telemetry.failureCount : 0, 1)
  assert.equal(telemetry?.type === 'compact_attempt_failed' ? telemetry.circuitOpen : true, false)
  assert.match(telemetry?.type === 'compact_attempt_failed' ? telemetry.error : '', /compact model unavailable/)
})

test('autoCompactIfNeeded ignores pre-compact hook failures', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let persistedFailureCount = 0
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: 'summary after hook failure', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-pre-hook-failure-test',
    getCompactFailureCount: async () => persistedFailureCount,
    setCompactFailureCount: async (count) => {
      persistedFailureCount = count
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
    onBeforeCompact: async () => {
      throw new Error('pre hook append failed')
    },
  })

  assert.equal(result.compacted, true)
  assert.equal(calls, 1)
  assert.equal(persistedFailureCount, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('autoCompactIfNeeded ignores post-compact hook failures after recording boundary', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let persistedFailureCount = 0
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: 'summary before hook failure', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-post-hook-failure-test',
    getCompactFailureCount: async () => persistedFailureCount,
    setCompactFailureCount: async (count) => {
      persistedFailureCount = count
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
    onAfterCompact: async () => {
      throw new Error('post hook append failed')
    },
  })

  assert.equal(result.compacted, true)
  assert.equal(calls, 1)
  assert.equal(persistedFailureCount, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 0)
  assert.equal(appended.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('autoCompactIfNeeded opens circuit after three consecutive summary failures', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      throw new Error(`compact failure ${calls}`)
    },
  }
  const baseInput = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-circuit-test',
    contextManagement: compactTestBudget(),
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  await autoCompactIfNeeded(baseInput)
  await autoCompactIfNeeded(baseInput)
  await autoCompactIfNeeded(baseInput)
  const afterOpen = await autoCompactIfNeeded(baseInput)

  assert.equal(afterOpen.compacted, false)
  assert.equal(calls, 3)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 3)
  const lastTelemetry = appended.at(-1)
  assert.equal(lastTelemetry?.type, 'compact_attempt_failed')
  assert.equal(lastTelemetry?.type === 'compact_attempt_failed' ? lastTelemetry.failureCount : 0, 3)
  assert.equal(lastTelemetry?.type === 'compact_attempt_failed' ? lastTelemetry.circuitOpen : false, true)
})

test('autoCompactIfNeeded honors persisted compact failure count', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: 'should not compact', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'persisted-compact-circuit-test',
    getCompactFailureCount: async () => 3,
    setCompactFailureCount: async () => {
      throw new Error('should not write when circuit is already open')
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, false)
  assert.equal(calls, 0)
  assert.equal(appended.length, 0)
})

test('autoCompactIfNeeded deduplicates concurrent runs for the same circuit key', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  let releaseSummary: (() => void) | undefined
  let markSummaryStarted: (() => void) | undefined
  const summaryStarted = new Promise<void>((resolve) => {
    markSummaryStarted = resolve
  })
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      markSummaryStarted?.()
      await new Promise<void>((release) => {
        releaseSummary = release
      })
      return { content: 'shared summary', toolCalls: [] }
    },
  }
  const input = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-dedup-test',
    contextManagement: compactTestBudget(),
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  const first = autoCompactIfNeeded(input)
  await summaryStarted
  const second = autoCompactIfNeeded(input)
  releaseSummary?.()
  const results = await Promise.all([first, second])

  assert.equal(results[0].compacted, true)
  assert.equal(results[1].compacted, true)
  assert.equal(calls, 1)
  assert.equal(appended.filter((record) => record.type === 'compact_boundary').length, 1)
})

test('autoCompactIfNeeded deduplicates concurrent failure count updates', async () => {
  resetAutoCompactFailureState()
  const records = compactableRecords()
  const appended: SessionRecord[] = []
  let calls = 0
  let persistedFailureCount = 0
  let releaseSummary: (() => void) | undefined
  let markSummaryStarted: (() => void) | undefined
  const summaryStarted = new Promise<void>((resolve) => {
    markSummaryStarted = resolve
  })
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      markSummaryStarted?.()
      await new Promise<void>((release) => {
        releaseSummary = release
      })
      throw new Error('shared failure')
    },
  }
  const input = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'compact-dedup-failure-test',
    getCompactFailureCount: async () => persistedFailureCount,
    setCompactFailureCount: async (count: number) => {
      persistedFailureCount = count
    },
    contextManagement: compactTestBudget(),
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  const first = autoCompactIfNeeded(input)
  await summaryStarted
  const second = autoCompactIfNeeded(input)
  releaseSummary?.()
  await Promise.all([first, second])

  assert.equal(calls, 1)
  assert.equal(persistedFailureCount, 1)
  assert.equal(appended.filter((record) => record.type === 'compact_attempt_failed').length, 1)
})

function compactableRecords(): SessionRecord[] {
  return [
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
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]
}

function compactTestBudget() {
  return {
    contextWindow: 600,
    summaryOutputTokens: 100,
    autoCompactBufferTokens: 50,
  }
}

test('formatCompactSummary strips analysis and formats summary section', async () => {
  const { formatCompactSummary } = await import('../src/prompts/compactPrompt.js')
  const input = '<analysis>thinking about the conversation...</analysis><summary>1. Primary Request:\nDo X\n\n2. Key Concepts:\n- TypeScript</summary>'
  const result = formatCompactSummary(input)
  assert.equal(result, 'Summary:\n1. Primary Request:\nDo X\n\n2. Key Concepts:\n- TypeScript')
})

test('formatCompactSummary handles missing tags gracefully', async () => {
  const { formatCompactSummary } = await import('../src/prompts/compactPrompt.js')
  const input = 'plain text summary without tags'
  const result = formatCompactSummary(input)
  assert.equal(result, 'plain text summary without tags')
})

test('formatCompactSummary handles partial tags', async () => {
  const { formatCompactSummary } = await import('../src/prompts/compactPrompt.js')
  const input = '<summary>1. Primary Request:\nDo X</summary>'
  const result = formatCompactSummary(input)
  assert.equal(result, 'Summary:\n1. Primary Request:\nDo X')
})

test('getCompactPrompt returns structured prompt with 9 sections', async () => {
  const { getCompactPrompt } = await import('../src/prompts/compactPrompt.js')
  const prompt = getCompactPrompt()
  assert.match(prompt, /create a detailed summary of the conversation/)
  assert.match(prompt, /Primary Request and Intent/)
  assert.match(prompt, /Key Technical Concepts/)
  assert.match(prompt, /Files and Code Sections/)
  assert.match(prompt, /Errors and fixes/)
  assert.match(prompt, /Problem Solving/)
  assert.match(prompt, /All user messages/)
  assert.match(prompt, /Pending Tasks/)
  assert.match(prompt, /Current Work/)
  assert.match(prompt, /Optional Next Step/)
  // The summarization request is built with `tools: []`, so the prompt says
  // nothing about tool use.
  assert.doesNotMatch(prompt, /Do NOT call any tools/)
  assert.doesNotMatch(prompt, /<analysis>/)
})

test('getCompactPrompt includes custom instructions when provided', async () => {
  const { getCompactPrompt } = await import('../src/prompts/compactPrompt.js')
  const prompt = getCompactPrompt('Focus on TypeScript code changes and remember error patterns.')
  assert.match(prompt, /Additional Instructions:/)
  assert.match(prompt, /Focus on TypeScript code changes and remember error patterns\./)
  // Custom instructions should appear after the base prompt
  const baseIdx = prompt.indexOf('Please provide your summary based on the conversation so far')
  const instructionsIdx = prompt.indexOf('Additional Instructions:')
  assert.ok(baseIdx < instructionsIdx, 'instructions should come after the base prompt')
})

test('getCompactPrompt omits instructions block when not provided', async () => {
  const { getCompactPrompt } = await import('../src/prompts/compactPrompt.js')
  const prompt = getCompactPrompt()
  assert.doesNotMatch(prompt, /Additional Instructions:/)
})

test('getCompactPrompt omits instructions block when empty string', async () => {
  const { getCompactPrompt } = await import('../src/prompts/compactPrompt.js')
  const prompt = getCompactPrompt('   ')
  assert.doesNotMatch(prompt, /Additional Instructions:/)
})

test('mergeHookInstructions merges user and hook instructions', async () => {
  const { mergeHookInstructions } = await import('../src/prompts/compactPrompt.js')
  assert.equal(mergeHookInstructions(undefined, undefined), undefined)
  assert.equal(mergeHookInstructions('user instructions', undefined), 'user instructions')
  assert.equal(mergeHookInstructions(undefined, 'hook output'), 'hook output')
  assert.equal(
    mergeHookInstructions('user instructions', 'hook output'),
    'user instructions\n\nhook output',
  )
})

test('summarizeRecordsForContinuation passes custom instructions to prompt', async () => {
  let requestContent = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requestContent = request.messages[0]?.content ?? ''
      return {
        content: '<summary>Summary content</summary>',
        toolCalls: [],
      }
    },
  }

  await summarizeRecordsForContinuation({
    records: [{
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'Build feature X',
      createdAt: '2026-06-01T00:00:00.000Z',
    }],
    provider,
    model: 'fake-model',
    compactInstructions: 'Always include file paths verbatim.',
  })

  assert.match(requestContent, /Additional Instructions:/)
  assert.match(requestContent, /Always include file paths verbatim\./)
})

test('summarizeRecordsForContinuation uses structured prompt and formats output', async () => {
  let requestContent = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requestContent = request.messages[0]?.content ?? ''
      return {
        content: '<analysis>analyzing...</analysis><summary>1. Primary Request:\nBuild feature X</summary>',
        toolCalls: [],
      }
    },
  }

  const result = await summarizeRecordsForContinuation({
    records: [{
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'Build feature X',
      createdAt: '2026-06-01T00:00:00.000Z',
    }],
    provider,
    model: 'fake-model',
  })

  // Prompt should contain structured instructions
  assert.match(requestContent, /Primary Request and Intent/)
  assert.match(requestContent, /create a detailed summary of the conversation/)
  // Output should have analysis stripped and summary formatted
  assert.equal(result.content, 'Summary:\n1. Primary Request:\nBuild feature X')
  assert.doesNotMatch(result.content, /analyzing/)
})

test('the summary request is text only: images become placeholders naming name, size and cache path', async () => {
  resetAutoCompactFailureState()
  const shot = makeImageAttachmentRef({ id: 'img-shot', name: 'shot.png', width: 800, height: 600 })
  const diagram = makeImageAttachmentRef({ id: 'img-diagram', name: 'diagram.png', width: 400, height: 300 })
  const latest = makeImageAttachmentRef({ id: 'img-latest', name: 'latest.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: `look at this ${'old context '.repeat(200)}`,
      images: [shot],
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'old-result',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: 'read an image',
      images: [diagram],
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'message',
      id: 'latest-user',
      role: 'user',
      content: 'latest request',
      images: [latest],
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]

  let seenPrompt = ''
  const provider: ModelProvider = {
    name: 'text-only-compact-model',
    async createMessage(request) {
      seenPrompt = request.messages[0]?.content ?? ''
      // A compact model does not have to see images (design §11.3).
      assert.equal(request.messages.every((message) => (message as { images?: unknown }).images === undefined), true)
      assert.equal(
        request.contextItems?.every((item) => item.kind !== 'message' || (item.message as { images?: unknown }).images === undefined),
        true,
      )
      return { content: 'compact summary', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'text-only-compact-model',
    tools: [],
    contextManagement: { contextWindow: 600, summaryOutputTokens: 100, autoCompactBufferTokens: 50 },
    attachmentFacts: {
      resolveAttachmentFacts: async (ref) => ({
        ok: true,
        facts: { originalWidth: 1600, originalHeight: 1200, localPath: `/cache/${ref.id}/original.png` },
      }),
    },
    appendRecord: async () => {},
  })

  assert.equal(result.compacted, true)
  assert.match(seenPrompt, /shot\.png, sent 800x600, original 1600x1200, cached at \/cache\/img-shot\/original\.png/)
  assert.match(seenPrompt, /diagram\.png, sent 400x300, original 1600x1200, cached at \/cache\/img-diagram\/original\.png/)
  assert.match(seenPrompt, /do not describe or infer what the image shows/)
  // The latest user message — text and image — goes into the summary too:
  // the boundary lands after it, so nothing else would carry it forward.
  assert.match(seenPrompt, /latest request/)
  assert.match(seenPrompt, /latest\.png/)
  // A pure projection: the records keep their refs for the request itself.
  assert.deepEqual(records[2] && 'images' in records[2] ? records[2].images : undefined, [latest])
  assert.deepEqual(records[0] && 'images' in records[0] ? records[0].images : undefined, [shot])
})

test('without an attachment resolver the summary placeholder still names the attachment', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old-user',
      role: 'user',
      content: 'see attached',
      images: [makeImageAttachmentRef({ id: 'img-a', name: 'a.png' })],
      createdAt: '2026-05-10T00:00:00.000Z',
    },
  ]
  let seenPrompt = ''
  const summary = await summarizeRecordsForContinuation({
    records,
    provider: {
      name: 'fake',
      async createMessage(request) {
        seenPrompt = request.messages[0]?.content ?? ''
        return { content: 'summary', toolCalls: [] }
      },
    },
    model: 'fake-model',
  })
  assert.equal(summary.content.length > 0, true)
  assert.match(seenPrompt, /a\.png, sent 64x64, cached in this session's attachment store \(attachment img-a\)/)
})


test('coordinator compact prompt variant is separate and forbids thread status', async () => {
  const { getCompactPrompt, getSharedPrefixCompactPrompt } = await import('../src/prompts/compactPrompt.js')
  const base = getCompactPrompt()
  const coord = getCompactPrompt('extra', 'coordinator')
  assert.notEqual(coord, base)
  assert.match(coord, /Do not record thread status/)
  assert.match(coord, /fresh board is restored after compaction/)
  assert.match(coord, /Questions Waiting on the User/)
  assert.match(coord, /Additional Instructions:\nextra/)
  assert.equal(getCompactPrompt(undefined, 'default'), base)
  assert.match(getSharedPrefixCompactPrompt(undefined, 'coordinator'), /Do not record thread status[\s\S]*Do not call any tools/)
})

test('force bypasses the threshold but not an open circuit breaker', async () => {
  resetAutoCompactFailureState()
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      calls += 1
      return { content: '<summary>forced</summary>', toolCalls: [] }
    },
  }
  const records = compactableRecords()
  const base = {
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: { ...compactTestBudget(), contextWindow: 10_000_000 },
    appendRecord: async () => {},
  }
  const unforced = await autoCompactIfNeeded({ ...base, circuitKey: 'force-a' })
  assert.equal(unforced.compacted, false)
  const forced = await autoCompactIfNeeded({ ...base, circuitKey: 'force-a', force: true })
  assert.equal(forced.compacted, true)
  const before = calls
  const blocked = await autoCompactIfNeeded({
    ...base,
    circuitKey: 'force-b',
    force: true,
    getCompactFailureCount: async () => COMPACT_FAILURE_LIMIT,
  })
  assert.equal(blocked.compacted, false)
  assert.equal(calls, before)
})

test('compactNow ignores the threshold and an open circuit, closes it on success and throws on failure', async () => {
  resetAutoCompactFailureState()
  let failNext = true
  const prompts: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      prompts.push(JSON.stringify(request.messages))
      if (failNext) throw new Error('summary failed')
      return { content: '<summary>manual</summary>', toolCalls: [] }
    },
  }
  const appended: SessionRecord[] = []
  const counts: number[] = []
  const base = {
    records: compactableRecords(),
    provider,
    model: 'fake-model',
    tools: [],
    circuitKey: 'manual',
    contextManagement: { ...compactTestBudget(), contextWindow: 10_000_000 },
    getCompactFailureCount: async () => COMPACT_FAILURE_LIMIT,
    setCompactFailureCount: async (count: number) => { counts.push(count) },
    appendRecord: async (record: SessionRecord) => { appended.push(record) },
  }

  await assert.rejects(compactNow(base), /summary failed/)
  assert.deepEqual(counts, [])
  assert.equal(appended.length, 0)

  failNext = false
  const result = await compactNow({ ...base, compactInstructions: 'keep the schema' })
  assert.equal(result.compacted, true)
  assert.ok(prompts.at(-1)?.includes('keep the schema'))
  assert.deepEqual(counts, [0])
  assert.equal(appended[0]?.type, 'compact_boundary')

  const nothingNew = await compactNow({ ...base, records: [...base.records, ...appended] })
  assert.equal(nothingNew.compacted, false)
})

test('compactPromptVariant reaches the request and coordination_update is summarized', async () => {
  let seen = ''
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(req) {
      seen = String(req.messages[0]?.content)
      return { content: '<summary>ok</summary>', toolCalls: [] }
    },
  }
  await summarizeRecordsForContinuation({
    records: [
      { id: 'u1', type: 'message', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      { id: 'c1', type: 'coordination_update', content: 'thread A finished', createdAt: new Date().toISOString() },
    ] as SessionRecord[],
    provider,
    model: 'fake-model',
    compactPromptVariant: 'coordinator',
  })
  assert.match(seen, /Do not record thread status/)
  assert.match(seen, /<coordination_update>\nthread A finished\n<\/coordination_update>/)
})
