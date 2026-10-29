import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { AgentLoop, type AgentLoopOptions } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { ModelProvider, PersistedQueuedMessage, SessionRecord, SteerSource, Tool } from '../src/harness/types.js'

function recordStreamFor(records: SessionRecord[]): RecordStream {
  return {
    load: async () => records,
    append: async (record) => { records.push(record) },
  }
}

function queued(id: string, content: string): PersistedQueuedMessage {
  return { id, content, priority: 'next', createdAt: new Date().toISOString() }
}

function steerFrom(pending: PersistedQueuedMessage[]): SteerSource {
  return {
    pending: () => [...pending],
    consume: async (messageId) => {
      const index = pending.findIndex((message) => message.id === messageId)
      if (index >= 0) pending.splice(index, 1)
    },
  }
}

function loopFor(
  provider: ModelProvider,
  records: SessionRecord[],
  steer: SteerSource,
  onTool: () => void,
  extra: Partial<AgentLoopOptions> = {},
) {
  const tool: Tool = {
    name: 'noop',
    description: 'noop',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      onTool()
      return { ok: true, content: 'ok' }
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })
  return new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [tool],
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    steer,
    ...extra,
  })
}

function userTexts(records: readonly SessionRecord[]): string[] {
  return records.flatMap((record) => record.type === 'message' && record.role === 'user' ? [record.content] : [])
}

test('an unmatched slash message still resolves its file mentions', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'slash-mention-'))
  await writeFile(path.join(cwd, 'notes.txt'), 'file mention content', 'utf8')
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() { return { content: 'done', toolCalls: [] } },
  }
  await loopFor(provider, records, steerFrom([]), () => {}, {
    toolContext: { cwd, sessionId: 's1', readFiles: new Set() },
  }).run({ text: '/inspect @notes.txt' })
  assert.deepEqual(userTexts(records), ['/inspect @notes.txt'])
  assert.ok(records.some((record) => record.type === 'at_mention_context'))
})

test('a message sent mid-turn joins the turn at the next step', async () => {
  const records: SessionRecord[] = []
  const pending: PersistedQueuedMessage[] = []
  const requests: string[] = []
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      calls += 1
      requests.push(JSON.stringify(request.messages))
      if (calls === 1) return { content: '', toolCalls: [{ id: 'noop-1', name: 'noop', input: {} }] }
      return { content: 'done', toolCalls: [] }
    },
  }

  await loopFor(provider, records, steerFrom(pending), () => {
    pending.push(queued('q1', 'also check the tests'), queued('q2', '  /tmp/notes\n请检查  '), queued('q3', 'and the docs'))
  }).run({ text: 'fix the bug' })

  assert.equal(calls, 2)
  assert.deepEqual(userTexts(records), ['fix the bug', 'also check the tests', '  /tmp/notes\n请检查  ', 'and the docs'])
  const steered = records.find((record) => record.type === 'message' && record.content === 'also check the tests')
  assert.equal(steered?.type === 'message' && steered.sourceQueuedMessageId, 'q1')
  // After the tool result, within the same turn.
  assert.ok(records.findIndex((record) => record.type === 'tool_result') < records.indexOf(steered!))
  assert.equal(steered?.type === 'message' && steered.turnId, records[0]?.type === 'message' ? records[0].turnId : undefined)
  assert.ok(requests[1]?.includes('also check the tests'))
  assert.ok(!requests[0]?.includes('also check the tests'))
  assert.ok(requests[1]?.includes('/tmp/notes'))
  assert.deepEqual(pending, [])
})

test('the queued message a turn started from is not steered into it again', async () => {
  const records: SessionRecord[] = []
  const pending = [queued('head', 'fix the bug'), queued('next', 'use the new API')]
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }

  await loopFor(provider, records, steerFrom(pending), () => {})
    .run({ text: 'fix the bug' }, undefined, undefined, { sourceQueuedMessageId: 'head' })

  assert.deepEqual(userTexts(records), ['fix the bug', 'use the new API'])
  assert.deepEqual(pending.map((message) => message.id), ['head'])
})

