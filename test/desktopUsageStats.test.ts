import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
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

async function scratchRoot(): Promise<{ root: string; dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'myagent-usage-'))
  const dir = getSessionsDir(root)
  await mkdir(dir, { recursive: true })
  return { root, dir, cleanup: () => rm(root, { recursive: true, force: true }) }
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

    const { days } = await new UsageScanner().scan([a.root, b.root])

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
    assert.deepEqual(await new UsageScanner().scan([]), { days: [] })
    assert.deepEqual(await new UsageScanner().scan([a.root]), { days: [] })
  } finally {
    await a.cleanup()
  }
})

test('scan reuses unchanged files and re-reads changed or removed ones', async () => {
  const a = await scratchRoot()
  try {
    const file = path.join(a.dir, 's1.metrics.jsonl')
    await writeFile(file, turn(new Date(2026, 9, 5, 14)) + '\n')
    const scanner = new UsageScanner()
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
    assert.deepEqual(await scanner.scan([a.root]), { days: [] })
  } finally {
    await a.cleanup()
  }
})
