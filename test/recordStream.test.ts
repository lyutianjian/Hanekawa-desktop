import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRecordStream } from '../src/harness/recordStream.js'
import { SessionStore } from '../src/sessions/service.js'
import { JsonlRecordStream } from '../src/sessions/recordStream.js'
import type { SessionRecord } from '../src/harness/types.js'
import { getSessionsDir } from '../src/utils/paths.js'

function message(id: string, content: string): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  }
}

test('MemoryRecordStream appends records in order and returns defensive copies', async () => {
  const stream = new MemoryRecordStream()
  await stream.append(message('a', 'one'))
  await stream.append(message('b', 'two'))

  const firstLoad = await stream.load()
  firstLoad.pop()

  const secondLoad = await stream.load()
  assert.deepEqual(secondLoad.map((record) => record.id), ['a', 'b'])
})

test('MemoryRecordStream stores metrics separately from records', async () => {
  const stream = new MemoryRecordStream()
  await stream.appendMetric({ event: 'turn', model: 'fake', response_tokens: 1, cache_read_tokens: 0, cache_hit_rate: 0, tool_calls: 0, duration_ms: 1 })

  assert.equal((await stream.load()).length, 0)
  assert.equal((await stream.loadMetrics()).length, 1)
})

test('JsonlRecordStream delegates records and metrics to SessionStore', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-record-stream-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()
    const stream = new JsonlRecordStream(store, session.id)

    await stream.append(message('msg-1', 'hello'))
    await stream.appendMetric({ event: 'turn', model: 'fake', response_tokens: 1, cache_read_tokens: 0, cache_hit_rate: 0, tool_calls: 0, duration_ms: 1 })

    const loaded = await stream.loadWithDiagnostics()
    assert.equal(loaded.records.length, 1)
    assert.equal(loaded.records[0]?.id, 'msg-1')

    const metricsPath = path.join(getSessionsDir(dir), `${session.id}.metrics.jsonl`)
    const metrics = readFileSync(metricsPath, 'utf8').trim().split('\n')
    assert.equal(metrics.length, 2)
    assert.equal(JSON.parse(metrics[1] ?? '{}').event, 'session_cache_summary')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
