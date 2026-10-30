import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../src/sessions/service.js'
import { getSessionsDir } from '../src/utils/paths.js'
import { parseJsonLines } from '../src/utils/json.js'
import type { SessionRecord } from '../src/harness/types.js'

async function makeTempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'hanekawa-session-replace-'))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

function message(id: string, content: string, role: 'user' | 'assistant' = 'user'): SessionRecord {
  return {
    type: 'message',
    id,
    role,
    content,
    createdAt: '2026-06-01T00:00:00.000Z',
  }
}

test('replaceRecords rewrites JSONL, updates metadata, and filters checkpoints', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    await store.appendRecord(session.id, message('msg-1', 'first title'))
    await store.appendRecord(session.id, message('msg-2', 'assistant answer', 'assistant'))
    await store.appendRecord(session.id, message('msg-3', 'new title'))
    await store.addCheckpointMapping(session.id, 'msg-1', 'hash-1')
    await store.addCheckpointMapping(session.id, 'msg-3', 'hash-3')

    await store.replaceRecords(session.id, [
      message('msg-3', 'new title'),
      {
        type: 'compact_boundary',
        id: 'compact-1',
        summary: 'summary',
        preTokens: 10,
        createdAt: '2026-06-01T00:00:01.000Z',
      },
    ])

    const records = await store.loadRecords(session.id)
    assert.deepEqual(records.map((record) => 'id' in record ? record.id : null), ['msg-3', 'compact-1'])
    const meta = await store.load(session.id)
    assert.equal(meta?.messageCount, 1)
    assert.equal(meta?.title, 'new title')
    assert.deepEqual(meta?.checkpoints?.map((mapping) => mapping.messageId), ['msg-3'])

    const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)
    const onDisk = parseJsonLines<SessionRecord>(await readFile(jsonlPath, 'utf8'))
    assert.deepEqual(onDisk.map((record) => 'id' in record ? record.id : null), ['msg-3', 'compact-1'])
  } finally {
    await cleanup(cwd)
  }
})

test('replaceRecords accepts an empty record list', async () => {
  const cwd = await makeTempCwd()
  try {
    const store = new SessionStore(cwd)
    await store.init()
    const session = await store.create()
    await store.appendRecord(session.id, message('msg-1', 'first title'))
    await store.addCheckpointMapping(session.id, 'msg-1', 'hash-1')

    await store.replaceRecords(session.id, [])

    assert.deepEqual(await store.loadRecords(session.id), [])
    const meta = await store.load(session.id)
    assert.equal(meta?.messageCount, 0)
    assert.deepEqual(meta?.checkpoints, [])
    const jsonlPath = path.join(getSessionsDir(cwd), `${session.id}.jsonl`)
    assert.equal(await readFile(jsonlPath, 'utf8'), '')
  } finally {
    await cleanup(cwd)
  }
})
