import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { UsageScanner } from '../src/desktop/usageStats.js'
import { getSessionsDir } from '../src/utils/paths.js'

function turn(at: Date, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'turn',
    created_at: at.toISOString(),
    session_id: 's',
    model: 'm1',
    input_tokens: 10,
    cache_creation_tokens: 5,
    cache_read_tokens: 100,
    response_tokens: 20,
    cache_hit_rate: null,
    tool_calls: 0,
    duration_ms: 1,
    ...over,
  })
}

async function scratchRoot(): Promise<{ root: string; dir: string; history: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-usage-'))
  const dir = getSessionsDir(root)
  await mkdir(dir, { recursive: true })
  return { root, dir, history: path.join(root, 'usage-history.json'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('scan buckets turns by local day, hour and model across projects', async () => {
  const a = await scratchRoot()
  const b = await scratchRoot()
  try {
    const first = new Date(2026, 9, 5, 14, 30)
    await writeFile(
      path.join(a.dir, 's1.metrics.jsonl'),
      [turn(first), turn(new Date(2026, 9, 5, 15), { model: 'm2' }), turn(new Date(2026, 9, 6, 9)), 'not json', JSON.stringify({ event: 'compact' })].join('\n') + '\n',
    )
    await writeFile(path.join(b.dir, 's2.metrics.jsonl'), turn(new Date(2026, 9, 6, 9)) + '\n')

    const { days } = await new UsageScanner(a.history).scan([a.root, b.root])

    assert.deepEqual(days.map((day) => day.day), ['2026-10-05', '2026-10-06'])
    assert.deepEqual(
      days.map((day) => [day.sessions, day.turns, day.tokens]),
      [[1, 2, 270], [1, 2, 270]],
    )
    assert.equal(days[0]!.hours[14], 1)
    assert.equal(days[0]!.hours[15], 1)
    assert.deepEqual(days[0]!.models, { m1: 135, m2: 135 })
  } finally {
    await a.cleanup()
    await b.cleanup()
  }
})

test('scan with no projects or no metrics returns no days', async () => {
  const a = await scratchRoot()
  try {
    assert.deepEqual(await new UsageScanner(a.history).scan([]), { days: [] })
    assert.deepEqual(await new UsageScanner(a.history).scan([a.root]), { days: [] })
  } finally {
    await a.cleanup()
  }
})

test('scan reuses unchanged files, re-reads changed ones and keeps removed ones', async () => {
  const a = await scratchRoot()
  try {
    const file = path.join(a.dir, 's1.metrics.jsonl')
    await writeFile(file, turn(new Date(2026, 9, 5, 14)) + '\n')
    const scanner = new UsageScanner(a.history)
    assert.equal((await scanner.scan([a.root])).days[0]!.turns, 1)

    // Same size and mtime, different content: only the cache can still say 1 turn at 14h.
    const stamp = new Date(2026, 9, 5)
    await utimes(file, stamp, stamp)
    await scanner.scan([a.root])
    await writeFile(file, turn(new Date(2026, 9, 5, 15)) + '\n')
    await utimes(file, stamp, stamp)
    const cached = (await scanner.scan([a.root])).days[0]!
    assert.equal(cached.hours[14], 1)

    await appendFile(file, turn(new Date(2026, 9, 5, 16)) + '\n')
    assert.equal((await scanner.scan([a.root])).days[0]!.turns, 2)

    await rm(file)
    assert.equal((await scanner.scan([a.root])).days[0]!.turns, 2)
    assert.equal((await new UsageScanner(a.history).scan([])).days[0]!.turns, 2)
  } finally {
    await a.cleanup()
  }
})

test('scan includes auxiliary and per-request spend without recounting response metadata', async () => {
  const a = await scratchRoot()
  try {
    const created_at = new Date(2026, 9, 5, 14).toISOString()
    const usage = { input_tokens: 50, cache_read_tokens: 20, response_tokens: 5 }
    const metrics = ['compact', 'aux_usage', 'subagent_usage', 'request_usage'].map((event) => JSON.stringify({ event, created_at, model: 'helper', usage }))
    await writeFile(path.join(a.dir, 's.metrics.jsonl'), [turn(new Date(created_at)), turn(new Date(created_at), { usageRecorded: true }), ...metrics].join('\n'))
    const [day] = (await new UsageScanner(a.history).scan([a.root])).days
    assert.equal(day!.tokens, 135 + 4 * 75)
    assert.equal(day!.turns, 2)
    assert.deepEqual(day!.models, { m1: 135, helper: 300 })
  } finally { await a.cleanup() }
})

test('v1 migration backs up and deduplicates renamed paths while preserving deleted sessions', async () => {
  const a = await scratchRoot()
  try {
    const file = path.join(a.dir, 's.metrics.jsonl')
    await writeFile(file, turn(new Date(2026, 9, 5, 14)))
    await new UsageScanner(a.history).scan([a.root])
    const current = JSON.parse(await readFile(a.history, 'utf8'))
    const cached = current.files.s
    const oldPath = file.replace('/.hanekawa/', '/.myagent/')
    const deletedPath = path.join(a.dir, 'deleted.metrics.jsonl')
    const legacy = { version: 1, files: { [file]: cached, [oldPath]: cached, [deletedPath]: cached } }
    await writeFile(a.history, JSON.stringify(legacy))
    const result = await new UsageScanner(a.history).scan([a.root])
    assert.equal(result.days[0]!.tokens, 270)
    assert.equal(result.days[0]!.sessions, 2)
    assert.deepEqual(JSON.parse(await readFile(`${a.history}.v1.bak`, 'utf8')), legacy)
    const migrated = JSON.parse(await readFile(a.history, 'utf8'))
    assert.equal(migrated.version, 2)
    assert.deepEqual(Object.keys(migrated.files).sort(), ['deleted', 's'])
    assert.deepEqual(await new UsageScanner(a.history).scan([a.root]), result)
    await rm(file)
    assert.deepEqual(await new UsageScanner(a.history).scan([]), result)
  } finally { await a.cleanup() }
})

test('a migrated cache still reparses old files first discovered on a later scan', async () => {
  const a = await scratchRoot()
  try {
    const file = path.join(a.dir, 's.metrics.jsonl')
    const at = new Date(2026, 9, 5, 14)
    await writeFile(file, turn(at))
    await new UsageScanner(a.history).scan([a.root])
    const cached = JSON.parse(await readFile(a.history, 'utf8')).files.s
    // A v1 cache had no auxiliary spend, even if mtime and size match.
    await writeFile(file, [turn(at), JSON.stringify({ event: 'aux_usage', created_at: at.toISOString(), model: 'helper', usage: { input_tokens: 50, cache_read_tokens: 0, response_tokens: 5 } })].join('\n'))
    const info = await stat(file)
    await writeFile(a.history, JSON.stringify({ version: 1, files: { [file]: { ...cached, size: info.size, mtimeMs: info.mtimeMs } } }))
    await new UsageScanner(a.history).scan([])
    assert.equal((await new UsageScanner(a.history).scan([a.root])).days[0]!.tokens, 190)
  } finally { await a.cleanup() }
})