test('a coordinator message is steered only into a coordinator-driven turn', async () => {
  for (const origin of ['user', 'coordinator'] as const) {
    const records: SessionRecord[] = []
    const pending: PersistedQueuedMessage[] = []
    let calls = 0
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        calls += 1
        if (calls === 1) return { content: '', toolCalls: [{ id: 'noop-1', name: 'noop', input: {} }] }
        return { content: 'done', toolCalls: [] }
      },
    }
    await loopFor(provider, records, steerFrom(pending), () => {
      pending.push({ ...queued('c1', 'from coordinator'), origin: 'coordinator' })
    }).run({ text: 'go' }, undefined, undefined, { origin })
    if (origin === 'user') {
      assert.deepEqual(userTexts(records), ['go'])
      assert.deepEqual(pending.map((message) => message.id), ['c1'])
    } else {
      assert.deepEqual(userTexts(records), ['go', 'from coordinator'])
      assert.deepEqual(pending, [])
    }
  }
})

test('a coordination update taken mid-turn lands after the tool results, and survives a failed ack', async () => {
  const records: SessionRecord[] = []
  const requests: string[] = []
  let pendingUpdate: string | undefined
  let acks = 0
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      calls += 1
      requests.push(JSON.stringify(request.messages))
      if (calls === 1) return { content: '', toolCalls: [{ id: 'noop-1', name: 'noop', input: {} }] }
      return { content: 'done', toolCalls: [] }
    },
  }

  await loopFor(provider, records, steerFrom([]), () => { pendingUpdate = 'thread t1 finished' }, {
    consumeCoordinationUpdate: async () => {
      if (!pendingUpdate) return undefined
      const content = pendingUpdate
      return {
        content,
        ack: async () => {
          acks += 1
          throw new Error('store unavailable')
        },
      }
    },
  }).run({ text: 'coordinate' })

  assert.equal(calls, 2)
  assert.equal(acks, 1)
  const update = records.find((record) => record.type === 'coordination_update')
  assert.ok(update && update.type === 'coordination_update')
  assert.equal(update.content, 'thread t1 finished')
  assert.equal(update.turnId, records[0]?.type === 'message' ? records[0].turnId : undefined)
  assert.ok(records.findIndex((record) => record.type === 'tool_result') < records.indexOf(update))
  assert.ok(requests[1]?.includes('thread t1 finished'))
  assert.ok(!requests[0]?.includes('thread t1 finished'))
})

test('a failing coordination hook does not fail the turn', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'done', toolCalls: [] }
    },
  }
  const result = await loopFor(provider, records, steerFrom([]), () => {}, {
    consumeCoordinationUpdate: async () => { throw new Error('boom') },
  }).run({ text: 'hi' })
  assert.equal(result.content, 'done')
  assert.ok(!records.some((record) => record.type === 'coordination_update'))
})

test('a memory index change joins the turn at the next step boundary', async () => {
  const records: SessionRecord[] = []
  const requests: string[] = []
  let pending: string | undefined
  let calls = 0
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      calls += 1
      requests.push(JSON.stringify(request.messages))
      if (calls === 1) return { content: '', toolCalls: [{ id: 'noop-1', name: 'noop', input: {} }] }
      return { content: 'done', toolCalls: [] }
    },
  }

  await loopFor(provider, records, steerFrom([]), () => { pending = 'MEMORY.md changed: Added: - [B](b.md)' }, {
    memoryIndexWatch: {
      take: () => { const content = pending; pending = undefined; return content },
      takeSinceOpening: () => undefined,
      noteWrite: () => {},
    },
  }).run({ text: 'hi' })

  const update = records.find((record) => record.type === 'memory_update')
  assert.ok(update && update.type === 'memory_update')
  assert.ok(records.findIndex((record) => record.type === 'tool_result') < records.indexOf(update))
  assert.ok(requests[1]?.includes('Added: - [B](b.md)'))
  assert.ok(!requests[0]?.includes('Added: - [B](b.md)'))
  assert.equal(records.filter((record) => record.type === 'memory_update').length, 1)
})
