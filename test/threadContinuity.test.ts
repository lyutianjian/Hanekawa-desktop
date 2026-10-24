import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { z } from 'zod/v3'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { AgentLoop } from '../src/harness/loop.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { autoCompactIfNeeded, resetAutoCompactFailureState } from '../src/harness/compact.js'
import { wrapInSystemReminder } from '../src/harness/systemReminder.js'
import { formatThreadTaskRestore } from '../src/runtime/coordination/messages.js'
import type { RecordStream } from '../src/harness/recordStream.js'
import type { CompactBoundaryRecord, ModelProvider, ModelRequest, SessionRecord, Tool } from '../src/harness/types.js'

type ContinuationBoundary = CompactBoundaryRecord & {
  continuation?: { lastInstruction?: { text: string; recordId: string } }
}
type BoundaryWithRestore = CompactBoundaryRecord & { restoredContinuity?: string; restoredFiles?: string }
const asRecord = (record: object): SessionRecord => record as unknown as SessionRecord

/**
 * Regressions for the thread-continuity plan (T04/T05): a compaction summary and
 * the task it continues are load-bearing context, not the oldest ordinary
 * message to drop when the request is over budget.
 */

const at = '2026-10-24T10:00:00.000Z'
const contextWindow = (contextWindow: number) => ({ contextWindow, summaryOutputTokens: 0 })

test('the latest compact summary survives budget pressure instead of the oldest history', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(4_500))
  const records: SessionRecord[] = [
    { type: 'compact_boundary', id: 'compact-1', summary: 'SUMMARY-KEEP '.repeat(70), preTokens: 900, createdAt: at },
    { type: 'message', id: 'old', role: 'user', content: 'OLD-DETAIL '.repeat(600), createdAt: at },
    { type: 'message', id: 'new', role: 'user', content: 'continue', createdAt: at },
  ]

  const built = await builder.build({ records, tools: [], includeUserContext: false })
  const ids = built.contextItems.map((item) => (item.kind === 'message' ? item.message.id : item.tool))

  assert.ok(ids.includes('compact-1'), `the summary was dropped: ${ids.join(', ')}`)
  assert.ok(ids.includes('new'), 'the newest user message survives')
  assert.ok(!ids.includes('old'), 'the trimmable history gives way to the summary')
})

test('the post-compact continuity is protected while the restored files are trimmable', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(4_500))
  const records: SessionRecord[] = [
    asRecord({
      type: 'compact_boundary',
      id: 'compact-1',
      summary: 'SUMMARY',
      preTokens: 900,
      postCompactRestore: 'consumed',
      restoredContinuity: 'TASK-KEEP '.repeat(60),
      restoredFiles: 'FILE-DROP '.repeat(900),
      createdAt: at,
    } satisfies BoundaryWithRestore),
    { type: 'message', id: 'new', role: 'user', content: 'continue', createdAt: at },
  ]

  const built = await builder.build({ records, tools: [], includeUserContext: false })
  const contents = built.contextItems
    .filter((item) => item.kind === 'message')
    .map((item) => item.message.content)

  assert.ok(contents.some((content) => content.includes('SUMMARY')), 'the summary survives')
  assert.ok(contents.some((content) => content.includes('TASK-KEEP')), 'the task continuity survives')
  assert.ok(!contents.some((content) => content.includes('FILE-DROP')), 'the file restore is dropped first')
})

test('a compact boundary records the last real instruction it summarized', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    { type: 'message', id: 'old-user', role: 'user', content: 'old context '.repeat(200), createdAt: at },
    { type: 'message', id: 'old-assistant', role: 'assistant', content: 'old answer '.repeat(200), createdAt: at },
    {
      type: 'message',
      id: 'reminder',
      role: 'user',
      content: wrapInSystemReminder('THE LATEST ASTONISHINGLY IMPORTANT INTERNAL GEM'),
      createdAt: at,
    },
    { type: 'message', id: 'instruction', role: 'user', content: 'LATEST-REAL-INSTRUCTION', createdAt: at },
  ]
  const appended: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'compact summary', toolCalls: [] }
    },
  }

  const result = await autoCompactIfNeeded({
    records,
    provider,
    model: 'fake-model',
    tools: [],
    contextManagement: contextWindow(2_550),
    appendRecord: async (record) => { appended.push(record) },
  })

  assert.equal(result.compacted, true)
  const boundary = appended[0] as ContinuationBoundary
  assert.equal(boundary.type, 'compact_boundary')
  assert.deepEqual(boundary.continuation?.lastInstruction, {
    text: 'LATEST-REAL-INSTRUCTION',
    recordId: 'instruction',
  })
})

function recordStreamFor(records: SessionRecord[]): RecordStream {
  return {
    load: async () => records,
    append: async (record) => { records.push(record) },
    update: async (recordId, update) => {
      const index = records.findIndex((record) => record.id === recordId)
      const record = records[index]
      if (record) records[index] = update(record)
    },
  }
}

