import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionRecord } from '../src/harness/types.js'
import { getSessionsDir } from '../src/utils/paths.js'
import { parseJsonLines } from '../src/utils/json.js'

/**
 * Unit tests for SessionStore extensions added in task 3.1:
 *   - truncateToMessage(sessionId, messageId)
 *   - getCheckpointMappings(sessionId)
 *   - addCheckpointMapping(sessionId, messageId, commitHash)
 *
 * Each test uses an isolated temp directory created with `mkdtemp` so tests
 * never interfere with the surrounding project or with each other. The temp
 * directory is passed as the `cwd` to `SessionStore`, which writes session
 * data under `<cwd>/.hanekawa/sessions/`.
 *
 * Validates: Requirements 6.1, 6.2, 6.4
 */

async function makeTempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'hanekawa-session-ext-'))
}

async function cleanup(dir: string): Promise<void> {
  // Restore permissions on any files we made read-only so the temp dir can
  // be removed cleanly on Linux/macOS.
  try {
    const sessionsDir = getSessionsDir(dir)
    await chmod(sessionsDir, 0o700)
  } catch {
    // Ignore â€?directory may not exist
  }
  await rm(dir, { recursive: true, force: true })
}

function makeMessageRecord(id: string, content: string, role: 'user' | 'assistant' = 'user'): SessionRecord {
  return {
    type: 'message',
    id,
    role,
    content,
    createdAt: new Date().toISOString(),
  }
}

