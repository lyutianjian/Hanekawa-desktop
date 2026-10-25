import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSearchResults,
  searchStats,
  type SearchResults,
} from '../src/desktop/renderer/model/searchResults.js'

test('Glob treats only its separated final notice as metadata', () => {
  const realName = '[Showing 1 of 2 files; narrow the pattern or path.]'
  const result = parseSearchResults('Glob', `${realName}\na.ts\n\n[Showing 2 of 201 files; narrow the pattern or path.]`)!
  assert.deepEqual(result.files.map((file) => file.path), [realName, 'a.ts'])
  assert.equal(result.matchCount, 2)
  assert.equal(result.truncatedNote, '[Showing 2 of 201 files; narrow the pattern or path.]')
  assert.equal(parseSearchResults('Glob', realName)?.files[0]?.path, realName)
})

/**
 * The search family's parser (T15, design §6.2 检索) — pure, like every
 * `model/` module, because the rules are the interesting half: what counts as a
 * search result at all is a decision the view should inherit, not make.
 *
 * The formats are the two the tools actually print, quoted from
 * `src/tools/grep.ts` and `src/tools/glob.ts`: ripgrep rows
 * (`path:line:text`, no space) or the Node fallback's `path:line: text`
 * (one separator space), and `Glob`'s one path per line.
 */

/** `undefined`, spelled out — the answer half the cases exist to pin. */
function noResult(toolName: string, content: string | undefined): void {
  assert.equal(parseSearchResults(toolName, content), undefined)
}

test('a Grep payload groups its hits under first-seen files, in content order', () => {
  const results = parseSearchResults('Grep', [
    'src/a.ts:10:first in a',
    'src/b.ts:2:first in b',
    'src/a.ts:99:second in a',
  ].join('\n'))

  assert.ok(results)
  assert.equal(results.tool, 'Grep')
  assert.deepEqual(
    results.files.map((file) => [file.path, file.matches.map((hit) => [hit.line, hit.text])]),
    [
      ['src/a.ts', [[10, 'first in a'], [99, 'second in a']]],
      ['src/b.ts', [[2, 'first in b']]],
    ],
  )
  assert.equal(results.matchCount, 3, 'hit rows across every file')
})

test('the matched line keeps its own text, colon included', () => {
  // `http://x:8080` in a match is the case the row pattern exists for: the
  // first `:<digits>:` is the separator and everything after it is text,
  // because a path cannot be re-read out of the tail.
  const results = parseSearchResults('Grep', 'src/a.ts:10:see http://x:8080 done')
  assert.ok(results)
  assert.deepEqual(results.files[0]?.matches[0], { line: 10, text: 'see http://x:8080 done' })
})

test('the Node fallback’s separator space is just leading text, and Windows paths parse', () => {
  // `: ${line}` on the fallback path; `path.relative` yields backslashes on
  // Windows. Neither may break the row pattern.
  const results = parseSearchResults('Grep', 'src\\renderer\\a.ts:12:  const x = 1')
  assert.ok(results)
  assert.equal(results.files[0]?.path, 'src\\renderer\\a.ts')
  assert.deepEqual(results.files[0]?.matches[0], { line: 12, text: '  const x = 1' })
})

test('the pagination notice is the list’s footnote, not a row', () => {
  const results = parseSearchResults('Grep', 'src/a.ts:1:one\n\n[Showing results 1..1 of 812 total matches]')
  assert.ok(results)
  assert.equal(results.truncatedNote, '[Showing results 1..1 of 812 total matches]')
  assert.equal(results.matchCount, 1)
})

test('anything that is not a row disqualifies the whole payload', () => {
  // Strict on purpose: an error string, a `No matches found.`, and a multiline
  // `rg -U` match with its `--` separators are all content the fallback body
  // should draw — a family that half-parsed its input would group an error
  // message under a path nobody clicked.
  noResult('Grep', 'No matches found.')
  noResult('Grep', 'Error: Invalid regular expression pattern.')
  noResult('Grep', 'src/a.ts:10:match\n--\nsrc/a.ts:40:other')
  noResult('Grep', 'src/a.ts:not-a-number:text')
  noResult('Grep', '')
  noResult('Grep', undefined)
})

test('a Glob payload is one file per line, and a file is its own hit', () => {
  const results = parseSearchResults('Glob', 'test/a.test.ts\nsrc/c.ts')
  assert.ok(results)
  assert.equal(results.tool, 'Glob')
  assert.deepEqual(
    results.files.map((file) => [file.path, file.matches.length]),
    [['test/a.test.ts', 0], ['src/c.ts', 0]],
  )
  assert.equal(results.matchCount, 2, 'the file count, not a hit count')
  assert.equal(results.truncatedNote, undefined)
})

test('a Glob payload that is not a list yields nothing', () => {
  noResult('Glob', 'No files found.')
  noResult('Glob', '')
  noResult('Glob', undefined)
})

test('only the two family members parse at all', () => {
  noResult('Read', 'src/a.ts:1:one')
  noResult('Bash', 'src/a.ts:1:one')
})

test('the head’s counts are the parsed list’s own, per family', () => {
  // `8 处 / 3 文件` for a Grep, `14 个文件` for a Glob (§6.2) — derived from
  // the list, so the head and the body can never disagree.
  const grep: SearchResults = {
    tool: 'Grep',
    files: [
      { path: 'a.ts', matches: [{ line: 1, text: 'x' }, { line: 2, text: 'y' }] },
      { path: 'b.ts', matches: [{ line: 3, text: 'z' }] },
    ],
    matchCount: 3,
  }
  assert.equal(searchStats(grep), '3 处 / 2 文件')

  const glob: SearchResults = {
    tool: 'Glob',
    files: [{ path: 'a.ts', matches: [] }],
    matchCount: 1,
  }
  assert.equal(searchStats(glob), '1 个文件')
})
