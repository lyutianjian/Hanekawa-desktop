import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getSessionsDir } from '../src/utils/paths.js'
import { findSessionSource, peekSessionIndex, readSessionRecords, scanSessionContent, type ContentScanState } from '../src/sessions/readonlyReader.js'
const id = '1d869182-cb22-4b54-9307-4a83849b9823'

test('readonly reader reads legacy location without creating or migrating files and skips unfinished tails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readonly-sessions-'))
  try {
    const dir = join(root, '.hanekawa', 'sessions')
    await mkdir(dir, { recursive: true })
    const content = `${JSON.stringify({ type: 'message', id: 'm1', role: 'user', content: 'hello', createdAt: 'now' })}\nmalformed\n{"type":"message"`
    await writeFile(join(dir, 'index.json'), JSON.stringify({ sessions: [{ id, title: '旧会话', updatedAt: '2026-10-31T00:00:00Z', messageCount: 1 }] }))
    await writeFile(join(dir, `${id}.jsonl`), content)
    const before = await readdir(dir)
    assert.equal((await peekSessionIndex(root))[0]?.title, '旧会话')
    const source = await findSessionSource(root, id)
    const rows = []
    for await (const row of readSessionRecords(source)) rows.push(row)
    assert.equal(rows.filter((r) => r.record).length, 1)
    assert.equal(rows.filter((r) => r.diagnostic).length, 2)
    assert.deepEqual(await readdir(dir), before)
    assert.equal(await readFile(join(dir, `${id}.jsonl`), 'utf8'), content)
    await assert.rejects(readdir(getSessionsDir(root)), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('content scanner resumes inside large rows with bounded bytes and excludes hidden and tool content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-scan-'))
  try {
    const dir = getSessionsDir(root)
    await mkdir(dir, { recursive: true })
    const lines = [
      { type: 'tool_result', id: 'tool', role: 'user', content: 'x'.repeat(8000) + '缓存目标' },
      { type: 'message', id: 'm1', role: 'assistant', thinkingBlocks: [{ thinking: '隐藏目标' }], content: '前文'.repeat(3000) + '缓存目标 和更多内容' },
      { type: 'message', id: 'm2', role: 'user', content: 'hidden replacement 缓存目标', displayContent: '显示的内容' },
    ]
    await writeFile(join(dir, `${id}.jsonl`), lines.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const source = await findSessionSource(root, id)
    let offset = 0
    let state: ContentScanState | undefined
    const hits = []
    let calls = 0
    for (;;) {
      const result = await scanSessionContent(source, { query: '缓存目标', offset, state, budget: 1024 })
      calls++
      assert.ok(result.bytesScanned <= 1024)
      assert.ok(result.offset > offset)
      hits.push(...result.snippets)
      offset = result.offset
      state = result.state
      if (result.complete) break
      assert.ok(calls < 100)
    }
    assert.ok(calls > 10)
    assert.deepEqual(hits.map((h) => h.messageId), ['m1'])
    assert.match(hits[0]!.text, /缓存目标/)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(scanSessionContent(source, { query: '目标', budget: 1024, signal: aborted.signal }), /abort/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy JSON is a read-only fallback, including cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readonly-legacy-json-'))
  try {
    const dir = getSessionsDir(root)
    await mkdir(dir, { recursive: true })
    const raw = JSON.stringify({ records: [{ type: 'message', id: 'old', role: 'user', content: '旧正文', createdAt: 'then' }] })
    await writeFile(join(dir, `${id}.json`), raw)
    const source = await findSessionSource(root, id)
    assert.equal(source.format, 'json')
    const rows = []
    for await (const row of readSessionRecords(source)) rows.push(row)
    assert.equal(rows[0]?.record?.type, 'message')
    assert.deepEqual(await readdir(dir), [`${id}.json`])
    assert.equal(await readFile(join(dir, `${id}.json`), 'utf8'), raw)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(async () => { for await (const _ of readSessionRecords(source, { signal: controller.signal })) { /* consume */ } }, /abort/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy content scanning resumes inside formatted JSON arrays under the same byte budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-content-budget-'))
  try {
    const dir = getSessionsDir(root)
    await mkdir(dir, { recursive: true })
    const raw = JSON.stringify({ meta: { title: '标题不是目标', role: 'user', content: '缓存目标' }, records: [
      { id: 'tool', type: 'tool_result', content: '缓存目标 ' + 'x'.repeat(10000) },
      { id: 'legacy-match', type: 'message', role: 'assistant', thinkingBlocks: [{ thinking: '隐藏目标' }], content: '前文'.repeat(2000) + '缓存目标' },
    ] }, null, 2)
    await writeFile(join(dir, `${id}.json`), raw)
    const source = await findSessionSource(root, id)
    let offset = 0
    let state: ContentScanState | undefined
    const hits = []
    for (let calls = 0; ; calls++) {
      const result = await scanSessionContent(source, { query: '缓存目标', offset, state, budget: 1024 })
      assert.ok(result.bytesScanned <= 1024)
      assert.ok(result.offset > offset)
      hits.push(...result.snippets)
      offset = result.offset
      state = result.state
      if (result.complete) break
      assert.ok(calls < 100)
    }
    assert.deepEqual(hits.map((hit) => hit.messageId), ['legacy-match'])
    assert.equal(await readFile(join(dir, `${id}.json`), 'utf8'), raw)
    assert.deepEqual(await readdir(dir), [`${id}.json`])
  } finally { await rm(root, { recursive: true, force: true }) }
})
