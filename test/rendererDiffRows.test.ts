import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIFF_CONTEXT_LINES,
  diffRowsFor,
  droppedLines,
  parseUnifiedPatch,
  patchPath,
  previewView,
} from '../src/desktop/renderer/model/diffRows.js'
import { buildFileToolPreview, capFileToolPreview } from '../src/services/fileToolPreview.js'
import { buildUnifiedPatch } from '../src/tools/editPatch.js'
import type { FileToolPreview } from '../src/services/fileToolPreview.js'

/**
 * The desktop's diff rows, over the two shapes they arrive in: the previews the
 * host sends the permission dialog, and — since T13 — the unified patches the
 * editing tools ship in `display.detail`. The patch half is built against
 * `buildUnifiedPatch` rather than hand-written fixtures so a change to the
 * tool-side shape shows up here instead of drifting.
 */

// `assertInsideCwd` resolves against a real path, so this has to be the real
// cwd rather than a fixture root; the readFile stub keeps the filesystem out.
const cwd = process.cwd()

function preview(toolName: string, input: unknown, files: Record<string, string>): FileToolPreview {
  const built = buildFileToolPreview(toolName, input, {
    cwd,
    readFile: (absolutePath) => {
      const key = absolutePath.replace(/\\/g, '/')
      for (const [name, content] of Object.entries(files)) {
        if (key.endsWith(name)) return content
      }
      return undefined
    },
  })
  assert.ok(built, 'expected a preview')
  return built
}

test('creating a file is all additions, numbered from one', () => {
  const view = previewView(preview('Write', { filePath: 'new.txt', content: 'a\nb\n' }, {}))

  assert.equal(view.kind, 'diff')
  assert.ok(view.kind === 'diff')
  assert.deepEqual(view.rows.map((row) => [row.kind, row.text]), [['add', 'a'], ['add', 'b']])
  assert.deepEqual(view.rows.map((row) => row.newLine), [1, 2])
  assert.deepEqual(view.rows.map((row) => row.oldLine), [undefined, undefined])
})

test('an edit shows removals, additions and bounded context', () => {
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  const view = previewView(preview(
    'Edit',
    { filePath: 'a.txt', oldString: 'line 15', newString: 'LINE 15' },
    { 'a.txt': original },
  ))

  assert.ok(view.kind === 'diff')
  const kinds = view.rows.map((row) => row.kind)
  assert.ok(kinds.includes('del'), 'the old line is shown')
  assert.ok(kinds.includes('add'), 'the new line is shown')
  assert.ok(kinds.includes('elided'), '30 lines of context are collapsed')

  const del = view.rows.find((row) => row.kind === 'del')
  const add = view.rows.find((row) => row.kind === 'add')
  assert.equal(del?.text, 'line 15')
  assert.equal(add?.text, 'LINE 15')

  // Context is capped either side of the change rather than shown whole; a
  // one-line edit in a long file must not render as 30 unchanged rows.
  const contextRows = view.rows.filter((row) => row.kind === 'ctx')
  assert.ok(contextRows.length <= DIFF_CONTEXT_LINES * 2, `got ${contextRows.length} context rows`)
})

test('a delete shows every line as a removal', () => {
  const view = previewView(preview('Delete', { filePath: 'gone.txt' }, { 'gone.txt': 'x\ny\n' }))

  assert.ok(view.kind === 'diff')
  assert.deepEqual(view.rows.map((row) => row.kind), ['del', 'del'])
  assert.deepEqual(view.rows.map((row) => row.oldLine), [1, 2])
})

test('overwriting an existing file diffs against its current contents', () => {
  const view = previewView(preview(
    'Write',
    { filePath: 'a.txt', content: 'one\nTWO\n' },
    { 'a.txt': 'one\ntwo\n' },
  ))

  assert.ok(view.kind === 'diff')
  assert.deepEqual(
    view.rows.filter((row) => row.kind !== 'ctx').map((row) => [row.kind, row.text]),
    [['del', 'two'], ['add', 'TWO']],
  )
})

