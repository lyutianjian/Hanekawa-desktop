import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getSessionsDir, userHome } from '../src/utils/paths.js'
import { createSessionReferenceHost } from '../src/runtime/sessionReferences.js'
import type { SessionRecord } from '../src/harness/types.js'

async function fixture(root: string, title: string, bodies: string[]) {
  const id = randomUUID()
  const dir = getSessionsDir(root)
  await mkdir(dir, { recursive: true })
  const existing = await readFile(join(dir, 'index.json'), 'utf8').then((s) => JSON.parse(s) as { sessions: unknown[] }).catch((): { sessions: unknown[] } => ({ sessions: [] }))
  existing.sessions.push({ id, title, messageCount: bodies.length, updatedAt: '2026-10-31T01:00:00Z' })
  await writeFile(join(dir, 'index.json'), JSON.stringify(existing))
  const records = bodies.map((content, i): SessionRecord => ({ type: 'message', id: `${id}-${i}`, role: i % 2 ? 'assistant' : 'user', content, createdAt: '2026-10-31T01:00:00Z', reasoningContent: '隐藏思考 SECRET', responseItems: [{ token: 'SECRET' }] }))
  await writeFile(join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { id, records, dir }
}

test('known projects and global sessions resolve without opening runtimes; search uses visible bodies and excludes caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-refs-'))
  const other = join(root, 'other')
  const a = await fixture(root, '相同名称', ['当前会话缓存命中'])
  const b = await fixture(other, '相同名称', ['实际正文缓存命中 SECRET'])
  const c = await fixture(userHome(), '全局引用 fixture', ['全局正文'])
  try {
    const host = createSessionReferenceHost({ cwd: root, listProjectRoots: async () => [other], getLiveState: (sessionId) => sessionId === b.id ? 'running' : 'unknown', redact: (text) => text.replaceAll('SECRET', '[已隐藏]') })
    const before = await readFile(join(b.dir, `${b.id}.jsonl`), 'utf8')
    assert.equal((await host.resolve(`hanekawa://session/${b.id}`)).projectRoot, other)
    assert.equal((await host.resolve(c.id)).projectIsGlobal, true)
    const title = await host.search({ action: 'search', query: '相同' }, { sessionId: a.id })
    assert.deepEqual(title.results.map((r) => r.sessionId), [b.id])
    const body = await host.search({ action: 'search', scope: 'content', query: '缓存命中' }, { sessionId: a.id })
    assert.deepEqual(body.results.map((r) => r.sessionId), [b.id])
    assert.match(body.results[0]!.snippets[0]!.text, /缓存命中/)
    assert.ok(!JSON.stringify(body).includes('SECRET'))
    const hidden = await host.search({ action: 'search', scope: 'content', query: '隐藏思考' })
    assert.equal(hidden.results.length, 0)
    const read = await host.read({ action: 'read', ref: b.id })
    assert.equal(read.session.state, 'running')
    assert.match(read.items[0]!.content, /\[已隐藏\]/)
    assert.ok(!JSON.stringify(read).includes('reasoningContent'))
    assert.equal(await readFile(join(b.dir, `${b.id}.jsonl`), 'utf8'), before)
    assert.deepEqual((await readdir(b.dir)).sort(), [`${b.id}.jsonl`, 'index.json'].sort())
    await assert.rejects(host.resolve(randomUUID()), /找不到/)
    await assert.rejects(host.search({ action: 'search', scope: 'content', query: '' }), /非空/)
    await assert.rejects(host.search({ action: 'search', query: '', projectRoot: '/unknown' }), /已知项目/)
  } finally { await rm(root, { recursive: true, force: true }); await rm(join(c.dir, `${c.id}.jsonl`), { force: true }); const index = JSON.parse(await readFile(join(c.dir, 'index.json'), 'utf8')) as { sessions: Array<{ id: string }> }; index.sessions = index.sessions.filter((row) => row.id !== c.id); await writeFile(join(c.dir, 'index.json'), JSON.stringify(index)) }
})

