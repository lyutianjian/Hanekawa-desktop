import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appendPromptHistory,
  getPromptHistoryPath,
  loadPromptHistory,
  promptHistoryTexts,
} from '../src/runtime/promptHistory.js'

test('prompt history uses the user-level JSONL path and preserves duplicates and multiline text', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hanekawa-history-'))
  try {
    const cwd = path.join(home, 'project')
    await appendPromptHistory('same\nmessage', cwd, { home, now: new Date('2026-01-01T00:00:00Z') })
    await appendPromptHistory('same\nmessage', cwd, { home, now: new Date('2026-01-01T00:00:01Z') })

    assert.equal(getPromptHistoryPath(home), path.join(home, '.hanekawa', 'history.jsonl'))
    assert.deepEqual(promptHistoryTexts(await loadPromptHistory(cwd, { home })), [
      'same\nmessage',
      'same\nmessage',
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('prompt history ignores malformed entries, limits recent records, and prioritizes current cwd', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hanekawa-history-'))
  try {
    const current = path.join(home, 'current')
    const other = path.join(home, 'other')
    const historyPath = getPromptHistoryPath(home)
    await mkdir(path.dirname(historyPath), { recursive: true })
    const entries = [
      '{bad json',
      JSON.stringify({ text: '', cwd: current, ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ text: 'current-old', cwd: current, ts: '2026-01-01T00:00:01Z' }),
      JSON.stringify({ text: 'other-new', cwd: other, ts: '2026-01-01T00:00:02Z' }),
      JSON.stringify({ text: 'current-new', cwd: current, ts: '2026-01-01T00:00:03Z' }),
    ]
    await writeFile(historyPath, `${entries.join('\n')}\n`, 'utf8')

    assert.deepEqual(promptHistoryTexts(await loadPromptHistory(current, { home, limit: 3 })), [
      'other-new',
      'current-old',
      'current-new',
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('prompt history loads only the newest requested valid entries', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'hanekawa-history-'))
  try {
    const cwd = path.join(home, 'project')
    for (let index = 0; index < 5; index += 1) {
      await appendPromptHistory(`entry-${index}`, cwd, { home })
    }
    assert.deepEqual(promptHistoryTexts(await loadPromptHistory(cwd, { home, limit: 3 })), [
      'entry-2', 'entry-3', 'entry-4',
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