test('the host\'s elided count is reported as the larger side, not the sum', () => {
  assert.equal(droppedLines({ oldLines: 300, newLines: 290 }), 300)

  const big = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
  const capped = capFileToolPreview(preview(
    'Write',
    { filePath: 'big.txt', content: Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n') },
    { 'big.txt': big },
  ))
  assert.ok(capped)
  assert.ok(capped.kind === 'diff' && capped.elided, 'the host capped this preview')

  const view = previewView(capped)
  assert.ok(view.kind === 'diff')
  const last = view.rows.at(-1)
  assert.equal(last?.kind, 'elided')
  assert.match(last?.text ?? '', /^省略 \d+ 行$/)
  // Summary tells the same truth, so a user reading either number is not misled.
  assert.match(view.summary, /（省略 \d+ 行）/)
})

test('a message preview is passed through, not rendered as an empty diff', () => {
  const view = previewView({
    kind: 'message',
    title: 'Write preview unavailable',
    filePath: 'x.txt',
    message: 'File is too large to preview.',
  })

  assert.equal(view.kind, 'message')
  assert.ok(view.kind === 'message')
  assert.equal(view.message, 'File is too large to preview.')
  assert.equal(view.filePath, 'x.txt')
})

test('rows are capped for display, with the overflow named', () => {
  const rows = diffRowsFor('', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))
  assert.equal(rows.length, 50)

  const view = previewView(
    { kind: 'diff', title: 't', filePath: 'f', oldText: '', newText: rows.map((r) => r.text).join('\n'), summary: '+50' },
    { maxRows: 10 },
  )
  assert.ok(view.kind === 'diff')
  assert.equal(view.rows.length, 11)
  assert.equal(view.rows.at(-1)?.kind, 'elided')
  assert.equal(view.rows.at(-1)?.text, '省略 40 行')
})

test('text ending in a newline does not produce a phantom trailing row', () => {
  assert.deepEqual(diffRowsFor('', 'a\n').map((row) => row.text), ['a'])
  assert.deepEqual(diffRowsFor('', 'a\n\n').map((row) => row.text), ['a', ''])
})

// --- the editing tools' unified patches (T13) -------------------------------

test("a tool's own patch parses back into rows with line numbers on both sides", () => {
  const patch = buildUnifiedPatch('src\\foo.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')
  assert.ok(patch)

  const parsed = parseUnifiedPatch(patch)
  assert.ok(parsed)
  assert.deepEqual(parsed.rows.map((row) => [row.kind, row.text]), [
    ['ctx', 'one'],
    ['del', 'two'],
    ['add', 'TWO'],
    ['ctx', 'three'],
  ])
  // Each side numbers only its own rows — the gutter the permission dialog's
  // diff already paints, and now the tool step's too.
  assert.deepEqual(parsed.rows.map((row) => [row.oldLine, row.newLine]), [
    [1, 1],
    [2, undefined],
    [undefined, 2],
    [3, 3],
  ])
  assert.equal(parsed.added, 1)
  assert.equal(parsed.deleted, 1)
  assert.equal(parsed.capped, false)
})

test('a patch that skips the file head names what it skipped', () => {
  const lines = Array.from({ length: 44 }, (_, i) => `line ${i + 1}`)
  const patch = buildUnifiedPatch(
    'a.txt',
    lines.join('\n'),
    lines.map((line, index) => (index === 37 ? 'CHANGED' : line)).join('\n'),
  )
  assert.ok(patch)

  const parsed = parseUnifiedPatch(patch)
  assert.ok(parsed)
  // Context keeps 35–41 around the change at 38, so the patch opens at `-35`
  // and the 34 lines above it are the first hunk's own elision.
  assert.deepEqual(parsed.rows[0], { kind: 'elided', text: '省略 34 行' })
  assert.equal(parsed.rows[1]?.oldLine, 35)
})

