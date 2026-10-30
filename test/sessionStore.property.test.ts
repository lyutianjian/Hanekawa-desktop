import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import fc from 'fast-check'
import { SessionStore } from '../src/sessions/service.js'
import { getSessionsDir } from '../src/utils/paths.js'
import { parseJsonLines } from '../src/utils/json.js'
import type { SessionRecord } from '../src/harness/types.js'

/**
 * Feature: keyboard-shortcuts-control, Property 4: Session truncation correctness
 *
 * Validates: Requirements 6.1, 6.2
 *
 * For any JSONL session file containing N records and any valid position K (0-indexed),
 * after calling `truncateToMessage(sessionId, records[K].id)`:
 *   - the call succeeds
 *   - the on-disk JSONL file contains exactly the records at positions 0..K (inclusive)
 *   - subsequent loadRecords() returns exactly the records at positions 0..K
 *
 * Generators construct heterogeneous record arrays (mix of `message`, `tool_use`,
 * `tool_result`, `tool_approval`, `compact_boundary`) with globally unique IDs so that
 * the messageId argument unambiguously identifies a single line.
 */

async function makeTempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'hanekawa-session-prop-'))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Build a heterogeneous SessionRecord arbitrary that always carries a top-level `id`. */
function makeRecordArbitrary(id: string): fc.Arbitrary<SessionRecord> {
  const isoTimestamp = fc.constant(new Date().toISOString())

  // message record (user or assistant)
  const messageRec = fc.record({
    type: fc.constant('message' as const),
    id: fc.constant(id),
    role: fc.constantFrom('user' as const, 'assistant' as const, 'system' as const, 'tool' as const),
    content: fc.string({ maxLength: 64 }),
    createdAt: isoTimestamp,
  })

  // tool_use record
  const toolUseRec = fc.record({
    type: fc.constant('tool_use' as const),
    id: fc.constant(id),
    tool: fc.string({ minLength: 1, maxLength: 16 }),
    input: fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 16 })),
    riskLevel: fc.constantFrom('safe' as const, 'confirm' as const, 'dangerous' as const),
    createdAt: isoTimestamp,
  })

  // tool_result record
  const toolResultRec = fc.record({
    type: fc.constant('tool_result' as const),
    id: fc.constant(id),
    toolUseId: fc.string({ minLength: 1, maxLength: 16 }),
    tool: fc.string({ minLength: 1, maxLength: 16 }),
    ok: fc.boolean(),
    content: fc.string({ maxLength: 64 }),
    createdAt: isoTimestamp,
  })

  // compact_boundary record
  const compactRec = fc.record({
    type: fc.constant('compact_boundary' as const),
    id: fc.constant(id),
    summary: fc.string({ maxLength: 64 }),
    preTokens: fc.integer({ min: 0, max: 100_000 }),
    createdAt: isoTimestamp,
  })

  return fc.oneof(messageRec, toolUseRec, toolResultRec, compactRec) as fc.Arbitrary<SessionRecord>
}

/** Generate an array of N records with globally unique IDs (id-N where N is the index). */
const recordsAndIndexArb = fc
  .integer({ min: 1, max: 20 })
  .chain((n) => {
    const recordsArb = fc.tuple(
      ...Array.from({ length: n }, (_, i) => makeRecordArbitrary(`msg-${i}`)),
    ) as fc.Arbitrary<SessionRecord[]>
    return fc.tuple(recordsArb, fc.integer({ min: 0, max: n - 1 }))
  })

describe('SessionStore.truncateToMessage — Property 4: session truncation correctness', () => {
  it('after truncating at position K, the file and loadRecords contain exactly records 0..K', async () => {
    await fc.assert(
      fc.asyncProperty(recordsAndIndexArb, async ([records, k]) => {
        const cwd = await makeTempCwd()
        try {
          const store = new SessionStore(cwd)
          await store.init()
          const session = await store.create('property test')

          for (const rec of records) {
            await store.appendRecord(session.id, rec)
          }

          // Sanity: all records were written
          const before = await store.loadRecords(session.id)
          assert.equal(before.length, records.length)

          const targetId = `msg-${k}`
          const result = await store.truncateToMessage(session.id, targetId)
          assert.equal(result.success, true, `truncate failed: ${result.error}`)
          assert.equal(result.error, undefined)

          // 1) loadRecords returns exactly records 0..K
          const after = await store.loadRecords(session.id)
          assert.equal(after.length, k + 1, `expected ${k + 1} records, got ${after.length}`)
          const expectedIds = records.slice(0, k + 1).map((r) => r.id)
          const actualIds = after.map((r) => ('id' in r ? r.id : null))
          assert.deepEqual(actualIds, expectedIds)

          // 2) The on-disk JSONL file matches exactly: each retained line should
          //    parse to the original record at the same index.
          const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)
          const onDisk = await readFile(jsonlPath, 'utf8')
          const parsed = parseJsonLines<SessionRecord>(onDisk)
          assert.equal(parsed.length, k + 1)
          assert.deepEqual(
            parsed.map((r) => ('id' in r ? r.id : null)),
            expectedIds,
          )
        } finally {
          await cleanup(cwd)
        }
      }),
      { numRuns: 100 },
    )
  })
})