test('latest long-message windows retain direction and every character exactly once; start and anchors page forwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-pages-'))
  try {
    const bodies = ['first', 'A'.repeat(31000), 'third', 'B'.repeat(51000), 'last']
    const { id, records } = await fixture(root, '分页', bodies)
    const host = createSessionReferenceHost({ cwd: root })
    const readAll = async (from: 'start' | 'latest') => {
      const seen = new Map<string, string>()
      let cursor: string | undefined
      let calls = 0
      do {
        const page = await host.read({ action: 'read', ref: id, limit: 2, ...(cursor ? { cursor } : { from }) })
        assert.equal(page.page.direction, from === 'latest' ? 'earlier' : 'later')
        assert.ok(page.items.reduce((n, item) => n + item.content.length, 0) <= 24000)
        for (const item of page.items) seen.set(item.messageId, (seen.get(item.messageId) ?? '') + item.content)
        cursor = page.page.nextCursor
        assert.equal(page.page.hasMore, !!cursor)
        assert.ok(++calls < 20)
      } while (cursor)
      for (const record of records) assert.equal(seen.get(record.id), record.type === 'message' ? record.content : '')
      assert.equal(seen.size, records.length)
    }
    await readAll('latest')
    await readAll('start')
    const anchored = await host.read({ action: 'read', ref: id, anchorMessageId: records[2]!.id, limit: 2 })
    assert.equal(anchored.page.direction, 'later')
    assert.equal(anchored.items[0]!.messageId, records[2]!.id)
    const first = await host.read({ action: 'read', ref: id, from: 'start', limit: 1 })
    const file = join(getSessionsDir(root), `${id}.jsonl`)
    await writeFile(file, JSON.stringify(records[0]) + '\n')
    await assert.rejects(host.read({ action: 'read', ref: id, cursor: first.page.nextCursor }), /rewind|已改变/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('content budget resumes within a giant tool log and reaches title-independent matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-budget-'))
  try {
    const { id, records } = await fixture(root, '不含关键字的标题', ['prefix ' + 'z'.repeat(20000) + ' needle'])
    const file = join(getSessionsDir(root), `${id}.jsonl`)
    await writeFile(file, JSON.stringify({ type: 'tool_result', id: 'tool', tool: 'Bash', content: 'noise '.repeat(10000), toolUseId: 'use' }) + '\n' + JSON.stringify(records[0]) + '\n')
    const host = createSessionReferenceHost({ cwd: root, scanBudgetBytes: 4096 })
    let cursor: string | undefined
    const hits: string[] = []
    let calls = 0
    do {
      const result = await host.search({ action: 'search', query: 'needle', scope: 'content', ...(cursor ? { cursor } : {}) })
      assert.ok(result.coverage.bytesScanned <= 4096)
      hits.push(...result.results.map((r) => r.sessionId))
      cursor = result.nextCursor
      assert.equal(result.complete, !cursor)
      assert.ok(++calls < 100)
    } while (cursor)
    assert.ok(calls > 10)
    assert.deepEqual(hits, [id])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('title lookup stays independent of large bodies with 1000 indexed sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-performance-'))
  try {
    const { id, records, dir } = await fixture(root, '特定标题', ['needle is visible'])
    const sessions = Array.from({ length: 999 }, (_, i) => ({ id: randomUUID(), title: `项目历史 ${i}`, messageCount: 1, updatedAt: '2026-10-01T00:00:00Z' }))
    sessions.unshift({ id, title: '特定标题', messageCount: 1, updatedAt: '2026-10-31T01:00:00Z' })
    await writeFile(join(dir, 'index.json'), JSON.stringify({ sessions }))
    await writeFile(join(dir, `${id}.jsonl`), JSON.stringify(records[0]) + '\n' + JSON.stringify({ type: 'tool_result', id: 'large', tool: 'Bash', toolUseId: 'use', content: 'x'.repeat(24 * 1024 * 1024) }) + '\n')
    const host = createSessionReferenceHost({ cwd: root })
    let started = performance.now()
    const title = await host.search({ action: 'search', query: '特定标题' })
    const titleMs = performance.now() - started
    assert.equal(title.results[0]?.sessionId, id)
    assert.equal(title.coverage.bytesScanned, 0)
    started = performance.now()
    const body = await host.search({ action: 'search', query: 'needle', scope: 'content', limit: 1 })
    const bodyMs = performance.now() - started
    assert.equal(body.results[0]?.sessionId, id)
    assert.ok(body.coverage.bytesScanned > 24 * 1024 * 1024)
    t.diagnostic(`1000 session title lookup: ${titleMs.toFixed(1)} ms; 24 MiB tool history content scan: ${bodyMs.toFixed(1)} ms`)
    const controller = new AbortController()
    const pending = host.search({ action: 'search', query: 'missing', scope: 'content' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, /abort/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('tool calls and results remain associated across separate read pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-tools-pages-'))
  try {
    const { id, records, dir } = await fixture(root, '工具历史', ['user prompt'])
    const toolUse: SessionRecord = { type: 'tool_use', id: 'call-1', tool: 'Read', input: { file_path: 'source.ts' }, riskLevel: 'safe', createdAt: '2026-10-31T01:00:01Z' }
    const toolResult: SessionRecord = { type: 'tool_result', id: 'result-1', tool: 'Read', toolUseId: toolUse.id, ok: true, content: 'visible result', createdAt: '2026-10-31T01:00:02Z' }
    await writeFile(join(dir, `${id}.jsonl`), [...records, toolUse, toolResult].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const host = createSessionReferenceHost({ cwd: root })
    let page = await host.read({ action: 'read', ref: id, from: 'start', includeTools: true, limit: 1 })
    page = await host.read({ action: 'read', ref: id, cursor: page.page.nextCursor, includeTools: true, limit: 1 })
    assert.equal(page.items[0]?.kind, 'tool_use')
    const callId = page.items[0]!.toolUseId
    page = await host.read({ action: 'read', ref: id, cursor: page.page.nextCursor, includeTools: true, limit: 1 })
    assert.equal(page.items[0]?.kind, 'tool_result')
    assert.equal(page.items[0]?.toolUseId, callId)
    assert.equal(page.items[0]?.content, 'visible result')
    await assert.rejects(host.search({ action: 'search', query: 'x'.repeat(1025) }), /1024/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
