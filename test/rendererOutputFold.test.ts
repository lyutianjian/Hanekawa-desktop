import assert from 'node:assert/strict'
import test from 'node:test'

import { OUTPUT_FOLD_LINES, foldOutput } from '../src/desktop/renderer/model/outputFold.js'

/**
 * Where a tool's output folds. Two hundred lines is more than the block shows
 * without scrolling, and far below the layout cost that froze a frame when a
 * long build log opened.
 */
test('output folds only past the limit, and a trailing newline is not a line', () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => String(i)).join('\n')
  assert.equal(foldOutput(lines(OUTPUT_FOLD_LINES)), undefined)
  assert.equal(foldOutput(`${lines(OUTPUT_FOLD_LINES)}\n`), undefined)
  const folded = foldOutput(lines(OUTPUT_FOLD_LINES + 1))
  assert.equal(folded?.total, OUTPUT_FOLD_LINES + 1)
  assert.equal(folded?.head.split('\n').length, OUTPUT_FOLD_LINES)
  assert.deepEqual(foldOutput('a\nb\nc', 2), { head: 'a\nb', total: 3 })
})
