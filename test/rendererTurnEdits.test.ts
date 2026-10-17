import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActivityStep, TranscriptEntry } from '../src/desktop/renderer/model/transcript.js'
import { collectTurnEdits, fileBadge, folderOf, markChangedWords } from '../src/desktop/renderer/model/turnEdits.js'

function patch(path: string, body: string[]): string {
  return [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n')
}

function edit(id: string, detail: string, status: 'done' | 'failed' = 'done'): ActivityStep {
  return { kind: 'tool', id, text: '', toolName: 'Edit', status, tool: { displayName: 'Edit', useSummary: '', detail } }
}

function run(...steps: ActivityStep[]): TranscriptEntry {
  return { kind: 'run', run: { id: `run:${steps[0]!.id}`, steps, status: 'done', failedCount: 0 } }
}

function user(id: string): TranscriptEntry {
  return { kind: 'item', item: { id, kind: 'user', text: 'go' } }
}

function answer(id: string): TranscriptEntry {
  return { kind: 'item', item: { id, kind: 'assistant', text: 'done' } }
}

const LOOP = patch('/p/src/loop.ts', ['@@ -10,2 +10,2 @@', ' keep', '-old line', '+new line'])
const LOOP_AGAIN = patch('/p/src/loop.ts', ['@@ -40,1 +40,2 @@', ' keep', '+added'])
const README = patch('/p/README.md', ['@@ -1,1 +1,1 @@', '-a', '+b'])

test('a turn gathers its files, sums repeated edits, and keys the card by the turn end', () => {
  const entries = [user('u1'), run(edit('e1', LOOP), edit('e2', README)), run(edit('e3', LOOP_AGAIN)), answer('a1')]
  const edits = collectTurnEdits(entries, new Set([3]))
  assert.deepEqual([...edits.keys()], [3])
  const turn = edits.get(3)!
  assert.equal(turn.key, 'e1')
  assert.equal(turn.userMessageId, 'u1')
  assert.deepEqual(turn.files.map((file) => [file.name, file.added, file.deleted]), [['loop.ts', 2, 1], ['README.md', 1, 1]])
  assert.deepEqual([turn.added, turn.deleted], [3, 2])
  assert.deepEqual(turn.files[0]!.rows.filter((row) => row.kind === 'elided').map((row) => row.text), ['9 行未修改', '39 行未修改'])
})

test('turns are kept apart, and a turn without a finished edit has no card', () => {
  const entries = [
    user('u1'), run(edit('e1', LOOP)), answer('a1'),
    user('u2'), run(edit('e2', README, 'failed')), answer('a2'),
    user('u3'), run(edit('e3', README)), answer('a3'),
  ]
  const edits = collectTurnEdits(entries, new Set([2, 5, 8]))
  assert.deepEqual([...edits.keys()], [2, 8])
  assert.equal(edits.get(8)!.userMessageId, 'u3')
  assert.deepEqual(edits.get(8)!.files.map((file) => file.name), ['README.md'])
})

test('an old capped patch without counts leaves the counts out rather than short', () => {
  const capped = patch('/p/big.ts', ['@@ -1,1 +1,1 @@', '-a', '+b', '… 40 more lines not shown'])
  const turn = collectTurnEdits([run(edit('e1', capped)), answer('a1')], new Set([1])).get(1)!
  assert.equal(turn.files[0]!.added, undefined)
  assert.equal(turn.added, undefined)
  assert.equal(turn.files[0]!.rows.at(-1)!.text, '另有 40 行未显示')
})

test('a line rewritten in place marks only the words that changed', () => {
  const rows = markChangedWords([
    { kind: 'del', text: 'const limit = 10', oldLine: 1 },
    { kind: 'add', text: 'const limit = 20', newLine: 1 },
    { kind: 'del', text: 'alpha', oldLine: 2 },
    { kind: 'add', text: 'something else entirely', newLine: 2 },
  ])
  assert.deepEqual(rows[0]!.marks, [[14, 16]])
  assert.deepEqual(rows[1]!.marks, [[14, 16]])
  // Unequal runs are a replacement, not a rewrite.
  assert.equal(rows[2]!.marks, undefined)
})

test('folder and badge', () => {
  assert.equal(folderOf('/Users/me/proj/src/harness/loop.ts', '/users/me/proj'), 'src/harness')
  assert.equal(folderOf('/Users/me/proj/README.md', '/Users/me/proj'), '')
  assert.equal(folderOf('/tmp/x/a.ts', '/Users/me/proj'), '/tmp/x')
  assert.equal(fileBadge('loop.ts'), 'TS')
  assert.equal(fileBadge('Makefile'), '')
  assert.equal(fileBadge('.env'), '')
})
