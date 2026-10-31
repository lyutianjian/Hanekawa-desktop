import test from 'node:test'
import assert from 'node:assert/strict'
import { parseComposerDocument, serializeComposerDocument, composerAtomicOffset } from '../src/desktop/renderer/model/composerDocument.js'
import { splitUserMessage } from '../src/desktop/renderer/model/userMessage.js'

const id = '01234567-89ab-cdef-0123-456789abcdef'
const link = `[标题 \\[括号\\]](hanekawa://session/${id})`

test('several inline references serialize without changing surrounding text or escaped titles', () => {
  const input = `参考 ${link}\n和 ${link} 继续 @src/a.ts`
  const fragments = parseComposerDocument(input)
  assert.equal(serializeComposerDocument(fragments), input)
  assert.equal(fragments.filter((entry) => entry.kind === 'session-reference').length, 2)
  const segments = splitUserMessage(input)
  assert.equal(segments.map((entry) => entry.text).join(''), input)
  assert.equal(segments.filter((entry) => entry.kind === 'session-reference').length, 2)
  assert.equal(segments.filter((entry) => entry.kind === 'file').length, 1)
})

test('caret offsets inside a reference snap to its boundary', () => {
  const input = `前 ${link} 后`
  assert.equal(composerAtomicOffset(input, 6, 'before'), 2)
  assert.equal(composerAtomicOffset(input, 6, 'after'), 2 + link.length)
  assert.equal(composerAtomicOffset(input, 1, 'before'), 1)
})

test('an @ inside a reference title does not become a file mention', () => {
  const input = `[讨论 @a.ts](hanekawa://session/${id})`
  assert.deepEqual(splitUserMessage(input).map((entry) => entry.kind), ['session-reference'])
})
