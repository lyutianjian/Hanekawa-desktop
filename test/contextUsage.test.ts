import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SessionController } from '../src/runtime/sessionController.js'
import { createRecordProxy } from '../src/runtime/bridges.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionRecord } from '../src/harness/types.js'
import type { AgentSession } from '../src/runtime/types.js'
import type { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'

/**
 * The context readout: last request's `promptTokens` plus an estimate of every
 * record appended since. One number, on the controller snapshot, so the TUI
 * status line and the desktop strip cannot drift apart.
 */

async function createHarness(existingRecords: readonly SessionRecord[] = [], system?: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-context-usage-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('context usage')

  const fileHistoryService = {
    init: async () => {},
    dispose: () => {},
    makeSnapshot: async () => {},
    trackEdit: async () => {},
  } as unknown as FileHistoryService

  const proxy = createRecordProxy()
  const controller = new SessionController({
    cwd,
    store,
    session,
    existingRecords,
    recordProxy: proxy,
    getSession: () => ({
      loop: {
        invalidateRecordsCache: () => {},
        describeContextSources: async () => ({ system: system ?? '', loadedTools: [], deferredTools: [] }),
      },
    } as unknown as AgentSession),
    createFileHistoryService: () => fileHistoryService,
  })
  await new Promise((resolve) => setImmediate(resolve))
  return { controller, proxy, store, session }
}

function toolResult(id: string, size: number): SessionRecord {
  return {
    id,
    type: 'tool_result',
    toolUseId: `use-${id}`,
    tool: 'Read',
    ok: true,
    content: 'x'.repeat(size),
    createdAt: new Date().toISOString(),
  }
}

const used = (controller: SessionController) => controller.getSnapshot().contextUsedTokens

test('the readout grows with records appended after the anchored request', async () => {
  const { controller, proxy } = await createHarness()

  proxy.onRecord(toolResult('r1', 100))
  proxy.onRequestUsage({ inputTokens: 1_000, cacheReadInputTokens: 99_000, outputTokens: 500 }, 'r1')

  // Input plus cache-read is what the model was sent; the output it answered
  // with is not part of the context the next request carries.
  const anchored = used(controller)
  assert.equal(anchored, 100_000)

  proxy.onRecord(toolResult('r2', 40_000))
  proxy.onRecord(toolResult('r3', 40_000))
  const grown = used(controller) ?? 0
  assert.ok(grown > 100_000, `expected growth past the request's own count, got ${grown}`)
  // The tool results are the only thing added, so the growth is their estimate
  // — a generous band, since the estimator's chars-per-token is its own business.
  assert.ok(grown < 140_000, `expected the growth to be the two results, got ${grown}`)
})

test('a missing anchor falls back to estimating the whole transcript', async () => {
  const { controller, proxy } = await createHarness()

  proxy.onRecord(toolResult('r1', 40_000))
  // A rewind or a compaction can take the anchor out of the transcript; the
  // readout must survive it rather than adding an estimate to a stale base.
  proxy.onRequestUsage({ inputTokens: 1_000, cacheReadInputTokens: 99_000, outputTokens: 0 }, 'gone')

  const fallback = used(controller) ?? 0
  assert.ok(fallback > 0, 'a fallback estimate is still a number')
  assert.ok(fallback < 100_000, `the stale request count must not survive, got ${fallback}`)
})

test('before the first request the readout is the transcript estimate', async () => {
  const { controller, proxy } = await createHarness()
  assert.equal(used(controller), undefined, 'an empty session reports nothing')

  proxy.onRecord(toolResult('r1', 40_000))
  const estimated = used(controller) ?? 0
  assert.ok(estimated > 0, 'a resumed session reports something before its first turn')
})

test('the readout drops back after the transcript is replaced', async () => {
  const { controller, proxy, store, session } = await createHarness()

  proxy.onRecord(toolResult('r1', 40_000))
  proxy.onRequestUsage({ inputTokens: 1_000, cacheReadInputTokens: 99_000, outputTokens: 0 }, 'r1')
  proxy.onRecord(toolResult('r2', 80_000))
  const before = used(controller) ?? 0

  // What `/compact` and `/rewind` both do: the records on disk become the
  // transcript, and the anchor from the old one no longer applies.
  await store.appendRecord(session.id, toolResult('r9', 10))
  await controller.reload()

  const after = used(controller) ?? 0
  assert.ok(after < before, `expected the readout to fall, went ${before} -> ${after}`)
})

test('the anchorless estimate counts the system prompt and stops at the last compaction', async () => {
  const system = 'y'.repeat(40_000)
  const { controller, proxy } = await createHarness([], system)

  proxy.onRecord(toolResult('r1', 40_000))
  const withSystem = used(controller) ?? 0
  assert.ok(withSystem > 20_000, `the system prompt belongs in the estimate, got ${withSystem}`)

  proxy.onRecord({
    id: 'c1',
    type: 'compact_boundary',
    createdAt: new Date().toISOString(),
    summary: 'compacted',
    preTokens: 0,
    postTokens: 0,
  } as unknown as SessionRecord)
  const afterCompact = used(controller) ?? 0
  assert.ok(
    afterCompact < withSystem,
    `records before the boundary are gone from the request, got ${withSystem} -> ${afterCompact}`,
  )
})

test('a request anchored before a compaction no longer counts as the readout', async () => {
  const { controller, proxy } = await createHarness()

  proxy.onRecord(toolResult('r1', 100))
  proxy.onRequestUsage({ inputTokens: 1_000, cacheReadInputTokens: 199_000, outputTokens: 0 }, 'r1')
  proxy.onRecord({
    id: 'c1',
    type: 'compact_boundary',
    createdAt: new Date().toISOString(),
    summary: 'compacted',
    preTokens: 0,
    postTokens: 0,
  } as unknown as SessionRecord)
  const afterCompact = used(controller) ?? 0
  assert.ok(afterCompact < 1_000, `the pre-compaction count must not survive, got ${afterCompact}`)

  // The request sent right after compaction still ended on a pre-boundary record.
  proxy.onRequestUsage({ inputTokens: 1_000, cacheReadInputTokens: 199_500, outputTokens: 0 }, 'r1')
  assert.ok((used(controller) ?? 0) < 1_000)
})

test('a streaming response moves the readout before its records land', async () => {
  const { controller, proxy } = await createHarness()

  proxy.onRecord(toolResult('r1', 100))
  proxy.onRequestUsage({ inputTokens: 1_000, cacheReadInputTokens: 99_000, outputTokens: 0 }, 'r1')
  assert.equal(used(controller), 100_000)

  proxy.onStreamEvent({ type: 'message_start' })
  proxy.onStreamEvent({ type: 'tool_input_delta', partialJson: 'x'.repeat(9_000) })
  const streaming = used(controller) ?? 0
  assert.ok(streaming >= 102_900 && streaming <= 103_100, `the streamed input counts, got ${streaming}`)

  // Each record takes over its share of the stream: nothing dips, nothing is counted twice.
  proxy.onRecord({ id: 'a1', type: 'message', role: 'assistant', content: 'done', createdAt: new Date().toISOString() })
  const afterMessage = used(controller) ?? 0
  assert.ok(afterMessage >= 102_900, `the tool input is still pending, got ${afterMessage}`)
  proxy.onRecord({
    id: 'u1',
    type: 'tool_use',
    tool: 'Write',
    input: { content: 'x'.repeat(9_000) },
    createdAt: new Date().toISOString(),
  } as SessionRecord)
  const afterToolUse = used(controller) ?? 0
  assert.ok(afterToolUse >= 102_900 && afterToolUse <= 103_200, `counted once, got ${afterToolUse}`)
})