test('truncateToMessage retains records up to and including the target message', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create('truncate test')

    // Append 5 message records: msg-0, msg-1, msg-2, msg-3, msg-4
    const records: SessionRecord[] = [
      makeMessageRecord('msg-0', 'first', 'user'),
      makeMessageRecord('msg-1', 'second', 'assistant'),
      makeMessageRecord('msg-2', 'third', 'user'),
      makeMessageRecord('msg-3', 'fourth', 'assistant'),
      makeMessageRecord('msg-4', 'fifth', 'user'),
    ]
    for (const r of records) {
      await store.appendRecord(session.id, r)
    }

    // Sanity check before truncation
    const before = await store.loadRecords(session.id)
    assert.equal(before.length, 5)

    // Truncate at msg-2 â€?should keep msg-0, msg-1, msg-2 (3 records)
    const result = await store.truncateToMessage(session.id, 'msg-2')
    assert.equal(result.success, true, `truncateToMessage should succeed, got error: ${result.error}`)
    assert.equal(result.error, undefined)

    const after = await store.loadRecords(session.id)
    assert.equal(after.length, 3)
    assert.deepEqual(
      after.map((r) => ('id' in r ? r.id : null)),
      ['msg-0', 'msg-1', 'msg-2'],
    )

    // Verify on-disk JSONL content matches expectations
    const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)
    const onDisk = await readFile(jsonlPath, 'utf8')
    const parsed = parseJsonLines<SessionRecord>(onDisk)
    assert.equal(parsed.length, 3)
    assert.equal(parsed[2] && 'id' in parsed[2] ? parsed[2].id : null, 'msg-2')

    // Index/messageCount should reflect truncation: 3 message records remain
    const meta = await store.load(session.id)
    assert.ok(meta)
    assert.equal(meta!.messageCount, 3)
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage retains only the first record when target is the first message', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, makeMessageRecord('only', 'first message'))
    await store.appendRecord(session.id, makeMessageRecord('second', 'second message', 'assistant'))
    await store.appendRecord(session.id, makeMessageRecord('third', 'third message'))

    const result = await store.truncateToMessage(session.id, 'only')
    assert.equal(result.success, true)

    const records = await store.loadRecords(session.id)
    assert.equal(records.length, 1)
    assert.equal('id' in records[0]! ? records[0]!.id : null, 'only')
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage keeps all records when the target is the last message', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, makeMessageRecord('a', 'a'))
    await store.appendRecord(session.id, makeMessageRecord('b', 'b', 'assistant'))
    await store.appendRecord(session.id, makeMessageRecord('c', 'c'))

    const result = await store.truncateToMessage(session.id, 'c')
    assert.equal(result.success, true)

    const records = await store.loadRecords(session.id)
    assert.equal(records.length, 3)
    assert.deepEqual(
      records.map((r) => ('id' in r ? r.id : null)),
      ['a', 'b', 'c'],
    )
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage returns error when target message ID does not exist', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, makeMessageRecord('msg-1', 'hello'))
    await store.appendRecord(session.id, makeMessageRecord('msg-2', 'world', 'assistant'))

    const result = await store.truncateToMessage(session.id, 'nonexistent-id')
    assert.equal(result.success, false)
    assert.ok(result.error, 'error message should be present')
    assert.match(result.error!, /not found|nonexistent-id/i)

    // The original file should be unchanged.
    const records = await store.loadRecords(session.id)
    assert.equal(records.length, 2)
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage returns error when session JSONL file is missing', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    // Use a session ID that has never had any records written.
    const result = await store.truncateToMessage(
      '00000000-0000-4000-8000-000000000000',
      'msg-1',
    )
    assert.equal(result.success, false)
    assert.ok(result.error)
    assert.match(result.error!, /not found/i)
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage tolerates malformed JSONL lines and skips them when scanning', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    const sessionsDir = getSessionsDir(cwd)
    const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`)

    // Write a JSONL file containing a corrupt line interleaved with valid records.
    const valid1 = JSON.stringify(makeMessageRecord('msg-1', 'one'))
    const corrupt = '{not valid json'
    const valid2 = JSON.stringify(makeMessageRecord('msg-2', 'two', 'assistant'))
    const valid3 = JSON.stringify(makeMessageRecord('msg-3', 'three'))
    await writeFile(jsonlPath, `${valid1}\n${corrupt}\n${valid2}\n${valid3}\n`, 'utf8')

    const result = await store.truncateToMessage(session.id, 'msg-2')
    assert.equal(result.success, true)

    // After truncation, file should contain valid1, corrupt, valid2 lines.
    const remaining = await readFile(jsonlPath, 'utf8')
    const remainingLines = remaining.split('\n').filter((l) => l.length > 0)
    assert.equal(remainingLines.length, 3)
    assert.equal(remainingLines[0], valid1)
    assert.equal(remainingLines[1], corrupt)
    assert.equal(remainingLines[2], valid2)
  } finally {
    await cleanup(cwd)
  }
})

test('getCheckpointMappings returns an empty array when no checkpoints exist', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create('empty-checkpoints test')

    const mappings = await store.getCheckpointMappings(session.id)
    assert.deepEqual(mappings, [])
  } finally {
    await cleanup(cwd)
  }
})

test('getCheckpointMappings returns an empty array when session metadata file is missing', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    // Use a session ID that was never created.
    const mappings = await store.getCheckpointMappings('11111111-1111-4111-8111-111111111111')
    assert.deepEqual(mappings, [])
  } finally {
    await cleanup(cwd)
  }
})

test('getCheckpointMappings reads stored checkpoint entries from session metadata', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create('with-checkpoints test')

    await store.addCheckpointMapping(session.id, 'msg-1', 'a1b2c3d4e5f6')
    await store.addCheckpointMapping(session.id, 'msg-2', 'f6e5d4c3b2a1')

    const mappings = await store.getCheckpointMappings(session.id)
    assert.equal(mappings.length, 2)

    const byId = new Map(mappings.map((m) => [m.messageId, m]))
    assert.equal(byId.get('msg-1')?.commitHash, 'a1b2c3d4e5f6')
    assert.equal(byId.get('msg-2')?.commitHash, 'f6e5d4c3b2a1')

    // Each mapping should have a valid ISO 8601 createdAt timestamp.
    for (const m of mappings) {
      assert.ok(m.createdAt, 'createdAt should be set')
      assert.ok(!Number.isNaN(Date.parse(m.createdAt)), 'createdAt should be parseable as a date')
    }
  } finally {
    await cleanup(cwd)
  }
})

test('addCheckpointMapping appends new entries without removing previous ones', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create('append test')

    // Add three checkpoints in order.
    await store.addCheckpointMapping(session.id, 'msg-a', 'hash-a')
    await store.addCheckpointMapping(session.id, 'msg-b', 'hash-b')
    await store.addCheckpointMapping(session.id, 'msg-c', 'hash-c')

    const mappings = await store.getCheckpointMappings(session.id)
    assert.equal(mappings.length, 3)

    // Order of insertion should be preserved (append semantics).
    assert.equal(mappings[0]!.messageId, 'msg-a')
    assert.equal(mappings[0]!.commitHash, 'hash-a')
    assert.equal(mappings[1]!.messageId, 'msg-b')
    assert.equal(mappings[1]!.commitHash, 'hash-b')
    assert.equal(mappings[2]!.messageId, 'msg-c')
    assert.equal(mappings[2]!.commitHash, 'hash-c')
  } finally {
    await cleanup(cwd)
  }
})

test('addCheckpointMapping persists checkpoints to the session index on disk', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.addCheckpointMapping(session.id, 'msg-1', 'commit-hash-xyz')

    const indexPath = path.join(getSessionsDir(cwd), 'index.json')
    const raw = await readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw) as { sessions: Array<{ id: string; checkpoints?: { messageId: string; commitHash: string }[] }> }
    const indexed = parsed.sessions.find((item) => item.id === session.id)

    assert.ok(indexed?.checkpoints, 'checkpoints array should exist in index meta')
    assert.equal(indexed.checkpoints!.length, 1)
    assert.equal(indexed.checkpoints![0]!.messageId, 'msg-1')
    assert.equal(indexed.checkpoints![0]!.commitHash, 'commit-hash-xyz')
  } finally {
    await cleanup(cwd)
  }
})

test('concurrent session creates preserve every index entry', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.create(`session ${index}`)),
    )

    const sessions = await store.list()
    const indexedIds = new Set(sessions.map((session) => session.id))
    for (const session of created) {
      assert.ok(indexedIds.has(session.id), `missing session ${session.id}`)
    }
  } finally {
    await cleanup(cwd)
  }
})

test('concurrent appendRecord calls preserve messageCount metadata', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendRecord(session.id, makeMessageRecord(`msg-${index}`, `message ${index}`)),
      ),
    )

    const records = await store.loadRecords(session.id)
    const meta = await store.load(session.id)
    assert.equal(records.length, 20)
    assert.equal(meta?.messageCount, 20)
  } finally {
    await cleanup(cwd)
  }
})

test('concurrent addCheckpointMapping calls preserve every checkpoint', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.addCheckpointMapping(session.id, `msg-${index}`, `hash-${index}`),
      ),
    )

    const mappings = await store.getCheckpointMappings(session.id)
    assert.equal(mappings.length, 20)
    const messageIds = new Set(mappings.map((mapping) => mapping.messageId))
    for (let index = 0; index < 20; index++) {
      assert.ok(messageIds.has(`msg-${index}`), `missing checkpoint msg-${index}`)
    }
  } finally {
    await cleanup(cwd)
  }
})

test('loadRecordsWithDiagnostics reports malformed JSONL lines while returning valid records', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    const sessionsDir = getSessionsDir(cwd)
    const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`)
    await writeFile(jsonlPath, `${JSON.stringify(makeMessageRecord('msg-1', 'hello'))}\n{bad json\n`, 'utf8')

    const result = await store.loadRecordsWithDiagnostics(session.id)
    assert.equal(result.records.length, 1)
    const malformed = result.diagnostics.find((diagnostic) => diagnostic.code === 'malformed_jsonl')
    assert.ok(malformed)
    assert.equal(malformed.line, 2)
  } finally {
    await cleanup(cwd)
  }
})