test('the gap between two hunks is one elided row, counted from the headers', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `l ${i}`)
  const patch = buildUnifiedPatch(
    'a.txt',
    lines.join('\n'),
    lines.map((line, index) => (index === 7 || index === 39 ? 'X' : line)).join('\n'),
  )
  assert.ok(patch)

  const parsed = parseUnifiedPatch(patch)
  assert.ok(parsed)
  const gaps = parsed.rows.filter((row) => row.kind === 'elided')
  assert.deepEqual(gaps.map((row) => row.text), ['省略 4 行', '省略 25 行'])
  assert.equal(parsed.added, 2)
  assert.equal(parsed.deleted, 2)
})

test('a capped patch keeps its rows and the whole patch\'s counts from its cap line', () => {
  const oldText = Array.from({ length: 120 }, (_, i) => `old ${i}`).join('\n')
  const patch = buildUnifiedPatch(
    'big.txt',
    oldText,
    Array.from({ length: 120 }, (_, i) => `new ${i}`).join('\n'),
    { maxLines: 20, maxChars: 100_000 },
  )
  assert.ok(patch)

  const parsed = parseUnifiedPatch(patch)
  assert.ok(parsed)
  assert.equal(parsed.capped, true)
  // The cap line is terminal: what it kept is rows, what it dropped is named.
  assert.deepEqual(parsed.rows.at(-1), { kind: 'elided', text: '省略 225 行' })
  // The kept rows alone are all removals; the cap line's counts are the whole rewrite's.
  assert.equal(parsed.partial, false)
  assert.equal(parsed.added, 120)
  assert.equal(parsed.deleted, 120)
})

test('an older cap line without counts marks the counts partial', () => {
  const parsed = parseUnifiedPatch(['--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-a', '… 40 more lines not shown'].join('\n'))
  assert.ok(parsed)
  assert.equal(parsed.capped, true)
  assert.equal(parsed.partial, true)
})

test('a C-quoted header path decodes back to the file name', () => {
  const patch = buildUnifiedPatch('/p/樱谷 "夜想".html', 'a\n', 'b\n')
  assert.ok(patch)
  assert.ok(patch.startsWith('--- "'), 'diff quotes a non-ASCII name')
  assert.equal(patchPath(patch), '/p/樱谷 "夜想".html')
})

test('a new file numbers its additions from one, with no head elision', () => {
  const patch = buildUnifiedPatch('new.txt', '', 'a\nb\n')
  assert.ok(patch)

  const parsed = parseUnifiedPatch(patch)
  assert.ok(parsed)
  assert.deepEqual(parsed.rows.map((row) => [row.kind, row.text, row.newLine]), [
    ['add', 'a', 1],
    ['add', 'b', 2],
  ])
  assert.equal(parsed.deleted, 0)
})

test('a no-newline marker is kept as a row of neither side', () => {
  const patch = buildUnifiedPatch('f.txt', 'no newline', 'no newline2')
  assert.ok(patch)

  const parsed = parseUnifiedPatch(patch)
  assert.ok(parsed)
  const markers = parsed.rows.filter((row) => row.text.startsWith('\\ No newline'))
  assert.equal(markers.length, 2)
  assert.ok(markers.every((row) => row.kind === 'ctx' && row.oldLine === undefined && row.newLine === undefined))
  // And it does not disturb the numbering on either side.
  assert.deepEqual(
    parsed.rows.filter((row) => row.kind !== 'ctx').map((row) => [row.kind, row.oldLine, row.newLine]),
    [['del', 1, undefined], ['add', undefined, 1]],
  )
})

test('anything that is not one of those patches parses to undefined, not to rows', () => {
  // The old record's plain content (§10), the empty string, and a header with
  // garbage after it — the caller falls back to the plain body for all three.
  assert.equal(parseUnifiedPatch('Edited a.txt'), undefined)
  assert.equal(parseUnifiedPatch(''), undefined)
  assert.equal(parseUnifiedPatch(['--- a/x', '+++ b/x', 'random text'].join('\n')), undefined)
  // A cap line with no hunk before it is not a shape the tool emits either.
  assert.equal(
    parseUnifiedPatch(['--- a/x', '+++ b/x', '… 5 more lines not shown'].join('\n')),
    undefined,
  )
})
