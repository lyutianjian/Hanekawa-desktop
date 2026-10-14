import { mkdtemp, rm } from 'node:fs/promises'
import fs, { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore, deriveSessionTitle, type SessionMeta } from '../src/sessions/service.js'
import { rollbackInterruptedPromptIfSynthetic } from '../src/runtime/interruptRollback.js'
import type { SessionRecord } from '../src/harness/types.js'
import { getSessionsDir } from '../src/utils/paths.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

test('SessionStore creates, lists, resolves, renames, and deletes sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session1 = await store.create('First session')
    const session2 = await store.create('Second session')

    assert.ok(session1.id)
    assert.ok(session1.shortId)
    assert.ok(session2.id)
    assert.notEqual(session1.id, session2.id)

    const list = await store.list()
    assert.equal(list.length, 2)

    const loaded = await store.load(session1.id)
    assert.ok(loaded)
    assert.equal(loaded?.title, 'First session')

    const resolvedByPrefix = await store.resolve(session1.shortId)
    assert.equal(resolvedByPrefix?.id, session1.id)

    await store.rename(session1.id, 'Renamed session')
    const renamed = await store.load(session1.id)
    assert.equal(renamed?.title, 'Renamed session')

    await store.delete(session1.id)
    const listAfterDelete = await store.list()
    assert.equal(listAfterDelete.length, 1)
    assert.equal(listAfterDelete[0]?.id, session2.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore appends and loads records while updating metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const message: SessionRecord = {
      type: 'message',
      id: 'msg-1',
      role: 'user',
      content: 'Hello from session test',
      createdAt: new Date().toISOString(),
    }

    await store.appendRecord(session.id, message)

    const records = await store.loadRecords(session.id)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.type, 'message')

    const loaded = await store.load(session.id)
    assert.equal(loaded?.messageCount, 1)
    assert.equal(loaded?.title, 'Hello from session test')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore drafts stay in memory until the first chat message', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = store.createDraft()
    const sessionsDir = getSessionsDir(dir)
    const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`)
    const metricsPath = path.join(sessionsDir, `${session.id}.metrics.jsonl`)
    assert.equal((await store.list()).some((item) => item.id === session.id), false)
    assert.equal(fs.existsSync(jsonlPath), false)

    await store.appendRecord(session.id, {
      id: 'queue-clear',
      type: 'message_queue',
      operation: 'clear',
      createdAt: '2026-07-15T00:00:00.000Z',
    })
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: 'test',
      error: 'deferred metric',
    })
    assert.equal(fs.existsSync(jsonlPath), false)
    assert.equal(fs.existsSync(metricsPath), false)
    assert.equal((await store.loadRecords(session.id)).length, 1)

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'msg-1',
      role: 'user',
      content: 'Materialize me',
      createdAt: '2026-07-15T00:00:01.000Z',
    })

    assert.equal(fs.existsSync(jsonlPath), true)
    assert.equal(fs.existsSync(metricsPath), true)
    assert.deepEqual((await store.loadRecords(session.id)).map((record) => record.id), ['queue-clear', 'msg-1'])
    assert.equal((await store.load(session.id))?.title, 'Materialize me')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore discards drafts without creating session files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = store.createDraft()
    store.discardDraft(session.id)

    assert.equal(await store.load(session.id), undefined)
    assert.equal(fs.existsSync(path.join(getSessionsDir(dir), `${session.id}.jsonl`)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore derives title from displayContent when present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const message: SessionRecord = {
      type: 'message',
      id: 'msg-display',
      role: 'user',
      content: 'Expanded skill prompt that should stay hidden from title',
      displayContent: '/debug hello',
      createdAt: new Date().toISOString(),
    }

    await store.appendRecord(session.id, message)

    const loaded = await store.load(session.id)
    assert.equal(loaded?.title, '/debug hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore truncateBeforeMessage removes the target message and later records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const records: SessionRecord[] = [
      {
        type: 'message',
        id: 'msg-1',
        role: 'user',
        content: 'first',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        type: 'message',
        id: 'msg-2',
        role: 'assistant',
        content: 'second',
        createdAt: '2026-06-01T00:00:01.000Z',
      },
      {
        type: 'message',
        id: 'msg-3',
        role: 'user',
        content: 'third',
        createdAt: '2026-06-01T00:00:02.000Z',
      },
      {
        type: 'message',
        id: 'msg-4',
        role: 'assistant',
        content: 'fourth',
        createdAt: '2026-06-01T00:00:03.000Z',
      },
    ]
    for (const record of records) {
      await store.appendRecord(session.id, record)
    }
    await store.addCheckpointMapping(session.id, 'msg-1', 'commit-1')
    await store.addCheckpointMapping(session.id, 'msg-3', 'commit-3')

    const result = await store.truncateBeforeMessage(session.id, 'msg-3')
    assert.equal(result.success, true)

    const after = await store.loadRecords(session.id)
    assert.deepEqual(after.map((record) => 'id' in record ? record.id : null), ['msg-1', 'msg-2'])

    const meta = await store.load(session.id)
    assert.equal(meta?.messageCount, 2)
    assert.deepEqual(meta?.checkpoints?.map((mapping) => mapping.messageId), ['msg-1'])

    const jsonlPath = path.join(getSessionsDir(dir), `${session.id}.jsonl`)
    const onDisk = readFileSync(jsonlPath, 'utf-8').trim().split('\n')
    assert.equal(onDisk.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollbackInterruptedPromptIfSynthetic removes interrupted prompt bookkeeping only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'do work',
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    await store.appendRecord(session.id, {
      id: 'at-1',
      type: 'at_mention_context',
      userMessageId: 'user-1',
      files: [],
      content: '',
      createdAt: '2026-06-01T00:00:01.000Z',
    })
    await store.appendRecord(session.id, {
      id: 'interrupt-1',
      type: 'turn_interruption',
      userMessageId: 'user-1',
      prompt: 'do work',
      remainingTasks: [],
      recoverable: true,
      createdAt: '2026-06-01T00:00:02.000Z',
    })

    const restored = await rollbackInterruptedPromptIfSynthetic({
      store,
      sessionId: session.id,
      userMessageId: 'user-1',
    })

    assert.deepEqual(restored, [])
    assert.deepEqual(await store.loadRecords(session.id), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollbackInterruptedPromptIfSynthetic preserves meaningful assistant output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'do work',
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    await store.appendRecord(session.id, {
      type: 'message',
      id: 'assistant-1',
      role: 'assistant',
      content: 'partial answer',
      createdAt: '2026-06-01T00:00:01.000Z',
    })

    const restored = await rollbackInterruptedPromptIfSynthetic({
      store,
      sessionId: session.id,
      userMessageId: 'user-1',
    })

    assert.equal(restored, null)
    assert.deepEqual((await store.loadRecords(session.id)).map((record) => 'id' in record ? record.id : null), ['user-1', 'assistant-1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore appendRecord updates metadata without rereading JSONL history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  const originalReadFileSync = fs.readFileSync
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const firstMessage: SessionRecord = {
      type: 'message',
      id: 'msg-1',
      role: 'user',
      content: 'Initial title',
      createdAt: new Date().toISOString(),
    }
    await store.appendRecord(session.id, firstMessage)

    const jsonlPath = path.join(getSessionsDir(dir), `${session.id}.jsonl`)
    fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(filePath) === jsonlPath) {
        throw new Error('appendRecord should not reread JSONL history')
      }
      return originalReadFileSync(filePath, ...(args as [BufferEncoding | undefined]))
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()

    await store.appendRecord(session.id, {
      type: 'message',
      id: 'msg-2',
      role: 'assistant',
      content: 'Second message',
      createdAt: new Date().toISOString(),
    })
    await store.appendRecord(session.id, {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Read',
      input: { file_path: 'README.md' },
      riskLevel: 'safe',
      createdAt: new Date().toISOString(),
    })

    const loaded = await store.load(session.id)
    assert.equal(loaded?.messageCount, 2)
    assert.equal(loaded?.title, 'Initial title')
  } finally {
    fs.readFileSync = originalReadFileSync
    syncBuiltinESMExports()
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore appends metrics next to session records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 6,
      response_tokens: 12,
      cache_read_tokens: 34,
      cache_hit_rate: 0.85,
      tool_calls: 2,
      duration_ms: 123,
    })
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: 'filesystem',
      error: 'connection timed out',
    })

    const metricsPath = path.join(getSessionsDir(dir), `${session.id}.metrics.jsonl`)
    const lines = readFileSync(metricsPath, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 3)
    const metric = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    assert.equal(metric.event, 'turn')
    assert.equal(metric.session_id, session.id)
    assert.equal(metric.input_tokens, 6)
    assert.equal(metric.response_tokens, 12)
    assert.equal(metric.cache_hit_rate, 0.85)
    const summary = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    assert.equal(summary.event, 'session_cache_summary')
    assert.equal(summary.total_turns, 1)
    assert.equal(summary.total_cache_hit_rate, 34 / 40)
    const mcpMetric = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>
    assert.equal(mcpMetric.event, 'mcp_connect_failed')
    assert.equal(mcpMetric.session_id, session.id)
    assert.equal(mcpMetric.server, 'filesystem')
    assert.equal(mcpMetric.error, 'connection timed out')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore reads back both the last request and the session totals', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create('metrics session')
    // Nothing recorded yet is "no answer", not a zeroed one — the caller keeps
    // counting from zero rather than painting a total it does not have.
    assert.equal(await store.loadSessionTotals(session.id), null)

    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 1_000,
      cache_creation_tokens: 500,
      response_tokens: 100,
      cache_read_tokens: 0,
      cache_hit_rate: 0,
      tool_calls: 0,
      duration_ms: 10,
    })
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 200,
      cache_creation_tokens: 50,
      response_tokens: 60,
      cache_read_tokens: 1_500,
      cache_hit_rate: 1_500 / 1_750,
      tool_calls: 1,
      duration_ms: 12,
    })

    assert.deepEqual(await store.loadSessionTotals(session.id), {
      inputTokens: 1_200,
      cacheCreationInputTokens: 550,
      cacheReadInputTokens: 1_500,
      outputTokens: 160,
    })
    assert.deepEqual(await store.loadLastRequestUsage(session.id), {
      inputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 1_500,
      outputTokens: 60,
    })

    // The cumulative rate counts writes as misses: 1500 read of 3250 sent.
    const summary = await store.loadMetricsSummary(session.id)
    assert.equal(summary?.totalCacheHitRate, 1_500 / 3_250)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore recovery ignores metrics JSONL files and removes polluted index entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()
    await store.appendRecord(session.id, {
      type: 'message',
      id: 'msg-1',
      role: 'user',
      content: 'real session',
      createdAt: new Date().toISOString(),
    })
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: 'test',
      error: 'keep this file',
    })

    const sessionsDir = getSessionsDir(dir)
    const indexPath = path.join(sessionsDir, 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { sessions: SessionMeta[] }
    index.sessions.push({
      ...session,
      id: `${session.id}.metrics`,
      messageCount: 0,
      title: undefined,
    })
    fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8')

    const listed = await store.list()
    assert.deepEqual(listed.map((item) => item.id), [session.id])
    assert.equal(fs.existsSync(path.join(sessionsDir, `${session.id}.metrics.jsonl`)), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore init removes empty sessions older than ten minutes but preserves recent ones', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const firstStore = new SessionStore(dir)
    await firstStore.init()
    const stale = await firstStore.create()
    await firstStore.appendRecord(stale.id, {
      id: 'queue-clear',
      type: 'message_queue',
      operation: 'clear',
      createdAt: '2026-07-15T00:00:00.000Z',
    })
    await firstStore.appendMetric(stale.id, {
      event: 'mcp_connect_failed',
      server: 'test',
      error: 'stale',
    })
    const recent = await firstStore.create()

    const sessionsDir = getSessionsDir(dir)
    const indexPath = path.join(sessionsDir, 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { sessions: SessionMeta[] }
    const staleMeta = index.sessions.find((item) => item.id === stale.id)
    assert.ok(staleMeta)
    staleMeta.updatedAt = '2000-01-01T00:00:00.000Z'
    fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8')
    const old = new Date('2000-01-01T00:00:00.000Z')
    fs.utimesSync(path.join(sessionsDir, `${stale.id}.jsonl`), old, old)
    fs.utimesSync(path.join(sessionsDir, `${stale.id}.metrics.jsonl`), old, old)

    const secondStore = new SessionStore(dir)
    await secondStore.init()
    const listed = await secondStore.list()
    assert.equal(listed.some((item) => item.id === stale.id), false)
    assert.equal(listed.some((item) => item.id === recent.id), true)
    assert.equal(fs.existsSync(path.join(sessionsDir, `${stale.id}.jsonl`)), false)
    assert.equal(fs.existsSync(path.join(sessionsDir, `${stale.id}.metrics.jsonl`)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore summarizes cache break causes in metrics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 100,
      response_tokens: 5,
      cache_read_tokens: 300,
      cache_hit_rate: 0.75,
      tool_calls: 0,
      duration_ms: 10,
    })
    await store.appendMetric(session.id, {
      event: 'cache_break',
      source: `agent:${session.id}`,
      reasons: ['system_prompt_changed(+10 chars)', 'beta_headers_changed'],
      drop_tokens: 2500,
    })

    const metricsPath = path.join(getSessionsDir(dir), `${session.id}.metrics.jsonl`)
    const metrics = readFileSync(metricsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const summary = [...metrics].reverse().find((metric) => metric.event === 'session_cache_summary')
    assert.equal(summary?.total_cache_hit_rate, 0.75)
    assert.equal(summary?.first_break_turn_count, 1)
    assert.equal(summary?.cache_break_count, 1)
    assert.deepEqual(summary?.cause_distribution, {
      system_prompt_changed: 1,
      beta_headers_changed: 1,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore restores cache summary before first metric append', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 100,
      response_tokens: 5,
      cache_read_tokens: 300,
      cache_hit_rate: 0.75,
      tool_calls: 0,
      duration_ms: 10,
    })
    await store.appendMetric(session.id, {
      event: 'cache_break',
      source: `agent:${session.id}`,
      reasons: ['tool_schemas_changed'],
      drop_tokens: 2500,
    })

    const restartedStore = new SessionStore(dir)
    await restartedStore.init()
    await restartedStore.appendMetric(session.id, {
      event: 'turn',
      model: 'fake-model',
      input_tokens: 200,
      response_tokens: 8,
      cache_read_tokens: 200,
      cache_hit_rate: 0.5,
      tool_calls: 1,
      duration_ms: 20,
    })

    const metricsPath = path.join(getSessionsDir(dir), `${session.id}.metrics.jsonl`)
    const metrics = readFileSync(metricsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const summary = [...metrics].reverse().find((metric) => metric.event === 'session_cache_summary')
    assert.equal(summary?.total_turns, 2)
    assert.equal(summary?.total_cache_hit_rate, 500 / 800)
    assert.equal(summary?.first_break_turn_count, 1)
    assert.equal(summary?.cache_break_count, 1)
    assert.deepEqual(summary?.cause_distribution, {
      tool_schemas_changed: 1,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore loads cache and compact metrics summary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    for (let i = 0; i < 6; i += 1) {
      await store.appendMetric(session.id, {
        event: 'turn',
        model: 'fake-model',
        input_tokens: 100,
        response_tokens: 5,
        cache_read_tokens: 100,
        cache_hit_rate: 0.5,
        tool_calls: 0,
        duration_ms: 10,
      })
      if (i === 1 || i === 5) {
        await store.appendMetric(session.id, {
          event: 'compact',
          model: 'fake-model',
          pre_tokens: 10_000,
          post_tokens: 4_000,
          compact_duration_ms: 25,
        })
      }
    }

    const summary = await store.loadMetricsSummary(session.id)
    assert.equal(summary?.totalTurns, 6)
    assert.equal(summary?.totalCacheHitRate, 0.5)
    assert.equal(summary?.averageCompactIntervalTurns, 4)

    const restartedStore = new SessionStore(dir)
    await restartedStore.init()
    const restoredSummary = await restartedStore.loadMetricsSummary(session.id)
    assert.equal(restoredSummary?.totalTurns, 6)
    assert.equal(restoredSummary?.totalCacheHitRate, 0.5)
    assert.equal(restoredSummary?.averageCompactIntervalTurns, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore returns null metrics summary when no metrics exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    assert.equal(await store.loadMetricsSummary(session.id), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore persists and clears compact failure count in metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.setCompactFailureCount(session.id, 3)
    assert.equal((await store.load(session.id))?.compactFailureCount, 3)

    await store.setCompactFailureCount(session.id, 0)
    assert.equal((await store.load(session.id))?.compactFailureCount, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore marks a session whose last turn failed until a newer message is sent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    const user = (id: string): SessionRecord => ({
      type: 'message', id, role: 'user', content: id, createdAt: '2026-06-01T00:00:00.000Z',
    })
    const assistant: SessionRecord = {
      type: 'message', id: 'a-1', role: 'assistant', content: 'half', createdAt: '2026-06-01T00:00:01.000Z',
    }
    const failure: SessionRecord = {
      type: 'turn_failure', id: 'f-1', userMessageId: 'u-1', error: 'boom', createdAt: '2026-06-01T00:00:02.000Z',
    }

    await store.appendRecord(session.id, user('u-1'))
    assert.equal((await store.load(session.id))?.lastTurnFailed, undefined)
    await store.appendRecord(session.id, failure)
    assert.equal((await store.load(session.id))?.lastTurnFailed, true)
    // A late assistant record from the same turn does not clear it.
    await store.appendRecord(session.id, assistant)
    assert.equal((await store.load(session.id))?.lastTurnFailed, true)
    assert.equal((await store.list())[0]?.lastTurnFailed, true)

    // Rebuilding the row from the records reaches the same answer.
    const truncated = await store.truncateBeforeMessage(session.id, 'a-1')
    assert.equal(truncated.success, true)
    assert.equal((await store.load(session.id))?.lastTurnFailed, true)

    await store.appendRecord(session.id, user('u-2'))
    assert.equal((await store.load(session.id))?.lastTurnFailed, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore repairs orphan tool protocol records in JSONL sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()

    const session = await store.create()
    await store.appendRecord(session.id, {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Grep',
      input: { pattern: 'x' },
      riskLevel: 'safe',
      createdAt: '2026-05-24T00:00:00.000Z',
      turnId: 'turn-1',
    })
    await store.appendRecord(session.id, {
      type: 'tool_result',
      id: 'result-2',
      toolUseId: 'missing-call',
      tool: 'Read',
      ok: true,
      content: 'orphan result',
      createdAt: '2026-05-24T00:00:01.000Z',
      turnId: 'turn-1',
    })

    const result = await store.repairRecords(session.id)
    assert.equal(result.repairedCount, 2)

    const records = await store.loadRecords(session.id)
    assert.ok(records.some((record) => record.type === 'tool_result' && record.toolUseId === 'call-1'))
    assert.ok(records.some((record) => record.type === 'tool_use' && record.id === 'missing-call'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionStore round-trips image refs beside text records without migrating old ones', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'))
  try {
    const store = new SessionStore(dir)
    await store.init()
    const session = await store.create()

    const promptImage = makeImageAttachmentRef({ id: 'img-prompt', ownerSessionId: session.id, name: 'prompt.png' })
    const resultImage = makeImageAttachmentRef({ id: 'img-result', ownerSessionId: session.id, name: 'screenshot.png' })
    const queuedImage = makeImageAttachmentRef({ id: 'img-queued', ownerSessionId: session.id, name: 'queued.png' })
    const interruptedImage = makeImageAttachmentRef({ id: 'img-interrupted', ownerSessionId: session.id, name: 'interrupted.png' })

    // First user message is pure image: no text, title falls back to the name.
    await store.appendRecord(session.id, {
      type: 'message',
      id: 'u1',
      role: 'user',
      content: '',
      createdAt: '2026-09-08T00:00:00.000Z',
      turnId: 'turn-1',
      images: [promptImage],
    })
    // Second is written exactly like an old build would: no images field at all.
    await store.appendRecord(session.id, {
      type: 'message',
      id: 'u2',
      role: 'user',
      content: 'legacy text-only record',
      createdAt: '2026-09-08T00:00:01.000Z',
      turnId: 'turn-2',
    })
    await store.appendRecord(session.id, {
      id: 'call-1',
      type: 'tool_use',
      tool: 'Read',
      input: { filePath: 'screenshot.png' },
      riskLevel: 'safe',
      createdAt: '2026-09-08T00:00:02.000Z',
      turnId: 'turn-2',
    })
    await store.appendRecord(session.id, {
      id: 'result-1',
      type: 'tool_result',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: '[Image 1: screenshot.png; …]',
      createdAt: '2026-09-08T00:00:03.000Z',
      turnId: 'turn-2',
      images: [resultImage],
    })
    await store.appendRecord(session.id, {
      id: 'q1',
      type: 'message_queue',
      operation: 'enqueue',
      message: {
        id: 'queued-1',
        content: 'queued with an image',
        priority: 'next',
        createdAt: '2026-09-08T00:00:04.000Z',
        images: [queuedImage],
      },
      createdAt: '2026-09-08T00:00:04.000Z',
    })
    await store.appendRecord(session.id, {
      id: 'int-1',
      type: 'turn_interruption',
      userMessageId: 'u2',
      prompt: 'legacy text-only record',
      images: [interruptedImage],
      remainingTasks: [],
      recoverable: true,
      createdAt: '2026-09-08T00:00:05.000Z',
      turnId: 'turn-2',
    })

    // A fresh store stands in for a restart: the refs must come back from the
    // JSONL exactly as written, and the old record must stay text-only.
    const reloaded = new SessionStore(dir)
    const records = await reloaded.loadRecords(session.id)

    const userWithImage = records.find((record) => record.type === 'message' && record.id === 'u1')
    assert.ok(userWithImage?.type === 'message')
    assert.deepEqual(userWithImage.images, [promptImage])

    const legacy = records.find((record) => record.type === 'message' && record.id === 'u2')
    assert.ok(legacy?.type === 'message')
    assert.equal('images' in legacy, false)

    const toolResult = records.find((record) => record.type === 'tool_result' && record.id === 'result-1')
    assert.ok(toolResult?.type === 'tool_result')
    assert.deepEqual(toolResult.images, [resultImage])

    const queueRecord = records.find((record) => record.type === 'message_queue' && record.operation === 'enqueue')
    assert.ok(queueRecord?.type === 'message_queue' && queueRecord.operation === 'enqueue')
    assert.deepEqual(queueRecord.message.images, [queuedImage])

    const interruption = records.find((record) => record.type === 'turn_interruption')
    assert.ok(interruption?.type === 'turn_interruption')
    assert.deepEqual(interruption.images, [interruptedImage])

    const meta = await reloaded.load(session.id)
    assert.equal(meta?.title, '图片：prompt.png')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deriveSessionTitle keeps text titles and falls back only for pure-image messages', () => {
  const image = makeImageAttachmentRef({ name: 'photo.png' })

  assert.equal(deriveSessionTitle({
    type: 'message',
    id: 'u1',
    role: 'user',
    content: 'hello',
    createdAt: '2026-09-08T00:00:00.000Z',
    images: [image],
  }), 'hello')

  assert.equal(deriveSessionTitle({
    type: 'message',
    id: 'u2',
    role: 'user',
    content: '',
    createdAt: '2026-09-08T00:00:00.000Z',
    images: [image],
  }), '图片：photo.png')

  assert.equal(deriveSessionTitle({
    type: 'message',
    id: 'u3',
    role: 'user',
    content: '   ',
    createdAt: '2026-09-08T00:00:00.000Z',
    images: [image],
  }), '图片：photo.png')

  // Old behavior untouched: empty text without images stays an empty title.
  assert.equal(deriveSessionTitle({
    type: 'message',
    id: 'u4',
    role: 'user',
    content: '',
    createdAt: '2026-09-08T00:00:00.000Z',
  }), '')

  assert.equal(deriveSessionTitle({
    type: 'message',
    id: 'a1',
    role: 'assistant',
    content: 'response',
    createdAt: '2026-09-08T00:00:00.000Z',
  }), undefined)
})