test('loadRecordsWithDiagnostics leaves orphan tool records to request preparation repair', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    const sessionsDir = getSessionsDir(cwd)
    const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`)
    const orphan = {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Grep',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:00.000Z',
      turnId: 'turn-1',
    }
    await writeFile(jsonlPath, `${JSON.stringify(orphan)}\n`, 'utf8')

    const result = await store.loadRecordsWithDiagnostics(session.id)
    assert.equal(result.records.length, 1)
    assert.equal(result.diagnostics.length, 0)
  } finally {
    await cleanup(cwd)
  }
})

test('list rebuilds missing index metadata from JSONL', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, makeMessageRecord('msg-1', 'rebuilt title'))
    await rm(path.join(getSessionsDir(cwd), 'index.json'), { force: true })

    const sessions = await store.list()
    const rebuilt = sessions.find((item) => item.id === session.id)
    assert.ok(rebuilt)
    assert.equal(rebuilt!.messageCount, 1)
    assert.equal(rebuilt!.title, 'rebuilt title')
  } finally {
    await cleanup(cwd)
  }
})

test('legacy checkpoint sidecar is migrated into index lookup', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    const legacyPath = path.join(getSessionsDir(cwd), `${session.id}.json`)
    await writeFile(legacyPath, JSON.stringify({
      meta: {
        id: session.id,
        shortId: session.shortId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: 0,
        checkpoints: [{ messageId: 'msg-1', commitHash: 'hash-1', createdAt: '2026-05-19T00:00:00.000Z' }],
      },
      records: [],
    }), 'utf8')

    const mappings = await store.getCheckpointMappings(session.id)
    assert.equal(mappings.length, 1)
    assert.equal(mappings[0]?.commitHash, 'hash-1')

    const index = JSON.parse(await readFile(path.join(getSessionsDir(cwd), 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string; checkpoints?: Array<{ commitHash: string }> }>
    }
    assert.equal(index.sessions.find((item) => item.id === session.id)?.checkpoints?.[0]?.commitHash, 'hash-1')
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage removes checkpoint mappings after the retained history', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, makeMessageRecord('msg-1', 'one'))
    await store.addCheckpointMapping(session.id, 'msg-1', 'hash-1')
    await store.appendRecord(session.id, makeMessageRecord('msg-2', 'two'))
    await store.addCheckpointMapping(session.id, 'msg-2', 'hash-2')

    const result = await store.truncateToMessage(session.id, 'msg-1')
    assert.equal(result.success, true)

    const mappings = await store.getCheckpointMappings(session.id)
    assert.equal(mappings.length, 1)
    assert.equal(mappings[0]?.messageId, 'msg-1')
  } finally {
    await cleanup(cwd)
  }
})

test('truncateToMessage returns an error when the file system rejects the write', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, makeMessageRecord('msg-1', 'hello'))
    await store.appendRecord(session.id, makeMessageRecord('msg-2', 'world', 'assistant'))

    // Simulate a file-system error by replacing the JSONL file with a directory
    // of the same name. `writeFile` will fail with EISDIR, which truncateToMessage
    // catches and reports as an error result. This works on all platforms.
    const sessionsDir = getSessionsDir(cwd)
    const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`)

    // Read the original content so we can put it back as a directory blocker.
    const originalContent = await readFile(jsonlPath, 'utf8')

    // Remove the original JSONL file and replace it with a directory at the same path.
    await rm(jsonlPath, { force: true })
    await mkdir(jsonlPath)
    // Place a dummy file inside the directory so the path looks like a real
    // collision. `existsSync` returns true for both files and directories, so
    // truncateToMessage will pass its existence check and then fail on read.
    await writeFile(path.join(jsonlPath, 'placeholder.txt'), originalContent, 'utf8')

    const result = await store.truncateToMessage(session.id, 'msg-1')
    assert.equal(result.success, false)
    assert.ok(result.error, 'error message should be returned')
    assert.match(
      result.error!,
      /Failed to truncate session|EISDIR|illegal operation|directory/i,
      `unexpected error message: ${result.error}`,
    )
  } finally {
    await cleanup(cwd)
  }
})