const THREAD_RESTORE = async (input: { lastInstruction?: { text: string; recordId: string } }) => formatThreadTaskRestore({
  threadId: 'thr_000000000001',
  title: 'Continuity',
  brief: 'BRIEF-KEEP',
  background: 'BACKGROUND-KEEP',
  ...(input.lastInstruction ? { lastInstruction: input.lastInstruction } : {}),
})

/** A thread-shaped loop: tight window, its own task restore, no tools to call. */
function threadLoop(
  provider: ModelProvider,
  records: SessionRecord[],
): AgentLoop {
  const tools: Tool[] = []
  return new AgentLoop({
    provider,
    model: 'fake-model',
    contextWindow: 8_000,
    tools,
    contextBuilder: new ContextBuilder(undefined, { summaryOutputTokens: 0 }),
    toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: { cwd: os.tmpdir(), sessionId: 'continuity-test', readFiles: new Set() },
    recordStream: recordStreamFor(records),
    contextManagement: { summaryOutputTokens: 0 },
    taskRestore: THREAD_RESTORE,
  })
}

function pendingBoundary(id: string, summary: string, instruction: string): SessionRecord {
  return asRecord({
    type: 'compact_boundary',
    id,
    summary,
    preTokens: 10,
    postCompactRestore: 'pending',
    continuation: { lastInstruction: { text: instruction, recordId: `${id}-instruction` } },
    createdAt: at,
  } satisfies ContinuationBoundary)
}

const history = (id: string, chars: number): SessionRecord => ({
  type: 'message',
  id,
  role: 'user',
  content: 'HISTORY '.repeat(chars / 8),
  createdAt: at,
})

test('a thread picks its task back up after a compaction, latest instruction first', async () => {
  const records: SessionRecord[] = [
    pendingBoundary('boundary-1', 'SUMMARY-ONE', 'LATEST-INSTRUCTION'),
    history('old', 8_000),
  ]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'carrying on', toolCalls: [] }
    },
  }

  await threadLoop(provider, records).run({ text: 'carry on' })

  const sent = JSON.stringify(requests.at(-1)?.messages ?? [])
  assert.match(sent, /SUMMARY-ONE/)
  assert.match(sent, /BRIEF-KEEP/)
  assert.match(sent, /LATEST-INSTRUCTION/)
  const boundary = records.find((record) => record.id === 'boundary-1')
  assert.equal(boundary?.type === 'compact_boundary' ? boundary.postCompactRestore : undefined, 'consumed')
  assert.match(boundary?.type === 'compact_boundary' ? boundary.restoredContinuity ?? '' : '', /BRIEF-KEEP/)
  // The file bodies live in their own trimmable item, never welded to the task.
  assert.equal(boundary?.type === 'compact_boundary' ? boundary.restoredFiles : undefined, undefined)
})

test('a second compaction still restores the task and the newest summary', async () => {
  const records: SessionRecord[] = [
    pendingBoundary('boundary-1', 'SUMMARY-ONE', 'FIRST-INSTRUCTION'),
    history('old', 8_000),
  ]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      requests.push(request)
      return { content: 'carrying on', toolCalls: [] }
    },
  }
  await threadLoop(provider, records).run({ text: 'first follow-up' })
  records.push(pendingBoundary('boundary-2', 'SUMMARY-TWO', 'SECOND-INSTRUCTION'))
  records.push(history('older-still', 8_000))
  // A reopened session is a fresh loop over the same log, exactly as after a close.
  await threadLoop(provider, records).run({ text: 'second follow-up' })

  const sent = JSON.stringify(requests.at(-1)?.messages ?? [])
  assert.match(sent, /SUMMARY-TWO/)
  assert.match(sent, /BRIEF-KEEP/)
  assert.match(sent, /SECOND-INSTRUCTION/)
})

test('a failed automatic compaction still leaves the task and the summary in the request', async () => {
  resetAutoCompactFailureState()
  const records: SessionRecord[] = [
    pendingBoundary('boundary-1', 'SUMMARY-ONE', 'LATEST-INSTRUCTION'),
    history('old', 30_000),
  ]
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage(request) {
      if (request.cacheSource.startsWith('compact')) throw new Error('summary provider down')
      requests.push(request)
      return { content: 'carrying on', toolCalls: [] }
    },
  }

  await threadLoop(provider, records).run({ text: 'carry on' })

  assert.ok(records.some((record) => record.type === 'compact_attempt_failed'), 'the attempt was recorded')
  const sent = JSON.stringify(requests.at(-1)?.messages ?? [])
  assert.match(sent, /SUMMARY-ONE/)
  assert.match(sent, /BRIEF-KEEP/)
  assert.match(sent, /LATEST-INSTRUCTION/)
})